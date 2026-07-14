import path from "node:path";
import { readFile } from "node:fs/promises";
import { canonicalJson, digestCanonical, sha256Bytes } from "./canonical-json";
import { PublishError } from "./errors";
import { assertSafeRelative, isWithin, safeIdentifier } from "./path-policy";
import { atomicWriteFile, createRunStore, type RunStorePaths } from "./run-store";
import type { ArticleAsset, ArticleMetadata, ArticlePackage, ImportedArticle } from "./types";

export interface CreateArticlePackageOptions {
  imported: ImportedArticle;
  runsRoot: string;
  articleId?: string;
  metadata?: Partial<ArticleMetadata>;
  body?: string;
}

export interface CreatedArticlePackage {
  article: ArticlePackage;
  paths: RunStorePaths;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(values.map((item) => firstString(item)).filter((item): item is string => Boolean(item)))];
}

function dateString(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  return firstString(value);
}

function deriveMetadata(
  imported: ImportedArticle,
  body: string,
  overrides: Partial<ArticleMetadata> = {},
): ArticleMetadata {
  const source = imported.frontmatter;
  const heading = /^#\s+(.+?)\s*$/m.exec(body)?.[1];
  const fallbackTitle = path.basename(imported.sourcePath, path.extname(imported.sourcePath));
  const title = firstString(overrides.title, source.title, heading, fallbackTitle) ?? "Untitled";
  const coverAssetId = firstString(
    overrides.coverAssetId,
    source.coverAssetId,
    imported.assets.find((asset) => asset.role === "cover")?.id,
  );

  return {
    title,
    slug: safeIdentifier(firstString(overrides.slug, source.slug, title) ?? "article"),
    summary: firstString(overrides.summary, source.summary, source.description) ?? "",
    author: firstString(overrides.author, source.author) ?? "",
    language: firstString(overrides.language, source.language, source.lang) ?? "",
    tags: overrides.tags ? stringArray(overrides.tags) : stringArray(source.tags),
    categories: overrides.categories ? stringArray(overrides.categories) : stringArray(source.categories),
    publishedAt: dateString(overrides.publishedAt ?? source.publishedAt ?? source.publishDate ?? source.date),
    updatedAt: dateString(overrides.updatedAt ?? source.updatedAt ?? source.lastmod),
    coverAssetId,
  };
}

function publicAssets(imported: ImportedArticle): ArticleAsset[] {
  const ids = new Set<string>();
  const paths = new Set<string>();
  return imported.assets
    .map((asset): ArticleAsset => {
      const relativePath = assertSafeRelative(asset.path, `asset ${asset.id} path`);
      if (!relativePath.startsWith("assets/")) {
        throw new PublishError("E_ASSET_PATH", `Asset path must be below assets/: ${relativePath}`);
      }
      if (ids.has(asset.id)) throw new PublishError("E_ASSET_ID", `Duplicate asset id: ${asset.id}`);
      if (paths.has(relativePath)) throw new PublishError("E_ASSET_PATH", `Duplicate asset path: ${relativePath}`);
      ids.add(asset.id);
      paths.add(relativePath);
      return {
        id: asset.id,
        path: relativePath,
        sha256: asset.sha256,
        mediaType: asset.mediaType,
        bytes: asset.bytes,
        role: asset.role,
        alt: asset.alt,
        caption: asset.caption,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
}

function assertKnownAssetReferences(body: string, assets: ArticleAsset[]): void {
  const known = new Set(assets.map((asset) => asset.id));
  for (const match of body.matchAll(/asset:\/\/([a-zA-Z0-9._-]+)/g)) {
    const id = match[1];
    if (id && !known.has(id)) {
      throw new PublishError("E_ASSET_REFERENCE", `Unknown asset reference: ${id}`);
    }
  }
}

export async function createArticlePackage(
  options: CreateArticlePackageOptions,
): Promise<CreatedArticlePackage> {
  const body = options.body ?? options.imported.body;
  const articleId = safeIdentifier(options.articleId ?? options.imported.sourceId, "article");
  const metadata = deriveMetadata(options.imported, body, options.metadata);
  for (const field of ["title", "slug", "summary", "author", "language"] as const) {
    if (!metadata[field].trim()) {
      throw new PublishError("E_METADATA_REQUIRED", `Article metadata field ${field} is required`);
    }
  }
  const assets = publicAssets(options.imported);
  assertKnownAssetReferences(body, assets);
  if (metadata.coverAssetId && !assets.some((asset) => asset.id === metadata.coverAssetId)) {
    throw new PublishError("E_COVER_ASSET", `Unknown cover asset: ${metadata.coverAssetId}`);
  }

  const bodyDigest = sha256Bytes(body);
  const revision = digestCanonical({
    schemaVersion: 1,
    articleId,
    metadata,
    body: { path: "body.md", sha256: bodyDigest },
    assets,
  });
  const article: ArticlePackage = {
    schemaVersion: 1,
    articleId,
    revision,
    metadata,
    body: { path: "body.md", sha256: bodyDigest },
    assets,
    provenance: {
      sourceId: options.imported.sourceId,
      sourceDigest: options.imported.sourceDigest,
      packagerVersion: 1,
    },
  };

  const paths = await createRunStore(options.runsRoot, articleId, revision);
  const sourceById = new Map(options.imported.assets.map((asset) => [asset.id, asset]));
  for (const asset of assets) {
    const importedAsset = sourceById.get(asset.id);
    if (!importedAsset) throw new PublishError("E_ASSET_SOURCE", `Missing imported asset: ${asset.id}`);
    const bytes = await readFile(importedAsset.sourcePath);
    const actualDigest = sha256Bytes(bytes);
    if (actualDigest !== asset.sha256 || bytes.byteLength !== asset.bytes) {
      throw new PublishError("E_SOURCE_CHANGED", `Imported asset changed before packaging: ${asset.id}`, {
        kind: "conflict",
        details: { expected: asset.sha256, actual: actualDigest },
      });
    }
    const outputPath = path.join(paths.packageRoot, ...asset.path.split("/"));
    if (!isWithin(paths.packageRoot, outputPath)) {
      throw new PublishError("E_PATH_ESCAPE", `Asset output escapes package: ${asset.path}`);
    }
    await atomicWriteFile(outputPath, bytes);
  }

  await atomicWriteFile(paths.body, body);
  await atomicWriteFile(paths.articleJson, canonicalJson(article));
  return { article, paths };
}

export const buildArticlePackage = createArticlePackage;
