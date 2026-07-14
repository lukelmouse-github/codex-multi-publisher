import { timingSafeEqual } from "node:crypto";
import { lstat, mkdir, opendir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, digestCanonical, sha256Bytes } from "./canonical-json";
import type { BaoyuCredentialProbeResult } from "./baoyu-credentials-probe";
import { asPublishError, PublishError } from "./errors";
import { assertRealPathWithin, isWithin } from "./path-policy";
import type { PublishErrorData } from "./types";
import {
  baoyuCommand,
  resolveBaoyuToolchain,
  type BaoyuToolchainLock,
  type ResolveBaoyuToolchainOptions,
  type ResolvedBaoyuToolchain,
} from "./toolchain";

export type BaoyuDraftOperation = "preflight" | "dry-run" | "create-draft";
export type BaoyuDraftState = "preflighted" | "dry_run" | "draft_created" | "partial" | "outcome_unknown";

export interface BaoyuDraftRequest {
  operation: BaoyuDraftOperation;
  repoRoot: string;
  artifactRoot: string;
  inputPath: string;
  coverPath?: string;
  title: string;
  author?: string;
  summary?: string;
  account: string;
  theme?: string;
  color?: string;
  cite?: boolean;
  confirmationToken?: string;
  journalDir?: string;
  timeoutMs?: number;
  skillDir?: string;
  lockPath?: string;
  lock?: BaoyuToolchainLock;
  allowNpxBootstrap?: boolean;
  allowUnprefixedCredentials?: boolean;
  env?: Record<string, string | undefined>;
}

export interface BaoyuCommandRequest {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface BaoyuCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type BaoyuCommandRunner = (request: BaoyuCommandRequest) => Promise<BaoyuCommandResult>;

export interface BaoyuDraftDependencies {
  resolveToolchain?: (options: ResolveBaoyuToolchainOptions) => Promise<ResolvedBaoyuToolchain>;
  commandRunner?: BaoyuCommandRunner;
  credentialProbe?: (
    toolchain: ResolvedBaoyuToolchain,
    request: BaoyuDraftRequest,
    runner: BaoyuCommandRunner,
    env: Record<string, string>,
  ) => Promise<BaoyuCredentialProbeResult>;
  now?: () => string;
}

interface NormalizedBaoyuDraftRequest extends BaoyuDraftRequest {
  repoRoot: string;
  artifactRoot: string;
  inputPath: string;
  coverPath?: string;
  title: string;
  account: string;
  theme: string;
  cite: boolean;
  journalDir: string;
  timeoutMs: number;
}

interface BaoyuDryRunPayload {
  articleType: string;
  title: string;
  author?: string;
  digest?: string;
  contentLength: number;
  placeholderImageCount?: number;
  account?: string;
}

export interface BaoyuDraftResult {
  contractVersion: 1;
  ok: boolean;
  operation: BaoyuDraftOperation;
  state: BaoyuDraftState;
  account: string;
  fingerprint: string;
  confirmationToken: string;
  toolchain: {
    skillDir: string;
    version: string;
    runtime: "bun" | "npx-bun";
  };
  dryRun?: BaoyuDryRunPayload;
  credentials?: BaoyuCredentialProbeResult["credentials"];
  mediaId?: string;
  sideEffect: "none" | "draft_created" | "unknown";
  diagnostics: string[];
  error?: PublishErrorData;
}

interface DraftFingerprint {
  fingerprint: string;
  confirmationToken: string;
  inputDigest: string;
  coverDigest?: string;
  artifactDigest: string;
}

interface DraftJournal {
  schemaVersion: 1;
  fingerprint: string;
  account: string;
  state: "draft_created" | "partial" | "outcome_unknown";
  mediaId?: string;
  inputDigest: string;
  createdAt: string;
}

const ERROR_MARKER = "@@BLOG_WECHAT_ERROR@@";
const CHILD_MARKER = "@@BLOG_WECHAT_CHILD@@";
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;

function cleanEnvironment(overrides?: Record<string, string | undefined>): Record<string, string> {
  const combined: Record<string, string | undefined> = { ...process.env, ...overrides };
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(combined)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function redactBaoyuStderr(stderr: string): string {
  return stderr
    .replace(/([?&](?:access_token|appid|secret)=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(WECHAT_[A-Z0-9_]*(?:APP_ID|APP_SECRET))\s*=\s*[^\s"']+/g, "$1=[REDACTED]")
    .replace(/\b((?:app_?id|app_?secret|access_token|authorization|secret)\s*[:=]\s*)[^\s,"']+/gi, "$1[REDACTED]");
}

function diagnosticsFrom(stderr: string): string[] {
  const redacted = redactBaoyuStderr(stderr);
  const limited = redacted.length > MAX_STDERR_BYTES ? redacted.slice(-MAX_STDERR_BYTES) : redacted;
  return limited.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function hasImageUploadFailure(stderr: string): boolean {
  return /^\[wechat-api\] Failed to upload(?: placeholder)?\b/m.test(stderr);
}

function errorFromTerminalMarker(stderr: string): PublishError | undefined {
  const markerIndex = stderr.lastIndexOf(ERROR_MARKER);
  if (markerIndex < 0) return undefined;
  const json = stderr.slice(markerIndex + ERROR_MARKER.length).trim().split(/\r?\n/, 1)[0];
  if (!json) return undefined;
  try {
    const data = JSON.parse(json) as Partial<PublishErrorData>;
    if (typeof data.code !== "string" || typeof data.message !== "string") return undefined;
    return new PublishError(data.code, data.message, {
      kind: data.kind,
      retryable: data.retryable,
      outcome: data.outcome,
      details: data.details,
    });
  } catch {
    return undefined;
  }
}

export function classifyBaoyuFailure(stderr: string, timedOut = false): PublishError {
  const marked = errorFromTerminalMarker(stderr);
  if (marked) return marked;
  const redacted = redactBaoyuStderr(stderr).trim();
  const details = redacted ? { stderr: redacted.slice(-16_384) } : undefined;
  if (timedOut) {
    return new PublishError("E_BAOYU_TIMEOUT", "Baoyu process timed out; remote outcome may be unknown", {
      kind: "outcome_unknown",
      outcome: "unknown",
      retryable: false,
      details,
    });
  }
  if (/Access token error 40164\b/.test(redacted)) {
    return new PublishError("E_WECHAT_IP_NOT_ALLOWED", "Current IP is not in the WeChat API allowlist", {
      kind: "auth",
      details,
    });
  }
  if (/Missing WECHAT_APP_ID|Missing WECHAT_APP_SECRET/.test(redacted)) {
    return new PublishError("E_CREDENTIALS_MISSING", "WeChat API credentials are missing", {
      kind: "auth",
      details,
    });
  }
  if (/Access token error|Failed to fetch access token/.test(redacted)) {
    return new PublishError("E_WECHAT_AUTH", "WeChat access-token request failed", {
      kind: "auth",
      details,
    });
  }
  if (/Upload failed|Failed to upload/.test(redacted)) {
    return new PublishError("E_WECHAT_UPLOAD", "One or more WeChat image uploads failed", {
      kind: "transient",
      retryable: false,
      outcome: "partial",
      details,
    });
  }
  if (/Publish failed/.test(redacted)) {
    return new PublishError("E_WECHAT_DRAFT", "WeChat rejected the draft request", {
      kind: "provider_rejected",
      details,
    });
  }
  if (/Markdown placeholder render failed/.test(redacted)) {
    return new PublishError("E_BAOYU_RENDER", "Baoyu failed to render the article", {
      kind: "validation",
      details,
    });
  }
  if (/File not found|No title found|No cover image|newspic requires/.test(redacted)) {
    return new PublishError("E_BAOYU_INPUT", "Baoyu rejected the article input", {
      kind: "validation",
      details,
    });
  }
  return new PublishError("E_BAOYU_CHILD", "Baoyu subprocess failed", {
    kind: "outcome_unknown",
    outcome: "unknown",
    retryable: false,
    details,
  });
}

export const defaultBaoyuCommandRunner: BaoyuCommandRunner = async (request) => {
  let processHandle: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    processHandle = Bun.spawn(request.argv, {
      cwd: request.cwd,
      detached: true,
      env: request.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new PublishError("E_BAOYU_SPAWN", "Cannot start Baoyu subprocess", {
      kind: "precondition",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }

  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const killProcessGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-processHandle.pid, signal);
    } catch {
      try {
        processHandle.kill(signal);
      } catch {
        // The process already exited.
      }
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessGroup("SIGTERM");
    forceKill = setTimeout(() => killProcessGroup("SIGKILL"), 2_000);
  }, request.timeoutMs);

  const stdoutPromise = new Response(processHandle.stdout).text();
  const stderrPromise = new Response(processHandle.stderr).text();
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    stdoutPromise,
    stderrPromise,
  ]).finally(() => {
    clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
  });

  if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES) {
    throw new PublishError("E_BAOYU_PROTOCOL", "Baoyu stdout exceeded the contract limit", {
      kind: "provider_rejected",
    });
  }

  return { exitCode, stdout, stderr, timedOut };
};

function parseJsonObject(stdout: string, label: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new PublishError("E_BAOYU_PROTOCOL", `${label} produced empty stdout`, {
      kind: "provider_rejected",
    });
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new PublishError("E_BAOYU_PROTOCOL", `${label} stdout is not one JSON object`, {
      kind: "provider_rejected",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

function parseDryRun(stdout: string): BaoyuDryRunPayload {
  const parsed = parseJsonObject(stdout, "Baoyu dry-run");
  if (typeof parsed.articleType !== "string"
    || typeof parsed.title !== "string"
    || typeof parsed.contentLength !== "number") {
    throw new PublishError("E_BAOYU_PROTOCOL", "Baoyu dry-run JSON has an unsupported schema", {
      kind: "provider_rejected",
    });
  }
  return {
    articleType: parsed.articleType,
    title: parsed.title,
    author: typeof parsed.author === "string" ? parsed.author : undefined,
    digest: typeof parsed.digest === "string" ? parsed.digest : undefined,
    contentLength: parsed.contentLength,
    placeholderImageCount: typeof parsed.placeholderImageCount === "number" ? parsed.placeholderImageCount : undefined,
    account: typeof parsed.account === "string" ? parsed.account : undefined,
  };
}

function parseDraft(stdout: string): { mediaId: string; title: string; articleType: string } {
  const parsed = parseJsonObject(stdout, "Baoyu create-draft");
  if (parsed.success !== true || typeof parsed.media_id !== "string" || !parsed.media_id.trim()) {
    throw new PublishError("E_BAOYU_PROTOCOL", "Baoyu create-draft JSON is missing a non-empty media_id", {
      kind: "provider_rejected",
      outcome: "unknown",
    });
  }
  return {
    mediaId: parsed.media_id,
    title: typeof parsed.title === "string" ? parsed.title : "",
    articleType: typeof parsed.articleType === "string" ? parsed.articleType : "news",
  };
}

async function normalizeRequest(request: BaoyuDraftRequest): Promise<NormalizedBaoyuDraftRequest> {
  if (!request.account.trim()) {
    throw new PublishError("E_ACCOUNT_REQUIRED", "An explicit WeChat account alias is required", {
      kind: "precondition",
    });
  }
  if (!request.title.trim()) throw new PublishError("E_TITLE_REQUIRED", "WeChat title is required");

  const repoRoot = path.resolve(request.repoRoot);
  const artifactRoot = path.resolve(request.artifactRoot);
  const inputPath = await assertRealPathWithin(artifactRoot, path.resolve(request.inputPath), "WeChat HTML");
  if (path.extname(inputPath).toLowerCase() !== ".html") {
    throw new PublishError("E_WECHAT_HTML_REQUIRED", "Baoyu wrapper only accepts frozen HTML candidates");
  }

  let coverPath: string | undefined;
  if (request.coverPath) {
    coverPath = await assertRealPathWithin(artifactRoot, path.resolve(request.coverPath), "WeChat cover");
  }
  if (request.operation !== "dry-run" && !coverPath) {
    throw new PublishError("E_COVER_REQUIRED", "A frozen cover image is required for WeChat preflight/create-draft");
  }

  const journalDir = path.resolve(request.journalDir ?? path.join(repoRoot, ".publish", "receipts", "baoyu-drafts"));
  if (!isWithin(repoRoot, journalDir)) {
    throw new PublishError("E_PATH_ESCAPE", "Baoyu draft journal must stay inside the repository", {
      kind: "precondition",
      details: { repoRoot, journalDir },
    });
  }
  const timeoutMs = request.timeoutMs ?? 300_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PublishError("E_TIMEOUT", "timeoutMs must be a positive finite number");
  }

  return {
    ...request,
    repoRoot,
    artifactRoot,
    inputPath,
    coverPath,
    title: request.title.trim(),
    account: request.account.trim(),
    theme: request.theme?.trim() || "default",
    cite: request.cite ?? true,
    journalDir,
    timeoutMs,
  };
}

function commonBaoyuArgs(request: NormalizedBaoyuDraftRequest): string[] {
  const args = [request.inputPath, "--theme", request.theme, "--title", request.title];
  if (request.author) args.push("--author", request.author);
  if (request.summary) args.push("--summary", request.summary);
  if (request.coverPath) args.push("--cover", request.coverPath);
  args.push("--account", request.account);
  if (request.color) args.push("--color", request.color);
  if (!request.cite) args.push("--no-cite");
  return args;
}

async function digestArtifactTree(root: string): Promise<string> {
  const entries: Array<{ path: string; sha256: string; bytes: number }> = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new PublishError("E_CANDIDATE_SYMLINK", `Frozen WeChat artifact contains a symlink: ${relative}`, {
          kind: "conflict",
        });
      }
      if (info.isDirectory()) {
        await visit(absolute, relative);
      } else if (info.isFile()) {
        const bytes = await readFile(absolute);
        entries.push({ path: relative, sha256: sha256Bytes(bytes), bytes: bytes.byteLength });
      } else {
        throw new PublishError("E_CANDIDATE_FILE", `Unsupported frozen WeChat artifact: ${relative}`, {
          kind: "conflict",
        });
      }
    }
  }
  await visit(root, "");
  return digestCanonical(entries.sort((left, right) => left.path.localeCompare(right.path)));
}

async function draftFingerprint(
  request: NormalizedBaoyuDraftRequest,
  toolchain: ResolvedBaoyuToolchain,
  accountIdentityDigest?: string,
): Promise<DraftFingerprint> {
  const inputDigest = sha256Bytes(await readFile(request.inputPath));
  const coverDigest = request.coverPath ? sha256Bytes(await readFile(request.coverPath)) : undefined;
  const artifactDigest = await digestArtifactTree(request.artifactRoot);
  const fingerprint = digestCanonical({
    endpoint: "wechat-draft-baoyu",
    inputDigest,
    coverDigest,
    artifactDigest,
    account: request.account,
    accountIdentityDigest,
    title: request.title,
    author: request.author,
    summary: request.summary,
    theme: request.theme,
    color: request.color,
    cite: request.cite,
    skillVersion: toolchain.skillVersion,
    verifiedFiles: toolchain.verifiedFiles,
  });
  return {
    fingerprint,
    confirmationToken: digestCanonical({ scope: "wechat-draft-baoyu:create-draft", fingerprint }),
    inputDigest,
    coverDigest,
    artifactDigest,
  };
}

async function runDryRun(
  request: NormalizedBaoyuDraftRequest,
  toolchain: ResolvedBaoyuToolchain,
  runner: BaoyuCommandRunner,
  env: Record<string, string>,
): Promise<{ payload: BaoyuDryRunPayload; diagnostics: string[] }> {
  const result = await runner({
    argv: baoyuCommand(toolchain, [...commonBaoyuArgs(request), "--dry-run"]),
    cwd: request.repoRoot,
    env,
    timeoutMs: Math.min(request.timeoutMs, 60_000),
  });
  if (result.timedOut) {
    const error = classifyBaoyuFailure(result.stderr, true);
    throw new PublishError("E_BAOYU_DRY_RUN_TIMEOUT", "Baoyu dry-run timed out", {
      kind: "transient",
      retryable: false,
      outcome: "not_applied",
      details: error.data.details,
    });
  }
  if (result.exitCode !== 0) throw classifyBaoyuFailure(result.stderr);
  const payload = parseDryRun(result.stdout);
  if (payload.account !== request.account) {
    throw new PublishError("E_ACCOUNT_MISMATCH", "Baoyu dry-run did not resolve the requested account", {
      kind: "precondition",
      details: { requested: request.account, resolved: payload.account },
    });
  }
  return { payload, diagnostics: diagnosticsFrom(result.stderr) };
}

async function defaultCredentialProbe(
  toolchain: ResolvedBaoyuToolchain,
  request: BaoyuDraftRequest,
  runner: BaoyuCommandRunner,
  env: Record<string, string>,
): Promise<BaoyuCredentialProbeResult> {
  const probeScript = fileURLToPath(new URL("./baoyu-credentials-probe.ts", import.meta.url));
  const args = [
    ...toolchain.runtime.argsPrefix,
    probeScript,
    "--config-module",
    toolchain.configModulePath,
    "--account",
    request.account,
  ];
  if (request.allowUnprefixedCredentials) args.push("--allow-unprefixed-credentials");
  const result = await runner({
    argv: [toolchain.runtime.command, ...args],
    cwd: request.repoRoot,
    env,
    timeoutMs: Math.min(request.timeoutMs ?? 300_000, 30_000),
  });
  if (result.timedOut || result.exitCode !== 0) throw classifyBaoyuFailure(result.stderr, result.timedOut);
  const parsed = parseJsonObject(result.stdout, "Baoyu credential probe") as unknown as BaoyuCredentialProbeResult;
  if (
    parsed.schemaVersion !== 1
    || parsed.account?.alias !== request.account
    || !parsed.credentials?.source
    || !/^sha256:[a-f0-9]{64}$/u.test(parsed.credentials.accountIdentityDigest ?? "")
  ) {
    throw new PublishError("E_CREDENTIAL_PROBE_PROTOCOL", "Baoyu credential probe returned an invalid result", {
      kind: "precondition",
    });
  }
  return parsed;
}

async function acquireJournalLock(journalDir: string, fingerprint: string): Promise<{
  journalPath: string;
  release(): Promise<void>;
}> {
  await mkdir(journalDir, { recursive: true });
  const key = fingerprint.replace(/^sha256:/, "");
  const journalPath = path.join(journalDir, `${key}.json`);
  const lockPath = path.join(journalDir, `${key}.lock`);
  try {
    await mkdir(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new PublishError("E_DRAFT_IN_PROGRESS", "The same WeChat draft fingerprint is already running", {
        kind: "conflict",
      });
    }
    throw error;
  }
  return {
    journalPath,
    release: () => rm(lockPath, { recursive: true, force: true }),
  };
}

async function assertNoDuplicate(journalPath: string): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(journalPath, "utf8")) as DraftJournal;
    throw new PublishError("E_DUPLICATE_DRAFT", "This exact WeChat draft candidate already has a terminal journal", {
      kind: "conflict",
      outcome: existing.state === "outcome_unknown" ? "unknown" : "applied",
      details: { journalPath, state: existing.state, mediaId: existing.mediaId },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function writeJournal(journalPath: string, journal: DraftJournal): Promise<void> {
  const temporary = `${journalPath}.${process.pid}.tmp`;
  await writeFile(temporary, canonicalJson(journal), { mode: 0o600 });
  await rename(temporary, journalPath);
}

function baseResult(
  request: NormalizedBaoyuDraftRequest,
  toolchain: ResolvedBaoyuToolchain,
  fingerprint: DraftFingerprint,
): Pick<BaoyuDraftResult, "contractVersion" | "operation" | "account" | "fingerprint" | "confirmationToken" | "toolchain"> {
  return {
    contractVersion: 1,
    operation: request.operation,
    account: request.account,
    fingerprint: fingerprint.fingerprint,
    confirmationToken: fingerprint.confirmationToken,
    toolchain: {
      skillDir: toolchain.skillDir,
      version: toolchain.skillVersion,
      runtime: toolchain.runtime.kind,
    },
  };
}

export async function runBaoyuDraft(
  input: BaoyuDraftRequest,
  dependencies: BaoyuDraftDependencies = {},
): Promise<BaoyuDraftResult> {
  const request = await normalizeRequest(input);
  const env = cleanEnvironment(request.env);
  const resolver = dependencies.resolveToolchain ?? resolveBaoyuToolchain;
  const runner = dependencies.commandRunner ?? defaultBaoyuCommandRunner;
  const credentialProbe = dependencies.credentialProbe ?? defaultCredentialProbe;
  const toolchain = await resolver({
    repoRoot: request.repoRoot,
    explicitDir: request.skillDir,
    lockPath: request.lockPath,
    lock: request.lock,
    env,
    allowNpxBootstrap: request.allowNpxBootstrap,
  });
  if (request.operation === "dry-run") {
    const fingerprint = await draftFingerprint(request, toolchain);
    const base = baseResult(request, toolchain, fingerprint);
    const dryRun = await runDryRun(request, toolchain, runner, env);
    return {
      ...base,
      ok: true,
      state: "dry_run",
      dryRun: dryRun.payload,
      sideEffect: "none",
      diagnostics: dryRun.diagnostics,
    };
  }

  const credentials = await credentialProbe(toolchain, request, runner, env);
  const accountIdentityDigest = credentials.credentials.accountIdentityDigest;
  if (!/^sha256:[a-f0-9]{64}$/u.test(accountIdentityDigest)) {
    throw new PublishError("E_CREDENTIAL_PROBE_PROTOCOL", "Credential probe did not bind the WeChat AppID", {
      kind: "precondition",
    });
  }
  const fingerprint = await draftFingerprint(request, toolchain, accountIdentityDigest);
  const base = baseResult(request, toolchain, fingerprint);

  if (request.operation === "preflight") {
    const dryRun = await runDryRun(request, toolchain, runner, env);
    return {
      ...base,
      ok: true,
      state: "preflighted",
      credentials: credentials.credentials,
      dryRun: dryRun.payload,
      sideEffect: "none",
      diagnostics: dryRun.diagnostics,
    };
  }

  if (!request.confirmationToken || !secureEqual(request.confirmationToken, fingerprint.confirmationToken)) {
    throw new PublishError("E_CONFIRMATION", "create-draft requires the exact confirmation token from preflight", {
      kind: "precondition",
    });
  }

  const lock = await acquireJournalLock(request.journalDir, fingerprint.fingerprint);
  let releaseJournalLock = true;
  const persistJournal = async (
    journal: DraftJournal,
    outcome: "applied" | "partial" | "unknown",
  ): Promise<void> => {
    try {
      await writeJournal(lock.journalPath, journal);
    } catch (error) {
      // Keep the lock directory as a durable duplicate blocker when the remote
      // side effect may have happened but its journal could not be persisted.
      releaseJournalLock = false;
      throw new PublishError("E_DRAFT_JOURNAL", "Cannot persist WeChat draft journal after a possible side effect", {
        kind: outcome === "unknown" ? "outcome_unknown" : "conflict",
        outcome,
        retryable: false,
        details: {
          journalPath: lock.journalPath,
          cause: error instanceof Error ? error.message : String(error),
          action: "inspect_wechat_drafts_and_remove_stale_lock_manually",
        },
      });
    }
  };
  try {
    await assertNoDuplicate(lock.journalPath);
    const dryRun = await runDryRun(request, toolchain, runner, env);

    const credentialsBeforePublish = await credentialProbe(toolchain, request, runner, env);
    if (credentialsBeforePublish.credentials.accountIdentityDigest !== accountIdentityDigest) {
      throw new PublishError("E_WECHAT_ACCOUNT_CHANGED", "The WeChat AppID changed after confirmation", {
        kind: "conflict",
      });
    }
    const beforePublish = await draftFingerprint(request, toolchain, accountIdentityDigest);
    if (beforePublish.fingerprint !== fingerprint.fingerprint) {
      throw new PublishError("E_CANDIDATE_CHANGED", "Frozen WeChat candidate changed after dry-run", {
        kind: "conflict",
      });
    }

    const real = await runner({
      argv: baoyuCommand(toolchain, commonBaoyuArgs(request)),
      cwd: request.repoRoot,
      env,
      timeoutMs: request.timeoutMs,
    });
    const diagnostics = [...dryRun.diagnostics, ...diagnosticsFrom(real.stderr)];

    if (real.timedOut) {
      const error = classifyBaoyuFailure(real.stderr, true);
      await persistJournal({
        schemaVersion: 1,
        fingerprint: fingerprint.fingerprint,
        account: request.account,
        state: "outcome_unknown",
        inputDigest: fingerprint.inputDigest,
        createdAt: (dependencies.now ?? (() => new Date().toISOString()))(),
      }, "unknown");
      return {
        ...base,
        ok: false,
        state: "outcome_unknown",
        credentials: credentials.credentials,
        dryRun: dryRun.payload,
        sideEffect: "unknown",
        diagnostics,
        error: error.data,
      };
    }
    if (real.exitCode !== 0) {
      const error = classifyBaoyuFailure(real.stderr);
      if (error.data.outcome !== "unknown") throw error;
      await persistJournal({
        schemaVersion: 1,
        fingerprint: fingerprint.fingerprint,
        account: request.account,
        state: "outcome_unknown",
        inputDigest: fingerprint.inputDigest,
        createdAt: (dependencies.now ?? (() => new Date().toISOString()))(),
      }, "unknown");
      return {
        ...base,
        ok: false,
        state: "outcome_unknown",
        credentials: credentials.credentials,
        dryRun: dryRun.payload,
        sideEffect: "unknown",
        diagnostics,
        error: error.data,
      };
    }

    let draft: ReturnType<typeof parseDraft>;
    try {
      draft = parseDraft(real.stdout);
    } catch (error) {
      const protocolError = asPublishError(error);
      await persistJournal({
        schemaVersion: 1,
        fingerprint: fingerprint.fingerprint,
        account: request.account,
        state: "outcome_unknown",
        inputDigest: fingerprint.inputDigest,
        createdAt: (dependencies.now ?? (() => new Date().toISOString()))(),
      }, "unknown");
      return {
        ...base,
        ok: false,
        state: "outcome_unknown",
        credentials: credentials.credentials,
        dryRun: dryRun.payload,
        sideEffect: "unknown",
        diagnostics,
        error: protocolError.data,
      };
    }
    if (hasImageUploadFailure(real.stderr)) {
      const error = new PublishError(
        "E_DRAFT_CONTENT_PARTIAL",
        "Draft was created, but one or more body images failed to upload",
        {
          kind: "transient",
          retryable: false,
          outcome: "partial",
          details: { mediaId: draft.mediaId, action: "inspect_or_delete_draft_do_not_retry" },
        },
      );
      await persistJournal({
        schemaVersion: 1,
        fingerprint: fingerprint.fingerprint,
        account: request.account,
        state: "partial",
        mediaId: draft.mediaId,
        inputDigest: fingerprint.inputDigest,
        createdAt: (dependencies.now ?? (() => new Date().toISOString()))(),
      }, "partial");
      return {
        ...base,
        ok: false,
        state: "partial",
        credentials: credentials.credentials,
        dryRun: dryRun.payload,
        mediaId: draft.mediaId,
        sideEffect: "draft_created",
        diagnostics,
        error: error.data,
      };
    }

    await persistJournal({
      schemaVersion: 1,
      fingerprint: fingerprint.fingerprint,
      account: request.account,
      state: "draft_created",
      mediaId: draft.mediaId,
      inputDigest: fingerprint.inputDigest,
      createdAt: (dependencies.now ?? (() => new Date().toISOString()))(),
    }, "applied");
    return {
      ...base,
      ok: true,
      state: "draft_created",
      credentials: credentials.credentials,
      dryRun: dryRun.payload,
      mediaId: draft.mediaId,
      sideEffect: "draft_created",
      diagnostics,
    };
  } finally {
    if (releaseJournalLock) await lock.release();
  }
}

function parseCli(argv: string[]): BaoyuDraftRequest {
  const operation = argv[0] as BaoyuDraftOperation | undefined;
  if (!operation || !["preflight", "dry-run", "create-draft"].includes(operation)) {
    throw new PublishError("E_USAGE", "First argument must be preflight, dry-run, or create-draft");
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;
    if (["--no-cite", "--allow-npx-bootstrap", "--allow-unprefixed-credentials"].includes(arg)) {
      flags.add(arg);
    } else if (argv[index + 1]) {
      values.set(arg, argv[index + 1]!);
      index += 1;
    }
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new PublishError("E_USAGE", `Missing required argument: ${name}`);
    return value;
  };
  return {
    operation,
    repoRoot: required("--repo-root"),
    artifactRoot: required("--artifact-root"),
    inputPath: required("--input"),
    coverPath: values.get("--cover"),
    title: required("--title"),
    author: values.get("--author"),
    summary: values.get("--summary"),
    account: required("--account"),
    theme: values.get("--theme"),
    color: values.get("--color"),
    cite: !flags.has("--no-cite"),
    confirmationToken: values.get("--confirmation"),
    journalDir: values.get("--journal-dir"),
    timeoutMs: values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : undefined,
    skillDir: values.get("--skill-dir"),
    lockPath: values.get("--lock"),
    allowNpxBootstrap: flags.has("--allow-npx-bootstrap"),
    allowUnprefixedCredentials: flags.has("--allow-unprefixed-credentials"),
  };
}

if (import.meta.main) {
  let operation: BaoyuDraftOperation = "dry-run";
  try {
    const request = parseCli(process.argv.slice(2));
    operation = request.operation;
    const result = await runBaoyuDraft(request);
    process.stdout.write(canonicalJson(result));
    for (const line of result.diagnostics) process.stderr.write(`${CHILD_MARKER} ${line}\n`);
    if (!result.ok && result.error) {
      process.stderr.write(`${ERROR_MARKER} ${canonicalJson(result.error)}`);
      process.exitCode = result.state === "partial" ? 2 : 3;
    }
  } catch (error) {
    const publishError = asPublishError(error);
    process.stdout.write(canonicalJson({
      contractVersion: 1,
      ok: false,
      operation,
      state: publishError.data.outcome === "unknown" ? "outcome_unknown" : "failed",
      error: publishError.data,
    }));
    process.stderr.write(`${ERROR_MARKER} ${canonicalJson(publishError.data)}`);
    process.exitCode = 1;
  }
}
