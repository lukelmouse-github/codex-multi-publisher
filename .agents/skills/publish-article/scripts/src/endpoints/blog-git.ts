import path from "node:path";
import {
  cp,
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { digestCanonical, sha256Bytes } from "../canonical-json";
import { PublishError } from "../errors";
import { hugoSectionFromContentRoot } from "../render-hugo";
import {
  assertPathWithinNoSymlinks,
  assertRealPathWithin,
  assertSafeRelative,
  ensureDirectoryWithin,
  isWithin,
} from "../path-policy";
import { readReceipt, verifyConfirmationToken, writeReceiptAtomic } from "../receipts";
import type {
  ArticlePackage,
  EndpointContext,
  PreparedPublication,
  PublishErrorData,
  PublisherEndpoint,
  PublishReceipt,
} from "../types";

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface BlogOptions {
  branch: string;
  remote: string;
  contentRoot: string;
  candidateBundleRoot?: string;
  commitMessage: string;
  confirmationSecret?: string;
}

interface TreeEntry {
  path: string;
  sha256: string;
  bytes: number;
  mode: "100644" | "100755";
}

interface GitSnapshot {
  ok: true;
  branch: string;
  upstream: string;
  head: string;
  upstreamHead: string;
  remoteHead: string;
  remote: string;
  remoteUrlDigest: string;
  target: string;
  stagedManagedPaths: string[];
}

export interface PreparedBlogPublication extends PreparedPublication {
  baselineDigest: string;
  renderDigest: string;
  blog: {
    target: string;
    targetBaselineDigest: string;
    baseHead: string;
    upstreamHead: string;
    remoteHead: string;
    remoteUrlDigest: string;
  };
}

const ENDPOINT_ID = "blog-git";

async function runGit(
  repoRoot: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sshCommand = Bun.which("ssh") ? "ssh -oBatchMode=yes" : undefined;
  const child = Bun.spawn(["git", ...args], {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      SSH_ASKPASS_REQUIRE: "never",
      ...(sshCommand ? { GIT_SSH_COMMAND: sshCommand } : {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const killProcessGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The process already exited.
      }
    }
  };
  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessGroup("SIGTERM");
    forceKill = setTimeout(() => killProcessGroup("SIGKILL"), 2_000);
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  if (forceKill) clearTimeout(forceKill);
  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: timedOut ? `${stderr.trim()}\nGit command timed out after ${timeoutMs}ms`.trim() : stderr.trim(),
    timedOut,
  };
}

async function requireGit(repoRoot: string, args: string[], code: string): Promise<string> {
  const result = await runGit(repoRoot, args);
  if (result.exitCode !== 0) {
    throw new PublishError(code, result.stderr || result.stdout || `git ${args[0]} failed`, {
      kind: "precondition",
    });
  }
  return result.stdout;
}

async function readGitBlob(repoRoot: string, objectId: string): Promise<Buffer> {
  if (!/^[a-f0-9]{40,64}$/u.test(objectId)) {
    throw new PublishError("E_GIT_OBJECT", "Git returned an invalid object id", { kind: "conflict" });
  }
  const child = Bun.spawn(["git", "cat-file", "blob", objectId], {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const killProcessGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The process already exited.
      }
    }
  };
  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessGroup("SIGTERM");
    forceKill = setTimeout(() => killProcessGroup("SIGKILL"), 2_000);
  }, 30_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => {
    clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
  });
  if (timedOut || exitCode !== 0) {
    throw new PublishError("E_GIT_OBJECT", timedOut ? "Reading Git blob timed out" : stderr.trim() || "Cannot read Git blob", {
      kind: timedOut ? "outcome_unknown" : "conflict",
      outcome: timedOut ? "unknown" : "not_applied",
    });
  }
  return Buffer.from(stdout);
}

async function resolvePushDestination(
  repoRoot: string,
  remote: string,
): Promise<{ url: string; digest: string }> {
  const urls = (await requireGit(
    repoRoot,
    ["remote", "get-url", "--push", "--all", remote],
    "E_GIT_REMOTE",
  )).split(/\r?\n/u).filter(Boolean);
  if (urls.length !== 1) {
    throw new PublishError(
      "E_GIT_PUSH_DESTINATION",
      `Blog publishing requires exactly one push URL for remote ${remote}`,
      { kind: "precondition", details: { remote, count: urls.length } },
    );
  }
  return { url: urls[0]!, digest: digestCanonical(urls) };
}

async function observeRemoteBranch(
  repoRoot: string,
  remote: string,
  branch: string,
): Promise<{ queryOk: boolean; sha?: string; error?: string }> {
  const ref = `refs/heads/${branch}`;
  const result = await runGit(repoRoot, ["ls-remote", "--heads", remote, ref]);
  if (result.exitCode !== 0) return { queryOk: false, error: result.stderr || result.stdout };
  const sha = result.stdout.split(/\s+/u)[0];
  return { queryOk: true, sha: /^[a-f0-9]{40}$/u.test(sha ?? "") ? sha : undefined };
}

function readOptions(context: EndpointContext, article: ArticlePackage): BlogOptions {
  const raw = context.options;
  const branch = typeof raw.branch === "string" ? raw.branch : "main";
  const remote = typeof raw.remote === "string" ? raw.remote : "origin";
  const contentRoot = typeof raw.contentRoot === "string" ? raw.contentRoot : "content/posts";
  const candidateBundleRoot = typeof raw.candidateBundleRoot === "string" ? raw.candidateBundleRoot : undefined;
  const commitMessage = typeof raw.commitMessage === "string"
    ? raw.commitMessage
    : `content: publish ${article.metadata.slug}`;
  const confirmationSecret = typeof raw.confirmationSecret === "string" ? raw.confirmationSecret : undefined;
  for (const [label, value] of [["branch", branch], ["remote", remote]] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) || value.includes("..") || value.includes("//")) {
      throw new PublishError("E_GIT_NAME", `Unsafe Git ${label}: ${value}`);
    }
  }
  return { branch, remote, contentRoot, candidateBundleRoot, commitMessage, confirmationSecret };
}

function normalizeRelative(value: string, label: string): string {
  return assertSafeRelative(value.replaceAll("\\", "/"), label);
}

function targetRelative(options: BlogOptions, article: ArticlePackage): string {
  const root = normalizeRelative(options.contentRoot, "blog content root");
  hugoSectionFromContentRoot(root);
  const slug = normalizeRelative(article.metadata.slug, "article slug");
  if (slug.includes("/")) throw new PublishError("E_SLUG", "Article slug must be a single path segment");
  return `${root}/${slug}`;
}

function blogOptionsDigest(options: BlogOptions, article: ArticlePackage, remoteUrlDigest: string): string {
  return digestCanonical({
    branch: options.branch,
    remote: options.remote,
    target: targetRelative(options, article),
    commitMessage: options.commitMessage,
    remoteUrlDigest,
  });
}

function blogBaselineDigest(
  targetBaselineDigest: string,
  snapshot: Pick<GitSnapshot, "head" | "upstreamHead" | "remoteHead" | "remoteUrlDigest">,
): string {
  return digestCanonical({
    targetBaselineDigest,
    head: snapshot.head,
    upstreamHead: snapshot.upstreamHead,
    remoteHead: snapshot.remoteHead,
    remoteUrlDigest: snapshot.remoteUrlDigest,
  });
}

function assertPreparedBlog(input: PreparedPublication): PreparedBlogPublication {
  const prepared = input as PreparedBlogPublication;
  const blog = prepared.blog;
  if (
    prepared.endpoint !== ENDPOINT_ID
    || !blog
    || typeof blog.target !== "string"
    || typeof blog.targetBaselineDigest !== "string"
    || typeof blog.baseHead !== "string"
    || typeof blog.upstreamHead !== "string"
    || typeof blog.remoteHead !== "string"
    || typeof blog.remoteUrlDigest !== "string"
    || typeof prepared.baselineDigest !== "string"
    || typeof prepared.renderDigest !== "string"
  ) {
    throw new PublishError("E_BLOG_PLAN", "Prepared Blog plan is incomplete or belongs to another endpoint");
  }
  const planCore = {
    schemaVersion: prepared.schemaVersion,
    endpoint: prepared.endpoint,
    articleId: prepared.articleId,
    packageRevision: prepared.packageRevision,
    optionsDigest: prepared.optionsDigest,
    baselineDigest: prepared.baselineDigest,
    renderDigest: prepared.renderDigest,
    actions: prepared.actions,
    blog,
  };
  if (digestCanonical(planCore) !== prepared.planDigest) {
    throw new PublishError("E_BLOG_PLAN", "Prepared Blog plan fields do not match planDigest", { kind: "conflict" });
  }
  return prepared;
}

async function acquirePublishLock(context: EndpointContext): Promise<() => Promise<void>> {
  const repoRoot = await realpath(path.resolve(context.repoRoot));
  const locksRoot = await ensureDirectoryWithin(repoRoot, path.join(repoRoot, ".publish", "locks"), "publication locks");
  const lockPath = path.join(locksRoot, `${ENDPOINT_ID}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(
          path.join(lockPath, "owner.json"),
          JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
          { mode: 0o600 },
        );
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let ownerPid: number | undefined;
      let ownerRecordValid = false;
      try {
        const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as {
          pid?: unknown;
          startedAt?: unknown;
        };
        if (
          typeof owner.pid === "number"
          && Number.isSafeInteger(owner.pid)
          && owner.pid > 0
          && typeof owner.startedAt === "number"
          && Number.isFinite(owner.startedAt)
        ) {
          ownerPid = owner.pid;
          ownerRecordValid = true;
        }
      } catch {
        // The age check below distinguishes an in-progress owner write from a stale crash artifact.
      }
      let active = false;
      if (ownerPid !== undefined) {
        try {
          process.kill(ownerPid, 0);
          active = true;
        } catch (probeError) {
          active = (probeError as NodeJS.ErrnoException).code !== "ESRCH";
        }
      } else if (!ownerRecordValid) {
        const info = await lstat(lockPath);
        active = Date.now() - info.mtimeMs < 30_000;
      }
      if (!active && attempt === 0) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      throw new PublishError("E_BLOG_IN_PROGRESS", "The Blog publication plan is already running", { kind: "conflict" });
    }
  }
  throw new PublishError("E_BLOG_IN_PROGRESS", "The Blog publication plan is already running", { kind: "conflict" });
}

function isManagedGitPath(candidate: string, target: string): boolean {
  const normalized = candidate.replaceAll("\\", "/");
  return normalized === target || normalized.startsWith(`${target}/`);
}

async function collectTree(root: string): Promise<TreeEntry[] | undefined> {
  const rootStat = await lstat(root).catch(() => undefined);
  if (!rootStat) return undefined;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new PublishError("E_BLOG_TREE", `Expected a real directory: ${root}`);
  }

  const entries: TreeEntry[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new PublishError("E_BLOG_SYMLINK", `Symlinks are not allowed in a managed bundle: ${relative}`);
      }
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        const info = await lstat(absolute);
        const bytes = await readFile(absolute);
        entries.push({
          path: relative,
          sha256: sha256Bytes(bytes),
          bytes: bytes.byteLength,
          mode: info.mode & 0o111 ? "100755" : "100644",
        });
      } else {
        throw new PublishError("E_BLOG_FILE", `Unsupported filesystem entry: ${relative}`);
      }
    }
  }
  await visit(root, "");
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function digestDirectory(root: string): Promise<string> {
  const entries = await collectTree(root);
  return entries ? digestCanonical({ state: "present", entries }) : digestCanonical({ state: "absent" });
}

function replacementArtifactPaths(target: string, operationId: string): { incoming: string; backup: string } {
  if (!/^sha256:[a-f0-9]{64}$/u.test(operationId)) {
    throw new PublishError("E_BLOG_PLAN", "Blog replacement requires a canonical plan digest", { kind: "conflict" });
  }
  const key = operationId.slice(-24);
  const parent = path.dirname(target);
  return {
    incoming: path.join(parent, `.publish-article-${key}.incoming`),
    backup: path.join(parent, `.publish-article-${key}.backup`),
  };
}

async function atomicReplaceDirectory(
  repoRoot: string,
  source: string,
  target: string,
  expectedDigest: string,
  operationId: string,
): Promise<void> {
  const parent = path.dirname(target);
  await ensureDirectoryWithin(repoRoot, parent, "Blog target parent");
  const { incoming, backup } = replacementArtifactPaths(target, operationId);
  const assertDirectory = async (candidate: string, label: string) => {
    const info = await lstat(candidate).catch(() => undefined);
    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      throw new PublishError("E_BLOG_TARGET", `${label} is not a real directory: ${candidate}`, {
        kind: "conflict",
      });
    }
    return info;
  };

  let existing = await assertDirectory(target, "Managed Blog target");
  let incomingInfo = await assertDirectory(incoming, "Blog replacement candidate");
  const backupInfo = await assertDirectory(backup, "Blog replacement backup");
  if (incomingInfo && await digestDirectory(incoming) !== expectedDigest) {
    await rm(incoming, { recursive: true, force: true });
    incomingInfo = undefined;
  }

  if (backupInfo) {
    if (existing) {
      if (await digestDirectory(target) === expectedDigest) {
        await rm(incoming, { recursive: true, force: true });
        await rm(backup, { recursive: true, force: true });
        return;
      }
      throw new PublishError("E_BLOG_REPLACEMENT_CONFLICT", "A prior Blog replacement backup conflicts with the current target", {
        kind: "conflict",
      });
    }
    if (incomingInfo) {
      await rename(incoming, target);
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    await rename(backup, target);
    existing = await assertDirectory(target, "Recovered Blog target");
  }

  if (existing && await digestDirectory(target) === expectedDigest) {
    await rm(incoming, { recursive: true, force: true });
    return;
  }
  if (!incomingInfo) {
    await cp(source, incoming, { recursive: true, errorOnExist: true, force: false });
    const incomingDigest = await digestDirectory(incoming);
    if (incomingDigest !== expectedDigest) {
      await rm(incoming, { recursive: true, force: true });
      throw new PublishError("E_BLOG_COPY_CHANGED", "Candidate bytes changed while copying into the worktree", {
        kind: "conflict",
      });
    }
    incomingInfo = await assertDirectory(incoming, "Blog replacement candidate");
  }
  let movedExisting = false;
  let installed = false;
  try {
    if (existing) {
      await rename(target, backup);
      movedExisting = true;
    }
    await rename(incoming, target);
    installed = true;
    if (movedExisting) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  } catch (error) {
    await rm(incoming, { recursive: true, force: true });
    if (movedExisting && !installed) {
      const targetAfterFailure = await lstat(target).catch(() => undefined);
      if (!targetAfterFailure) {
        try {
          await rename(backup, target);
        } catch (restoreError) {
          throw new PublishError("E_BLOG_ROLLBACK", "Blog target replacement failed and rollback could not be proven", {
            kind: "outcome_unknown",
            outcome: "partial",
            details: { cause: restoreError instanceof Error ? restoreError.message : String(restoreError) },
          });
        }
      }
    }
    throw error;
  }
}

async function persistReceipt(context: EndpointContext, receipt: PublishReceipt): Promise<void> {
  await writeReceiptAtomic(path.join(context.runRoot, "receipts", `${ENDPOINT_ID}.json`), receipt);
}

async function digestGitTreeAtCommit(
  repoRoot: string,
  commit: string,
  target: string,
): Promise<string> {
  const listing = await requireGit(
    repoRoot,
    ["ls-tree", "-r", "-z", "--full-tree", commit, "--", target],
    "E_GIT_COMMIT_TREE",
  );
  const entries: TreeEntry[] = [];
  const prefix = `${target}/`;
  for (const record of listing.split("\0").filter(Boolean)) {
    const match = /^(\d{6})\s+(\S+)\s+([a-f0-9]{40,64})\t([\s\S]+)$/u.exec(record);
    if (!match) {
      throw new PublishError("E_GIT_COMMIT_TREE", "Git returned an invalid tree record", { kind: "conflict" });
    }
    const [, mode, type, objectId, fullPath] = match;
    if ((mode !== "100644" && mode !== "100755") || type !== "blob" || !fullPath?.startsWith(prefix)) {
      throw new PublishError("E_GIT_COMMIT_TREE", "Confirmed Blog commit contains a symlink or unsupported entry", {
        kind: "conflict",
        details: { mode, type, path: fullPath },
      });
    }
    const relative = fullPath.slice(prefix.length);
    if (!relative || relative.startsWith("../")) {
      throw new PublishError("E_GIT_COMMIT_TREE", "Confirmed Blog commit escaped the managed target", {
        kind: "conflict",
      });
    }
    const bytes = await readGitBlob(repoRoot, objectId!);
    entries.push({
      path: relative,
      sha256: sha256Bytes(bytes),
      bytes: bytes.byteLength,
      mode,
    });
  }
  if (entries.length === 0) return digestCanonical({ state: "absent" });
  return digestCanonical({
    state: "present",
    entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
  });
}

function makeReceipt(
  prepared: PreparedPublication,
  state: PublishReceipt["state"],
  values: Partial<PublishReceipt> = {},
): PublishReceipt {
  const idempotencyKey = digestCanonical({ endpoint: ENDPOINT_ID, planDigest: prepared.planDigest });
  return {
    schemaVersion: 1,
    receiptId: digestCanonical({ idempotencyKey, state, checkpoint: values.checkpoint ?? null }),
    endpoint: ENDPOINT_ID,
    articleId: prepared.articleId,
    packageRevision: prepared.packageRevision,
    planDigest: prepared.planDigest,
    idempotencyKey,
    state,
    sideEffects: values.sideEffects ?? [],
    checkpoint: values.checkpoint,
    statusLocator: values.statusLocator,
    error: values.error,
  };
}

async function assertCommitScope(
  repoRoot: string,
  commit: string,
  expectedParent: string,
  target: string,
  expectedMessage: string,
  expectedTreeDigest: string,
): Promise<void> {
  const [parentsLine, names, message, treeDigest] = await Promise.all([
    requireGit(repoRoot, ["rev-list", "--parents", "-n", "1", commit], "E_GIT_COMMIT_PARENT"),
    requireGit(repoRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit], "E_GIT_COMMIT_SCOPE"),
    requireGit(repoRoot, ["log", "-1", "--format=%B", commit], "E_GIT_COMMIT_MESSAGE"),
    digestGitTreeAtCommit(repoRoot, commit, target),
  ]);
  const parents = parentsLine.split(/\s+/u).filter(Boolean);
  const paths = names.split("\0").filter(Boolean);
  if (
    parents.length !== 2
    || parents[0] !== commit
    || parents[1] !== expectedParent
    || paths.length === 0
    || paths.some((candidate) => !isManagedGitPath(candidate, target))
    || message.trim() !== expectedMessage.trim()
    || treeDigest !== expectedTreeDigest
  ) {
    throw new PublishError("E_GIT_COMMIT_SCOPE", "Recovered Blog commit is outside the confirmed plan", {
      kind: "conflict",
      details: { commit, parents, paths, expectedTreeDigest, treeDigest },
    });
  }
}

async function updateTrackingRef(
  repoRoot: string,
  remote: string,
  branch: string,
  commit: string,
  expectedOld: string,
): Promise<void> {
  const ref = `refs/remotes/${remote}/${branch}`;
  const current = await requireGit(repoRoot, ["rev-parse", ref], "E_GIT_UPSTREAM");
  if (current === commit) return;
  if (current !== expectedOld) {
    throw new PublishError("E_GIT_UPSTREAM_CHANGED", "The local remote-tracking ref changed during Blog push", {
      kind: "conflict",
      outcome: "applied",
      details: { ref, expectedOld, current, commit },
    });
  }
  await requireGit(repoRoot, ["update-ref", ref, commit, expectedOld], "E_GIT_UPSTREAM_UPDATE");
}

async function settleTrackingRef(
  repoRoot: string,
  remote: string,
  branch: string,
  commit: string,
  expectedOld: string,
): Promise<{ sideEffect?: Record<string, unknown>; error?: PublishErrorData }> {
  try {
    await updateTrackingRef(repoRoot, remote, branch, commit, expectedOld);
    return {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      sideEffect: { type: "git_tracking_ref_update_failed", remote, branch, commit },
      error: {
        code: "E_GIT_UPSTREAM_UPDATE",
        kind: "conflict",
        message: `${message}; remote push is already verified, run git fetch before the next publication`,
        retryable: false,
        outcome: "applied",
      },
    };
  }
}

async function completePush(
  prepared: PreparedBlogPublication,
  options: BlogOptions,
  repoRoot: string,
  context: EndpointContext,
  commit: string,
  sideEffectsInput: Array<Record<string, unknown>>,
): Promise<PublishReceipt> {
  const destination = await resolvePushDestination(repoRoot, options.remote);
  if (destination.digest !== prepared.blog.remoteUrlDigest) {
    throw new PublishError("E_GIT_REMOTE_CHANGED", "The confirmed Blog push URL changed", {
      kind: "conflict",
    });
  }
  const locator = {
    commit,
    remote: options.remote,
    branch: options.branch,
    remoteUrlDigest: prepared.blog.remoteUrlDigest,
  };
  const before = await observeRemoteBranch(repoRoot, destination.url, options.branch);
  if (before.queryOk && before.sha === commit) {
    const tracking = await settleTrackingRef(
      repoRoot,
      options.remote,
      options.branch,
      commit,
      prepared.blog.upstreamHead,
    );
    const pushed = makeReceipt(prepared, "pushed", {
      checkpoint: "push_complete",
      sideEffects: [
        ...sideEffectsInput,
        { type: "git_remote_observed", remote: options.remote, branch: options.branch, commit },
        ...(tracking.sideEffect ? [tracking.sideEffect] : []),
      ],
      statusLocator: locator,
      error: tracking.error,
    });
    await persistReceipt(context, pushed);
    return pushed;
  }

  if (!before.queryOk) {
    const unknown = makeReceipt(prepared, "outcome_unknown", {
      checkpoint: "remote_inspection_required",
      sideEffects: sideEffectsInput,
      statusLocator: locator,
      error: {
        code: "E_GIT_REMOTE_STATUS_UNKNOWN",
        kind: "outcome_unknown",
        message: before.error || "Cannot verify the confirmed Blog push destination",
        retryable: false,
        outcome: "unknown",
      },
    });
    await persistReceipt(context, unknown);
    return unknown;
  }
  if (before.sha !== prepared.blog.remoteHead) {
    const changed = makeReceipt(prepared, "committed", {
      checkpoint: "remote_changed",
      sideEffects: sideEffectsInput,
      statusLocator: locator,
      error: {
        code: "E_GIT_REMOTE_CHANGED",
        kind: "conflict",
        message: "The Blog remote branch changed after confirmation; no push was attempted",
        retryable: false,
        outcome: "not_applied",
        details: { expected: prepared.blog.remoteHead, observed: before.sha },
      },
    });
    await persistReceipt(context, changed);
    return changed;
  }

  const push = await runGit(
    repoRoot,
    [
      "push",
      `--force-with-lease=refs/heads/${options.branch}:${prepared.blog.remoteHead}`,
      destination.url,
      `${commit}:refs/heads/${options.branch}`,
    ],
    { timeoutMs: 120_000 },
  );
  const after = await observeRemoteBranch(repoRoot, destination.url, options.branch);
  if (after.queryOk && after.sha === commit) {
    const tracking = await settleTrackingRef(
      repoRoot,
      options.remote,
      options.branch,
      commit,
      prepared.blog.upstreamHead,
    );
    const pushed = makeReceipt(prepared, "pushed", {
      checkpoint: "push_complete",
      sideEffects: [
        ...sideEffectsInput,
        { type: "git_push", remote: options.remote, branch: options.branch, commit },
        ...(tracking.sideEffect ? [tracking.sideEffect] : []),
      ],
      statusLocator: locator,
      error: tracking.error,
    });
    await persistReceipt(context, pushed);
    return pushed;
  }

  const outcomeUnknown = push.timedOut || !after.queryOk || push.exitCode === 0;
  const remoteChanged = after.queryOk && after.sha !== prepared.blog.remoteHead;
  const error: PublishErrorData = {
    code: outcomeUnknown ? "E_GIT_PUSH_UNKNOWN" : remoteChanged ? "E_GIT_REMOTE_CHANGED" : "E_GIT_PUSH",
    kind: outcomeUnknown ? "outcome_unknown" : remoteChanged ? "conflict" : "transient",
    message: push.stderr || push.stdout || after.error || "Git push failed",
    retryable: !outcomeUnknown && !remoteChanged,
    outcome: outcomeUnknown ? "unknown" : "not_applied",
    details: { commit, remote: options.remote, branch: options.branch, observedRemoteHead: after.sha },
  };
  const pending = makeReceipt(prepared, outcomeUnknown ? "outcome_unknown" : "committed", {
    checkpoint: outcomeUnknown ? "remote_inspection_required" : remoteChanged ? "remote_changed" : "push_pending",
    sideEffects: sideEffectsInput,
    statusLocator: locator,
    error,
  });
  await persistReceipt(context, pending);
  return pending;
}

async function inspectPreflight(
  article: ArticlePackage,
  context: EndpointContext,
  options: { allowAhead?: boolean } = {},
): Promise<GitSnapshot> {
  const repoRoot = await realpath(path.resolve(context.repoRoot));
  const blogOptions = readOptions(context, article);
  const expectedTarget = targetRelative(blogOptions, article);
  if (expectedTarget === ".git" || expectedTarget.startsWith(".git/")) {
    throw new PublishError("E_BLOG_TARGET", "The managed Blog target cannot be inside .git");
  }
  await assertPathWithinNoSymlinks(repoRoot, path.join(repoRoot, ...expectedTarget.split("/")), "Blog target");
  const actualRoot = await realpath(path.resolve(
    await requireGit(repoRoot, ["rev-parse", "--show-toplevel"], "E_GIT_REPO"),
  ));
  if (actualRoot !== repoRoot) {
    throw new PublishError("E_GIT_ROOT", `Expected Git root ${repoRoot}, got ${actualRoot}`, { kind: "precondition" });
  }

  const branch = await requireGit(repoRoot, ["branch", "--show-current"], "E_GIT_BRANCH");
  if (branch !== blogOptions.branch) {
    throw new PublishError("E_GIT_BRANCH", `Expected branch ${blogOptions.branch}, got ${branch || "detached HEAD"}`, {
      kind: "conflict",
    });
  }
  await requireGit(repoRoot, ["check-ref-format", "--branch", blogOptions.branch], "E_GIT_BRANCH");
  const pushDestination = await resolvePushDestination(repoRoot, blogOptions.remote);
  const currentRemoteUrlDigest = pushDestination.digest;
  const upstream = await requireGit(
    repoRoot,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    "E_GIT_UPSTREAM",
  );
  if (upstream !== `${blogOptions.remote}/${blogOptions.branch}`) {
    throw new PublishError(
      "E_GIT_UPSTREAM",
      `Expected upstream ${blogOptions.remote}/${blogOptions.branch}, got ${upstream}`,
      { kind: "conflict" },
    );
  }
  const [head, upstreamHead] = await Promise.all([
    requireGit(repoRoot, ["rev-parse", "HEAD"], "E_GIT_HEAD"),
    requireGit(repoRoot, ["rev-parse", "@{upstream}"], "E_GIT_UPSTREAM"),
  ]);
  const remoteObservation = await observeRemoteBranch(repoRoot, pushDestination.url, blogOptions.branch);
  if (!remoteObservation.queryOk || !remoteObservation.sha) {
    throw new PublishError("E_GIT_REMOTE_STATUS", "Cannot verify the current remote branch SHA", {
      kind: "precondition",
      details: { remote: blogOptions.remote, branch: blogOptions.branch },
    });
  }
  const remoteHead = remoteObservation.sha;
  if (!options.allowAhead && head !== upstreamHead) {
    throw new PublishError("E_GIT_NOT_SYNCED", "Blog publishing requires HEAD to equal its upstream before preparation", {
      kind: "conflict",
      details: { head, upstreamHead },
    });
  }
  if (!options.allowAhead && remoteHead !== upstreamHead) {
    throw new PublishError("E_GIT_REMOTE_CHANGED", "Remote branch differs from the locally tracked upstream", {
      kind: "conflict",
      details: { upstreamHead, remoteHead },
    });
  }

  const staged = (await requireGit(repoRoot, ["diff", "--cached", "--name-only", "-z"], "E_GIT_INDEX"))
    .split("\0")
    .filter(Boolean);
  const unrelatedStaged = staged.filter((item) => !isManagedGitPath(item, expectedTarget));
  if (unrelatedStaged.length > 0) {
    throw new PublishError("E_GIT_STAGED_CONFLICT", "Unrelated staged files would be captured by the publish commit", {
      kind: "conflict",
      details: { paths: unrelatedStaged },
    });
  }

  return {
    ok: true,
    branch,
    upstream,
    head,
    upstreamHead,
    remoteHead,
    remote: blogOptions.remote,
    remoteUrlDigest: currentRemoteUrlDigest,
    target: expectedTarget,
    stagedManagedPaths: staged,
  };
}

export class BlogGitEndpoint implements PublisherEndpoint {
  readonly id = ENDPOINT_ID;
  readonly capabilities = {
    draft: false,
    publish: true,
    update: true,
    imageUpload: false,
    status: true,
  } as const;

  async preflight(article: ArticlePackage, context: EndpointContext): Promise<Record<string, unknown>> {
    return { ...await inspectPreflight(article, context) };
  }

  async prepare(article: ArticlePackage, context: EndpointContext): Promise<PreparedBlogPublication> {
    const snapshot = await inspectPreflight(article, context);
    const options = readOptions(context, article);
    if (!options.candidateBundleRoot) {
      throw new PublishError("E_BLOG_CANDIDATE", "candidateBundleRoot is required to prepare the Blog endpoint");
    }
    const repoRoot = await realpath(path.resolve(context.repoRoot));
    const runRoot = await assertRealPathWithin(path.join(repoRoot, ".publish"), context.runRoot, "publication run root");
    const section = hugoSectionFromContentRoot(options.contentRoot);
    const expectedCandidate = path.join(
      runRoot,
      "renders",
      "blog",
      "content",
      ...section.split("/").filter(Boolean),
      article.metadata.slug,
    );
    const candidate = await assertRealPathWithin(runRoot, path.resolve(options.candidateBundleRoot), "Blog candidate bundle");
    if (candidate !== await realpath(expectedCandidate).catch(() => "")) {
      throw new PublishError("E_BLOG_CANDIDATE", "Blog candidate must be the fixed renderer output for this run");
    }
    const candidateStat = await lstat(candidate).catch(() => undefined);
    if (!candidateStat?.isDirectory() || candidateStat.isSymbolicLink()) {
      throw new PublishError("E_BLOG_CANDIDATE", `Candidate bundle does not exist: ${candidate}`);
    }
    const relativeTarget = targetRelative(options, article);
    const target = path.resolve(repoRoot, relativeTarget);
    if (!isWithin(repoRoot, target)) throw new PublishError("E_PATH_ESCAPE", "Blog target escaped the repository");

    const [targetBaselineDigest, renderDigest] = await Promise.all([
      digestDirectory(target),
      digestDirectory(candidate),
    ]);
    const baselineDigest = blogBaselineDigest(targetBaselineDigest, snapshot);
    const blog = {
      target: relativeTarget,
      targetBaselineDigest,
      baseHead: snapshot.head,
      upstreamHead: snapshot.upstreamHead,
      remoteHead: snapshot.remoteHead,
      remoteUrlDigest: snapshot.remoteUrlDigest,
    };
    const actions = [
      { id: "apply-bundle", description: `Replace ${relativeTarget} with the frozen candidate`, sideEffect: true },
      { id: "git-commit", description: `Commit only ${relativeTarget}`, sideEffect: true },
      { id: "git-push", description: `Lease-guarded fast-forward push to ${options.remote}/${options.branch}`, sideEffect: true },
    ];
    const optionsDigest = blogOptionsDigest(options, article, snapshot.remoteUrlDigest);
    const planCore = {
      schemaVersion: 1 as const,
      endpoint: ENDPOINT_ID,
      articleId: article.articleId,
      packageRevision: article.revision,
      optionsDigest,
      baselineDigest,
      renderDigest,
      actions,
      blog,
    };
    return {
      ...planCore,
      planDigest: digestCanonical(planCore),
      artifactRoot: candidate,
    };
  }

  async publish(
    input: PreparedPublication,
    confirmation: string,
    context: EndpointContext,
  ): Promise<PublishReceipt> {
    const prepared = assertPreparedBlog(input);
    const secret = typeof context.options.confirmationSecret === "string"
      ? context.options.confirmationSecret
      : undefined;
    if (!verifyConfirmationToken(confirmation, prepared, secret)) {
      throw new PublishError("E_CONFIRMATION", "The Blog confirmation token is stale or invalid", {
        kind: "precondition",
      });
    }

    const article = context.options.article as ArticlePackage | undefined;
    if (!article || article.articleId !== prepared.articleId || article.revision !== prepared.packageRevision) {
      throw new PublishError("E_ARTICLE_CONTEXT", "The confirmed ArticlePackage is missing or no longer matches");
    }
    const releaseLock = await acquirePublishLock(context);
    try {
      const repoRoot = await realpath(path.resolve(context.repoRoot));
      const options = readOptions(context, article);
      const runRoot = await assertRealPathWithin(path.join(repoRoot, ".publish"), context.runRoot, "publication run root");
      const section = hugoSectionFromContentRoot(options.contentRoot);
      const expectedCandidate = path.join(
        runRoot,
        "renders",
        "blog",
        "content",
        ...section.split("/").filter(Boolean),
        article.metadata.slug,
      );
      const candidate = await assertRealPathWithin(runRoot, prepared.artifactRoot, "Blog candidate bundle");
      if (candidate !== await realpath(expectedCandidate).catch(() => "")) {
        throw new PublishError("E_BLOG_CANDIDATE", "Confirmed Blog candidate is outside the fixed renderer output");
      }
      const relativeTarget = targetRelative(options, article);
      if (relativeTarget !== prepared.blog.target) {
        throw new PublishError("E_BLOG_TARGET_STALE", "Blog target changed after confirmation", { kind: "conflict" });
      }
      const target = path.resolve(repoRoot, relativeTarget);
      const receiptPath = path.join(runRoot, "receipts", `${ENDPOINT_ID}.json`);
      const existing = await lstat(receiptPath).catch(() => undefined) ? await readReceipt(receiptPath) : undefined;
      if (
        existing
        && existing.planDigest !== prepared.planDigest
        && existing.state !== "pushed"
        && existing.sideEffects.length > 0
      ) {
        throw new PublishError("E_BLOG_RECEIPT_CONFLICT", "This run already contains side effects for another Blog plan", {
          kind: "conflict",
        });
      }
      if (
        existing?.planDigest === prepared.planDigest
        && ["pushed", "partial", "outcome_unknown"].includes(existing.state)
      ) {
        return existing;
      }

      const resumable = existing?.planDigest === prepared.planDigest
        && (
          (existing.state === "prepared" && existing.checkpoint === "publish_started")
          || (existing.state === "committed" && ["commit_created", "push_pending"].includes(existing.checkpoint ?? ""))
        );
      const currentDestination = await resolvePushDestination(repoRoot, options.remote);
      if (currentDestination.digest !== prepared.blog.remoteUrlDigest) {
        throw new PublishError("E_BLOG_OPTIONS_STALE", "Blog push URL changed after confirmation", {
          kind: "conflict",
        });
      }
      const snapshot = await inspectPreflight(article, context, { allowAhead: resumable });
      if (blogOptionsDigest(options, article, snapshot.remoteUrlDigest) !== prepared.optionsDigest) {
        throw new PublishError("E_BLOG_OPTIONS_STALE", "Blog branch, push URL, target, or commit message changed after confirmation", {
          kind: "conflict",
        });
      }
      const currentRender = await digestDirectory(candidate);
      if (currentRender !== prepared.renderDigest) {
        throw new PublishError("E_BLOG_RENDER_STALE", "The frozen Blog candidate changed after confirmation", {
          kind: "conflict",
        });
      }

      if (
        existing?.planDigest === prepared.planDigest
        && existing.state === "committed"
        && ["commit_created", "push_pending"].includes(existing.checkpoint ?? "")
      ) {
        const commit = typeof existing.statusLocator?.commit === "string" ? existing.statusLocator.commit : undefined;
        if (!commit || snapshot.head !== commit) {
          throw new PublishError("E_GIT_CHECKPOINT", "HEAD no longer matches the committed Blog checkpoint", {
            kind: "conflict",
          });
        }
        if (await digestDirectory(target) !== prepared.renderDigest) {
          throw new PublishError("E_GIT_CHECKPOINT", "Committed Blog checkpoint does not contain the confirmed bundle", {
            kind: "conflict",
          });
        }
        await assertCommitScope(
          repoRoot,
          commit,
          prepared.blog.baseHead,
          relativeTarget,
          options.commitMessage,
          prepared.renderDigest!,
        );
        return completePush(prepared, options, repoRoot, context, commit, existing.sideEffects);
      }

      let currentTarget = await digestDirectory(target);
      const sideEffects: Array<Record<string, unknown>> = [];
      const resumingStarted = existing?.planDigest === prepared.planDigest
        && existing.state === "prepared"
        && existing.checkpoint === "publish_started";

      if (resumingStarted) {
        if (snapshot.head !== prepared.blog.baseHead) {
          if (currentTarget !== prepared.renderDigest) {
            throw new PublishError("E_GIT_CHECKPOINT", "HEAD advanced but the managed bundle is not the confirmed candidate", {
              kind: "conflict",
            });
          }
          await assertCommitScope(
            repoRoot,
            snapshot.head,
            prepared.blog.baseHead,
            relativeTarget,
            options.commitMessage,
            prepared.renderDigest!,
          );
          const recoveredEffects = [
            { type: "worktree_applied", target: relativeTarget, digest: currentRender, recovered: true },
            { type: "git_commit", commit: snapshot.head, message: options.commitMessage, recovered: true },
          ];
          const committed = makeReceipt(prepared, "committed", {
            checkpoint: "commit_created",
            sideEffects: recoveredEffects,
            statusLocator: {
              commit: snapshot.head,
              remote: options.remote,
              branch: options.branch,
              remoteUrlDigest: snapshot.remoteUrlDigest,
            },
          });
          await persistReceipt(context, committed);
          return completePush(prepared, options, repoRoot, context, snapshot.head, recoveredEffects);
        }
        if (
          snapshot.upstreamHead !== prepared.blog.upstreamHead
          || snapshot.remoteHead !== prepared.blog.remoteHead
        ) {
          throw new PublishError("E_GIT_CHECKPOINT", "Upstream or remote changed while resuming the Blog worktree checkpoint", {
            kind: "conflict",
          });
        }
        if (![prepared.blog.targetBaselineDigest, prepared.renderDigest].includes(currentTarget)) {
          const replacement = replacementArtifactPaths(target, prepared.planDigest);
          const hasRecoveryArtifact = Boolean(
            await lstat(replacement.incoming).catch(() => undefined)
            || await lstat(replacement.backup).catch(() => undefined),
          );
          if (!hasRecoveryArtifact) {
            throw new PublishError("E_BLOG_BASELINE_STALE", "Managed Blog bundle changed outside the resumable checkpoint", {
              kind: "conflict",
            });
          }
          await atomicReplaceDirectory(repoRoot, candidate, target, currentRender, prepared.planDigest);
          currentTarget = await digestDirectory(target);
          if (currentTarget !== prepared.renderDigest) {
            throw new PublishError("E_BLOG_REPLACEMENT_RECOVERY", "Could not recover the interrupted Blog replacement", {
              kind: "outcome_unknown",
              outcome: "partial",
            });
          }
        }
      } else {
        const currentBaseline = blogBaselineDigest(currentTarget, snapshot);
        if (currentBaseline !== prepared.baselineDigest) {
          throw new PublishError("E_BLOG_BASELINE_STALE", "Blog target, HEAD, upstream, or push URL changed after preparation", {
            kind: "conflict",
          });
        }
        const started = makeReceipt(prepared, "prepared", {
          checkpoint: "publish_started",
          statusLocator: {
            parentCommit: snapshot.head,
            remote: options.remote,
            branch: options.branch,
            remoteUrlDigest: snapshot.remoteUrlDigest,
          },
        });
        await persistReceipt(context, started);
      }

      try {
        if (currentTarget !== currentRender || resumingStarted) {
          await atomicReplaceDirectory(repoRoot, candidate, target, currentRender, prepared.planDigest);
          currentTarget = await digestDirectory(target);
          if (currentTarget !== currentRender) {
            throw new PublishError("E_BLOG_APPLY", "Applied Blog bundle does not match the confirmed candidate", {
              kind: "outcome_unknown",
              outcome: "partial",
            });
          }
          sideEffects.push({
            type: "worktree_applied",
            target: relativeTarget,
            digest: currentRender,
            ...(resumingStarted ? { recovered: true } : {}),
          });
        }
        await requireGit(repoRoot, ["add", "--", relativeTarget], "E_GIT_ADD");

        const staged = (await requireGit(repoRoot, ["diff", "--cached", "--name-only", "-z"], "E_GIT_INDEX"))
          .split("\0")
          .filter(Boolean);
        const unrelated = staged.filter((item) => !isManagedGitPath(item, relativeTarget));
        if (unrelated.length > 0) {
          throw new PublishError("E_GIT_STAGED_CONFLICT", "Unrelated files appeared in the Git index", {
            kind: "conflict",
            outcome: "partial",
            details: { paths: unrelated },
          });
        }

        const stagedDiff = await runGit(repoRoot, ["diff", "--cached", "--quiet", "--", relativeTarget]);
        let commitSha = await requireGit(repoRoot, ["rev-parse", "HEAD"], "E_GIT_HEAD");
        if (stagedDiff.exitCode === 1) {
          const commitResult = await runGit(
            repoRoot,
            ["-c", "commit.gpgSign=false", "commit", "-m", options.commitMessage, "--", relativeTarget],
            { timeoutMs: 120_000 },
          );
          const headAfterCommit = await requireGit(repoRoot, ["rev-parse", "HEAD"], "E_GIT_HEAD");
          if (commitResult.exitCode !== 0 && !commitResult.timedOut) {
            throw new PublishError(
              "E_GIT_COMMIT",
              commitResult.stderr || commitResult.stdout || "Git commit failed",
              { kind: "precondition" },
            );
          }
          if (commitResult.timedOut) {
            if (headAfterCommit === prepared.blog.baseHead) {
              throw new PublishError("E_GIT_COMMIT_UNKNOWN", "Git commit timed out and its outcome cannot be proven", {
                kind: "outcome_unknown",
                outcome: "unknown",
              });
            }
            try {
              await assertCommitScope(
                repoRoot,
                headAfterCommit,
                prepared.blog.baseHead,
                relativeTarget,
                options.commitMessage,
                prepared.renderDigest,
              );
            } catch (error) {
              throw new PublishError("E_GIT_COMMIT_UNKNOWN", "Git commit timed out and produced an unverified HEAD", {
                kind: "outcome_unknown",
                outcome: "unknown",
                details: { cause: error instanceof Error ? error.message : String(error) },
              });
            }
            commitSha = headAfterCommit;
            sideEffects.push({
              type: "git_commit",
              commit: commitSha,
              message: options.commitMessage,
              recoveredAfterTimeout: true,
            });
          } else {
            commitSha = headAfterCommit;
            await assertCommitScope(
              repoRoot,
              commitSha,
              prepared.blog.baseHead,
              relativeTarget,
              options.commitMessage,
              prepared.renderDigest,
            );
            sideEffects.push({ type: "git_commit", commit: commitSha, message: options.commitMessage });
          }
        } else if (stagedDiff.exitCode !== 0) {
          throw new PublishError("E_GIT_DIFF", stagedDiff.stderr || "Unable to inspect staged Blog diff");
        } else if (commitSha !== prepared.blog.baseHead) {
          throw new PublishError("E_GIT_HEAD", "HEAD advanced without the confirmed Blog commit", { kind: "conflict" });
        }

        const committed = makeReceipt(prepared, "committed", {
          checkpoint: "commit_created",
          sideEffects,
          statusLocator: {
            commit: commitSha,
            remote: options.remote,
            branch: options.branch,
            remoteUrlDigest: snapshot.remoteUrlDigest,
          },
        });
        await persistReceipt(context, committed);
        return completePush(prepared, options, repoRoot, context, commitSha, sideEffects);
      } catch (error) {
        const failure = error instanceof PublishError ? error.data : undefined;
        const hasPartialOutcome = sideEffects.length > 0 || failure?.outcome === "partial";
        const outcomeUnknown = failure?.outcome === "unknown";
        const state: PublishReceipt["state"] = outcomeUnknown
          ? "outcome_unknown"
          : hasPartialOutcome
            ? "partial"
            : "failed";
        const message = error instanceof Error ? error.message : String(error);
        const receipt = makeReceipt(prepared, state, {
          checkpoint: outcomeUnknown
            ? "local_inspection_required"
            : hasPartialOutcome
              ? "worktree_or_index_changed"
              : "not_applied",
          sideEffects,
          error: {
            code: failure?.code ?? "E_BLOG_PUBLISH",
            kind: failure?.kind ?? "transient",
            message,
            retryable: false,
            outcome: outcomeUnknown ? "unknown" : hasPartialOutcome ? "partial" : "not_applied",
          },
        });
        await persistReceipt(context, receipt);
        return receipt;
      }
    } finally {
      await releaseLock();
    }
  }

  async status(receipt: PublishReceipt, context: EndpointContext): Promise<Record<string, unknown>> {
    const commit = typeof receipt.statusLocator?.commit === "string" ? receipt.statusLocator.commit : undefined;
    if (!commit) return { state: receipt.state, supported: false, reason: "receipt has no commit locator" };
    const remote = typeof receipt.statusLocator?.remote === "string" ? receipt.statusLocator.remote : undefined;
    const branch = typeof receipt.statusLocator?.branch === "string" ? receipt.statusLocator.branch : undefined;
    const expectedUrlDigest = typeof receipt.statusLocator?.remoteUrlDigest === "string"
      ? receipt.statusLocator.remoteUrlDigest
      : undefined;
    if (!remote || !branch || !expectedUrlDigest) {
      return { state: receipt.state, supported: false, reason: "receipt has no bound remote locator" };
    }
    const repoRoot = await realpath(path.resolve(context.repoRoot));
    const destination = await resolvePushDestination(repoRoot, remote);
    if (destination.digest !== expectedUrlDigest) {
      throw new PublishError("E_GIT_REMOTE_CHANGED", "Cannot query status because the bound push URL changed", {
        kind: "conflict",
      });
    }
    const [local, observed] = await Promise.all([
      runGit(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]),
      observeRemoteBranch(repoRoot, destination.url, branch),
    ]);
    return {
      state: receipt.state,
      supported: true,
      commit,
      localCommitExists: local.exitCode === 0,
      remoteObserved: observed.queryOk,
      remoteCommit: observed.sha,
      remoteMatchesReceipt: observed.sha === commit,
      deployment: "unobserved",
    };
  }
}

export function createBlogGitEndpoint(): PublisherEndpoint {
  return new BlogGitEndpoint();
}
