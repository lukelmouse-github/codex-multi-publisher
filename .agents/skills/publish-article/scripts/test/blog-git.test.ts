import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BlogGitEndpoint } from "../src/endpoints/blog-git";
import { createConfirmationToken, readReceipt, writeReceiptAtomic } from "../src/receipts";
import type { ArticlePackage, EndpointContext } from "../src/types";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[], allowFailure = false): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (!allowFailure && code !== 0) throw new Error(err || out || `git ${args[0]} failed`);
  return { code, out: out.trim(), err: err.trim() };
}

function article(): ArticlePackage {
  return {
    schemaVersion: 1,
    articleId: "sample",
    revision: `sha256:${"a".repeat(64)}`,
    metadata: {
      title: "测试文章",
      slug: "sample",
      summary: "摘要",
      author: "Example Author",
      language: "zh-CN",
      tags: [],
      categories: [],
      publishedAt: "2026-07-01T00:00:00+08:00",
    },
    body: { path: "body.md", sha256: `sha256:${"b".repeat(64)}` },
    assets: [],
    provenance: {
      sourceId: "source",
      sourceDigest: `sha256:${"c".repeat(64)}`,
      packagerVersion: 1,
    },
  };
}

async function fixture(): Promise<{
  root: string;
  repo: string;
  remote: string;
  candidate: string;
  runRoot: string;
  context: EndpointContext;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "publish-blog-git-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  await mkdir(repo);
  await git(root, ["init", "--bare", remote]);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Publish Test"]);
  await git(repo, ["config", "user.email", "publish@example.test"]);
  await writeFile(path.join(repo, "README.md"), "seed\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "seed"]);
  await writeFile(path.join(repo, "seed-2.txt"), "second seed\n");
  await git(repo, ["add", "seed-2.txt"]);
  await git(repo, ["commit", "-m", "second seed"]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main"]);

  const runRoot = path.join(repo, ".publish", "run");
  const candidate = path.join(runRoot, "renders", "blog", "content", "posts", "sample");
  await mkdir(path.join(candidate, "assets"), { recursive: true });
  await writeFile(path.join(candidate, "index.md"), "+++\ntitle = \"测试文章\"\ndraft = false\n+++\n\n正文\n");
  await writeFile(path.join(candidate, "assets", "cover.png"), "image-bytes");
  await writeFile(path.join(repo, "unrelated.txt"), "leave me alone\n");

  const context: EndpointContext = {
    repoRoot: repo,
    runRoot,
    options: {
      article: article(),
      branch: "main",
      remote: "origin",
      contentRoot: "content/posts",
      candidateBundleRoot: candidate,
      commitMessage: "content: publish sample",
    },
  };
  return { root, repo, remote, candidate, runRoot, context };
}

describe("BlogGitEndpoint", () => {
  test("applies, stages, commits and pushes only the managed bundle", async () => {
    const setup = await fixture();
    const endpoint = new BlogGitEndpoint();
    const prepared = await endpoint.prepare(article(), setup.context);
    const receipt = await endpoint.publish(prepared, createConfirmationToken(prepared), setup.context);

    expect(receipt.state).toBe("pushed");
    expect(receipt.sideEffects.map((item) => item.type)).toEqual([
      "worktree_applied",
      "git_commit",
      "git_push",
    ]);
    expect((await git(setup.repo, ["status", "--short", "--", "unrelated.txt"])).out).toBe("?? unrelated.txt");
    expect((await git(setup.repo, ["show", "HEAD:content/posts/sample/index.md"])).out).toContain("测试文章");
    expect((await git(setup.root, ["--git-dir", setup.remote, "show", "main:content/posts/sample/index.md"])).out)
      .toContain("正文");
    expect((await readReceipt(path.join(setup.runRoot, "receipts", "blog-git.json"))).state).toBe("pushed");
  });

  test("keeps a stable commit for a no-op candidate while verifying the remote", async () => {
    const setup = await fixture();
    const endpoint = new BlogGitEndpoint();
    const first = await endpoint.prepare(article(), setup.context);
    await endpoint.publish(first, createConfirmationToken(first), setup.context);
    const before = (await git(setup.repo, ["rev-parse", "HEAD"])).out;

    const second = await endpoint.prepare(article(), setup.context);
    const receipt = await endpoint.publish(second, createConfirmationToken(second), setup.context);
    const after = (await git(setup.repo, ["rev-parse", "HEAD"])).out;

    expect(receipt.state).toBe("pushed");
    expect(after).toBe(before);
    expect(receipt.sideEffects.some((item) => item.type === "git_commit")).toBe(false);
  });

  test("rejects a stale baseline before changing the worktree", async () => {
    const setup = await fixture();
    const endpoint = new BlogGitEndpoint();
    const prepared = await endpoint.prepare(article(), setup.context);
    const target = path.join(setup.repo, "content", "posts", "sample");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "index.md"), "user edit\n");

    await expect(endpoint.publish(prepared, createConfirmationToken(prepared), setup.context))
      .rejects.toThrow("changed after preparation");
    expect(await readFile(path.join(target, "index.md"), "utf8")).toBe("user edit\n");
  });

  test("records a committed checkpoint when the lease-guarded push fails", async () => {
    const setup = await fixture();
    const endpoint = new BlogGitEndpoint();
    const prepared = await endpoint.prepare(article(), setup.context);
    await git(setup.root, ["--git-dir", setup.remote, "config", "core.hooksPath", "hooks"]);
    const rejectHook = path.join(setup.remote, "hooks", "pre-receive");
    await writeFile(rejectHook, "#!/bin/sh\nexit 1\n");
    await chmod(rejectHook, 0o755);

    const receipt = await endpoint.publish(prepared, createConfirmationToken(prepared), setup.context);
    expect(receipt.state).toBe("committed");
    expect(receipt.checkpoint).toBe("push_pending");
    expect(receipt.error?.code).toBe("E_GIT_PUSH");
    expect(receipt.sideEffects.some((item) => item.type === "git_commit")).toBe(true);

    const committedHead = (await git(setup.repo, ["rev-parse", "HEAD"])).out;
    await rm(rejectHook);
    const resumed = await endpoint.publish(prepared, createConfirmationToken(prepared), setup.context);
    expect(resumed.state).toBe("pushed");
    expect((await git(setup.repo, ["rev-parse", "HEAD"])).out).toBe(committedHead);
  });

  test("recovers a confirmed commit made after the publish-started checkpoint", async () => {
    const setup = await fixture();
    const endpoint = new BlogGitEndpoint();
    const prepared = await endpoint.prepare(article(), setup.context);
    const receiptPath = path.join(setup.runRoot, "receipts", "blog-git.json");
    await writeReceiptAtomic(receiptPath, {
      schemaVersion: 1,
      receiptId: "publish-started",
      endpoint: "blog-git",
      articleId: prepared.articleId,
      packageRevision: prepared.packageRevision,
      planDigest: prepared.planDigest,
      idempotencyKey: "publish-started",
      state: "prepared",
      checkpoint: "publish_started",
      sideEffects: [],
    });

    const target = path.join(setup.repo, "content", "posts", "sample");
    await mkdir(path.dirname(target), { recursive: true });
    await cp(setup.candidate, target, { recursive: true });
    await git(setup.repo, ["add", "--", "content/posts/sample"]);
    await git(setup.repo, ["commit", "-m", "content: publish sample", "--", "content/posts/sample"]);
    const recoveredCommit = (await git(setup.repo, ["rev-parse", "HEAD"])).out;

    const receipt = await endpoint.publish(prepared, createConfirmationToken(prepared), setup.context);
    expect(receipt.state).toBe("pushed");
    expect(receipt.sideEffects).toContainEqual(expect.objectContaining({
      type: "git_commit",
      commit: recoveredCommit,
      recovered: true,
    }));
    expect((await git(setup.root, ["--git-dir", setup.remote, "rev-parse", "main"])).out).toBe(recoveredCommit);
  });

  test("refuses a tampered committed checkpoint even when its message and path look valid", async () => {
    const setup = await fixture();
    const endpoint = new BlogGitEndpoint();
    const prepared = await endpoint.prepare(article(), setup.context);
    const target = path.join(setup.repo, "content", "posts", "sample");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "index.md"), "unconfirmed managed bytes\n");
    await git(setup.repo, ["add", "--", "content/posts/sample"]);
    await git(setup.repo, ["commit", "-m", "content: publish sample", "--", "content/posts/sample"]);
    const commit = (await git(setup.repo, ["rev-parse", "HEAD"])).out;
    await rm(target, { recursive: true, force: true });
    await cp(setup.candidate, target, { recursive: true });
    await writeReceiptAtomic(path.join(setup.runRoot, "receipts", "blog-git.json"), {
      schemaVersion: 1,
      receiptId: "tampered-commit",
      endpoint: "blog-git",
      articleId: prepared.articleId,
      packageRevision: prepared.packageRevision,
      planDigest: prepared.planDigest,
      idempotencyKey: "tampered-commit",
      state: "committed",
      checkpoint: "commit_created",
      sideEffects: [{ type: "git_commit", commit }],
      statusLocator: { commit },
    });

    await expect(endpoint.publish(prepared, createConfirmationToken(prepared), setup.context))
      .rejects.toThrow("outside the confirmed plan");
  });

  test("blocks unrelated staged files before preparation", async () => {
    const setup = await fixture();
    await writeFile(path.join(setup.repo, "other.md"), "already staged\n");
    await git(setup.repo, ["add", "other.md"]);
    const endpoint = new BlogGitEndpoint();
    await expect(endpoint.prepare(article(), setup.context)).rejects.toThrow("Unrelated staged files");
  });

  test("binds the real push URL and the synchronized base commit", async () => {
    const setup = await fixture();
    const endpoint = new BlogGitEndpoint();
    const prepared = await endpoint.prepare(article(), setup.context);
    const otherRemote = path.join(setup.root, "other.git");
    await git(setup.root, ["init", "--bare", otherRemote]);
    await git(setup.repo, ["remote", "set-url", "--push", "origin", otherRemote]);
    await expect(endpoint.publish(prepared, createConfirmationToken(prepared), setup.context))
      .rejects.toThrow("push URL");

    await git(setup.repo, ["remote", "set-url", "--push", "origin", setup.remote]);
    await writeFile(path.join(setup.repo, "ahead.md"), "unconfirmed commit\n");
    await git(setup.repo, ["add", "ahead.md"]);
    await git(setup.repo, ["commit", "-m", "unconfirmed"]);
    await expect(endpoint.publish(prepared, createConfirmationToken(prepared), setup.context))
      .rejects.toThrow("HEAD to equal its upstream");
  });

  test("observes and pushes the exact push URL when the fetch URL differs", async () => {
    const setup = await fixture();
    const fetchRemote = path.join(setup.root, "fetch-only.git");
    await git(setup.root, ["clone", "--bare", setup.remote, fetchRemote]);
    const fetchHead = (await git(setup.root, ["--git-dir", fetchRemote, "rev-parse", "main"])).out;
    await git(setup.repo, ["remote", "set-url", "origin", fetchRemote]);
    await git(setup.repo, ["remote", "set-url", "--push", "origin", setup.remote]);

    const endpoint = new BlogGitEndpoint();
    const prepared = await endpoint.prepare(article(), setup.context);
    const receipt = await endpoint.publish(prepared, createConfirmationToken(prepared), setup.context);
    const commit = receipt.statusLocator?.commit as string;

    expect(receipt.state).toBe("pushed");
    expect((await git(setup.root, ["--git-dir", setup.remote, "rev-parse", "main"])).out).toBe(commit);
    expect((await git(setup.root, ["--git-dir", fetchRemote, "rev-parse", "main"])).out).toBe(fetchHead);
    expect(await endpoint.status(receipt, setup.context)).toMatchObject({
      remoteObserved: true,
      remoteMatchesReceipt: true,
      remoteCommit: commit,
    });
  });

  test("uses a repository-global lock across publication runs", async () => {
    const setup = await fixture();
    const endpoint = new BlogGitEndpoint();
    const prepared = await endpoint.prepare(article(), setup.context);
    const lock = path.join(setup.repo, ".publish", "locks", "blog-git.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    await expect(endpoint.publish(prepared, createConfirmationToken(prepared), setup.context))
      .rejects.toMatchObject({ data: { code: "E_BLOG_IN_PROGRESS" } });
  });

  test("rejects a remote race with an exact SHA lease", async () => {
    const setup = await fixture();
    const endpoint = new BlogGitEndpoint();
    const prepared = await endpoint.prepare(article(), setup.context);
    const priorRemoteHead = (await git(setup.repo, ["rev-parse", "HEAD^"])).out;
    await git(setup.repo, ["config", "core.hooksPath", ".git/hooks"]);
    const hook = path.join(setup.repo, ".git", "hooks", "pre-push");
    await writeFile(hook, [
      "#!/bin/sh",
      `git --git-dir=\"${setup.remote}\" update-ref refs/heads/main ${priorRemoteHead}`,
      "exit 0",
      "",
    ].join("\n"));
    await chmod(hook, 0o755);

    const receipt = await endpoint.publish(prepared, createConfirmationToken(prepared), setup.context);
    expect(receipt).toMatchObject({
      state: "committed",
      checkpoint: "remote_changed",
      error: { code: "E_GIT_REMOTE_CHANGED", retryable: false, outcome: "not_applied" },
    });
    expect((await git(setup.root, ["--git-dir", setup.remote, "rev-parse", "main"])).out).toBe(priorRemoteHead);
  });

  test("recovers the deterministic replacement gap after target was moved to backup", async () => {
    const setup = await fixture();
    const target = path.join(setup.repo, "content", "posts", "sample");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "index.md"), "old managed article\n");
    await git(setup.repo, ["add", "--", "content/posts/sample"]);
    await git(setup.repo, ["commit", "-m", "seed managed article"]);
    await git(setup.repo, ["push", "origin", "main"]);

    const endpoint = new BlogGitEndpoint();
    const prepared = await endpoint.prepare(article(), setup.context);
    await writeReceiptAtomic(path.join(setup.runRoot, "receipts", "blog-git.json"), {
      schemaVersion: 1,
      receiptId: "publish-started-gap",
      endpoint: "blog-git",
      articleId: prepared.articleId,
      packageRevision: prepared.packageRevision,
      planDigest: prepared.planDigest,
      idempotencyKey: "publish-started-gap",
      state: "prepared",
      checkpoint: "publish_started",
      sideEffects: [],
    });
    const key = prepared.planDigest.replace(/[^a-f0-9]/gu, "").slice(-24);
    const parent = path.dirname(target);
    const incoming = path.join(parent, `.publish-article-${key}.incoming`);
    const backup = path.join(parent, `.publish-article-${key}.backup`);
    await cp(setup.candidate, incoming, { recursive: true });
    await rename(target, backup);

    const receipt = await endpoint.publish(prepared, createConfirmationToken(prepared), setup.context);
    expect(receipt.state).toBe("pushed");
    expect(await readFile(path.join(target, "index.md"), "utf8")).toContain("测试文章");
    expect(await lstat(backup).catch(() => undefined)).toBeUndefined();
    expect(await lstat(incoming).catch(() => undefined)).toBeUndefined();
  });

  test("rejects a symlink in the Blog target ancestry", async () => {
    const setup = await fixture();
    const outside = path.join(setup.root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(setup.repo, "content"));
    const endpoint = new BlogGitEndpoint();
    await expect(endpoint.prepare(article(), setup.context)).rejects.toThrow("symbolic link");
  });
});
