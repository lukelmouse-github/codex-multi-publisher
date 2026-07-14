import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { executeCli } from "../src/cli";
import { sha256Bytes } from "../src/canonical-json";
import type { ArticlePackage } from "../src/types";
import { WECHAT_CODE_SLOT_PREFIX } from "../src/wechat-code";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; repo: string; source: string; image: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "publish-cli-test-"));
  roots.push(root);
  const repo = path.join(root, "blog");
  const sourceRoot = path.join(root, "notes");
  await mkdir(path.join(sourceRoot, "images"), { recursive: true });
  await mkdir(repo);
  const source = path.join(sourceRoot, "article.md");
  const image = path.join(sourceRoot, "images", "proof.png");
  await writeFile(image, "png fixture bytes");
  await writeFile(source, [
    "---",
    "title: CLI article",
    "summary: CLI fixture summary",
    "author: Example Author",
    "language: zh-CN",
    "date: 2026-07-01T00:00:00+08:00",
    "---",
    "",
    "# CLI article",
    "",
    "![proof](images/proof.png)",
    "",
  ].join("\n"));
  return { root, repo, source, image };
}

async function run(
  cwd: string,
  command: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(err || out || `${command} ${args[0] ?? ""} failed`);
  return { code, out: out.trim(), err: err.trim() };
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run(cwd, "git", args)).out;
}

async function initializeLocalBlog(setup: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const remote = path.join(setup.root, "remote.git");
  const versionOutput = (await run(setup.repo, "hugo", ["version"])).out;
  const version = /v(\d+\.\d+\.\d+)/u.exec(versionOutput)?.[1];
  if (!version) throw new Error(`Unable to parse Hugo version: ${versionOutput}`);

  await git(setup.root, ["init", "--bare", remote]);
  await git(setup.repo, ["init", "-b", "main"]);
  await git(setup.repo, ["config", "user.name", "Publish CLI Test"]);
  await git(setup.repo, ["config", "user.email", "publish-cli@example.test"]);
  await git(setup.repo, ["config", "core.hooksPath", ".git/hooks"]);
  await mkdir(path.join(setup.repo, "layouts", "_default"), { recursive: true });
  await mkdir(path.join(setup.repo, "static", "css"), { recursive: true });
  await writeFile(path.join(setup.repo, "hugo.toml"), [
    'baseURL = "https://example.test/"',
    'languageCode = "zh-cn"',
    'title = "Publish CLI Test"',
    "",
  ].join("\n"));
  await writeFile(path.join(setup.repo, "vercel.json"), JSON.stringify({
    build: { env: { HUGO_VERSION: version } },
  }));
  await writeFile(
    path.join(setup.repo, "layouts", "_default", "single.html"),
    '<!doctype html><html><head><title>{{ .Title }}</title><link rel="stylesheet" href="/css/main.css"></head><body><div class="post-content md-content">{{ .Content }}</div></body></html>\n',
  );
  await writeFile(
    path.join(setup.repo, "static", "css", "main.css"),
    ".md-content .highlight{}\n.md-content pre code{}\n.chroma{}\n",
  );
  await writeFile(path.join(setup.repo, "README.md"), "seed blog\n");
  await git(setup.repo, [
    "add",
    "README.md",
    "hugo.toml",
    "vercel.json",
    "layouts/_default/single.html",
    "static/css/main.css",
  ]);
  await git(setup.repo, ["commit", "-m", "seed blog"]);
  await git(setup.repo, ["remote", "add", "origin", remote]);
  await git(setup.repo, ["push", "-u", "origin", "main"]);
  return remote;
}

describe("publish-article CLI", () => {
  test("imports an arbitrary local article read-only and freezes a stable ArticlePackage", async () => {
    const setup = await fixture();
    const before = await Promise.all([setup.source, setup.image].map(async (file) => sha256Bytes(await readFile(file))));
    const imported = await executeCli([
      "import",
      "--source",
      setup.source,
      "--repo",
      setup.repo,
    ]);
    const runRoot = imported.runRoot as string;
    expect(runRoot).toStartWith(path.join(await realpath(setup.repo), ".publish", "work"));
    expect(imported.assets).toBe(1);
    expect(imported.metadata).toMatchObject({ title: "CLI article", publishedAt: "2026-07-01T00:00:00+08:00" });
    expect(imported.remoteImageReferences).toEqual([]);

    const packaged = await executeCli(["package", "--run", runRoot, "--repo", setup.repo]);
    const articlePath = path.join(packaged.packageRoot as string, "article.json");
    const article = JSON.parse(await readFile(articlePath, "utf8")) as ArticlePackage;
    expect(article.metadata.title).toBe("CLI article");
    expect(article.metadata.publishedAt).toBe("2026-07-01T00:00:00+08:00");
    expect(article.assets).toHaveLength(1);
    expect(article.assets[0]?.path).toMatch(/^assets\/[a-f0-9]{64}\.png$/);
    expect(JSON.stringify(article)).not.toContain(setup.root);

    const packagedAgain = await executeCli(["package", "--run", runRoot, "--repo", setup.repo]);
    expect(packagedAgain.revision).toBe(packaged.revision);
    const after = await Promise.all([setup.source, setup.image].map(async (file) => sha256Bytes(await readFile(file))));
    expect(after).toEqual(before);
  });

  test("blocks unlisted files in the draft asset directory", async () => {
    const setup = await fixture();
    const imported = await executeCli(["import", "--source", setup.source, "--repo", setup.repo]);
    const runRoot = imported.runRoot as string;
    await writeFile(path.join(runRoot, "draft", "assets", "forgotten.png"), "not registered");
    await expect(executeCli(["package", "--run", runRoot, "--repo", setup.repo]))
      .rejects.toThrow("missing from metadata.json");
  });

  test("returns help and rejects unknown commands", async () => {
    expect((await executeCli(["--help"])).help).toContain("only creates a private draft");
    expect((await executeCli(["--help"])).help).toContain("validate-wechat");
    await expect(executeCli(["freepublish"])).rejects.toThrow("Unknown command");
  });

  test("renders explicit WeChat code slots and validates fidelity without a remote side effect", async () => {
    const setup = await fixture();
    const imported = await executeCli(["import", "--source", setup.source, "--repo", setup.repo]);
    const workingRun = imported.runRoot as string;
    await writeFile(path.join(workingRun, "draft", "body.md"), [
      "# CLI article",
      "",
      "```json",
      "{",
      '\t\"nested\": \"<safe>\"',
      "}",
      "```",
      "",
    ].join("\n"));
    const packaged = await executeCli(["package", "--run", workingRun, "--repo", setup.repo]);
    const candidate = path.join(workingRun, "working", "candidate.html");
    const output = path.join(workingRun, "working", "code-rendered.html");
    await mkdir(path.dirname(candidate), { recursive: true });
    await writeFile(
      candidate,
      `<section><p><span leaf="">正文。</span></p><!--${WECHAT_CODE_SLOT_PREFIX}0--></section>`,
    );

    const rendered = await executeCli([
      "render-wechat-code",
      "--run",
      workingRun,
      "--html",
      candidate,
      "--output",
      output,
      "--repo",
      setup.repo,
    ]);
    expect(rendered.mode).toBe("slots");
    expect((rendered.fidelity as { ok: boolean }).ok).toBe(true);
    expect(await readFile(output, "utf8")).toContain("&nbsp;&nbsp;&nbsp;&nbsp;");

    const validated = await executeCli([
      "validate-wechat",
      "--run",
      packaged.runRoot as string,
      "--html",
      output,
      "--repo",
      setup.repo,
    ]);
    expect((validated.fidelity as { ok: boolean }).ok).toBe(true);
    expect(validated.htmlSha256).toBe(rendered.htmlSha256);

    const broken = path.join(workingRun, "working", "broken.html");
    await writeFile(broken, (await readFile(output, "utf8")).replace("&nbsp;&nbsp;&nbsp;&nbsp;", ""));
    await expect(executeCli([
      "validate-wechat",
      "--run",
      workingRun,
      "--html",
      broken,
      "--repo",
      setup.repo,
    ])).rejects.toMatchObject({ data: { code: "E_WECHAT_CODE_FIDELITY" } });
  });

  test("publishes a Blog end to end to a local bare remote and reports its status", async () => {
    const setup = await fixture();
    const remote = await initializeLocalBlog(setup);

    const imported = await executeCli(["import", "--source", setup.source, "--repo", setup.repo]);
    const packaged = await executeCli([
      "package",
      "--run",
      imported.runRoot as string,
      "--repo",
      setup.repo,
    ]);
    const runRoot = packaged.runRoot as string;
    const slug = (packaged.metadata as { slug: string }).slug;

    const rendered = await executeCli(["render-blog", "--run", runRoot, "--repo", setup.repo]);
    expect((rendered.validation as { ok: boolean }).ok).toBe(true);
    expect(rendered.diff as string).toContain("index.md");

    const prepared = await executeCli([
      "prepare",
      "--run",
      runRoot,
      "--targets",
      "blog",
      "--repo",
      setup.repo,
    ]);
    expect(prepared.report as string).toContain(`content/posts/${slug}`);

    const published = await executeCli([
      "publish",
      "--run",
      runRoot,
      "--confirm",
      prepared.confirmationToken as string,
      "--repo",
      setup.repo,
    ]);
    const receipts = published.receipts as Array<{
      state: string;
      statusLocator?: { commit?: string };
    }>;
    expect(published.ok).toBe(true);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.state).toBe("pushed");
    const commit = receipts[0]?.statusLocator?.commit;
    expect(commit).toMatch(/^[a-f0-9]{40}$/);

    expect(await git(setup.root, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(commit!);
    expect(await git(setup.root, [
      "--git-dir",
      remote,
      "show",
      `main:content/posts/${slug}/index.md`,
    ])).toContain("CLI article");
    const changedPaths = (await git(setup.root, [
      "--git-dir",
      remote,
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      commit!,
    ])).split("\n").filter(Boolean);
    expect(changedPaths.length).toBeGreaterThan(0);
    expect(changedPaths.every((entry) => entry.startsWith(`content/posts/${slug}/`))).toBe(true);

    const status = await executeCli(["status", "--run", runRoot, "--repo", setup.repo]);
    const endpoints = status.endpoints as Array<{
      id: string;
      receipt: { state: string };
      status: {
        supported: boolean;
        localCommitExists: boolean;
        remoteObserved: boolean;
        remoteMatchesReceipt: boolean;
        remoteCommit: string;
      };
    }>;
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.id).toBe("blog");
    expect(endpoints[0]?.receipt.state).toBe("pushed");
    expect(endpoints[0]?.status).toMatchObject({
      supported: true,
      localCommitExists: true,
      remoteObserved: true,
      remoteMatchesReceipt: true,
      remoteCommit: commit,
    });
  }, 30_000);
});
