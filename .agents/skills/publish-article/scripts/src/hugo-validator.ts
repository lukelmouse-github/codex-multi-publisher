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
  styleContract: BlogStyleContractResult;
  warnings: string[];
}

export interface BlogStyleContractResult {
  postContentUsesMarkdownStyles: true;
  stylesheetHref: string;
  codeBlockCount: number;
  codeBlockStylesPresent: true;
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function htmlTagsWithClass(html: string, className: string): string[] {
  return (html.match(/<[^>]+>/gu) ?? []).filter((tag) => {
    const value = htmlAttribute(tag, "class");
    return value?.split(/\s+/u).includes(className) ?? false;
  });
}

function styleContractError(message: string, details: Record<string, unknown> = {}): PublishError {
  return new PublishError("E_HUGO_STYLE_CONTRACT", message, {
    kind: "validation",
    outcome: "not_applied",
    details,
  });
}

export async function validateBlogStyleContract(
  destination: string,
  outputPath: string,
): Promise<BlogStyleContractResult> {
  const html = await readFile(outputPath, "utf8");
  const contentTags = htmlTagsWithClass(html, "post-content");
  const hasMarkdownStyles = contentTags.some((tag) => {
    const classes = htmlAttribute(tag, "class")?.split(/\s+/u) ?? [];
    return classes.includes("md-content");
  });
  if (!hasMarkdownStyles) {
    throw styleContractError(
      "Built article is missing PaperMod's post-content md-content class contract; a stale layout override may disable typography and code styles",
      { outputPath },
    );
  }

  const stylesheetTag = (html.match(/<link\b[^>]*>/giu) ?? []).find((tag) => {
    const href = htmlAttribute(tag, "href");
    return href ? new URL(href, "https://blog.invalid").pathname.endsWith(".css") : false;
  });
  const stylesheetHref = stylesheetTag ? htmlAttribute(stylesheetTag, "href") : undefined;
  if (!stylesheetHref) {
    throw styleContractError("Built article does not reference a CSS stylesheet", { outputPath });
  }

  const stylesheetUrl = new URL(stylesheetHref, "https://blog.invalid");
  const relativeStylesheetPath = decodeURIComponent(stylesheetUrl.pathname).replace(/^\/+/, "");
  const stylesheetPath = path.resolve(destination, relativeStylesheetPath);
  const relativeToDestination = path.relative(destination, stylesheetPath);
  if (relativeToDestination.startsWith("..") || path.isAbsolute(relativeToDestination)) {
    throw styleContractError("Built article stylesheet escaped the Hugo destination", { stylesheetHref });
  }

  let css: string;
  try {
    css = await readFile(stylesheetPath, "utf8");
  } catch (error) {
    throw styleContractError("Built article stylesheet is missing from the Hugo output", {
      stylesheetHref,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const requiredSelectors: Array<[string, RegExp]> = [
    ["markdown highlight container", /\.md-content\s+\.highlight(?:[:.\s,{])/u],
    ["markdown code body", /\.md-content\s+pre\s+code(?:[:.\s,{])/u],
    ["Chroma syntax tokens", /\.chroma\s*\{/u],
  ];
  const missingSelectors = requiredSelectors.filter(([, selector]) => !selector.test(css)).map(([label]) => label);
  if (missingSelectors.length > 0) {
    throw styleContractError("Built stylesheet cannot style PaperMod code blocks", {
      stylesheetHref,
      missingSelectors,
    });
  }

  const highlightTags = htmlTagsWithClass(html, "highlight");
  const chromaTags = htmlTagsWithClass(html, "chroma");
  if (highlightTags.length > 0 && chromaTags.length === 0) {
    throw styleContractError("Built article code blocks are missing Chroma classes", {
      outputPath,
      highlightBlocks: highlightTags.length,
    });
  }
  return {
    postContentUsesMarkdownStyles: true,
    stylesheetHref,
    codeBlockCount: highlightTags.length,
    codeBlockStylesPresent: true,
  };
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
    const styleContract = await validateBlogStyleContract(destination, outputPath);
    return { ok: true, expectedVersion, actualVersion, versionMatches, outputPath, styleContract, warnings };
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
