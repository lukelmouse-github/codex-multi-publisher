import path from "node:path";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as TOML from "@iarna/toml";
import type { ArticleAsset, ArticlePackage } from "./types";
import { canonicalJson, digestCanonical } from "./canonical-json";
import { PublishError } from "./errors";
import { assertSafeRelative, isWithin } from "./path-policy";

export interface HugoRenderResult {
  candidateRoot: string;
  contentRoot: string;
  bundleRoot: string;
  articlePath: string;
  manifestPath: string;
  treeDigest: string;
}

export function hugoSectionFromContentRoot(value: string): string {
  const root = assertSafeRelative(value.replaceAll("\\", "/"), "blog content root");
  if (root === "content") return "";
  if (!root.startsWith("content/")) {
    throw new PublishError("E_HUGO_CONTENT_ROOT", "Blog contentRoot must be content or a directory below content/");
  }
  return root.slice("content/".length);
}

function validatePublishDate(value: string | undefined, now: Date): string {
  if (!value) {
    throw new PublishError("E_DATE_REQUIRED", "publishedAt is required before rendering a Hugo post");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new PublishError("E_DATE_INVALID", `Invalid publishedAt value: ${value}`);
  }
  if (timestamp > now.getTime()) {
    throw new PublishError("E_DATE_FUTURE", "publishedAt cannot be in the future while buildFuture=false");
  }
  return value;
}

function assetById(article: ArticlePackage): Map<string, ArticleAsset> {
  return new Map(article.assets.map((asset) => [asset.id, asset]));
}

export function rewriteAssetUris(body: string, article: ArticlePackage): string {
  const assets = assetById(article);
  return body.replace(/asset:\/\/([A-Za-z0-9._-]+)/g, (_match, id: string) => {
    const asset = assets.get(id);
    if (!asset) throw new PublishError("E_ASSET_UNKNOWN", `Unknown asset reference: ${id}`);
    return assertSafeRelative(asset.path, `asset ${id}`);
  });
}

function buildFrontmatter(article: ArticlePackage, now: Date): string {
  const cover = article.metadata.coverAssetId
    ? article.assets.find((asset) => asset.id === article.metadata.coverAssetId)
    : undefined;
  const data: Record<string, unknown> = {
    title: article.metadata.title,
    date: validatePublishDate(article.metadata.publishedAt, now),
    draft: false,
  };
  if (article.metadata.updatedAt) data.lastmod = article.metadata.updatedAt;
  if (article.metadata.summary) data.summary = article.metadata.summary;
  if (article.metadata.author) data.author = article.metadata.author;
  if (article.metadata.tags.length > 0) data.tags = article.metadata.tags;
  if (article.metadata.categories.length > 0) data.categories = article.metadata.categories;
  if (cover) {
    data.images = [assertSafeRelative(cover.path, "cover path")];
    data.cover = { image: assertSafeRelative(cover.path, "cover path"), alt: cover.alt ?? article.metadata.title };
  }
  return `+++\n${TOML.stringify(data as TOML.JsonMap).trimEnd()}\n+++`;
}

export async function renderHugoBundle(
  article: ArticlePackage,
  packageRoot: string,
  outputRoot: string,
  options: { now?: Date; contentRoot?: string } = {},
): Promise<HugoRenderResult> {
  const slug = assertSafeRelative(article.metadata.slug, "slug");
  if (slug.includes("/")) throw new PublishError("E_SLUG", "slug must be a single path segment");
  const section = hugoSectionFromContentRoot(options.contentRoot ?? "content/posts");
  const bodyPath = path.join(packageRoot, article.body.path);
  const assetsRoot = path.join(packageRoot, "assets");
  const candidateRoot = path.resolve(outputRoot);
  const contentRoot = path.join(candidateRoot, "content");
  const bundleRoot = path.join(contentRoot, ...section.split("/").filter(Boolean), slug);
  if (!isWithin(candidateRoot, bundleRoot)) throw new PublishError("E_PATH_ESCAPE", "Hugo bundle escaped output root");

  await rm(candidateRoot, { recursive: true, force: true });
  await mkdir(bundleRoot, { recursive: true });

  const body = await readFile(bodyPath, "utf8");
  const rewritten = rewriteAssetUris(body, article);
  const frontmatter = buildFrontmatter(article, options.now ?? new Date());
  const articlePath = path.join(bundleRoot, "index.md");
  await writeFile(articlePath, `${frontmatter}\n\n${rewritten.trimEnd()}\n`, "utf8");

  for (const asset of article.assets) {
    const relative = assertSafeRelative(asset.path, `asset ${asset.id}`);
    const source = path.join(packageRoot, relative);
    const destination = path.join(bundleRoot, relative);
    if (!isWithin(assetsRoot, source) || !isWithin(bundleRoot, destination)) {
      throw new PublishError("E_PATH_ESCAPE", `Asset ${asset.id} escaped its root`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
  }

  const publicManifest = {
    schemaVersion: 1,
    articleId: article.articleId,
    revision: article.revision,
    managedFiles: ["index.md", ...article.assets.map((asset) => assertSafeRelative(asset.path))].sort(),
  };
  const manifestPath = path.join(bundleRoot, ".publish-manifest.json");
  await writeFile(manifestPath, canonicalJson(publicManifest), "utf8");
  const treeDigest = digestCanonical(publicManifest);
  return { candidateRoot, contentRoot, bundleRoot, articlePath, manifestPath, treeDigest };
}
