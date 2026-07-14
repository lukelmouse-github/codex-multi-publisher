import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createArticlePackage } from "../src/article-package";
import { importMarkdown } from "../src/import-markdown";

const roots: string[] = [];
const sourcePath = path.join(import.meta.dir, "fixtures", "import-standard", "article.md");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "publish-package-test-"));
  roots.push(root);
  return root;
}

describe("createArticlePackage", () => {
  test("creates a deterministic, portable package under the revision run directory", async () => {
    const importRoot = await tempRoot();
    const imported = await importMarkdown({ sourcePath, outputRoot: path.join(importRoot, "scratch") });
    const firstRoot = await tempRoot();
    const secondRoot = await tempRoot();

    const first = await createArticlePackage({ imported, runsRoot: firstRoot, articleId: "stable-article" });
    const second = await createArticlePackage({ imported, runsRoot: secondRoot, articleId: "stable-article" });

    expect(first.article.revision).toBe(second.article.revision);
    expect(first.article.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(path.basename(first.paths.runRoot)).toBe(first.article.revision.slice("sha256:".length));
    expect(await readFile(first.paths.articleJson, "utf8")).toBe(await readFile(second.paths.articleJson, "utf8"));
    expect(await readFile(first.paths.body, "utf8")).toBe(imported.body);
    expect((await stat(first.paths.assetsRoot)).isDirectory()).toBe(true);

    const manifest = await readFile(first.paths.articleJson, "utf8");
    expect(manifest).not.toContain(importRoot);
    expect(manifest).not.toContain(sourcePath);
    expect(first.article.assets.every((asset) => asset.path.startsWith("assets/"))).toBe(true);
  });

  test("changes the revision when publishable body content changes", async () => {
    const importRoot = await tempRoot();
    const imported = await importMarkdown({ sourcePath, outputRoot: path.join(importRoot, "scratch") });
    const runsRoot = await tempRoot();

    const first = await createArticlePackage({ imported, runsRoot, articleId: "stable-article" });
    const second = await createArticlePackage({
      imported,
      runsRoot,
      articleId: "stable-article",
      body: `${imported.body}\nChanged\n`,
    });

    expect(second.article.revision).not.toBe(first.article.revision);
  });

  test("keeps the package channel-neutral when no Blog publication date exists", async () => {
    const importRoot = await tempRoot();
    const imported = await importMarkdown({ sourcePath, outputRoot: path.join(importRoot, "scratch") });
    const runsRoot = await tempRoot();
    delete imported.frontmatter.date;

    const packaged = await createArticlePackage({ imported, runsRoot, articleId: "missing-date" });
    expect(packaged.article.metadata.publishedAt).toBeUndefined();
  });
});
