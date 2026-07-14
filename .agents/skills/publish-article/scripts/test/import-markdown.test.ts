import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { sha256Bytes } from "../src/canonical-json";
import { importMarkdown } from "../src/import-markdown";

const roots: string[] = [];
const fixtures = path.join(import.meta.dir, "fixtures");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "publish-import-test-"));
  roots.push(root);
  return root;
}

describe("importMarkdown", () => {
  test("imports Markdown and HTML images by content hash while leaving source files untouched", async () => {
    const sourcePath = path.join(fixtures, "import-standard", "article.md");
    const sourceAssetPaths = [
      path.join(fixtures, "import-standard", "images", "diagram one.png"),
      path.join(fixtures, "import-standard", "images", "html.png"),
    ];
    const before = await Promise.all([sourcePath, ...sourceAssetPaths].map(async (file) => sha256Bytes(await Bun.file(file).bytes())));
    const root = await tempRoot();

    const imported = await importMarkdown({ sourcePath, outputRoot: path.join(root, "scratch") });

    expect(imported.frontmatter.title).toBe("Import fixture");
    expect(imported.body).toMatch(/!\[Architecture\]\(asset:\/\/asset-[a-f0-9]{16} "Diagram"\)/);
    expect(imported.body).toMatch(/<img src="asset:\/\/asset-[a-f0-9]{16}" alt="HTML alt">/);
    expect(imported.body).toContain("![Remote](https://example.com/remote.png)");
    expect(imported.assets).toHaveLength(2);
    expect(new Set(imported.assets.map((asset) => asset.id)).size).toBe(2);
    for (const asset of imported.assets) {
      expect(asset.path).toMatch(/^assets\/[a-f0-9]{64}\.png$/);
      expect(asset.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect((await stat(path.join(root, "scratch", asset.path))).isFile()).toBe(true);
    }

    const after = await Promise.all([sourcePath, ...sourceAssetPaths].map(async (file) => sha256Bytes(await Bun.file(file).bytes())));
    expect(after).toEqual(before);
  });

  test("resolves explicit and unique Obsidian embeds but blocks ambiguous basenames", async () => {
    const vaultRoot = path.join(fixtures, "import-obsidian", "vault");
    const root = await tempRoot();
    const imported = await importMarkdown({
      sourcePath: path.join(vaultRoot, "notes", "article.md"),
      outputRoot: path.join(root, "scratch"),
      vaultRoot,
    });

    expect(imported.assets).toHaveLength(2);
    expect(imported.body).not.toContain("![[");
    expect(imported.body.match(/asset:\/\/asset-/g)).toHaveLength(2);

    await expect(importMarkdown({
      sourcePath: path.join(vaultRoot, "notes", "ambiguous.md"),
      outputRoot: path.join(root, "ambiguous"),
      vaultRoot,
    })).rejects.toThrow("ambiguous");
  });

  test("rejects traversal and symlink escapes", async () => {
    const root = await tempRoot();
    const sourceRoot = path.join(root, "source");
    await Bun.write(path.join(sourceRoot, "article.md"), "![escape](../outside.png)\n");
    await Bun.write(path.join(root, "outside.png"), "outside");

    await expect(importMarkdown({
      sourcePath: path.join(sourceRoot, "article.md"),
      outputRoot: path.join(root, "scratch-one"),
    })).rejects.toThrow("outside");

    await writeFile(path.join(sourceRoot, "article.md"), "![escape](linked.png)\n");
    await symlink(path.join(root, "outside.png"), path.join(sourceRoot, "linked.png"));
    await expect(importMarkdown({
      sourcePath: path.join(sourceRoot, "article.md"),
      outputRoot: path.join(root, "scratch-two"),
    })).rejects.toThrow("outside");
  });

  test("does not allow the scratch directory to overlap the read-only source tree", async () => {
    const sourceRoot = path.join(fixtures, "import-standard");
    await expect(importMarkdown({
      sourcePath: path.join(sourceRoot, "article.md"),
      outputRoot: path.join(sourceRoot, ".scratch"),
    })).rejects.toThrow("outputRoot");
    expect(await readdir(sourceRoot)).not.toContain(".scratch");
  });
});
