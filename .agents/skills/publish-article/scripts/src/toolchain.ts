import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PublishError } from "./errors";

export const BAOYU_REQUIRED_FILES = [
  "SKILL.md",
  "scripts/wechat-api.ts",
  "scripts/wechat-extend-config.ts",
  "scripts/md-to-wechat.ts",
] as const;

export type BaoyuRequiredFile = (typeof BAOYU_REQUIRED_FILES)[number];

export interface BaoyuToolchainLock {
  schemaVersion: 1;
  baoyuPostToWechat: {
    repository: string;
    version: string;
    files: Record<BaoyuRequiredFile, string>;
  };
}

export interface BaoyuRuntime {
  kind: "bun" | "npx-bun";
  command: string;
  argsPrefix: string[];
}

export interface ResolvedBaoyuToolchain {
  skillDir: string;
  skillVersion: string;
  apiScriptPath: string;
  configModulePath: string;
  markdownScriptPath: string;
  runtime: BaoyuRuntime;
  lock: BaoyuToolchainLock;
  verifiedFiles: Record<BaoyuRequiredFile, string>;
}

export interface ResolveBaoyuToolchainOptions {
  repoRoot: string;
  explicitDir?: string;
  lockPath?: string;
  lock?: BaoyuToolchainLock;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  codexHome?: string;
  allowNpxBootstrap?: boolean;
}

function defaultLockPath(): string {
  return path.resolve(import.meta.dir, "../..", "toolchain.lock.json");
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function executableCandidates(name: string, env: Record<string, string | undefined>): string[] {
  const pathValue = env.PATH ?? process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const candidates: string[] = [];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      candidates.push(path.join(directory, process.platform === "win32" ? `${name}${extension}` : name));
    }
  }
  return candidates;
}

export async function findExecutable(
  name: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if (path.isAbsolute(name)) {
    try {
      await access(name, fsConstants.X_OK);
      return name;
    } catch {
      return undefined;
    }
  }
  for (const candidate of executableCandidates(name, env)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function sha256File(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function parseSkillVersion(skillMarkdown: string): string | undefined {
  const frontmatter = skillMarkdown.match(/^---\s*\n([\s\S]*?)\n---/);
  return frontmatter?.[1]?.match(/^version:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
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

export function baoyuSkillCandidates(options: ResolveBaoyuToolchainOptions): string[] {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const codexHome = options.codexHome ?? env.CODEX_HOME ?? path.join(homeDir, ".codex");
  return uniqueResolvedPaths([
    options.explicitDir,
    env.BAOYU_POST_TO_WECHAT_DIR,
    path.join(options.repoRoot, ".agents", "skills", "baoyu-post-to-wechat"),
    path.join(homeDir, ".agents", "skills", "baoyu-post-to-wechat"),
    path.join(codexHome, "skills", "baoyu-post-to-wechat"),
  ]);
}

async function readLock(options: ResolveBaoyuToolchainOptions): Promise<BaoyuToolchainLock> {
  if (options.lock) return options.lock;
  const lockPath = path.resolve(options.lockPath ?? defaultLockPath());
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    throw new PublishError("E_TOOLCHAIN_LOCK", `Cannot read Baoyu toolchain lock: ${lockPath}`, {
      kind: "precondition",
      details: { lockPath, cause: error instanceof Error ? error.message : String(error) },
    });
  }
  const candidate = parsed as Partial<BaoyuToolchainLock>;
  if (candidate.schemaVersion !== 1 || !candidate.baoyuPostToWechat) {
    throw new PublishError("E_TOOLCHAIN_LOCK", "Unsupported Baoyu toolchain lock schema", {
      kind: "precondition",
      details: { lockPath },
    });
  }
  return candidate as BaoyuToolchainLock;
}

async function locateSkill(options: ResolveBaoyuToolchainOptions): Promise<string> {
  const attempted = baoyuSkillCandidates(options);
  for (const directory of attempted) {
    if (await isReadableFile(path.join(directory, "SKILL.md"))) return directory;
  }
  throw new PublishError("E_BAOYU_NOT_FOUND", "Cannot locate baoyu-post-to-wechat skill", {
    kind: "precondition",
    details: { attempted },
  });
}

async function resolveRuntime(options: ResolveBaoyuToolchainOptions): Promise<BaoyuRuntime> {
  const env = options.env ?? process.env;
  const requestedBun = env.BAOYU_BUN;
  if (requestedBun) {
    const bun = await findExecutable(requestedBun, env);
    if (!bun) {
      throw new PublishError("E_BUN_NOT_FOUND", `BAOYU_BUN is not executable: ${requestedBun}`, {
        kind: "precondition",
      });
    }
    return { kind: "bun", command: bun, argsPrefix: [] };
  }

  const bun = await findExecutable("bun", env);
  if (bun) return { kind: "bun", command: bun, argsPrefix: [] };

  const npx = await findExecutable("npx", env);
  if (npx && options.allowNpxBootstrap) {
    return { kind: "npx-bun", command: npx, argsPrefix: ["-y", "bun"] };
  }

  throw new PublishError("E_BUN_NOT_FOUND", "Bun runtime is required for baoyu-post-to-wechat", {
    kind: "precondition",
    details: {
      npxAvailable: Boolean(npx),
      npxBootstrapAllowed: Boolean(options.allowNpxBootstrap),
    },
  });
}

export function baoyuCommand(toolchain: ResolvedBaoyuToolchain, args: string[]): string[] {
  return [
    toolchain.runtime.command,
    ...toolchain.runtime.argsPrefix,
    toolchain.apiScriptPath,
    ...args,
  ];
}

export async function resolveBaoyuToolchain(
  options: ResolveBaoyuToolchainOptions,
): Promise<ResolvedBaoyuToolchain> {
  const [skillDir, lock, runtime] = await Promise.all([
    locateSkill(options),
    readLock(options),
    resolveRuntime(options),
  ]);

  const verifiedFiles = {} as Record<BaoyuRequiredFile, string>;
  for (const relativePath of BAOYU_REQUIRED_FILES) {
    const absolutePath = path.join(skillDir, relativePath);
    if (!(await isReadableFile(absolutePath))) {
      throw new PublishError("E_BAOYU_INCOMPLETE", `Baoyu skill is missing ${relativePath}`, {
        kind: "precondition",
        details: { skillDir, relativePath },
      });
    }
    const actual = await sha256File(absolutePath);
    verifiedFiles[relativePath] = actual;
    const expected = lock.baoyuPostToWechat.files[relativePath];
    if (!expected || actual !== expected) {
      throw new PublishError("E_TOOLCHAIN_LOCK_MISMATCH", `Baoyu file does not match toolchain lock: ${relativePath}`, {
        kind: "precondition",
        details: { relativePath, expected, actual, skillDir },
      });
    }
  }

  const skillVersion = parseSkillVersion(await readFile(path.join(skillDir, "SKILL.md"), "utf8"));
  if (!skillVersion || skillVersion !== lock.baoyuPostToWechat.version) {
    throw new PublishError("E_TOOLCHAIN_VERSION_MISMATCH", "Baoyu skill version does not match toolchain lock", {
      kind: "precondition",
      details: { expected: lock.baoyuPostToWechat.version, actual: skillVersion, skillDir },
    });
  }

  return {
    skillDir,
    skillVersion,
    apiScriptPath: path.join(skillDir, "scripts", "wechat-api.ts"),
    configModulePath: path.join(skillDir, "scripts", "wechat-extend-config.ts"),
    markdownScriptPath: path.join(skillDir, "scripts", "md-to-wechat.ts"),
    runtime,
    lock,
    verifiedFiles,
  };
}
