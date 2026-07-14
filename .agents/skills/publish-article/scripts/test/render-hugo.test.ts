import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { ArticlePackage } from "../src/types";
import { renderHugoBundle, rewriteAssetUris } from "../src/render-hugo";
import { diffDirectories, readExpectedHugoVersion, validateHugoCandidate } from "../src/hugo-validator";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function article(): ArticlePackage {
  return {
    schemaVersion: 1,
    articleId: "sample",
    revision: "sha256:revision",
    metadata: {
      title: "示例文章",
      slug: "sample-post",
      summary: "摘要",
      author: "Example Author",
      language: "zh-CN",
      tags: ["AI"],
      categories: ["技术"],
      publishedAt: "2026-07-01T00:00:00+08:00",
      coverAssetId: "cover",
    },
    body: { path: "body.md", sha256: "sha256:body" },
    assets: [
      {
        id: "cover",
        path: "assets/cover.png",
        sha256: "sha256:cover",
        mediaType: "image/png",
        bytes: 3,
        role: "cover",
        alt: "封面",
      },
    ],
    provenance: { sourceId: "source", sourceDigest: "sha256:source", packagerVersion: 1 },
  };
}

describe("renderHugoBundle", () => {
  test("rewrites asset URIs and emits a PaperMod leaf bundle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "publish-hugo-test-"));
    roots.push(root);
    const packageRoot = path.join(root, "package");
    await mkdir(path.join(packageRoot, "assets"), { recursive: true });
    await writeFile(path.join(packageRoot, "body.md"), "# 正文\n\n![封面](asset://cover)\n");
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "#059669" } })
      .png()
      .toFile(path.join(packageRoot, "assets", "cover.png"));

    const result = await renderHugoBundle(article(), packageRoot, path.join(root, "render"), {
      now: new Date("2026-07-14T00:00:00+08:00"),
    });
    const output = await readFile(result.articlePath, "utf8");
    expect(output).toContain("draft = false");
    expect(output).toContain('title = "示例文章"');
    expect(output).toContain("![封面](assets/cover.png)");
    expect((await stat(path.join(result.bundleRoot, "assets", "cover.png"))).size).toBeGreaterThan(0);
  });

  test("rejects unknown asset references", () => {
    expect(() => rewriteAssetUris("![](asset://missing)", article())).toThrow("Unknown asset reference");
  });

  test("requires a publication date at the Hugo renderer boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "publish-hugo-date-"));
    roots.push(root);
    const packageRoot = path.join(root, "package");
    await mkdir(path.join(packageRoot, "assets"), { recursive: true });
    await writeFile(path.join(packageRoot, "body.md"), "# Body\n");
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "#059669" } })
      .png()
      .toFile(path.join(packageRoot, "assets", "cover.png"));
    const missingDate = article();
    delete missingDate.metadata.publishedAt;

    await expect(renderHugoBundle(missingDate, packageRoot, path.join(root, "render")))
      .rejects.toMatchObject({ data: { code: "E_DATE_REQUIRED" } });
  });

  test("renders the candidate under the configured Hugo content section", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "publish-hugo-section-"));
    roots.push(root);
    const packageRoot = path.join(root, "package");
    await mkdir(path.join(packageRoot, "assets"), { recursive: true });
    await writeFile(path.join(packageRoot, "body.md"), "# Body\n");
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "#059669" } })
      .png()
      .toFile(path.join(packageRoot, "assets", "cover.png"));

    const result = await renderHugoBundle(article(), packageRoot, path.join(root, "render"), {
      now: new Date("2026-07-14T00:00:00+08:00"),
      contentRoot: "content/articles",
    });
    expect(result.bundleRoot).toBe(path.join(result.contentRoot, "articles", "sample-post"));
    expect((await stat(path.join(result.bundleRoot, "index.md"))).isFile()).toBe(true);
  });

  test("normalizes Windows-style contentRoot separators", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "publish-hugo-windows-root-"));
    roots.push(root);
    const packageRoot = path.join(root, "package");
    await mkdir(path.join(packageRoot, "assets"), { recursive: true });
    await writeFile(path.join(packageRoot, "body.md"), "# Body\n");
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "#059669" } })
      .png()
      .toFile(path.join(packageRoot, "assets", "cover.png"));

    const result = await renderHugoBundle(article(), packageRoot, path.join(root, "render"), {
      now: new Date("2026-07-14T00:00:00+08:00"),
      contentRoot: "content\\articles",
    });
    expect(result.bundleRoot).toBe(path.join(result.contentRoot, "articles", "sample-post"));
  });

  test("builds the candidate with a self-contained Hugo repository fixture", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "publish-hugo-build-"));
    roots.push(root);
    const repoRoot = path.join(root, "repo");
    await mkdir(path.join(repoRoot, "layouts", "_default"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "vercel.json"),
      `${JSON.stringify({ build: { env: { HUGO_VERSION: "0.163.1" } } }, null, 2)}\n`,
    );
    await writeFile(path.join(repoRoot, "hugo.toml"), 'baseURL = "https://example.invalid/"\n');
    await writeFile(
      path.join(repoRoot, "layouts", "_default", "single.html"),
      "<!doctype html><html><body><h1>{{ .Title }}</h1>{{ with .Resources.GetMatch \"assets/*\" }}{{ $image := .Resize \"1x1\" }}<img src=\"{{ $image.RelPermalink }}\">{{ end }}{{ .Content }}</body></html>\n",
    );
    const packageRoot = path.join(root, "package");
    await mkdir(path.join(packageRoot, "assets"), { recursive: true });
    await writeFile(path.join(packageRoot, "body.md"), "# 正文\n");
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "#059669" } })
      .png()
      .toFile(path.join(packageRoot, "assets", "cover.png"));
    const rendered = await renderHugoBundle(article(), packageRoot, path.join(root, "render"), {
      now: new Date("2026-07-14T00:00:00+08:00"),
      contentRoot: "content/articles",
    });
    const validation = await validateHugoCandidate(repoRoot, rendered.contentRoot, "sample-post", "articles");
    expect(validation.ok).toBe(true);
    expect(validation.expectedVersion).toBe("0.163.1");
    expect(await stat(path.join(repoRoot, ".hugo_build.lock")).catch(() => undefined)).toBeUndefined();
    expect(await stat(path.join(repoRoot, "resources")).catch(() => undefined)).toBeUndefined();
  });

  test("keeps local absolute paths out of the review diff headers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "publish-hugo-diff-"));
    roots.push(root);
    const current = path.join(root, "content", "posts", "sample-post");
    const candidate = path.join(root, ".publish", "runs", "revision", "renders", "blog", "content", "posts", "sample-post");
    await mkdir(current, { recursive: true });
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(current, "index.md"), "before\n");
    await writeFile(path.join(candidate, "index.md"), "after\n");

    const diff = await diffDirectories(root, current, candidate);
    expect(diff).toContain("diff --git a/bundle/index.md b/bundle/index.md");
    expect(diff).not.toContain(root);
    expect(diff).not.toContain(".publish/runs/revision");
  });

  test("classifies a missing Vercel Hugo contract as a local validation error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "publish-hugo-config-"));
    roots.push(root);

    await expect(readExpectedHugoVersion(root)).rejects.toMatchObject({
      data: {
        code: "E_HUGO_CONFIG",
        kind: "validation",
        outcome: "not_applied",
      },
    });
  });
});
