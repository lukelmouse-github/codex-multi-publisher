import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { digestCanonical, sha256Bytes } from "../src/canonical-json";
import type { ArticlePackage } from "../src/types";
import {
  freezeWechatCandidate,
  verifyFrozenWechatCandidate,
  type FreezeWechatCandidateOptions,
  type GzhDesignProvenanceInput,
} from "../src/wechat-freeze";
import { extractWechatPreviewPayload } from "../src/wechat-html";
import { WECHAT_BODY_IMAGE_MAX_BYTES } from "../src/wechat-images";
import { renderWechatCode, WECHAT_CODE_SLOT_PREFIX } from "../src/wechat-code";

const fixturePath = fileURLToPath(new URL("./fixtures/wechat/original-green.html", import.meta.url));
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "publish-article-wechat-freeze-"));
  cleanup.push(root);
  return root;
}

interface FixtureBuffers {
  cover: Buffer;
  opaque: Buffer;
  transparent: Buffer;
  screenshot: Buffer;
}

async function makeBuffers(): Promise<FixtureBuffers> {
  const cover = await sharp({
    create: { width: 600, height: 315, channels: 3, background: { r: 4, g: 120, b: 87 } },
  })
    .webp({ lossless: true })
    .toBuffer();
  const opaque = await sharp({
    create: { width: 320, height: 180, channels: 3, background: { r: 16, g: 185, b: 129 } },
  })
    .webp({ lossless: true })
    .toBuffer();
  const transparent = await sharp({
    create: { width: 160, height: 90, channels: 4, background: { r: 52, g: 211, b: 153, alpha: 0.45 } },
  })
    .webp({ lossless: true })
    .toBuffer();
  const screenshot = await sharp({
    create: { width: 240, height: 160, channels: 3, background: { r: 236, g: 253, b: 245 } },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { cover, opaque, transparent, screenshot };
}

function provenance(): GzhDesignProvenanceInput {
  return {
    repository: "https://github.com/isjiamu/gzh-design-skill",
    revision: "ba1f4175519b481cb3566616c9e5178705067904",
    license: "AGPL-3.0-or-later",
    licenseSha256: sha256Bytes("fixture AGPL license"),
    themeId: "moyu-green",
    runnerContract: "gzh-design-sidecar/v1",
    toolchainLockDigest: sha256Bytes("fixture toolchain lock"),
    files: [
      { path: "references/theme-moyu-green.md", sha256: sha256Bytes("theme") },
      { path: "SKILL.md", sha256: sha256Bytes("skill") },
      { path: "references/common-components.md", sha256: sha256Bytes("common") },
    ],
  };
}

async function createFixture(
  root: string,
  buffers: FixtureBuffers,
): Promise<{ options: FreezeWechatCandidateOptions; article: ArticlePackage; sourceDigests: string[] }> {
  const packageRoot = path.join(root, "package");
  const assetRoot = path.join(packageRoot, "assets");
  const candidateRoot = path.join(root, "candidate");
  await mkdir(assetRoot, { recursive: true });
  await mkdir(candidateRoot, { recursive: true });

  const files = [
    ["cover.webp", buffers.cover],
    ["inline.webp", buffers.opaque],
    ["transparent.webp", buffers.transparent],
    ["screenshot.png", buffers.screenshot],
  ] as const;
  for (const [name, bytes] of files) await writeFile(path.join(assetRoot, name), bytes);
  const body = "# 原创绿色测试稿\n\n内容只用于冻结测试。\n";
  await writeFile(path.join(packageRoot, "body.md"), body);
  const candidateHtmlPath = path.join(candidateRoot, "wechat-candidate.html");
  await writeFile(candidateHtmlPath, await readFile(fixturePath));

  const article: ArticlePackage = {
    schemaVersion: 1,
    articleId: "wechat-fixture",
    revision: digestCanonical({ fixture: "wechat-fixture", version: 1 }),
    metadata: {
      title: "原创绿色测试稿",
      slug: "wechat-fixture",
      summary: "验证微信候选冻结。",
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
        path: "assets/cover.webp",
        sha256: sha256Bytes(buffers.cover),
        mediaType: "image/webp",
        bytes: buffers.cover.byteLength,
        role: "cover",
      },
      {
        id: "inline-opaque",
        path: "assets/inline.webp",
        sha256: sha256Bytes(buffers.opaque),
        mediaType: "image/webp",
        bytes: buffers.opaque.byteLength,
        role: "inline",
      },
      {
        id: "inline-transparent",
        path: "assets/transparent.webp",
        sha256: sha256Bytes(buffers.transparent),
        mediaType: "image/webp",
        bytes: buffers.transparent.byteLength,
        role: "inline",
      },
      {
        id: "screenshot",
        path: "assets/screenshot.png",
        sha256: sha256Bytes(buffers.screenshot),
        mediaType: "image/png",
        bytes: buffers.screenshot.byteLength,
        role: "screenshot",
      },
    ],
    provenance: {
      sourceId: "fixture-source",
      sourceDigest: sha256Bytes("fixture source"),
      packagerVersion: 1,
    },
  };

  return {
    article,
    sourceDigests: files.map(([, bytes]) => sha256Bytes(bytes)),
    options: {
      article,
      packageRoot,
      candidateHtmlPath,
      candidateRoot,
      frozenRoot: path.join(root, "frozen"),
      provenance: provenance(),
    },
  };
}

describe("freezeWechatCandidate", () => {
  test("freezes exact HTML, JPG/PNG assets, render digest, preview, and AGPL provenance", async () => {
    const root = await tempRoot();
    const buffers = await makeBuffers();
    const fixture = await createFixture(root, buffers);
    const result = await freezeWechatCandidate(fixture.options);
    const verified = await verifyFrozenWechatCandidate(result.root);

    expect(result.renderDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verified.renderDigest).toBe(result.renderDigest);
    expect(result.provenanceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.manifest.assets).toHaveLength(4);
    expect(result.manifest.codeFidelity).toMatchObject({
      schemaVersion: 1,
      renderer: "wechat-code-inline/v1",
      blockCount: 0,
      sourceBodySha256: fixture.article.body.sha256,
    });
    expect(result.manifest.codeFidelity.sourceProjectionSha256)
      .toBe(result.manifest.codeFidelity.renderedProjectionSha256);
    expect(result.manifest.assets.every((asset) => ["image/jpeg", "image/png"].includes(asset.mediaType))).toBe(true);
    expect(result.manifest.assets.find((asset) => asset.id === "cover")?.role).toBe("cover");
    expect(
      result.manifest.assets
        .filter((asset) => asset.role !== "cover")
        .every((asset) => asset.bytes <= WECHAT_BODY_IMAGE_MAX_BYTES),
    ).toBe(true);
    expect(result.manifest.assets.find((asset) => asset.id === "inline-transparent")?.mediaType).toBe("image/png");
    expect(result.manifest.assets.find((asset) => asset.id === "inline-opaque")?.mediaType).toBe("image/jpeg");
    expect(result.coverPath).toMatch(/\.jpg$/);

    const html = await readFile(result.htmlPath, "utf8");
    const preview = await readFile(result.previewPath, "utf8");
    expect(extractWechatPreviewPayload(preview)).toBe(html);
    expect(html).not.toContain("asset://");
    expect(html).not.toContain(".webp");
    expect(html).not.toContain(root);

    const sidecarBytes = await readFile(result.provenancePath, "utf8");
    expect(sidecarBytes).toContain('"license":"AGPL-3.0-or-later"');
    expect(sidecarBytes).toContain('"repository":"https://github.com/isjiamu/gzh-design-skill"');
    expect(sidecarBytes).not.toContain(root);
    expect(sidecarBytes).not.toContain("createdAt");

    const sourcePaths = fixture.article.assets.map((asset) => path.join(fixture.options.packageRoot, asset.path));
    expect(await Promise.all(sourcePaths.map(async (file) => sha256Bytes(await readFile(file))))).toEqual(fixture.sourceDigests);
  });

  test("produces stable digests in different scratch directories", async () => {
    const root = await tempRoot();
    const buffers = await makeBuffers();
    const first = await createFixture(path.join(root, "one"), buffers);
    const second = await createFixture(path.join(root, "two"), buffers);

    const firstFrozen = await freezeWechatCandidate(first.options);
    const secondFrozen = await freezeWechatCandidate(second.options);
    expect(firstFrozen.renderDigest).toBe(secondFrozen.renderDigest);
    expect(firstFrozen.provenanceDigest).toBe(secondFrozen.provenanceDigest);
    expect(firstFrozen.manifest).toEqual(secondFrozen.manifest);
    expect(firstFrozen.provenance).toEqual(secondFrozen.provenance);
  });

  test("detects any mutation after freezing", async () => {
    const root = await tempRoot();
    const fixture = await createFixture(root, await makeBuffers());
    const result = await freezeWechatCandidate(fixture.options);
    await writeFile(result.htmlPath, `${await readFile(result.htmlPath, "utf8")} `);
    await expect(verifyFrozenWechatCandidate(result.root)).rejects.toMatchObject({
      data: { code: "E_WECHAT_HTML_DIGEST" },
    });
  });

  test("rejects a frozen image symlink that resolves outside the frozen root", async () => {
    const root = await tempRoot();
    const fixture = await createFixture(root, await makeBuffers());
    const result = await freezeWechatCandidate(fixture.options);
    const asset = result.manifest.assets.find((item) => item.role !== "cover")!;
    const assetPath = path.join(result.root, asset.path);
    const outside = path.join(root, "outside-image");
    await writeFile(outside, await readFile(assetPath));
    await unlink(assetPath);
    await symlink(outside, assetPath);

    await expect(verifyFrozenWechatCandidate(result.root)).rejects.toMatchObject({
      data: { code: "E_PATH_ESCAPE" },
    });
  });

  test("rejects images outside ArticlePackage, an invalid AGPL sidecar, and an existing frozen root", async () => {
    const root = await tempRoot();
    const fixture = await createFixture(root, await makeBuffers());
    await writeFile(
      fixture.options.candidateHtmlPath,
      '<section><p><span leaf="">原创正文。</span></p><img src="asset://not-owned"></section>',
    );
    await expect(freezeWechatCandidate(fixture.options)).rejects.toMatchObject({
      data: { code: "E_WECHAT_ASSET_UNKNOWN" },
    });

    const invalidLicense = await createFixture(path.join(root, "invalid-license"), await makeBuffers());
    invalidLicense.options.provenance = { ...invalidLicense.options.provenance, license: "MIT" };
    await expect(freezeWechatCandidate(invalidLicense.options)).rejects.toMatchObject({
      data: { code: "E_GZH_LICENSE" },
    });

    const existing = await createFixture(path.join(root, "existing"), await makeBuffers());
    await mkdir(existing.options.frozenRoot, { recursive: true });
    await expect(freezeWechatCandidate(existing.options)).rejects.toMatchObject({
      data: { code: "E_WECHAT_ALREADY_FROZEN" },
    });
  });

  test("refuses unmarked code before freezing and accepts source-rendered code slots", async () => {
    const root = await tempRoot();
    const fixture = await createFixture(root, await makeBuffers());
    const body = ["# Code", "", "```json", "{", '  \"nested\": true', "}", "```", ""].join("\n");
    fixture.article.body.sha256 = sha256Bytes(body);
    await writeFile(path.join(fixture.options.packageRoot, "body.md"), body);
    await writeFile(
      fixture.options.candidateHtmlPath,
      '<section><p><span leaf="">代码。</span></p><section style="margin:0;background:#1E293B;"><section style="display:flex;"><span style="font-family:Consolas,monospace;"><span leaf="">json</span></span></section><section><p style="font-family:Consolas,monospace;"><span leaf="">{\"nested\":true}</span></p></section></section></section>',
    );
    await expect(freezeWechatCandidate(fixture.options)).rejects.toMatchObject({
      data: { code: "E_WECHAT_CODE_FIDELITY" },
    });

    const rendered = await renderWechatCode({
      markdown: body,
      candidateHtml: `<section><p><span leaf="">代码。</span></p><!--${WECHAT_CODE_SLOT_PREFIX}0--></section>`,
    });
    await writeFile(fixture.options.candidateHtmlPath, rendered.html);
    const frozen = await freezeWechatCandidate(fixture.options);
    expect(frozen.manifest.codeFidelity.blockCount).toBe(1);
    expect(frozen.manifest.codeFidelity.sourceProjectionSha256)
      .toBe(frozen.manifest.codeFidelity.renderedProjectionSha256);
  });
});
