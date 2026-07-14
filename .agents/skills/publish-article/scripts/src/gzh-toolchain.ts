import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { digestCanonical } from "./canonical-json";
import { PublishError } from "./errors";
import { assertRealPathWithin, assertSafeRelative } from "./path-policy";
import { findExecutable, sha256File } from "./toolchain";
import type { GzhDesignProvenanceInput, LockedGzhFile } from "./wechat-freeze";

export const DEFAULT_GZH_THEME_ID = "moyu-green";
export const GZH_DESIGN_REPOSITORY = "https://github.com/isjiamu/gzh-design-skill";
export const GZH_DESIGN_REVISION = "ba1f4175519b481cb3566616c9e5178705067904";
export const GZH_REQUIRED_FILES = [
  "LICENSE",
  "SKILL.md",
  "references/common-components.md",
  "references/theme-index.md",
  "scripts/validate_gzh_html.py",
] as const;

export interface GzhThemeLock {
  path: string;
  sha256: string;
}

export interface GzhDesignToolchainLock {
  schemaVersion: 1;
  gzhDesignSkill: {
    repository: string;
    revision: string;
    license: "AGPL-3.0-or-later";
    runnerContract: string;
    files: Record<string, string>;
    themes: Record<string, GzhThemeLock>;
  };
  [key: string]: unknown;
}

export interface GzhGitCommandRequest {
  gitPath: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
}

export interface GzhGitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GzhGitRunner = (request: GzhGitCommandRequest) => Promise<GzhGitCommandResult>;

export interface ResolveGzhToolchainOptions {
  repoRoot: string;
  explicitDir?: string;
  themeId?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  codexHome?: string;
  lockPath?: string;
  lock?: GzhDesignToolchainLock;
  gitRunner?: GzhGitRunner;
}

export interface ResolvedGzhToolchain {
  skillDir: string;
  repository: string;
  revision: string;
  themeId: string;
  themeFilePath: string;
  verifiedFiles: Record<string, string>;
  provenance: GzhDesignProvenanceInput;
}

function defaultLockPath(): string {
  return path.resolve(import.meta.dir, "../..", "toolchain.lock.json");
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function uniqueResolvedPaths(values: Array<string | undefined>): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    output.push(resolved);
  }
  return output;
}

export function gzhSkillCandidates(options: ResolveGzhToolchainOptions): string[] {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const codexHome = options.codexHome ?? env.CODEX_HOME ?? path.join(homeDir, ".codex");
  return uniqueResolvedPaths([
    options.explicitDir,
    env.GZH_DESIGN_SKILL_DIR,
    path.join(options.repoRoot, ".publish", "toolchains", "gzh-design-skill"),
    path.join(homeDir, ".agents", "skills", "gzh-design-skill"),
    path.join(codexHome, "skills", "gzh-design-skill"),
  ]);
}

function environment(overrides?: Record<string, string | undefined>): Record<string, string> {
  const combined: Record<string, string | undefined> = { ...process.env, ...overrides };
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(combined)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

async function readLock(options: ResolveGzhToolchainOptions): Promise<GzhDesignToolchainLock> {
  if (options.lock) return options.lock;
  const lockPath = path.resolve(options.lockPath ?? defaultLockPath());
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    throw new PublishError("E_GZH_TOOLCHAIN_LOCK", `Cannot read gzh-design toolchain lock: ${lockPath}`, {
      kind: "precondition",
      details: { lockPath, cause: error instanceof Error ? error.message : String(error) },
    });
  }
  const lock = parsed as Partial<GzhDesignToolchainLock>;
  if (lock.schemaVersion !== 1 || !lock.gzhDesignSkill) {
    throw new PublishError("E_GZH_TOOLCHAIN_LOCK", "Unsupported gzh-design toolchain lock schema", {
      kind: "precondition",
      details: { lockPath },
    });
  }
  return lock as GzhDesignToolchainLock;
}

async function locateRepository(options: ResolveGzhToolchainOptions): Promise<string> {
  const attempted = gzhSkillCandidates(options);
  for (const candidate of attempted) {
    if (await pathExists(path.join(candidate, ".git"))) return candidate;
  }
  throw new PublishError("E_GZH_NOT_FOUND", "Cannot locate an installed gzh-design-skill Git checkout", {
    kind: "precondition",
    details: { attempted, installAttempted: false },
  });
}

export const defaultGzhGitRunner: GzhGitRunner = async (request) => {
  const child = Bun.spawn([request.gitPath, ...request.args], {
    cwd: request.cwd,
    env: request.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

async function gitOutput(
  runner: GzhGitRunner,
  gitPath: string,
  cwd: string,
  args: string[],
  env: Record<string, string>,
  label: string,
): Promise<string> {
  const result = await runner({ gitPath, cwd, args, env });
  if (result.exitCode !== 0) {
    throw new PublishError("E_GZH_GIT", `Cannot read gzh-design ${label}`, {
      kind: "precondition",
      details: { args, exitCode: result.exitCode },
    });
  }
  const value = result.stdout.trim();
  if (!value) {
    throw new PublishError("E_GZH_GIT", `gzh-design ${label} is empty`, {
      kind: "precondition",
      details: { args },
    });
  }
  return value;
}

export function normalizeGithubRepository(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\/+$/u, "");
  let repositoryPath: string | undefined;
  const scp = trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/iu);
  if (scp) {
    repositoryPath = scp[1];
  } else {
    try {
      const url = new URL(trimmed);
      if (url.hostname.toLowerCase() !== "github.com") return undefined;
      repositoryPath = url.pathname.replace(/^\/+|\/+$/gu, "");
    } catch {
      return undefined;
    }
  }
  const withoutGit = repositoryPath?.replace(/\.git$/iu, "");
  if (!withoutGit || withoutGit.split("/").length !== 2) return undefined;
  return `https://github.com/${withoutGit.toLowerCase()}`;
}

function validateThemeId(themeId: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(themeId)) {
    throw new PublishError("E_GZH_THEME", `Invalid gzh-design theme id: ${themeId}`);
  }
}

function provenanceFiles(
  verifiedFiles: Record<string, string>,
  licensePath: string,
): LockedGzhFile[] {
  return Object.entries(verifiedFiles)
    .filter(([relativePath]) => relativePath !== licensePath)
    .map(([relativePath, sha256]) => ({ path: relativePath, sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function resolveGzhToolchain(
  options: ResolveGzhToolchainOptions,
): Promise<ResolvedGzhToolchain> {
  const themeId = options.themeId ?? DEFAULT_GZH_THEME_ID;
  validateThemeId(themeId);
  const [skillDir, lock] = await Promise.all([locateRepository(options), readLock(options)]);
  const locked = lock.gzhDesignSkill;

  if (normalizeGithubRepository(locked.repository) !== normalizeGithubRepository(GZH_DESIGN_REPOSITORY)) {
    throw new PublishError("E_GZH_TOOLCHAIN_LOCK", "gzh-design lock declares an unexpected repository", {
      kind: "precondition",
      details: { expected: GZH_DESIGN_REPOSITORY },
    });
  }
  if (locked.revision !== GZH_DESIGN_REVISION) {
    throw new PublishError("E_GZH_TOOLCHAIN_LOCK", "gzh-design lock declares an unexpected revision", {
      kind: "precondition",
      details: { expected: GZH_DESIGN_REVISION, actual: locked.revision },
    });
  }
  if (locked.license !== "AGPL-3.0-or-later" || !locked.runnerContract) {
    throw new PublishError("E_GZH_TOOLCHAIN_LOCK", "gzh-design license or runner contract is not locked", {
      kind: "precondition",
    });
  }
  for (const required of GZH_REQUIRED_FILES) {
    if (!locked.files[required]) {
      throw new PublishError("E_GZH_TOOLCHAIN_LOCK", `gzh-design lock is missing ${required}`, {
        kind: "precondition",
      });
    }
  }

  const theme = locked.themes[themeId];
  if (!theme) {
    throw new PublishError("E_GZH_THEME_NOT_LOCKED", `gzh-design theme is not locked: ${themeId}`, {
      kind: "precondition",
      details: { themeId, availableThemes: Object.keys(locked.themes).sort() },
    });
  }

  const env = environment(options.env);
  const gitPath = await findExecutable("git", env);
  if (!gitPath) {
    throw new PublishError("E_GIT_NOT_FOUND", "Git is required to verify gzh-design-skill", {
      kind: "precondition",
    });
  }
  const runner = options.gitRunner ?? defaultGzhGitRunner;
  const [rawOrigin, revision] = await Promise.all([
    gitOutput(runner, gitPath, skillDir, ["remote", "get-url", "origin"], env, "origin"),
    gitOutput(runner, gitPath, skillDir, ["rev-parse", "--verify", "HEAD^{commit}"], env, "HEAD"),
  ]);
  const origin = normalizeGithubRepository(rawOrigin);
  const expectedRepository = normalizeGithubRepository(locked.repository);
  if (!origin || origin !== expectedRepository) {
    throw new PublishError("E_GZH_ORIGIN_MISMATCH", "gzh-design origin does not match the locked repository", {
      kind: "precondition",
      details: { expected: locked.repository },
    });
  }
  if (!/^[a-f0-9]{40}$/u.test(revision) || revision !== locked.revision) {
    throw new PublishError("E_GZH_REVISION_MISMATCH", "gzh-design HEAD does not match the locked full commit", {
      kind: "precondition",
      details: { expected: locked.revision, actual: /^[a-f0-9]{40}$/u.test(revision) ? revision : "invalid" },
    });
  }

  const themePath = assertSafeRelative(theme.path, `gzh theme ${themeId}`);
  const expectedFiles: Record<string, string> = { ...locked.files, [themePath]: theme.sha256 };
  const verifiedFiles: Record<string, string> = {};
  for (const [relativeInput, expected] of Object.entries(expectedFiles).sort(([left], [right]) => left.localeCompare(right))) {
    const relativePath = assertSafeRelative(relativeInput, "gzh locked file");
    const absolutePath = path.join(skillDir, relativePath);
    if (!(await pathExists(absolutePath))) {
      throw new PublishError("E_GZH_FILE_MISSING", `gzh-design locked file is missing: ${relativePath}`, {
        kind: "precondition",
        details: { relativePath },
      });
    }
    const safePath = await assertRealPathWithin(skillDir, absolutePath, `gzh locked file ${relativePath}`);
    const actual = await sha256File(safePath);
    if (actual !== expected) {
      throw new PublishError("E_GZH_FILE_MISMATCH", `gzh-design locked file changed: ${relativePath}`, {
        kind: "precondition",
        details: { relativePath, expected, actual },
      });
    }
    verifiedFiles[relativePath] = actual;
  }

  const licensePath = "LICENSE";
  const licenseSha256 = verifiedFiles[licensePath];
  if (!licenseSha256 || locked.license !== "AGPL-3.0-or-later") {
    throw new PublishError("E_GZH_LICENSE", "gzh-design AGPL license is missing or unlocked", {
      kind: "precondition",
    });
  }

  const provenance: GzhDesignProvenanceInput = {
    repository: GZH_DESIGN_REPOSITORY,
    revision,
    license: locked.license,
    licenseSha256,
    themeId,
    runnerContract: locked.runnerContract,
    toolchainLockDigest: digestCanonical(lock),
    files: provenanceFiles(verifiedFiles, licensePath),
  };

  return {
    skillDir,
    repository: GZH_DESIGN_REPOSITORY,
    revision,
    themeId,
    themeFilePath: path.join(skillDir, themePath),
    verifiedFiles,
    provenance,
  };
}
