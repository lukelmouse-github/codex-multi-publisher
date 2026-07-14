#!/usr/bin/env bun

import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createArticlePackage } from "./article-package";
import { canonicalJson, sha256Bytes } from "./canonical-json";
import { BlogGitEndpoint, digestDirectory, type PreparedBlogPublication } from "./endpoints/blog-git";
import { WechatDraftEndpoint } from "./endpoints/wechat-draft";
import { asPublishError, PublishError } from "./errors";
import { diffDirectories, validateHugoCandidate } from "./hugo-validator";
import { resolveGzhToolchain } from "./gzh-toolchain";
import { importMarkdown } from "./import-markdown";
import {
  assertPathWithinNoSymlinks,
  assertRealPathWithin,
  assertSafeRelative,
  ensureDirectoryWithin,
  isWithin,
  safeIdentifier,
} from "./path-policy";
import {
  assertPublicationPlanIntegrity,
  createPublicationPlan,
  renderPrepareReport,
  type PrepareReportDetails,
  type PublicationPlanDocument,
} from "./prepare-report";
import { PublisherRegistry } from "./registry";
import { createConfirmationToken, readReceipt, verifyConfirmationToken } from "./receipts";
import { hugoSectionFromContentRoot, renderHugoBundle } from "./render-hugo";
import { atomicWriteFile } from "./run-store";
import type {
  ArticleAsset,
  ArticleMetadata,
  ArticlePackage,
  AssetRole,
  EndpointContext,
  ImportedArticle,
  ImportedAsset,
  PreparedPublication,
} from "./types";
import { freezeWechatCandidate, verifyFrozenWechatCandidate } from "./wechat-freeze";

export const CLI_HELP = `publish-article

Commands:
  import --source <article.md> [--vault-root <dir>] [--repo <blog>]
  package --run <working-run> [--repo <blog>]
  render-blog --run <run> [--repo <blog>]
  freeze-wechat --run <run> --html <candidate.html> [--style <profile>] [--gzh-dir <dir>]
  prepare --run <run> [--targets blog,wechat] [--repo <blog>]
  publish --run <run> --confirm <token> [--repo <blog>]
  status --run <run> [--repo <blog>]

Prepare is read-only for Git and WeChat. Publish requires the exact confirmation
token printed by prepare. The WeChat endpoint only creates a private draft.`;

const SKILL_DIR = path.resolve(import.meta.dir, "../..");
const DEFAULT_REPO_ROOT = path.resolve(SKILL_DIR, "../../..");
const ASSET_ROLES = new Set<AssetRole>(["cover", "inline", "screenshot", "source"]);
const MEDIA_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

interface ParsedArguments {
  command: string;
  positionals: string[];
  options: Map<string, string | true>;
}

interface DraftAssetRecord {
  id: string;
  file: string;
  role: AssetRole;
  alt?: string;
  caption?: string;
  originalReference?: string;
}

interface DraftDocument {
  schemaVersion: 1;
  metadata: Partial<ArticleMetadata>;
  assets: DraftAssetRecord[];
}

interface WorkingState {
  schemaVersion: 1;
  phase: "imported" | "packaged";
  sourceDigest: string;
  packageRunRoot?: string;
  packageRevision?: string;
}

interface BlogRenderRecord {
  schemaVersion: 1;
  articleId: string;
  articleRevision: string;
  candidateRoot: string;
  contentRoot: string;
  bundleRoot: string;
  treeDigest: string;
  target: string;
  validation: Record<string, unknown>;
  diff: string;
}

interface WechatRenderRecord {
  schemaVersion: 1;
  articleId: string;
  articleRevision: string;
  styleProfile: string;
  frozenRoot: string;
  renderDigest: string;
  previewPath: string;
  validatorOutput: string;
}

interface EndpointConfiguration {
  schemaVersion: 1;
  defaultTargets: string[];
  endpoints: Record<string, {
    driver: string;
    branch?: string;
    remote?: string;
    contentRoot?: string;
    account?: string;
    mode?: string;
  }>;
}

interface StyleConfiguration {
  schemaVersion: 1;
  defaultProfile: string;
  profiles: Record<string, {
    description: string;
    wechatTheme: { provider: string; themeId: string };
  }>;
}

interface LoadedPackage {
  requestedRunRoot: string;
  packageRunRoot: string;
  packageRoot: string;
  article: ArticlePackage;
}

function parseArguments(argv: string[]): ParsedArguments {
  if (argv.length === 0) return { command: "help", positionals: [], options: new Map() };
  const [command = "help", ...rest] = argv;
  if (command === "--help" || command === "-h") return { command: "help", positionals: [], options: new Map() };
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]!;
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    const equal = item.indexOf("=");
    const name = equal >= 0 ? item.slice(2, equal) : item.slice(2);
    if (!name || options.has(name)) throw new PublishError("E_ARGUMENT", `Duplicate or invalid option: ${item}`);
    if (equal >= 0) {
      options.set(name, item.slice(equal + 1));
      continue;
    }
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(name, next);
      index += 1;
    } else {
      options.set(name, true);
    }
  }
  return { command, positionals, options };
}

function stringOption(parsed: ParsedArguments, name: string, required = false): string | undefined {
  const value = parsed.options.get(name);
  if (value === true) throw new PublishError("E_ARGUMENT", `--${name} requires a value`);
  if (required && !value) throw new PublishError("E_ARGUMENT", `Missing required option --${name}`);
  return value;
}

function rejectUnknownOptions(parsed: ParsedArguments, allowed: string[]): void {
  const supported = new Set(allowed);
  const unknown = [...parsed.options.keys()].filter((key) => !supported.has(key));
  if (unknown.length > 0) throw new PublishError("E_ARGUMENT", `Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}`);
}

function resolveLocalInput(value: string): string {
  return value.startsWith("file://") ? fileURLToPath(value) : path.resolve(value);
}

async function repoRootFor(parsed: ParsedArguments): Promise<string> {
  const configured = stringOption(parsed, "repo") ?? DEFAULT_REPO_ROOT;
  const root = await realpath(path.resolve(configured));
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PublishError("E_REPO_ROOT", `Repository root is not a real directory: ${root}`);
  }
  return root;
}

async function publishRootFor(repoRoot: string): Promise<string> {
  const publishRoot = path.join(repoRoot, ".publish");
  const existing = await lstat(publishRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new PublishError("E_PUBLISH_ROOT", ".publish must be a real directory inside the repository");
  }
  return ensureDirectoryWithin(repoRoot, publishRoot, "publish root");
}

async function resolveManagedRun(repoRoot: string, input: string): Promise<string> {
  const publishRoot = await publishRootFor(repoRoot);
  const candidate = await realpath(path.resolve(input));
  if (!isWithin(publishRoot, candidate)) {
    throw new PublishError("E_RUN_PATH", "--run must point inside this repository's .publish directory");
  }
  return candidate;
}

async function readJson<T>(file: string): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PublishError("E_JSON_READ", `Unable to read ${file}: ${message}`, { kind: "precondition" });
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(path.resolve(file), canonicalJson(value));
}

function draftMetadata(frontmatter: Record<string, unknown>): Partial<ArticleMetadata> {
  const output: Partial<ArticleMetadata> = {};
  const strings: Array<[keyof ArticleMetadata, unknown]> = [
    ["title", frontmatter.title],
    ["slug", frontmatter.slug],
    ["summary", frontmatter.summary ?? frontmatter.description],
    ["author", frontmatter.author],
    ["language", frontmatter.language ?? frontmatter.lang],
    ["publishedAt", frontmatter.publishedAt ?? frontmatter.publishDate ?? frontmatter.date],
    ["updatedAt", frontmatter.updatedAt ?? frontmatter.lastmod],
    ["coverAssetId", frontmatter.coverAssetId],
  ];
  for (const [key, value] of strings) {
    if (typeof value === "string" && value.trim()) (output as Record<string, unknown>)[key] = value.trim();
  }
  for (const key of ["tags", "categories"] as const) {
    const value = frontmatter[key];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) output[key] = value;
  }
  return output;
}

function remoteImageReferences(body: string): string[] {
  const references = new Set<string>();
  for (const match of body.matchAll(/!\[[^\]]*\]\(\s*(?:<)?(https?:\/\/[^\s)>]+)(?:>)?(?:\s+[^)]*)?\)/giu)) {
    if (match[1]) references.add(match[1]);
  }
  for (const match of body.matchAll(/<img\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/giu)) {
    if (match[1]) references.add(match[1]);
  }
  return [...references].sort();
}

async function commandImport(parsed: ParsedArguments): Promise<Record<string, unknown>> {
  rejectUnknownOptions(parsed, ["source", "vault-root", "repo"]);
  const sourceValue = stringOption(parsed, "source") ?? parsed.positionals[0];
  if (!sourceValue) throw new PublishError("E_ARGUMENT", "import requires --source <article.md>");
  if (parsed.positionals.length > (stringOption(parsed, "source") ? 0 : 1)) {
    throw new PublishError("E_ARGUMENT", "import accepts only one source article");
  }
  const sourcePath = resolveLocalInput(sourceValue);
  if (!/\.md(?:own)?$/iu.test(sourcePath)) throw new PublishError("E_SOURCE_TYPE", "Source article must be Markdown");
  const vaultValue = stringOption(parsed, "vault-root");
  const repoRoot = await repoRootFor(parsed);
  const publishRoot = await publishRootFor(repoRoot);
  const temporary = await mkdtemp(path.join(tmpdir(), "publish-article-import-"));
  let sessionRoot: string | undefined;
  try {
    const imported = await importMarkdown({
      sourcePath,
      outputRoot: temporary,
      vaultRoot: vaultValue ? resolveLocalInput(vaultValue) : undefined,
    });
    const sourceWorkRoot = await ensureDirectoryWithin(
      publishRoot,
      path.join(publishRoot, "work", safeIdentifier(imported.sourceId)),
      "article working directory",
    );
    sessionRoot = await ensureDirectoryWithin(
      sourceWorkRoot,
      path.join(sourceWorkRoot, randomUUID()),
      "article run directory",
    );
    const draftRoot = path.join(sessionRoot, "draft");
    await mkdir(path.join(draftRoot, "assets"), { recursive: true });
    const persistedAssets: ImportedAsset[] = [];
    for (const asset of imported.assets) {
      const relative = assertSafeRelative(asset.path, `asset ${asset.id}`);
      const destination = path.join(draftRoot, ...relative.split("/"));
      if (!isWithin(draftRoot, destination)) throw new PublishError("E_PATH_ESCAPE", "Draft asset escaped its root");
      await mkdir(path.dirname(destination), { recursive: true });
      const verifiedScratch = await assertRealPathWithin(
        temporary,
        path.join(temporary, ...relative.split("/")),
        `verified scratch asset ${asset.id}`,
      );
      const scratchBytes = await readFile(verifiedScratch);
      if (sha256Bytes(scratchBytes) !== asset.sha256) {
        throw new PublishError("E_ASSET_COPY", `Verified scratch asset changed: ${asset.id}`, { kind: "conflict" });
      }
      await cp(verifiedScratch, destination, { errorOnExist: true, force: false });
      persistedAssets.push({ ...asset, sourcePath: destination });
    }
    const persisted: ImportedArticle = { ...imported, assets: persistedAssets };
    const draft: DraftDocument = {
      schemaVersion: 1,
      metadata: draftMetadata(imported.frontmatter),
      assets: persistedAssets.map((asset) => ({
        id: asset.id,
        file: asset.path,
        role: asset.role,
        alt: asset.alt,
        caption: asset.caption,
        originalReference: asset.originalReference,
      })),
    };
    await Promise.all([
      writeJson(path.join(sessionRoot, "imported.json"), persisted),
      atomicWriteFile(path.join(draftRoot, "body.md"), imported.body),
      writeJson(path.join(draftRoot, "metadata.json"), draft),
      writeJson(path.join(sessionRoot, "state.json"), {
        schemaVersion: 1,
        phase: "imported",
        sourceDigest: imported.sourceDigest,
      } satisfies WorkingState),
    ]);
    return {
      contractVersion: 1,
      command: "import",
      runRoot: sessionRoot,
      sourcePath: imported.sourcePath,
      sourceDigest: imported.sourceDigest,
      draftBody: path.join(draftRoot, "body.md"),
      draftMetadata: path.join(draftRoot, "metadata.json"),
      metadata: draft.metadata,
      assets: imported.assets.length,
      unresolvedReferences: [],
      remoteImageReferences: remoteImageReferences(imported.body),
    };
  } catch (error) {
    if (sessionRoot) await rm(sessionRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const rootInfo = await lstat(root).catch(() => undefined);
  if (!rootInfo) return output;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new PublishError("E_DRAFT_ASSETS", "draft/assets must be a real directory");
  async function visit(directory: string, prefix: string): Promise<void> {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new PublishError("E_DRAFT_SYMLINK", `Draft asset cannot be a symlink: ${relative}`);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) output.push(relative);
      else throw new PublishError("E_DRAFT_ASSET", `Unsupported draft asset entry: ${relative}`);
    }
  }
  await visit(root, "");
  return output.sort();
}

async function commandPackage(parsed: ParsedArguments): Promise<Record<string, unknown>> {
  rejectUnknownOptions(parsed, ["run", "repo"]);
  const repoRoot = await repoRootFor(parsed);
  const runRoot = await resolveManagedRun(repoRoot, stringOption(parsed, "run", true)!);
  const imported = await readJson<ImportedArticle>(path.join(runRoot, "imported.json"));
  const draftRoot = path.join(runRoot, "draft");
  const body = await readFile(path.join(draftRoot, "body.md"), "utf8");
  const draft = await readJson<DraftDocument>(path.join(draftRoot, "metadata.json"));
  if (draft.schemaVersion !== 1 || !draft.metadata || !Array.isArray(draft.assets)) {
    throw new PublishError("E_DRAFT_METADATA", "draft/metadata.json has an unsupported schema");
  }

  const listedFiles = new Set<string>();
  const assets: ImportedAsset[] = [];
  for (const record of draft.assets) {
    if (!record.id || !ASSET_ROLES.has(record.role)) {
      throw new PublishError("E_DRAFT_ASSET", `Invalid draft asset record: ${record.id || "(missing id)"}`);
    }
    const relative = assertSafeRelative(record.file, `draft asset ${record.id}`);
    if (!relative.startsWith("assets/")) throw new PublishError("E_DRAFT_ASSET", "Draft asset files must be below draft/assets/");
    if (listedFiles.has(relative)) throw new PublishError("E_DRAFT_ASSET", `Draft asset file listed twice: ${relative}`);
    listedFiles.add(relative);
    const sourcePath = await assertRealPathWithin(draftRoot, path.join(draftRoot, ...relative.split("/")), `draft asset ${record.id}`);
    const bytes = await readFile(sourcePath);
    const digest = sha256Bytes(bytes);
    const normalizedId = safeIdentifier(record.id, `asset-${digest.slice(7, 23)}`);
    if (normalizedId !== record.id) {
      throw new PublishError("E_DRAFT_ASSET_ID", `Asset id must already be a safe stable identifier: ${record.id}`);
    }
    const extension = path.extname(relative).toLowerCase();
    const safeExtension = /^\.[a-z0-9]{1,10}$/u.test(extension) ? extension : ".bin";
    assets.push({
      id: normalizedId,
      path: `assets/${digest.slice("sha256:".length)}${safeExtension}`,
      sha256: digest,
      mediaType: MEDIA_TYPES[safeExtension] ?? "application/octet-stream",
      bytes: bytes.byteLength,
      role: record.role,
      alt: record.alt,
      caption: record.caption,
      originalReference: record.originalReference ?? `generated:${record.id}`,
      sourcePath,
    });
  }

  const actualFiles = (await listFiles(path.join(draftRoot, "assets"))).map((file) => `assets/${file}`);
  const unlisted = actualFiles.filter((file) => !listedFiles.has(file));
  if (unlisted.length > 0) {
    throw new PublishError("E_DRAFT_ASSET_UNLISTED", "draft/assets contains files missing from metadata.json", {
      details: { paths: unlisted },
    });
  }
  const packagedImport: ImportedArticle = { ...imported, body, assets };
  const created = await createArticlePackage({
    imported: packagedImport,
    runsRoot: path.join(await publishRootFor(repoRoot), "runs"),
    metadata: draft.metadata,
    body,
  });
  await writeJson(path.join(runRoot, "state.json"), {
    schemaVersion: 1,
    phase: "packaged",
    sourceDigest: imported.sourceDigest,
    packageRunRoot: created.paths.runRoot,
    packageRevision: created.article.revision,
  } satisfies WorkingState);
  return {
    contractVersion: 1,
    command: "package",
    workingRunRoot: runRoot,
    runRoot: created.paths.runRoot,
    packageRoot: created.paths.packageRoot,
    articleId: created.article.articleId,
    revision: created.article.revision,
    metadata: created.article.metadata,
    assets: created.article.assets,
  };
}

async function loadPackage(repoRoot: string, runInput: string): Promise<LoadedPackage> {
  const requestedRunRoot = await resolveManagedRun(repoRoot, runInput);
  let packageRunRoot = requestedRunRoot;
  const directArticle = path.join(packageRunRoot, "package", "article.json");
  if (!(await lstat(directArticle).catch(() => undefined))) {
    const state = await readJson<WorkingState>(path.join(requestedRunRoot, "state.json"));
    if (!state.packageRunRoot || state.phase !== "packaged") {
      throw new PublishError("E_PACKAGE_MISSING", "Run has not been frozen into an ArticlePackage yet");
    }
    packageRunRoot = await resolveManagedRun(repoRoot, state.packageRunRoot);
  }
  const packageRoot = path.join(packageRunRoot, "package");
  const article = await readJson<ArticlePackage>(path.join(packageRoot, "article.json"));
  if (article.schemaVersion !== 1 || !article.revision || !article.articleId) {
    throw new PublishError("E_ARTICLE_PACKAGE", "ArticlePackage schema is invalid");
  }
  return { requestedRunRoot, packageRunRoot, packageRoot, article };
}

async function loadEndpointConfig(): Promise<EndpointConfiguration> {
  const config = await readJson<EndpointConfiguration>(path.join(SKILL_DIR, "config", "endpoints.json"));
  if (config.schemaVersion !== 1 || !Array.isArray(config.defaultTargets) || !config.endpoints) {
    throw new PublishError("E_ENDPOINT_CONFIG", "Endpoint configuration is invalid");
  }
  return config;
}

async function loadStyleConfig(): Promise<StyleConfiguration> {
  const config = await readJson<StyleConfiguration>(path.join(SKILL_DIR, "config", "style.json"));
  if (config.schemaVersion !== 1 || !config.defaultProfile || !config.profiles) {
    throw new PublishError("E_STYLE_CONFIG", "Style configuration is invalid");
  }
  return config;
}

async function commandRenderBlog(parsed: ParsedArguments): Promise<Record<string, unknown>> {
  rejectUnknownOptions(parsed, ["run", "repo"]);
  const repoRoot = await repoRootFor(parsed);
  const loaded = await loadPackage(repoRoot, stringOption(parsed, "run", true)!);
  const outputRoot = path.join(loaded.packageRunRoot, "renders", "blog");
  await assertPathWithinNoSymlinks(loaded.packageRunRoot, outputRoot, "Blog render directory");
  await ensureDirectoryWithin(loaded.packageRunRoot, path.dirname(outputRoot), "renders directory");
  const endpointConfig = await loadEndpointConfig();
  const contentRoot = endpointConfig.endpoints.blog?.contentRoot ?? "content/posts";
  const section = hugoSectionFromContentRoot(contentRoot);
  const rendered = await renderHugoBundle(loaded.article, loaded.packageRoot, outputRoot, { contentRoot });
  const validation = await validateHugoCandidate(repoRoot, rendered.contentRoot, loaded.article.metadata.slug, section);
  const targetRelative = `${assertSafeRelative(contentRoot)}/${assertSafeRelative(loaded.article.metadata.slug)}`;
  const target = path.join(repoRoot, ...targetRelative.split("/"));
  let baseline = target;
  if (!(await lstat(target).catch(() => undefined))) {
    baseline = path.join(loaded.packageRunRoot, "working", "empty-blog-baseline");
    await rm(baseline, { recursive: true, force: true });
    await mkdir(baseline, { recursive: true });
  }
  const diff = await diffDirectories(repoRoot, baseline, rendered.bundleRoot);
  const record: BlogRenderRecord = {
    schemaVersion: 1,
    articleId: loaded.article.articleId,
    articleRevision: loaded.article.revision,
    candidateRoot: rendered.candidateRoot,
    contentRoot: rendered.contentRoot,
    bundleRoot: rendered.bundleRoot,
    treeDigest: rendered.treeDigest,
    target: targetRelative,
    validation: validation as unknown as Record<string, unknown>,
    diff,
  };
  const recordPath = path.join(loaded.packageRunRoot, "renders", "blog-result.json");
  await writeJson(recordPath, record);
  return { contractVersion: 1, command: "render-blog", runRoot: loaded.packageRunRoot, recordPath, ...record };
}

async function commandFreezeWechat(parsed: ParsedArguments): Promise<Record<string, unknown>> {
  rejectUnknownOptions(parsed, ["run", "html", "style", "gzh-dir", "repo"]);
  const repoRoot = await repoRootFor(parsed);
  const loaded = await loadPackage(repoRoot, stringOption(parsed, "run", true)!);
  const styles = await loadStyleConfig();
  const styleProfile = stringOption(parsed, "style") ?? styles.defaultProfile;
  const profile = styles.profiles[styleProfile];
  if (!profile) throw new PublishError("E_STYLE_UNKNOWN", `Unknown style profile: ${styleProfile}`);
  const htmlPath = resolveLocalInput(stringOption(parsed, "html", true)!);
  const gzhDir = stringOption(parsed, "gzh-dir");
  return freezeWechatWithResolvedToolchain({ repoRoot, loaded, styleProfile, profile, htmlPath, gzhDir });
}

async function freezeWechatWithResolvedToolchain(options: {
  repoRoot: string;
  loaded: LoadedPackage;
  styleProfile: string;
  profile: StyleConfiguration["profiles"][string];
  htmlPath: string;
  gzhDir?: string;
}): Promise<Record<string, unknown>> {
  if (options.profile.wechatTheme.provider !== "gzh-design-skill") {
    throw new PublishError("E_STYLE_PROVIDER", `Unsupported WeChat style provider: ${options.profile.wechatTheme.provider}`);
  }
  const toolchain = await resolveGzhToolchain({
    repoRoot: options.repoRoot,
    explicitDir: options.gzhDir,
    themeId: options.profile.wechatTheme.themeId,
  });
  const python = Bun.which("python3") ?? Bun.which("python");
  if (!python) throw new PublishError("E_GZH_VALIDATOR", "Python is required by the locked gzh-design validator");
  const validator = Bun.spawn(
    [python, path.join(toolchain.skillDir, "scripts", "validate_gzh_html.py"), options.htmlPath],
    { cwd: options.repoRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [validatorCode, validatorStdout, validatorStderr] = await Promise.all([
    validator.exited,
    new Response(validator.stdout).text(),
    new Response(validator.stderr).text(),
  ]);
  if (validatorCode !== 0) {
    throw new PublishError("E_GZH_VALIDATION", "gzh-design rejected the candidate HTML", {
      details: { output: (validatorStdout || validatorStderr).slice(-16_384) },
    });
  }
  const validatorOutput = validatorStdout.trim();
  const candidateBytes = await readFile(options.htmlPath);
  const candidateDigest = sha256Bytes(candidateBytes);
  const frozenRoot = path.join(
    options.loaded.packageRunRoot,
    "renders",
    "wechat",
    safeIdentifier(options.styleProfile),
    candidateDigest.slice("sha256:".length),
  );
  await assertPathWithinNoSymlinks(options.loaded.packageRunRoot, frozenRoot, "WeChat render directory");
  await ensureDirectoryWithin(
    options.loaded.packageRunRoot,
    path.dirname(frozenRoot),
    "WeChat style render directory",
  );
  let frozen;
  if (await lstat(frozenRoot).catch(() => undefined)) {
    frozen = await verifyFrozenWechatCandidate(frozenRoot);
    if (
      frozen.manifest.articleRevision !== options.loaded.article.revision
      || frozen.manifest.renderer.theme !== toolchain.themeId
      || frozen.manifest.renderer.toolchainLockDigest !== toolchain.provenance.toolchainLockDigest
    ) {
      throw new PublishError("E_WECHAT_FROZEN_CONFLICT", "Existing frozen WeChat candidate does not match this toolchain");
    }
  } else {
    frozen = await freezeWechatCandidate({
      article: options.loaded.article,
      packageRoot: options.loaded.packageRoot,
      candidateHtmlPath: options.htmlPath,
      candidateRoot: path.dirname(options.htmlPath),
      frozenRoot,
      provenance: toolchain.provenance,
    });
  }
  const record: WechatRenderRecord = {
    schemaVersion: 1,
    articleId: options.loaded.article.articleId,
    articleRevision: options.loaded.article.revision,
    styleProfile: options.styleProfile,
    frozenRoot: frozen.root,
    renderDigest: frozen.renderDigest,
    previewPath: frozen.previewPath,
    validatorOutput,
  };
  const recordPath = path.join(options.loaded.packageRunRoot, "renders", "wechat-result.json");
  await writeJson(recordPath, record);
  return {
    contractVersion: 1,
    command: "freeze-wechat",
    runRoot: options.loaded.packageRunRoot,
    recordPath,
    styleProfile: options.styleProfile,
    themeId: toolchain.themeId,
    gzhRevision: toolchain.revision,
    frozenRoot: frozen.root,
    htmlPath: frozen.htmlPath,
    previewPath: frozen.previewPath,
    renderDigest: frozen.renderDigest,
    validatorOutput,
    assets: frozen.manifest.assets,
  };
}

function createRegistry(): PublisherRegistry {
  return new PublisherRegistry()
    .register("blog-git", () => new BlogGitEndpoint())
    .register("wechat-draft-baoyu", () => new WechatDraftEndpoint());
}

function endpointContext(
  repoRoot: string,
  loaded: LoadedPackage,
  target: string,
  prepared: PreparedPublication,
  configuration: EndpointConfiguration,
): EndpointContext {
  const settings = configuration.endpoints[target];
  if (!settings) throw new PublishError("E_ENDPOINT_UNKNOWN", `Unknown configured target: ${target}`);
  if (settings.driver !== prepared.endpoint) {
    throw new PublishError("E_ENDPOINT_DRIFT", `Target ${target} changed driver after preparation`, { kind: "conflict" });
  }
  if (settings.driver === "blog-git") {
    return {
      repoRoot,
      runRoot: loaded.packageRunRoot,
      options: {
        article: loaded.article,
        branch: settings.branch ?? "main",
        remote: settings.remote ?? "origin",
        contentRoot: settings.contentRoot ?? "content/posts",
        candidateBundleRoot: prepared.artifactRoot,
        commitMessage: `content: publish ${loaded.article.metadata.slug}`,
      },
    };
  }
  if (settings.driver === "wechat-draft-baoyu") {
    if (settings.mode !== "draft") throw new PublishError("E_WECHAT_MODE", "WeChat endpoint must remain in draft mode");
    return {
      repoRoot,
      runRoot: loaded.packageRunRoot,
      options: {
        article: loaded.article,
        frozenRoot: prepared.artifactRoot,
        account: settings.account,
        title: loaded.article.metadata.title,
        author: loaded.article.metadata.author,
        summary: loaded.article.metadata.summary,
      },
    };
  }
  throw new PublishError("E_ENDPOINT_UNKNOWN", `Unsupported endpoint driver: ${settings.driver}`);
}

async function commandPrepare(parsed: ParsedArguments): Promise<Record<string, unknown>> {
  rejectUnknownOptions(parsed, ["run", "targets", "repo"]);
  const repoRoot = await repoRootFor(parsed);
  const loaded = await loadPackage(repoRoot, stringOption(parsed, "run", true)!);
  const configuration = await loadEndpointConfig();
  const targetValue = stringOption(parsed, "targets");
  const targets = [...new Set((targetValue ? targetValue.split(",") : configuration.defaultTargets)
    .map((target) => target.trim()).filter(Boolean))];
  if (targets.length === 0) throw new PublishError("E_TARGETS", "At least one publishing target is required");
  const registry = createRegistry();
  const endpointPlans: Array<{ id: string; prepared: PreparedPublication; details?: Record<string, unknown> }> = [];
  const reportDetails: PrepareReportDetails = {};

  for (const target of targets) {
    const settings = configuration.endpoints[target];
    if (!settings) throw new PublishError("E_ENDPOINT_UNKNOWN", `Unknown configured target: ${target}`);
    const endpoint = registry.resolve(settings.driver);
    if (settings.driver === "blog-git") {
      const record = await readJson<BlogRenderRecord>(path.join(loaded.packageRunRoot, "renders", "blog-result.json"));
      if (record.articleRevision !== loaded.article.revision) {
        throw new PublishError("E_BLOG_RENDER_STALE", "Blog render belongs to another ArticlePackage revision");
      }
      const expectedCandidateRoot = path.join(loaded.packageRunRoot, "renders", "blog");
      const expectedContentRoot = path.join(expectedCandidateRoot, "content");
      const configuredContentRoot = settings.contentRoot ?? "content/posts";
      const section = hugoSectionFromContentRoot(configuredContentRoot);
      const expectedBundleRoot = path.join(
        expectedContentRoot,
        ...section.split("/").filter(Boolean),
        loaded.article.metadata.slug,
      );
      await assertPathWithinNoSymlinks(loaded.packageRunRoot, expectedBundleRoot, "Blog candidate bundle");
      const bundleRoot = await assertRealPathWithin(expectedCandidateRoot, expectedBundleRoot, "Blog candidate bundle");
      const contentRoot = await assertRealPathWithin(expectedCandidateRoot, expectedContentRoot, "Blog candidate content root");
      const validation = await validateHugoCandidate(repoRoot, contentRoot, loaded.article.metadata.slug, section);
      const targetRelative = `${assertSafeRelative(configuredContentRoot)}/${assertSafeRelative(loaded.article.metadata.slug)}`;
      const provisional: PreparedPublication = {
        schemaVersion: 1,
        endpoint: settings.driver,
        articleId: loaded.article.articleId,
        packageRevision: loaded.article.revision,
        optionsDigest: "",
        planDigest: "",
        artifactRoot: bundleRoot,
        actions: [],
      };
      const context = endpointContext(repoRoot, loaded, target, provisional, configuration);
      const prepared = await endpoint.prepare(loaded.article, context);
      const currentTarget = path.join(repoRoot, ...targetRelative.split("/"));
      let currentBaseline = currentTarget;
      if (!(await lstat(currentTarget).catch(() => undefined))) {
        currentBaseline = path.join(loaded.packageRunRoot, "working", "empty-blog-baseline-prepare");
        await rm(currentBaseline, { recursive: true, force: true });
        await mkdir(currentBaseline, { recursive: true });
      }
      const freshDiff = await diffDirectories(repoRoot, currentBaseline, prepared.artifactRoot);
      const baselineDigest = await digestDirectory(currentTarget);
      if (baselineDigest !== (prepared as PreparedBlogPublication).blog.targetBaselineDigest) {
        throw new PublishError("E_BLOG_BASELINE_RACE", "Blog target changed while generating the confirmation diff", {
          kind: "conflict",
        });
      }
      endpointPlans.push({ id: target, prepared, details: { validation, target: targetRelative } });
      reportDetails.blog = { diff: freshDiff, hugo: validation as unknown as Record<string, unknown>, target: targetRelative };
      continue;
    }
    if (settings.driver === "wechat-draft-baoyu") {
      const record = await readJson<WechatRenderRecord>(path.join(loaded.packageRunRoot, "renders", "wechat-result.json"));
      if (record.articleRevision !== loaded.article.revision) {
        throw new PublishError("E_WECHAT_RENDER_STALE", "WeChat render belongs to another ArticlePackage revision");
      }
      const wechatRenderRoot = path.join(loaded.packageRunRoot, "renders", "wechat");
      const safeFrozenRoot = await assertRealPathWithin(wechatRenderRoot, record.frozenRoot, "frozen WeChat candidate");
      const frozen = await verifyFrozenWechatCandidate(safeFrozenRoot);
      const provisional: PreparedPublication = {
        schemaVersion: 1,
        endpoint: settings.driver,
        articleId: loaded.article.articleId,
        packageRevision: loaded.article.revision,
        optionsDigest: "",
        planDigest: "",
        artifactRoot: frozen.root,
        actions: [],
      };
      const context = endpointContext(repoRoot, loaded, target, provisional, configuration);
      const prepared = await endpoint.prepare(loaded.article, context);
      endpointPlans.push({ id: target, prepared, details: { styleProfile: record.styleProfile } });
      reportDetails.wechat = {
        previewPath: frozen.previewPath,
        account: settings.account ?? "",
        assets: frozen.manifest.assets as unknown as Array<Record<string, unknown>>,
        toolchain: {
          provider: "JimLiu/baoyu-skills",
          version: (prepared as PreparedPublication & { providerVersion?: string }).providerVersion,
        },
      };
      continue;
    }
    throw new PublishError("E_ENDPOINT_UNKNOWN", `Unsupported endpoint driver: ${settings.driver}`);
  }

  const plan = createPublicationPlan(loaded.article, endpointPlans);
  const report = renderPrepareReport(loaded.article, plan, reportDetails);
  const planPath = path.join(loaded.packageRunRoot, "publication-plan.json");
  const reportPath = path.join(loaded.packageRunRoot, "reports", "prepare.md");
  await Promise.all([writeJson(planPath, plan), atomicWriteFile(reportPath, report)]);
  return {
    contractVersion: 1,
    command: "prepare",
    runRoot: loaded.packageRunRoot,
    planPath,
    reportPath,
    confirmationToken: plan.confirmationToken,
    report,
  };
}

async function commandPublish(parsed: ParsedArguments): Promise<Record<string, unknown>> {
  rejectUnknownOptions(parsed, ["run", "confirm", "repo"]);
  const repoRoot = await repoRootFor(parsed);
  const loaded = await loadPackage(repoRoot, stringOption(parsed, "run", true)!);
  const confirmation = stringOption(parsed, "confirm", true)!;
  const plan = await readJson<PublicationPlanDocument>(path.join(loaded.packageRunRoot, "publication-plan.json"));
  assertPublicationPlanIntegrity(loaded.article, plan);
  verifyConfirmationToken(confirmation, plan.aggregate);
  const configuration = await loadEndpointConfig();
  const registry = createRegistry();
  const receipts = [];
  for (const endpointPlan of plan.endpointPlans) {
    const endpoint = registry.resolve(endpointPlan.prepared.endpoint);
    const context = endpointContext(repoRoot, loaded, endpointPlan.id, endpointPlan.prepared, configuration);
    const receipt = await endpoint.publish(
      endpointPlan.prepared,
      createConfirmationToken(endpointPlan.prepared),
      context,
    );
    receipts.push(receipt);
  }
  const ok = receipts.every((receipt) => receipt.state === "pushed" || receipt.state === "draft_created");
  const result = {
    contractVersion: 1,
    command: "publish",
    ok,
    runRoot: loaded.packageRunRoot,
    receipts,
    wechatNotice: receipts.some((receipt) => receipt.state === "draft_created")
      ? "微信公众号草稿已保存，请前往公众平台人工预览并发布。"
      : undefined,
  };
  await writeJson(path.join(loaded.packageRunRoot, "publication-result.json"), result);
  return result;
}

async function commandStatus(parsed: ParsedArguments): Promise<Record<string, unknown>> {
  rejectUnknownOptions(parsed, ["run", "repo"]);
  const repoRoot = await repoRootFor(parsed);
  const loaded = await loadPackage(repoRoot, stringOption(parsed, "run", true)!);
  const plan = await readJson<PublicationPlanDocument>(path.join(loaded.packageRunRoot, "publication-plan.json"));
  assertPublicationPlanIntegrity(loaded.article, plan);
  const configuration = await loadEndpointConfig();
  const registry = createRegistry();
  const endpoints = [];
  for (const endpointPlan of plan.endpointPlans) {
    const receiptPath = path.join(loaded.packageRunRoot, "receipts", `${endpointPlan.prepared.endpoint}.json`);
    if (!(await lstat(receiptPath).catch(() => undefined))) {
      endpoints.push({ id: endpointPlan.id, state: "not_started" });
      continue;
    }
    let receipt;
    try {
      receipt = await readReceipt(receiptPath);
    } catch (error) {
      endpoints.push({ id: endpointPlan.id, state: "receipt_invalid", error: asPublishError(error).data });
      continue;
    }
    try {
      const endpoint = registry.resolve(endpointPlan.prepared.endpoint);
      const context = endpointContext(repoRoot, loaded, endpointPlan.id, endpointPlan.prepared, configuration);
      endpoints.push({ id: endpointPlan.id, receipt, status: await endpoint.status(receipt, context) });
    } catch (error) {
      const publishError = asPublishError(error);
      endpoints.push({
        id: endpointPlan.id,
        receipt,
        status: { supported: false, queryError: publishError.data },
      });
    }
  }
  return { contractVersion: 1, command: "status", runRoot: loaded.packageRunRoot, endpoints };
}

export async function executeCli(argv: string[]): Promise<Record<string, unknown>> {
  const parsed = parseArguments(argv);
  switch (parsed.command) {
    case "help":
      return { contractVersion: 1, command: "help", help: CLI_HELP };
    case "import":
      return commandImport(parsed);
    case "package":
      return commandPackage(parsed);
    case "render-blog":
      return commandRenderBlog(parsed);
    case "freeze-wechat":
      return commandFreezeWechat(parsed);
    case "prepare":
      return commandPrepare(parsed);
    case "publish":
      return commandPublish(parsed);
    case "status":
      return commandStatus(parsed);
    default:
      throw new PublishError("E_COMMAND", `Unknown command: ${parsed.command}`);
  }
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    const result = await executeCli(argv);
    if (result.command === "help") console.log(CLI_HELP);
    else console.log(canonicalJson(result).trimEnd());
    if (result.command === "publish" && result.ok === false) process.exitCode = 2;
  } catch (error) {
    const failure = asPublishError(error);
    console.error(canonicalJson({ contractVersion: 1, ok: false, error: failure.data }).trimEnd());
    process.exitCode = 1;
  }
}
