import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { probeBaoyuCredentials } from "../src/baoyu-credentials-probe";
import {
  classifyBaoyuFailure,
  redactBaoyuStderr,
  runBaoyuDraft,
  type BaoyuDraftDependencies,
  type BaoyuDraftRequest,
} from "../src/baoyu-draft";
import { resolveBaoyuToolchain, sha256File, type ResolvedBaoyuToolchain } from "../src/toolchain";

const temporaryRoots: string[] = [];
const fixtureApi = path.resolve(import.meta.dir, "fixtures", "fake-baoyu-wechat-api.ts");

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function articleFixture(): Promise<{
  repoRoot: string;
  artifactRoot: string;
  inputPath: string;
  coverPath: string;
  journalDir: string;
}> {
  const repoRoot = await tempRoot("baoyu-draft-repo-");
  const artifactRoot = path.join(repoRoot, ".publish", "work", "candidate");
  const inputPath = path.join(artifactRoot, "wechat.html");
  const coverPath = path.join(artifactRoot, "cover.png");
  const bodyImagePath = path.join(artifactRoot, "body.png");
  const journalDir = path.join(repoRoot, ".publish", "receipts", "baoyu-drafts");
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(inputPath, "<html><head><title>Fixture</title></head><body><p>hello</p><img src=\"body.png\"></body></html>");
  await writeFile(coverPath, new Uint8Array([137, 80, 78, 71]));
  await writeFile(bodyImagePath, new Uint8Array([137, 80, 78, 71, 1]));
  return { repoRoot, artifactRoot, inputPath, coverPath, journalDir };
}

function fakeToolchain(): ResolvedBaoyuToolchain {
  const hashes = {
    "SKILL.md": "sha256:test-skill",
    "scripts/wechat-api.ts": "sha256:test-api",
    "scripts/wechat-extend-config.ts": "sha256:test-config",
    "scripts/md-to-wechat.ts": "sha256:test-markdown",
  } as const;
  return {
    skillDir: path.dirname(path.dirname(fixtureApi)),
    skillVersion: "test-1",
    apiScriptPath: fixtureApi,
    configModulePath: "/unused/wechat-extend-config.ts",
    markdownScriptPath: "/unused/md-to-wechat.ts",
    runtime: { kind: "bun", command: process.execPath, argsPrefix: [] },
    lock: {
      schemaVersion: 1,
      baoyuPostToWechat: {
        repository: "https://example.invalid/baoyu",
        version: "test-1",
        files: hashes,
      },
    },
    verifiedFiles: hashes,
  };
}

function dependencies(): BaoyuDraftDependencies {
  return {
    resolveToolchain: async () => fakeToolchain(),
    credentialProbe: async (_toolchain, request) => ({
      schemaVersion: 1,
      account: { alias: request.account, name: "Fixture", availableAliases: [request.account] },
      credentials: {
        source: "process.env (WECHAT_BLOG_APP_ID/WECHAT_BLOG_APP_SECRET)",
        skippedSources: [],
        accountIdentityDigest: `sha256:${"d".repeat(64)}`,
      },
    }),
    now: () => "2026-07-14T00:00:00.000Z",
  };
}

async function requestFor(operation: BaoyuDraftRequest["operation"], extra: Partial<BaoyuDraftRequest> = {}) {
  const fixture = await articleFixture();
  return {
    operation,
    ...fixture,
    title: "Fixture title",
    author: "Example Author",
    summary: "Fixture summary",
    account: "blog",
    theme: "default",
    env: {},
    ...extra,
  } satisfies BaoyuDraftRequest;
}

describe("Baoyu toolchain resolver", () => {
  test("discovers Bun and verifies every locked Baoyu file", async () => {
    const root = await tempRoot("baoyu-toolchain-");
    const skillDir = path.join(root, "baoyu-post-to-wechat");
    await mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: baoyu-post-to-wechat\nversion: test-1\n---\n");
    await copyFile(fixtureApi, path.join(skillDir, "scripts", "wechat-api.ts"));
    await writeFile(path.join(skillDir, "scripts", "wechat-extend-config.ts"), "export {};\n");
    await writeFile(path.join(skillDir, "scripts", "md-to-wechat.ts"), "export {};\n");

    const files = {
      "SKILL.md": await sha256File(path.join(skillDir, "SKILL.md")),
      "scripts/wechat-api.ts": await sha256File(path.join(skillDir, "scripts", "wechat-api.ts")),
      "scripts/wechat-extend-config.ts": await sha256File(path.join(skillDir, "scripts", "wechat-extend-config.ts")),
      "scripts/md-to-wechat.ts": await sha256File(path.join(skillDir, "scripts", "md-to-wechat.ts")),
    };
    const resolved = await resolveBaoyuToolchain({
      repoRoot: root,
      explicitDir: skillDir,
      env: { PATH: "", BAOYU_BUN: process.execPath },
      lock: {
        schemaVersion: 1,
        baoyuPostToWechat: { repository: "https://example.invalid", version: "test-1", files },
      },
    });

    expect(resolved.skillDir).toBe(skillDir);
    expect(resolved.runtime).toEqual({ kind: "bun", command: process.execPath, argsPrefix: [] });
    expect(resolved.verifiedFiles).toEqual(files);
  });

  test("blocks an upstream file that does not match the lock", async () => {
    const root = await tempRoot("baoyu-toolchain-mismatch-");
    const skillDir = path.join(root, "baoyu-post-to-wechat");
    await mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "---\nversion: test-1\n---\n");
    await writeFile(path.join(skillDir, "scripts", "wechat-api.ts"), "changed\n");
    await writeFile(path.join(skillDir, "scripts", "wechat-extend-config.ts"), "export {};\n");
    await writeFile(path.join(skillDir, "scripts", "md-to-wechat.ts"), "export {};\n");

    await expect(resolveBaoyuToolchain({
      repoRoot: root,
      explicitDir: skillDir,
      env: { PATH: "", BAOYU_BUN: process.execPath },
      lock: fakeToolchain().lock,
    })).rejects.toMatchObject({ data: { code: "E_TOOLCHAIN_LOCK_MISMATCH" } });
  });
});

describe("Baoyu credential probe", () => {
  test("validates the explicit alias and returns no credential values", async () => {
    const root = await tempRoot("baoyu-probe-");
    const modulePath = path.join(root, "config.ts");
    await writeFile(modulePath, `
      export const loadWechatExtendConfig = () => ({});
      export const listAccounts = () => ["blog"];
      export const resolveAccount = (_config, alias) => ({ alias, name: "Blog" });
      export const loadCredentials = () => ({
        appId: "must-not-leak",
        appSecret: "must-not-leak",
        source: "process.env (WECHAT_BLOG_APP_ID/WECHAT_BLOG_APP_SECRET)",
        skippedSources: []
      });
    `);
    const result = await probeBaoyuCredentials({ configModulePath: modulePath, account: "blog" });
    expect(result.account.alias).toBe("blog");
    expect(result.credentials.accountIdentityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    await expect(probeBaoyuCredentials({ configModulePath: modulePath, account: "other" }))
      .rejects.toMatchObject({ data: { code: "E_ACCOUNT_UNKNOWN" } });
  });

  test("blocks unprefixed fallback for an explicitly selected account", async () => {
    const root = await tempRoot("baoyu-probe-fallback-");
    const modulePath = path.join(root, "config.ts");
    await writeFile(modulePath, `
      export const loadWechatExtendConfig = () => ({});
      export const listAccounts = () => ["blog"];
      export const resolveAccount = (_config, alias) => ({ alias });
      export const loadCredentials = () => ({ source: "process.env", skippedSources: [] });
    `);
    await expect(probeBaoyuCredentials({ configModulePath: modulePath, account: "blog" }))
      .rejects.toMatchObject({ data: { code: "E_CREDENTIALS_AMBIGUOUS" } });
  });
});

describe("Baoyu draft subprocess contract", () => {
  test("dry-run is JSON-only and has no remote side effect", async () => {
    const request = await requestFor("dry-run");
    const result = await runBaoyuDraft(request, dependencies());
    expect(result).toMatchObject({ ok: true, state: "dry_run", sideEffect: "none" });
    expect(result.dryRun?.title).toBe("Fixture title");
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
  });

  test("preflight validates credentials and returns a confirmation bound to the frozen candidate", async () => {
    const request = await requestFor("preflight");
    const result = await runBaoyuDraft(request, dependencies());
    expect(result).toMatchObject({
      ok: true,
      state: "preflighted",
      credentials: { source: "process.env (WECHAT_BLOG_APP_ID/WECHAT_BLOG_APP_SECRET)" },
      sideEffect: "none",
    });
    expect(result.confirmationToken).toStartWith("sha256:");
  });

  test("create-draft runs an identical dry-run first and invokes the real child exactly once", async () => {
    const logPath = path.join(await tempRoot("baoyu-call-log-"), "calls.jsonl");
    const request = await requestFor("preflight", { env: { FAKE_BAOYU_CALL_LOG: logPath } });
    const preflight = await runBaoyuDraft(request, dependencies());
    const result = await runBaoyuDraft({
      ...request,
      operation: "create-draft",
      confirmationToken: preflight.confirmationToken,
    }, dependencies());

    expect(result).toMatchObject({ ok: true, state: "draft_created", mediaId: "fixture-media-id" });
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const createCalls = calls.slice(-2);
    expect(createCalls.map((call) => call.dryRun)).toEqual([true, false]);
    const withoutDryFlag = createCalls[0].args.filter((arg: string) => arg !== "--dry-run");
    expect(withoutDryFlag).toEqual(createCalls[1].args);
  });

  test("requires the exact confirmation token", async () => {
    const request = await requestFor("create-draft", { confirmationToken: "wrong" });
    await expect(runBaoyuDraft(request, dependencies())).rejects.toMatchObject({ data: { code: "E_CONFIRMATION" } });
  });

  test("invalidates confirmation when the selected account AppID changes", async () => {
    const request = await requestFor("preflight");
    let identity = `sha256:${"1".repeat(64)}`;
    const deps = dependencies();
    deps.credentialProbe = async (_toolchain, candidate) => ({
      schemaVersion: 1,
      account: { alias: candidate.account, availableAliases: [candidate.account] },
      credentials: {
        source: "process.env (WECHAT_BLOG_APP_ID/WECHAT_BLOG_APP_SECRET)",
        skippedSources: [],
        accountIdentityDigest: identity,
      },
    });
    const preflight = await runBaoyuDraft(request, deps);
    identity = `sha256:${"2".repeat(64)}`;
    await expect(runBaoyuDraft({
      ...request,
      operation: "create-draft",
      confirmationToken: preflight.confirmationToken,
    }, deps)).rejects.toMatchObject({ data: { code: "E_CONFIRMATION" } });
  });

  test("blocks an inline image mutation after dry-run before the real provider call", async () => {
    const request = await requestFor("preflight");
    let mutateDuringDryRun = false;
    let realCalls = 0;
    const deps = dependencies();
    deps.commandRunner = async (command) => {
      if (command.argv.includes("--dry-run")) {
        if (mutateDuringDryRun) {
          await writeFile(path.join(request.artifactRoot, "body.png"), "changed-inline-image");
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            articleType: "news",
            title: request.title,
            contentLength: 42,
            placeholderImageCount: 1,
            account: request.account,
          }),
          stderr: "",
          timedOut: false,
        };
      }
      realCalls += 1;
      return { exitCode: 0, stdout: JSON.stringify({ success: true, media_id: "unexpected" }), stderr: "", timedOut: false };
    };
    const preflight = await runBaoyuDraft(request, deps);
    mutateDuringDryRun = true;
    await expect(runBaoyuDraft({
      ...request,
      operation: "create-draft",
      confirmationToken: preflight.confirmationToken,
    }, deps)).rejects.toMatchObject({ data: { code: "E_CANDIDATE_CHANGED" } });
    expect(realCalls).toBe(0);
  });

  test("Failed to upload plus media_id is partial and is never retried", async () => {
    const logPath = path.join(await tempRoot("baoyu-partial-log-"), "calls.jsonl");
    const request = await requestFor("preflight", {
      env: { FAKE_BAOYU_CALL_LOG: logPath, FAKE_BAOYU_DRAFT_MODE: "partial" },
    });
    const preflight = await runBaoyuDraft(request, dependencies());
    const result = await runBaoyuDraft({
      ...request,
      operation: "create-draft",
      confirmationToken: preflight.confirmationToken,
    }, dependencies());

    expect(result).toMatchObject({
      ok: false,
      state: "partial",
      mediaId: "fixture-media-id",
      sideEffect: "draft_created",
      error: { code: "E_DRAFT_CONTENT_PARTIAL", retryable: false, outcome: "partial" },
    });
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((call) => !call.dryRun)).toHaveLength(1);
  });

  test("a real-child timeout is outcome_unknown, journaled, and not retried", async () => {
    const logPath = path.join(await tempRoot("baoyu-timeout-log-"), "calls.jsonl");
    const request = await requestFor("preflight", {
      timeoutMs: 1_000,
      env: {
        FAKE_BAOYU_CALL_LOG: logPath,
        FAKE_BAOYU_DRAFT_MODE: "timeout",
        FAKE_BAOYU_TIMEOUT_MS: "5000",
      },
    });
    const preflight = await runBaoyuDraft(request, dependencies());
    const createRequest = {
      ...request,
      operation: "create-draft" as const,
      confirmationToken: preflight.confirmationToken,
    };
    const result = await runBaoyuDraft(createRequest, dependencies());
    expect(result).toMatchObject({
      ok: false,
      state: "outcome_unknown",
      sideEffect: "unknown",
      error: { code: "E_BAOYU_TIMEOUT", retryable: false, outcome: "unknown" },
    });
    await expect(runBaoyuDraft(createRequest, dependencies()))
      .rejects.toMatchObject({ data: { code: "E_DUPLICATE_DRAFT", outcome: "unknown" } });
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((call) => !call.dryRun)).toHaveLength(1);
  });

  test("an incomplete success response is outcome_unknown and duplicate-guarded", async () => {
    const request = await requestFor("preflight", { env: { FAKE_BAOYU_DRAFT_MODE: "missing-media" } });
    const preflight = await runBaoyuDraft(request, dependencies());
    const createRequest = {
      ...request,
      operation: "create-draft" as const,
      confirmationToken: preflight.confirmationToken,
    };
    const result = await runBaoyuDraft(createRequest, dependencies());
    expect(result).toMatchObject({
      ok: false,
      state: "outcome_unknown",
      sideEffect: "unknown",
      error: { code: "E_BAOYU_PROTOCOL", outcome: "unknown" },
    });
    await expect(runBaoyuDraft(createRequest, dependencies()))
      .rejects.toMatchObject({ data: { code: "E_DUPLICATE_DRAFT", outcome: "unknown" } });
  });

  test("a successful fingerprint cannot create a duplicate draft", async () => {
    const request = await requestFor("preflight");
    const preflight = await runBaoyuDraft(request, dependencies());
    const createRequest = {
      ...request,
      operation: "create-draft" as const,
      confirmationToken: preflight.confirmationToken,
    };
    await runBaoyuDraft(createRequest, dependencies());
    await expect(runBaoyuDraft(createRequest, dependencies()))
      .rejects.toMatchObject({ data: { code: "E_DUPLICATE_DRAFT", outcome: "applied" } });
  });

  test("stderr is classified and secrets are redacted", () => {
    const raw = "request?appid=fixture-app-id&secret=fixture-app-secret&access_token=fixture-token WECHAT_BLOG_APP_SECRET=fixture-env-secret";
    const redacted = redactBaoyuStderr(raw);
    expect(redacted).not.toContain("fixture-app-id");
    expect(redacted).not.toContain("fixture-env-secret");
    expect(redacted).not.toContain("fixture-token");
    expect(classifyBaoyuFailure("Error: Access token error 40164: invalid ip").data.code)
      .toBe("E_WECHAT_IP_NOT_ALLOWED");
  });

  test("wrapper and fake provider contain no public-publish endpoint", async () => {
    const forbidden = ["free", "publish"].join("");
    const sources = await Promise.all([
      readFile(path.resolve(import.meta.dir, "../src/baoyu-draft.ts"), "utf8"),
      readFile(fixtureApi, "utf8"),
    ]);
    expect(sources.join("\n").toLowerCase()).not.toContain(forbidden);
  });
});
