import path from "node:path";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PublishError } from "./errors";

export interface HugoValidationResult {
  ok: true;
  expectedVersion: string;
  actualVersion: string;
  versionMatches: boolean;
  outputPath: string;
  warnings: string[];
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function readExpectedHugoVersion(repoRoot: string): Promise<string> {
  const configPath = path.join(repoRoot, "vercel.json");
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { build?: { env?: { HUGO_VERSION?: string } } };
    const version = parsed.build?.env?.HUGO_VERSION;
    if (!version) {
      throw new PublishError("E_HUGO_VERSION", "vercel.json does not declare HUGO_VERSION", {
        kind: "validation",
      });
    }
    return version;
  } catch (error) {
    if (error instanceof PublishError) throw error;
    throw new PublishError("E_HUGO_CONFIG", `Cannot read the required Vercel Hugo pin at ${configPath}`, {
      kind: "validation",
      outcome: "not_applied",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

export async function validateHugoCandidate(
  repoRoot: string,
  candidateContentRoot: string,
  slug: string,
  section = "posts",
): Promise<HugoValidationResult> {
  const expectedVersion = await readExpectedHugoVersion(repoRoot);
  const versionResult = await run("hugo", ["version"], repoRoot);
  if (versionResult.exitCode !== 0) throw new PublishError("E_HUGO_MISSING", versionResult.stderr || "hugo not found");
  const actualVersion = versionResult.stdout.trim();
  const versionMatches = actualVersion.includes(`v${expectedVersion}`);
  const warnings = versionMatches ? [] : [`Local Hugo differs from Vercel pin ${expectedVersion}: ${actualVersion}`];

  const [destination, resourceDir] = await Promise.all([
    mkdtemp(path.join(tmpdir(), "publish-article-hugo-")),
    mkdtemp(path.join(tmpdir(), "publish-article-hugo-resources-")),
  ]);
  try {
    const result = await run(
      "hugo",
      [
        "--source", repoRoot,
        "--contentDir", candidateContentRoot,
        "--destination", destination,
        "--cleanDestinationDir",
        "--noBuildLock",
      ],
      repoRoot,
      { HUGO_RESOURCEDIR: resourceDir },
    );
    if (result.exitCode !== 0) {
      throw new PublishError("E_HUGO_BUILD", result.stderr || result.stdout || "Hugo build failed");
    }
    const outputPath = path.join(destination, ...section.split("/").filter(Boolean), slug, "index.html");
    const output = await stat(outputPath).catch(() => undefined);
    if (!output?.isFile() || output.size === 0) {
      const expected = [...section.split("/").filter(Boolean), slug, "index.html"].join("/");
      throw new PublishError("E_HUGO_OUTPUT", `Hugo did not produce ${expected}`);
    }
    return { ok: true, expectedVersion, actualVersion, versionMatches, outputPath, warnings };
  } finally {
    await Promise.all([
      rm(destination, { recursive: true, force: true }),
      rm(resourceDir, { recursive: true, force: true }),
    ]);
  }
}

export async function diffDirectories(repoRoot: string, current: string, candidate: string): Promise<string> {
  const asGitArgument = (target: string): string => {
    const relative = path.relative(repoRoot, target);
    if (relative === "") return ".";
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return relative.replaceAll("\\", "/");
    }
    return path.resolve(target).replaceAll("\\", "/");
  };
  const currentArgument = asGitArgument(current);
  const candidateArgument = asGitArgument(candidate);
  const result = await run(
    "git",
    ["-c", "core.quotePath=false", "diff", "--no-index", "--", currentArgument, candidateArgument],
    repoRoot,
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new PublishError("E_DIFF", result.stderr || "Unable to generate candidate diff");
  }
  const headerPrefixes = [
    "diff --git ",
    "--- ",
    "+++ ",
    "Binary files ",
    "rename from ",
    "rename to ",
    "copy from ",
    "copy to ",
  ];
  const roots = [currentArgument, candidateArgument]
    .flatMap((value) => {
      const normalized = value.replace(/^\.\//u, "").replace(/\/$/u, "");
      return normalized.startsWith("/") ? [normalized, normalized.replace(/^\/+/, "")] : [normalized];
    })
    .filter((value) => value !== "" && value !== ".")
    .sort((left, right) => right.length - left.length);
  return result.stdout
    .split("\n")
    .map((line) => {
      if (!headerPrefixes.some((prefix) => line.startsWith(prefix))) return line;
      return roots.reduce((sanitized, root) => sanitized.replaceAll(root, "bundle"), line);
    })
    .join("\n");
}
