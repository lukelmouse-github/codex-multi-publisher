import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";

import type { BaoyuCommandRequest, BaoyuDraftDependencies } from "../src/baoyu-draft";
import { digestCanonical, sha256Bytes } from "../src/canonical-json";
import { WechatDraftEndpoint } from "../src/endpoints/wechat-draft";
import { createConfirmationToken, readReceipt } from "../src/receipts";
import type { ResolvedBaoyuToolchain } from "../src/toolchain";
import type { ArticlePackage, EndpointContext } from "../src/types";
import {
  freezeWechatCandidate,
  type FrozenWechatCandidate,
  type GzhDesignProvenanceInput,
} from "../src/wechat-freeze";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type ProviderMode = "success" | "partial" | "timeout";

interface ProviderControl {
  mode: ProviderMode;
  calls: BaoyuCommandRequest[];
}

interface EndpointFixture {
  root: string;
  repoRoot: string;
  runRoot: string;
  packageRoot: string;
  article: ArticlePackage;
  context: EndpointContext;
  control: ProviderControl;
  frozen: FrozenWechatCandidate;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "publish-wechat-endpoint-"));
  cleanup.push(root);
  return root;
}

function provenance(): GzhDesignProvenanceInput {
  return {
    repository: "https://github.com/isjiamu/gzh-design-skill",
    revision: "ba1f4175519b481cb3566616c9e5178705067904",
    license: "AGPL-3.0-or-later",
    licenseSha256: sha256Bytes("endpoint fixture AGPL license"),
    themeId: "moyu-green",
    runnerContract: "gzh-design-sidecar/v1",
    toolchainLockDigest: sha256Bytes("endpoint fixture gzh lock"),
    files: [
      { path: "SKILL.md", sha256: sha256Bytes("endpoint fixture skill") },
      { path: "references/theme-moyu-green.md", sha256: sha256Bytes("endpoint fixture theme") },
    ],
  };
}

function fakeToolchain(root: string): ResolvedBaoyuToolchain {
  const files = {
    "SKILL.md": sha256Bytes("baoyu skill"),
    "scripts/wechat-api.ts": sha256Bytes("baoyu api"),
    "scripts/wechat-extend-config.ts": sha256Bytes("baoyu config"),
    "scripts/md-to-wechat.ts": sha256Bytes("baoyu markdown"),
  } as const;
  return {
    skillDir: path.join(root, "fake-baoyu"),
    skillVersion: "endpoint-fixture-v1",
    apiScriptPath: path.join(root, "fake-baoyu", "scripts", "wechat-api.ts"),
    configModulePath: path.join(root, "fake-baoyu", "scripts", "wechat-extend-config.ts"),
    markdownScriptPath: path.join(root, "fake-baoyu", "scripts", "md-to-wechat.ts"),
    runtime: { kind: "bun", command: "fixture-bun", argsPrefix: [] },
    lock: {
      schemaVersion: 1,
      baoyuPostToWechat: {
        repository: "https://example.invalid/baoyu-fixture",
        version: "endpoint-fixture-v1",
        files,
      },
    },
    verifiedFiles: files,
  };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function dependencies(root: string, control: ProviderControl): BaoyuDraftDependencies {
  return {
    resolveToolchain: async () => fakeToolchain(root),
    credentialProbe: async (_toolchain, request) => ({
      schemaVersion: 1,
      account: { alias: request.account, name: "Endpoint Fixture", availableAliases: [request.account] },
      credentials: {
        source: `process.env (WECHAT_${request.account.toUpperCase()}_APP_ID/WECHAT_${request.account.toUpperCase()}_APP_SECRET)`,
        skippedSources: [],
        accountIdentityDigest: `sha256:${"e".repeat(64)}`,
      },
    }),
    commandRunner: async (request) => {
      control.calls.push(request);
      const dryRun = request.argv.includes("--dry-run");
      const account = valueAfter(request.argv, "--account");
      const title = valueAfter(request.argv, "--title") ?? "Endpoint fixture";
      if (dryRun) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            articleType: "news",
            title,
            contentLength: 321,
            placeholderImageCount: 1,
            account,
          }),
          stderr: "[wechat-api] validated frozen endpoint fixture\n",
          timedOut: false,
        };
      }
      if (control.mode === "timeout") {
        return { exitCode: 143, stdout: "", stderr: "", timedOut: true };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          success: true,
          media_id: "endpoint-fixture-media-id",
          title,
          articleType: "news",
        }),
        stderr: control.mode === "partial"
          ? "[wechat-api] Failed to upload placeholder WECHATIMGPH_1: Error: Upload failed 40005\n"
          : "[wechat-api] draft saved\n",
        timedOut: false,
      };
    },
    now: () => "2026-07-14T00:00:00.000Z",
  };
}

async function freezeVariant(
  fixture: Pick<EndpointFixture, "root" | "packageRoot" | "article">,
  name: string,
  text: string,
): Promise<FrozenWechatCandidate> {
  const candidateRoot = path.join(fixture.root, `candidate-${name}`);
  await mkdir(candidateRoot, { recursive: true });
  const candidateHtmlPath = path.join(candidateRoot, "wechat-candidate.html");
  await writeFile(candidateHtmlPath, [
    '<section style="max-width:677px;margin:0 auto;color:#065f46">',
    `  <p><span leaf="">${text}</span></p>`,
    '  <img src="asset://inline" alt="原创端点测试图" style="max-width:100%;height:auto">',
    "</section>",
    "",
  ].join("\n"));
  return freezeWechatCandidate({
    article: fixture.article,
    packageRoot: fixture.packageRoot,
    candidateRoot,
    candidateHtmlPath,
    frozenRoot: path.join(fixture.root, `frozen-${name}`),
    provenance: provenance(),
  });
}

async function endpointFixture(mode: ProviderMode = "success"): Promise<EndpointFixture> {
  const root = await tempRoot();
  const repoRoot = path.join(root, "repo");
  const runRoot = path.join(repoRoot, ".publish", "work", "endpoint-fixture");
  const packageRoot = path.join(runRoot, "package");
  const assetRoot = path.join(packageRoot, "assets");
  await mkdir(assetRoot, { recursive: true });

  const cover = await sharp({
    create: { width: 600, height: 315, channels: 3, background: { r: 4, g: 120, b: 87 } },
  }).png().toBuffer();
  const inline = await sharp({
    create: { width: 320, height: 180, channels: 3, background: { r: 16, g: 185, b: 129 } },
  }).webp({ lossless: true }).toBuffer();
  const body = "# 原创微信端点测试\n\n只用于无网络端点测试。\n";
  await writeFile(path.join(packageRoot, "body.md"), body);
  await writeFile(path.join(assetRoot, "cover.png"), cover);
  await writeFile(path.join(assetRoot, "inline.webp"), inline);

  const article: ArticlePackage = {
    schemaVersion: 1,
    articleId: "wechat-endpoint-fixture",
    revision: digestCanonical({ fixture: "wechat-endpoint", version: 1 }),
    metadata: {
      title: "原创微信端点测试",
      slug: "wechat-endpoint-fixture",
      summary: "验证端点确认、幂等与回执映射。",
      author: "Example Author",
      language: "zh-CN",
      tags: ["测试"],
      categories: ["工程"],
      coverAssetId: "cover",
    },
    body: { path: "body.md", sha256: sha256Bytes(body) },
    assets: [
      {
        id: "cover",
        path: "assets/cover.png",
        sha256: sha256Bytes(cover),
        mediaType: "image/png",
        bytes: cover.byteLength,
        role: "cover",
      },
      {
        id: "inline",
        path: "assets/inline.webp",
        sha256: sha256Bytes(inline),
        mediaType: "image/webp",
        bytes: inline.byteLength,
        role: "inline",
      },
    ],
    provenance: {
      sourceId: "endpoint-fixture-source",
      sourceDigest: sha256Bytes("endpoint fixture source"),
      packagerVersion: 1,
    },
  };

  const partialFixture = { root, packageRoot, article };
  const frozen = await freezeVariant(partialFixture, "one", "这是第一份已冻结候选。 ".trim());
  const control: ProviderControl = { mode, calls: [] };
  const context: EndpointContext = {
    repoRoot,
    runRoot,
    options: {
      article,
      frozenRoot: frozen.root,
      account: "blog",
      theme: "moyu-green",
      cite: true,
      confirmationSecret: "outer-confirmation-secret",
      baoyuDependencies: dependencies(root, control),
    },
  };
  return { root, repoRoot, runRoot, packageRoot, article, context, control, frozen };
}

describe("WechatDraftEndpoint", () => {
  test("maps prepare and the outer confirmation to exactly one Baoyu create-draft", async () => {
    const fixture = await endpointFixture();
    const endpoint = new WechatDraftEndpoint();
    const prepared = await endpoint.prepare(fixture.article, fixture.context);

    expect(prepared).toMatchObject({
      endpoint: "wechat-draft-baoyu",
      articleId: fixture.article.articleId,
      packageRevision: fixture.article.revision,
      account: "blog",
      renderDigest: fixture.frozen.renderDigest,
    });
    expect(prepared.previewPath).toBe(await realpath(fixture.frozen.previewPath));
    expect(prepared.providerConfirmationToken).toStartWith("sha256:");
    expect(prepared.actions.map((action) => action.id)).toEqual(["baoyu-dry-run", "upload-images", "create-draft"]);

    const confirmation = createConfirmationToken(prepared, "outer-confirmation-secret");
    const receipt = await endpoint.publish(prepared, confirmation, fixture.context);
    expect(receipt).toMatchObject({
      endpoint: "wechat-draft-baoyu",
      state: "draft_created",
      checkpoint: "draft_created",
      statusLocator: {
        account: "blog",
        mediaId: "endpoint-fixture-media-id",
        fingerprint: prepared.providerFingerprint,
      },
    });
    expect(receipt.sideEffects).toEqual([
      { type: "wechat_draft", account: "blog", mediaId: "endpoint-fixture-media-id" },
    ]);

    expect(fixture.control.calls.map((call) => call.argv.includes("--dry-run"))).toEqual([true, true, false]);
    const realCall = fixture.control.calls.at(-1)!;
    expect(realCall.argv).toContain(await realpath(fixture.frozen.htmlPath));
    expect(valueAfter(realCall.argv, "--cover")).toBe(await realpath(fixture.frozen.coverPath!));
    expect(valueAfter(realCall.argv, "--account")).toBe("blog");
    expect(valueAfter(realCall.argv, "--theme")).toBe("moyu-green");
    expect(await readReceipt(path.join(fixture.runRoot, "receipts", "wechat-draft-baoyu.json"))).toEqual(receipt);
  });

  test("returns the persisted terminal receipt without a second provider call", async () => {
    const fixture = await endpointFixture();
    const endpoint = new WechatDraftEndpoint();
    const prepared = await endpoint.prepare(fixture.article, fixture.context);
    const confirmation = createConfirmationToken(prepared, "outer-confirmation-secret");
    const first = await endpoint.publish(prepared, confirmation, fixture.context);
    const callsAfterFirst = fixture.control.calls.length;
    const second = await endpoint.publish(prepared, confirmation, fixture.context);

    expect(second).toEqual(first);
    expect(second.receiptId).toBe(first.receiptId);
    expect(fixture.control.calls).toHaveLength(callsAfterFirst);
  });

  test("rebuilds a draft-created receipt from the provider journal without a duplicate call", async () => {
    const fixture = await endpointFixture();
    const endpoint = new WechatDraftEndpoint();
    const prepared = await endpoint.prepare(fixture.article, fixture.context);
    const confirmation = createConfirmationToken(prepared, "outer-confirmation-secret");
    await endpoint.publish(prepared, confirmation, fixture.context);
    const callsAfterFirst = fixture.control.calls.length;
    await rm(path.join(fixture.runRoot, "receipts", "wechat-draft-baoyu.json"));

    const recovered = await endpoint.publish(prepared, confirmation, fixture.context);
    expect(recovered).toMatchObject({
      state: "draft_created",
      checkpoint: "journal_recovered:draft_created",
      statusLocator: { account: "blog", mediaId: "endpoint-fixture-media-id" },
    });
    expect(recovered.sideEffects).toEqual([{
      type: "wechat_draft",
      account: "blog",
      mediaId: "endpoint-fixture-media-id",
      recovered: true,
    }]);
    expect(fixture.control.calls).toHaveLength(callsAfterFirst);
  });

  test("maps a body-image upload failure to a non-retryable partial receipt", async () => {
    const fixture = await endpointFixture("partial");
    const endpoint = new WechatDraftEndpoint();
    const prepared = await endpoint.prepare(fixture.article, fixture.context);
    const receipt = await endpoint.publish(
      prepared,
      createConfirmationToken(prepared, "outer-confirmation-secret"),
      fixture.context,
    );

    expect(receipt).toMatchObject({
      state: "partial",
      checkpoint: "partial",
      error: { code: "E_DRAFT_CONTENT_PARTIAL", retryable: false, outcome: "partial" },
      statusLocator: { account: "blog", mediaId: "endpoint-fixture-media-id" },
    });
    expect(receipt.sideEffects).toEqual([
      { type: "wechat_draft", account: "blog", mediaId: "endpoint-fixture-media-id" },
    ]);
    expect(fixture.control.calls.filter((call) => !call.argv.includes("--dry-run"))).toHaveLength(1);
  });

  test("maps an ambiguous timeout to outcome_unknown and never retries it", async () => {
    const fixture = await endpointFixture("timeout");
    const endpoint = new WechatDraftEndpoint();
    const prepared = await endpoint.prepare(fixture.article, fixture.context);
    const confirmation = createConfirmationToken(prepared, "outer-confirmation-secret");
    const receipt = await endpoint.publish(prepared, confirmation, fixture.context);

    expect(receipt).toMatchObject({
      state: "outcome_unknown",
      checkpoint: "outcome_unknown",
      error: { code: "E_BAOYU_TIMEOUT", retryable: false, outcome: "unknown" },
      statusLocator: { account: "blog", fingerprint: prepared.providerFingerprint },
    });
    expect(receipt.sideEffects).toEqual([
      { type: "wechat_remote_outcome", account: "blog", outcome: "unknown" },
    ]);
    const callsAfterUnknown = fixture.control.calls.length;
    expect(await endpoint.publish(prepared, confirmation, fixture.context)).toEqual(receipt);
    expect(fixture.control.calls).toHaveLength(callsAfterUnknown);
  });

  test("blocks a stale outer confirmation, changed account, and changed frozen candidate", async () => {
    const fixture = await endpointFixture();
    const endpoint = new WechatDraftEndpoint();
    const prepared = await endpoint.prepare(fixture.article, fixture.context);
    const confirmation = createConfirmationToken(prepared, "outer-confirmation-secret");
    const callsAfterPrepare = fixture.control.calls.length;

    await expect(endpoint.publish(prepared, createConfirmationToken(prepared, "wrong-secret"), fixture.context))
      .rejects.toMatchObject({ data: { code: "E_CONFIRMATION" } });
    expect(fixture.control.calls).toHaveLength(callsAfterPrepare);

    fixture.context.options.account = "other";
    await expect(endpoint.publish(prepared, confirmation, fixture.context))
      .rejects.toMatchObject({ data: { code: "E_WECHAT_OPTIONS_STALE" } });
    expect(fixture.control.calls).toHaveLength(callsAfterPrepare);

    fixture.context.options.account = "blog";
    const changed = await freezeVariant(fixture, "two", "这是第二份已冻结候选。");
    expect(changed.renderDigest).not.toBe(prepared.renderDigest);
    fixture.context.options.frozenRoot = changed.root;
    await expect(endpoint.publish(prepared, confirmation, fixture.context))
      .rejects.toMatchObject({ data: { code: "E_WECHAT_RENDER_STALE" } });
    expect(fixture.control.calls).toHaveLength(callsAfterPrepare);
  });
});
