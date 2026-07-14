import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { canonicalJson, digestCanonical, sha256Bytes } from "./canonical-json";
import { PublishError } from "./errors";
import { assertRealPathWithin, assertSafeRelative, isWithin } from "./path-policy";
import type { ArticleAsset, ArticlePackage, AssetRole } from "./types";
import {
  assertWechatCodeFidelity,
  digestWechatCodeProjection,
  inspectRenderedWechatCodeBlocks,
  readArticlePackageBody,
  WECHAT_CODE_TAB_SIZE,
  WECHAT_CODE_THEME,
} from "./wechat-code";
import {
  buildWechatPreview,
  extractWechatPreviewPayload,
  inspectWechatHtml,
  normalizeWechatHtml,
  rewriteWechatImageSources,
  validateFrozenWechatImageFiles,
} from "./wechat-html";
import { deriveWechatImages, type FrozenWechatImage, type WechatImageInput } from "./wechat-images";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const GZH_REPOSITORY = "https://github.com/isjiamu/gzh-design-skill";
const GZH_LICENSE = "AGPL-3.0-or-later";

export interface LockedGzhFile {
  path: string;
  sha256: string;
}

export interface GzhDesignProvenanceInput {
  repository: string;
  revision: string;
  license: string;
  licenseSha256: string;
  themeId: string;
  runnerContract: string;
  toolchainLockDigest: string;
  files: LockedGzhFile[];
}

export interface FreezeWechatCandidateOptions {
  article: ArticlePackage;
  packageRoot: string;
  candidateHtmlPath: string;
  candidateRoot?: string;
  frozenRoot: string;
  provenance: GzhDesignProvenanceInput;
}

export interface WechatRenderAsset {
  id: string;
  role: AssetRole;
  path: string;
  sha256: string;
  sourceSha256: string;
  bytes: number;
  mediaType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  hasAlpha: boolean;
}

export interface WechatRenderManifest {
  schemaVersion: 1;
  articleId: string;
  articleRevision: string;
  renderer: {
    id: "wechat-gzh-design";
    contract: string;
    theme: string;
    toolchainLockDigest: string;
  };
  html: {
    path: "wechat.html";
    sha256: string;
    bytes: number;
  };
  preview: {
    path: "preview.html";
    sourceHtmlSha256: string;
  };
  codeFidelity: {
    schemaVersion: 1;
    renderer: "wechat-code-inline/v1";
    theme: string;
    tabSize: number;
    blockCount: number;
    sourceBodySha256: string;
    sourceProjectionSha256: string;
    renderedProjectionSha256: string;
  };
  assets: WechatRenderAsset[];
  cover?: {
    assetId: string;
    path: string;
    sha256: string;
  };
  renderDigest: string;
}

export interface GzhDesignProvenanceSidecar {
  schemaVersion: 1;
  component: "gzh-design-skill";
  repository: string;
  revision: string;
  license: string;
  licenseSha256: string;
  themeId: string;
  runnerContract: string;
  toolchainLockDigest: string;
  files: LockedGzhFile[];
  outputHtmlSha256: string;
  renderDigest: string;
  provenanceDigest: string;
}

export interface FrozenWechatCandidate {
  root: string;
  htmlPath: string;
  previewPath: string;
  manifestPath: string;
  provenancePath: string;
  coverPath?: string;
  renderDigest: string;
  provenanceDigest: string;
  manifest: WechatRenderManifest;
  provenance: GzhDesignProvenanceSidecar;
}

function freezeError(code: string, message: string, details?: Record<string, unknown>): PublishError {
  return new PublishError(code, message, { kind: "validation", details });
}

function assertDigest(value: string, label: string): void {
  if (!DIGEST_PATTERN.test(value)) throw freezeError("E_DIGEST", `${label} must be a sha256 digest`);
}

function withoutKey<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function normalizeLockedFiles(files: LockedGzhFile[]): LockedGzhFile[] {
  const seen = new Set<string>();
  return files
    .map((file) => {
      const relative = assertSafeRelative(file.path, "gzh-design locked file");
      assertDigest(file.sha256, `digest for ${relative}`);
      if (seen.has(relative)) throw freezeError("E_GZH_PROVENANCE_DUPLICATE", `Duplicate gzh-design file: ${relative}`);
      seen.add(relative);
      return { path: relative, sha256: file.sha256 };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function validateProvenance(input: GzhDesignProvenanceInput): GzhDesignProvenanceInput {
  const repository = input.repository.replace(/\/$/u, "");
  if (repository !== GZH_REPOSITORY) {
    throw freezeError("E_GZH_REPOSITORY", `Unexpected gzh-design repository: ${input.repository}`);
  }
  if (input.license !== GZH_LICENSE) {
    throw freezeError("E_GZH_LICENSE", `gzh-design must be attributed as ${GZH_LICENSE}`);
  }
  if (!/^[a-f0-9]{40}$/u.test(input.revision)) {
    throw freezeError("E_GZH_REVISION", "gzh-design revision must be a full Git commit SHA");
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(input.themeId)) {
    throw freezeError("E_GZH_THEME", "gzh-design theme id is invalid");
  }
  if (!input.runnerContract) throw freezeError("E_GZH_CONTRACT", "gzh-design runner contract is required");
  assertDigest(input.licenseSha256, "gzh-design LICENSE digest");
  assertDigest(input.toolchainLockDigest, "toolchain lock digest");
  const files = normalizeLockedFiles(input.files);
  if (files.length === 0) throw freezeError("E_GZH_PROVENANCE_FILES", "gzh-design provenance must include locked files");
  return { ...input, repository, files };
}

function articleAssetMaps(article: ArticlePackage): {
  byId: Map<string, ArticleAsset>;
  byPath: Map<string, ArticleAsset>;
} {
  const byId = new Map<string, ArticleAsset>();
  const byPath = new Map<string, ArticleAsset>();
  for (const asset of article.assets) {
    if (byId.has(asset.id)) throw freezeError("E_ARTICLE_ASSET_DUPLICATE", `Duplicate article asset id: ${asset.id}`);
    const relative = assertSafeRelative(asset.path, `article asset ${asset.id}`);
    if (byPath.has(relative)) throw freezeError("E_ARTICLE_ASSET_DUPLICATE", `Duplicate article asset path: ${relative}`);
    assertDigest(asset.sha256, `article asset ${asset.id}`);
    byId.set(asset.id, asset);
    byPath.set(relative, asset);
  }
  return { byId, byPath };
}

function resolveCandidateAsset(
  source: string,
  maps: ReturnType<typeof articleAssetMaps>,
): ArticleAsset {
  if (source.startsWith("asset://")) {
    const id = source.slice("asset://".length);
    const asset = maps.byId.get(id);
    if (!asset) throw freezeError("E_WECHAT_ASSET_UNKNOWN", `Unknown ArticlePackage asset: ${id}`);
    return asset;
  }
  const relative = assertSafeRelative(source, "candidate image source");
  const asset = maps.byPath.get(relative);
  if (!asset) {
    throw freezeError("E_WECHAT_ASSET_UNKNOWN", `Candidate image is not owned by ArticlePackage: ${source}`);
  }
  return asset;
}

function chooseCover(article: ArticlePackage, maps: ReturnType<typeof articleAssetMaps>): ArticleAsset | undefined {
  if (article.metadata.coverAssetId) {
    const cover = maps.byId.get(article.metadata.coverAssetId);
    if (!cover) throw freezeError("E_WECHAT_COVER", `Unknown cover asset: ${article.metadata.coverAssetId}`);
    return cover;
  }
  const covers = article.assets.filter((asset) => asset.role === "cover");
  if (covers.length > 1) throw freezeError("E_WECHAT_COVER", "ArticlePackage has multiple cover assets and no coverAssetId");
  return covers[0];
}

function toManifestAsset(image: FrozenWechatImage): WechatRenderAsset {
  return {
    id: image.id,
    role: image.role,
    path: image.path,
    sha256: image.sha256,
    sourceSha256: image.sourceSha256,
    bytes: image.bytes,
    mediaType: image.mediaType,
    width: image.width,
    height: image.height,
    hasAlpha: image.hasAlpha,
  };
}

async function readCandidateHtml(options: FreezeWechatCandidateOptions): Promise<string> {
  const candidateRoot = options.candidateRoot ?? path.dirname(options.candidateHtmlPath);
  const candidatePath = await assertRealPathWithin(candidateRoot, options.candidateHtmlPath, "gzh HTML candidate");
  return normalizeWechatHtml(await readFile(candidatePath, "utf8"));
}

function finalPath(root: string, relative: string): string {
  const candidate = path.resolve(root, relative);
  if (!isWithin(root, candidate)) throw freezeError("E_PATH_ESCAPE", `Frozen artifact escapes root: ${relative}`);
  return candidate;
}

export async function freezeWechatCandidate(options: FreezeWechatCandidateOptions): Promise<FrozenWechatCandidate> {
  assertDigest(options.article.revision, "ArticlePackage revision");
  const provenanceInput = validateProvenance(options.provenance);
  if (await pathExists(options.frozenRoot)) {
    throw freezeError("E_WECHAT_ALREADY_FROZEN", `Frozen WeChat root already exists: ${options.frozenRoot}`);
  }

  const packageRoot = await assertRealPathWithin(options.packageRoot, options.packageRoot, "ArticlePackage root");
  const candidateHtml = await readCandidateHtml(options);
  const articleBody = await readArticlePackageBody(options.article, packageRoot);
  const codeFidelityReport = assertWechatCodeFidelity(articleBody, candidateHtml, WECHAT_CODE_TAB_SIZE);
  const inspection = inspectWechatHtml(candidateHtml, "candidate");
  const maps = articleAssetMaps(options.article);
  const cover = chooseCover(options.article, maps);

  const referencedBySource = new Map<string, ArticleAsset>();
  for (const reference of inspection.images) {
    referencedBySource.set(reference.src, resolveCandidateAsset(reference.src, maps));
  }
  const uniqueReferenced = new Map<string, ArticleAsset>();
  for (const asset of referencedBySource.values()) uniqueReferenced.set(asset.id, asset);

  const parent = path.dirname(options.frozenRoot);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(parent, `.${path.basename(options.frozenRoot)}.staging-`));

  try {
    const assetRoot = path.join(stagingRoot, "assets");
    const derivationInputs: WechatImageInput[] = [];
    for (const asset of uniqueReferenced.values()) {
      derivationInputs.push({
        id: asset.id,
        sourcePath: path.resolve(packageRoot, assertSafeRelative(asset.path, `article asset ${asset.id}`)),
        sourceRoot: packageRoot,
        destinationRoot: assetRoot,
        role: asset.id === cover?.id
          ? "cover"
          : asset.role === "screenshot"
            ? "screenshot"
            : "inline",
        expectedSourceSha256: asset.sha256,
      });
    }
    if (cover && !uniqueReferenced.has(cover.id)) {
      derivationInputs.push({
        id: cover.id,
        sourcePath: path.resolve(packageRoot, assertSafeRelative(cover.path, `cover asset ${cover.id}`)),
        sourceRoot: packageRoot,
        destinationRoot: assetRoot,
        role: "cover",
        expectedSourceSha256: cover.sha256,
      });
    }

    const derived = await deriveWechatImages(derivationInputs);
    const derivedById = new Map(derived.map((image) => [image.id, image]));
    const replacements = new Map<string, string>();
    for (const [source, asset] of referencedBySource) {
      const image = derivedById.get(asset.id);
      if (!image) throw freezeError("E_WECHAT_IMAGE_UNRESOLVED", `No derived image for ${asset.id}`);
      replacements.set(source, image.path);
    }
    const frozenHtml = rewriteWechatImageSources(candidateHtml, replacements);
    const htmlBytes = Buffer.from(frozenHtml, "utf8");
    const htmlSha256 = sha256Bytes(htmlBytes);
    await writeFile(path.join(stagingRoot, "wechat.html"), htmlBytes, { flag: "wx" });
    await validateFrozenWechatImageFiles(frozenHtml, stagingRoot);

    const preview = buildWechatPreview(frozenHtml, options.article.metadata.title);
    if (extractWechatPreviewPayload(preview) !== frozenHtml) {
      throw freezeError("E_WECHAT_PREVIEW_BYTES", "Preview payload bytes differ from frozen WeChat HTML");
    }
    await writeFile(path.join(stagingRoot, "preview.html"), preview, { encoding: "utf8", flag: "wx" });

    const manifestAssets = derived.map(toManifestAsset).sort((left, right) => {
      const idOrder = left.id.localeCompare(right.id);
      return idOrder === 0 ? left.path.localeCompare(right.path) : idOrder;
    });
    const coverImage = cover ? derivedById.get(cover.id) : undefined;
    const unsignedManifest = {
      schemaVersion: 1 as const,
      articleId: options.article.articleId,
      articleRevision: options.article.revision,
      renderer: {
        id: "wechat-gzh-design" as const,
        contract: provenanceInput.runnerContract,
        theme: provenanceInput.themeId,
        toolchainLockDigest: provenanceInput.toolchainLockDigest,
      },
      html: { path: "wechat.html" as const, sha256: htmlSha256, bytes: htmlBytes.byteLength },
      preview: { path: "preview.html" as const, sourceHtmlSha256: htmlSha256 },
      codeFidelity: {
        schemaVersion: 1 as const,
        renderer: "wechat-code-inline/v1" as const,
        theme: WECHAT_CODE_THEME,
        tabSize: codeFidelityReport.tabSize,
        blockCount: codeFidelityReport.sourceBlockCount,
        sourceBodySha256: options.article.body.sha256,
        sourceProjectionSha256: codeFidelityReport.sourceProjectionSha256,
        renderedProjectionSha256: codeFidelityReport.renderedProjectionSha256,
      },
      assets: manifestAssets,
      cover: coverImage
        ? { assetId: cover!.id, path: coverImage.path, sha256: coverImage.sha256 }
        : undefined,
    };
    const renderDigest = digestCanonical(unsignedManifest);
    const manifest: WechatRenderManifest = { ...unsignedManifest, renderDigest };
    await writeFile(path.join(stagingRoot, "render-manifest.json"), canonicalJson(manifest), {
      encoding: "utf8",
      flag: "wx",
    });

    const unsignedSidecar = {
      schemaVersion: 1 as const,
      component: "gzh-design-skill" as const,
      repository: provenanceInput.repository,
      revision: provenanceInput.revision,
      license: provenanceInput.license,
      licenseSha256: provenanceInput.licenseSha256,
      themeId: provenanceInput.themeId,
      runnerContract: provenanceInput.runnerContract,
      toolchainLockDigest: provenanceInput.toolchainLockDigest,
      files: provenanceInput.files,
      outputHtmlSha256: htmlSha256,
      renderDigest,
    };
    const provenanceDigest = digestCanonical(unsignedSidecar);
    const provenance: GzhDesignProvenanceSidecar = { ...unsignedSidecar, provenanceDigest };
    await writeFile(path.join(stagingRoot, "gzh-design.provenance.json"), canonicalJson(provenance), {
      encoding: "utf8",
      flag: "wx",
    });

    await verifyFrozenWechatCandidate(stagingRoot);
    await rename(stagingRoot, options.frozenRoot);

    return {
      root: options.frozenRoot,
      htmlPath: finalPath(options.frozenRoot, "wechat.html"),
      previewPath: finalPath(options.frozenRoot, "preview.html"),
      manifestPath: finalPath(options.frozenRoot, "render-manifest.json"),
      provenancePath: finalPath(options.frozenRoot, "gzh-design.provenance.json"),
      coverPath: manifest.cover ? finalPath(options.frozenRoot, manifest.cover.path) : undefined,
      renderDigest,
      provenanceDigest,
      manifest,
      provenance,
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function parseManifest(value: unknown): WechatRenderManifest {
  if (!value || typeof value !== "object") throw freezeError("E_WECHAT_MANIFEST", "Render manifest is invalid");
  const manifest = value as WechatRenderManifest;
  if (
    manifest.schemaVersion !== 1
    || !manifest.html
    || !Array.isArray(manifest.assets)
    || manifest.codeFidelity?.schemaVersion !== 1
    || manifest.codeFidelity.renderer !== "wechat-code-inline/v1"
  ) {
    throw freezeError("E_WECHAT_MANIFEST", "Render manifest schema is invalid");
  }
  assertDigest(manifest.renderDigest, "render digest");
  assertDigest(manifest.codeFidelity.sourceBodySha256, "source body digest");
  assertDigest(manifest.codeFidelity.sourceProjectionSha256, "source code projection digest");
  assertDigest(manifest.codeFidelity.renderedProjectionSha256, "rendered code projection digest");
  return manifest;
}

function parseSidecar(value: unknown): GzhDesignProvenanceSidecar {
  if (!value || typeof value !== "object") throw freezeError("E_GZH_PROVENANCE", "gzh-design provenance is invalid");
  const sidecar = value as GzhDesignProvenanceSidecar;
  if (sidecar.schemaVersion !== 1 || sidecar.component !== "gzh-design-skill" || !Array.isArray(sidecar.files)) {
    throw freezeError("E_GZH_PROVENANCE", "gzh-design provenance schema is invalid");
  }
  assertDigest(sidecar.provenanceDigest, "provenance digest");
  return sidecar;
}

export async function verifyFrozenWechatCandidate(frozenRoot: string): Promise<FrozenWechatCandidate> {
  const root = await assertRealPathWithin(frozenRoot, frozenRoot, "frozen WeChat root");
  const manifestPath = await assertRealPathWithin(root, path.join(root, "render-manifest.json"), "render manifest");
  const provenancePath = await assertRealPathWithin(
    root,
    path.join(root, "gzh-design.provenance.json"),
    "gzh-design provenance",
  );
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const provenance = parseSidecar(JSON.parse(await readFile(provenancePath, "utf8")) as unknown);

  const actualRenderDigest = digestCanonical(withoutKey(manifest as unknown as Record<string, unknown>, "renderDigest"));
  if (actualRenderDigest !== manifest.renderDigest) {
    throw freezeError("E_WECHAT_RENDER_DIGEST", "Frozen render manifest digest mismatch", {
      expected: manifest.renderDigest,
      actual: actualRenderDigest,
    });
  }
  const actualProvenanceDigest = digestCanonical(
    withoutKey(provenance as unknown as Record<string, unknown>, "provenanceDigest"),
  );
  if (actualProvenanceDigest !== provenance.provenanceDigest) {
    throw freezeError("E_GZH_PROVENANCE_DIGEST", "gzh-design provenance digest mismatch");
  }
  if (provenance.renderDigest !== manifest.renderDigest || provenance.outputHtmlSha256 !== manifest.html.sha256) {
    throw freezeError("E_GZH_PROVENANCE_LINK", "gzh-design provenance is not bound to this render");
  }
  if (
    provenance.themeId !== manifest.renderer.theme ||
    provenance.runnerContract !== manifest.renderer.contract ||
    provenance.toolchainLockDigest !== manifest.renderer.toolchainLockDigest
  ) {
    throw freezeError("E_GZH_PROVENANCE_LINK", "gzh-design provenance does not match the frozen renderer contract");
  }
  validateProvenance({
    repository: provenance.repository,
    revision: provenance.revision,
    license: provenance.license,
    licenseSha256: provenance.licenseSha256,
    themeId: provenance.themeId,
    runnerContract: provenance.runnerContract,
    toolchainLockDigest: provenance.toolchainLockDigest,
    files: provenance.files,
  });

  const htmlRelative = assertSafeRelative(manifest.html.path, "frozen HTML path");
  const htmlPath = await assertRealPathWithin(root, path.resolve(root, htmlRelative), "frozen WeChat HTML");
  const htmlBytes = await readFile(htmlPath);
  if (htmlBytes.byteLength !== manifest.html.bytes || sha256Bytes(htmlBytes) !== manifest.html.sha256) {
    throw freezeError("E_WECHAT_HTML_DIGEST", "Frozen WeChat HTML bytes changed after confirmation");
  }
  const html = htmlBytes.toString("utf8");
  const renderedCode = inspectRenderedWechatCodeBlocks(html);
  const renderedProjectionSha256 = digestWechatCodeProjection(renderedCode.blocks);
  if (
    renderedCode.unmarkedCodeCount > 0
    || renderedCode.blocks.length !== manifest.codeFidelity.blockCount
    || renderedProjectionSha256 !== manifest.codeFidelity.renderedProjectionSha256
    || manifest.codeFidelity.sourceProjectionSha256 !== manifest.codeFidelity.renderedProjectionSha256
    || manifest.codeFidelity.tabSize !== WECHAT_CODE_TAB_SIZE
    || manifest.codeFidelity.theme !== WECHAT_CODE_THEME
  ) {
    throw freezeError("E_WECHAT_CODE_FIDELITY", "Frozen WeChat code projection does not match its manifest", {
      unmarkedCodeCount: renderedCode.unmarkedCodeCount,
      expectedBlockCount: manifest.codeFidelity.blockCount,
      actualBlockCount: renderedCode.blocks.length,
      expectedProjectionSha256: manifest.codeFidelity.renderedProjectionSha256,
      actualProjectionSha256: renderedProjectionSha256,
    });
  }
  const references = await validateFrozenWechatImageFiles(html, root);

  const manifestPaths = new Map<string, WechatRenderAsset>();
  for (const asset of manifest.assets) {
    const relative = assertSafeRelative(asset.path, `render asset ${asset.id}`);
    if (manifestPaths.has(relative)) throw freezeError("E_WECHAT_MANIFEST", `Duplicate render asset path: ${relative}`);
    const absolute = await assertRealPathWithin(root, path.resolve(root, relative), `render asset ${asset.id}`);
    const bytes = await readFile(absolute);
    if (bytes.byteLength !== asset.bytes || sha256Bytes(bytes) !== asset.sha256) {
      throw freezeError("E_WECHAT_IMAGE_DIGEST", `Frozen image bytes changed: ${relative}`);
    }
    const metadata = await sharp(bytes, { failOn: "error", animated: false }).metadata();
    const expectedFormat = asset.mediaType === "image/png" ? "png" : "jpeg";
    if (metadata.format !== expectedFormat || metadata.width !== asset.width || metadata.height !== asset.height) {
      throw freezeError("E_WECHAT_IMAGE_METADATA", `Frozen image metadata changed: ${relative}`);
    }
    manifestPaths.set(relative, asset);
  }
  for (const reference of references) {
    if (!manifestPaths.has(reference.src)) {
      throw freezeError("E_WECHAT_MANIFEST", `HTML references an image missing from render manifest: ${reference.src}`);
    }
  }
  for (const [relative] of manifestPaths) {
    const usedByBody = references.some((reference) => reference.src === relative);
    const usedByCover = manifest.cover?.path === relative;
    if (!usedByBody && !usedByCover) {
      throw freezeError("E_WECHAT_MANIFEST", `Render manifest contains an unused image: ${relative}`);
    }
  }
  if (manifest.cover) {
    const cover = manifestPaths.get(manifest.cover.path);
    if (!cover || cover.sha256 !== manifest.cover.sha256) {
      throw freezeError("E_WECHAT_COVER", "Frozen cover is missing or does not match the render manifest");
    }
  }

  const previewRelative = assertSafeRelative(manifest.preview.path, "preview path");
  const previewPath = await assertRealPathWithin(root, path.resolve(root, previewRelative), "WeChat preview");
  const preview = await readFile(previewPath, "utf8");
  const previewPayload = extractWechatPreviewPayload(preview);
  if (previewPayload !== html || sha256Bytes(previewPayload) !== manifest.preview.sourceHtmlSha256) {
    throw freezeError("E_WECHAT_PREVIEW_BYTES", "Preview no longer contains the exact frozen HTML bytes");
  }

  return {
    root,
    htmlPath,
    previewPath,
    manifestPath,
    provenancePath,
    coverPath: manifest.cover ? finalPath(root, manifest.cover.path) : undefined,
    renderDigest: manifest.renderDigest,
    provenanceDigest: provenance.provenanceDigest,
    manifest,
    provenance,
  };
}
