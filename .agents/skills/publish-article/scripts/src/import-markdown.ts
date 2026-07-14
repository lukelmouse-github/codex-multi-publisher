import path from "node:path";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import type { Html, Image, Root, Text } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { sha256Bytes } from "./canonical-json";
import { PublishError } from "./errors";
import { parseFrontmatter } from "./frontmatter";
import { isWithin, safeIdentifier } from "./path-policy";
import { atomicWriteFile } from "./run-store";
import type { ImportedArticle, ImportedAsset } from "./types";

export interface ImportMarkdownOptions {
  sourcePath: string;
  outputRoot: string;
  vaultRoot?: string;
  sourceId?: string;
}

interface Reference {
  kind: "markdown" | "html" | "obsidian";
  original: string;
  start: number;
  end: number;
  alt?: string;
  title?: string | null;
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

const MEDIA_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function nodeOffsets(node: { position?: { start: { offset?: number }; end: { offset?: number } } }): [number, number] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    throw new PublishError("E_MARKDOWN_POSITION", "Markdown parser did not report source offsets");
  }
  return [start, end];
}

function isExternalReference(reference: string): boolean {
  return /^(?:https?:|data:|asset:|#|\/\/)/i.test(reference) || reference.startsWith("/");
}

function referencePath(reference: string): string {
  const withoutAngles = reference.startsWith("<") && reference.endsWith(">")
    ? reference.slice(1, -1)
    : reference;
  const withoutSuffix = withoutAngles.split(/[?#]/, 1)[0] ?? "";
  try {
    return decodeURIComponent(withoutSuffix).replaceAll("\\", "/");
  } catch {
    throw new PublishError("E_ASSET_REFERENCE", `Image reference is not valid URL encoding: ${reference}`);
  }
}

function markdownImage(alt: string | undefined, assetId: string, title?: string | null): string {
  const safeAlt = (alt ?? "").replaceAll("\\", "\\\\").replaceAll("]", "\\]");
  const titleSuffix = title
    ? ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : "";
  return `![${safeAlt}](asset://${assetId}${titleSuffix})`;
}

function collectReferences(body: string, tree: Root): Reference[] {
  const references: Reference[] = [];

  visit(tree, "image", (node: Image) => {
    if (isExternalReference(node.url)) return;
    const [start, end] = nodeOffsets(node);
    references.push({
      kind: "markdown",
      original: node.url,
      start,
      end,
      alt: node.alt ?? undefined,
      title: node.title,
    });
  });

  visit(tree, "html", (node: Html) => {
    const [nodeStart] = nodeOffsets(node);
    const imagePattern = /<img\b[^>]*>/gi;
    for (const imageMatch of node.value.matchAll(imagePattern)) {
      const tag = imageMatch[0];
      const tagOffset = imageMatch.index ?? 0;
      const sourceMatch = /\bsrc\s*=\s*(?:(['"])(.*?)\1|([^\s'"=<>`]+))/i.exec(tag);
      if (!sourceMatch) continue;
      const original = sourceMatch[2] ?? sourceMatch[3] ?? "";
      if (!original || isExternalReference(original)) continue;
      const sourceOffset = sourceMatch.index + sourceMatch[0].lastIndexOf(original);
      const start = nodeStart + tagOffset + sourceOffset;
      references.push({ kind: "html", original, start, end: start + original.length });
    }
  });

  visit(tree, "text", (node: Text) => {
    const [nodeStart] = nodeOffsets(node);
    const embedPattern = /!\[\[([^\]\n]+)\]\]/g;
    for (const match of node.value.matchAll(embedPattern)) {
      const rawTarget = match[1] ?? "";
      const [rawPath = "", modifier] = rawTarget.split("|", 2);
      const original = rawPath.trim();
      if (!original || isExternalReference(original)) continue;
      const start = nodeStart + (match.index ?? 0);
      const modifierAlt = modifier?.trim();
      const fallbackAlt = path.basename(original, path.extname(original));
      references.push({
        kind: "obsidian",
        original,
        start,
        end: start + match[0].length,
        alt: modifierAlt && !/^\d+(?:x\d+)?$/i.test(modifierAlt) ? modifierAlt : fallbackAlt,
      });
    }
  });

  references.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < references.length; index += 1) {
    const previous = references[index - 1];
    const current = references[index];
    if (previous && current && current.start < previous.end) {
      throw new PublishError("E_MARKDOWN_REFERENCE", "Overlapping image references are not supported");
    }
  }
  return references;
}

async function existingRealPath(candidate: string, allowedRoot: string): Promise<string | undefined> {
  if (!isWithin(allowedRoot, candidate)) {
    throw new PublishError("E_PATH_ESCAPE", `Image reference resolves outside ${allowedRoot}`);
  }
  try {
    const resolved = await realpath(candidate);
    if (!isWithin(allowedRoot, resolved)) {
      throw new PublishError("E_PATH_ESCAPE", `Image reference resolves outside ${allowedRoot}`);
    }
    return resolved;
  } catch (error) {
    if (error instanceof PublishError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

async function findByBasename(root: string, basename: string): Promise<string[]> {
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === basename) matches.push(candidate);
    }
  }
  return matches.sort();
}

async function resolveReference(
  reference: Reference,
  sourceDirectory: string,
  allowedRoot: string,
): Promise<string> {
  const decoded = referencePath(reference.original);
  if (!decoded) {
    throw new PublishError("E_ASSET_REFERENCE", `Image reference is empty: ${reference.original}`);
  }

  if (reference.kind !== "obsidian") {
    const candidate = await existingRealPath(path.resolve(sourceDirectory, decoded), allowedRoot);
    if (!candidate) {
      throw new PublishError("E_ASSET_NOT_FOUND", `Image not found: ${reference.original}`, {
        details: { reference: reference.original },
      });
    }
    return candidate;
  }

  const vaultRelative = decoded.replace(/^\/+/, "");
  if (decoded.includes("/") || decoded.includes("\\")) {
    const candidates = [path.resolve(sourceDirectory, decoded), path.resolve(allowedRoot, vaultRelative)];
    for (const candidatePath of [...new Set(candidates)]) {
      const candidate = await existingRealPath(candidatePath, allowedRoot);
      if (candidate) return candidate;
    }
    throw new PublishError("E_ASSET_NOT_FOUND", `Obsidian image not found: ${reference.original}`, {
      details: { reference: reference.original },
    });
  }

  const matches = await findByBasename(allowedRoot, decoded);
  if (matches.length === 0) {
    throw new PublishError("E_ASSET_NOT_FOUND", `Obsidian image not found: ${reference.original}`);
  }
  if (matches.length > 1) {
    throw new PublishError("E_ASSET_AMBIGUOUS", `Obsidian image is ambiguous: ${reference.original}`, {
      kind: "conflict",
      details: { reference: reference.original, candidates: matches },
    });
  }
  const match = matches[0];
  if (!match) throw new PublishError("E_ASSET_NOT_FOUND", `Obsidian image not found: ${reference.original}`);
  const resolved = await existingRealPath(match, allowedRoot);
  if (!resolved) throw new PublishError("E_ASSET_NOT_FOUND", `Obsidian image not found: ${reference.original}`);
  return resolved;
}

function applyReplacements(body: string, replacements: Replacement[]): string {
  let output = body;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
}

export async function importMarkdown(options: ImportMarkdownOptions): Promise<ImportedArticle> {
  if (!path.isAbsolute(options.sourcePath)) {
    throw new PublishError("E_SOURCE_PATH", "sourcePath must be an absolute path");
  }
  if (!path.isAbsolute(options.outputRoot)) {
    throw new PublishError("E_OUTPUT_ROOT", "outputRoot must be an absolute path");
  }

  const sourcePath = await realpath(options.sourcePath);
  const sourceDirectory = path.dirname(sourcePath);
  const allowedRoot = await realpath(options.vaultRoot ?? sourceDirectory);
  if (!isWithin(allowedRoot, sourcePath)) {
    throw new PublishError("E_SOURCE_PATH", "sourcePath must be inside vaultRoot");
  }
  if (isWithin(allowedRoot, options.outputRoot)) {
    throw new PublishError("E_OUTPUT_ROOT", "outputRoot must not overlap the read-only source tree");
  }

  await mkdir(options.outputRoot, { recursive: true });
  const realOutputRoot = await realpath(options.outputRoot);
  if (isWithin(allowedRoot, realOutputRoot)) {
    throw new PublishError("E_OUTPUT_ROOT", "outputRoot resolves inside the read-only source tree");
  }
  const assetsRoot = path.join(realOutputRoot, "assets");
  await mkdir(assetsRoot, { recursive: true });

  const sourceBytes = await readFile(sourcePath);
  const sourceDigest = sha256Bytes(sourceBytes);
  const parsed = parseFrontmatter(sourceBytes.toString("utf8"));
  const tree = unified().use(remarkParse).parse(parsed.body) as Root;
  const references = collectReferences(parsed.body, tree);
  const replacements: Replacement[] = [];
  const assetsByDigest = new Map<string, ImportedAsset>();
  const sourceSnapshots = new Map<string, string>([[sourcePath, sourceDigest]]);

  for (const reference of references) {
    const resolved = await resolveReference(reference, sourceDirectory, allowedRoot);
    const info = await stat(resolved);
    if (!info.isFile()) {
      throw new PublishError("E_ASSET_NOT_FILE", `Image reference is not a file: ${reference.original}`);
    }
    const bytes = await readFile(resolved);
    const digest = sha256Bytes(bytes);
    sourceSnapshots.set(resolved, digest);

    let asset = assetsByDigest.get(digest);
    if (!asset) {
      const digestHex = digest.slice("sha256:".length);
      const rawExtension = path.extname(resolved).toLowerCase();
      const extension = /^\.[a-z0-9]{1,10}$/.test(rawExtension) ? rawExtension : ".bin";
      const relativePath = `assets/${digestHex}${extension}`;
      const outputPath = path.join(realOutputRoot, ...relativePath.split("/"));
      if (!isWithin(realOutputRoot, outputPath)) {
        throw new PublishError("E_PATH_ESCAPE", "Generated asset path escapes outputRoot");
      }
      await atomicWriteFile(outputPath, bytes);
      const copiedDigest = sha256Bytes(await readFile(outputPath));
      if (copiedDigest !== digest) {
        throw new PublishError("E_ASSET_COPY", `Copied image digest mismatch: ${reference.original}`, {
          kind: "transient",
          retryable: true,
        });
      }
      asset = {
        id: `asset-${digestHex.slice(0, 16)}`,
        path: relativePath,
        sha256: digest,
        mediaType: MEDIA_TYPES[extension] ?? "application/octet-stream",
        bytes: bytes.byteLength,
        role: "inline",
        alt: reference.alt,
        originalReference: reference.original,
        sourcePath: resolved,
      };
      assetsByDigest.set(digest, asset);
    }

    replacements.push({
      start: reference.start,
      end: reference.end,
      value: reference.kind === "html"
        ? `asset://${asset.id}`
        : markdownImage(reference.alt, asset.id, reference.title),
    });
  }

  for (const [originalPath, digest] of sourceSnapshots) {
    const currentDigest = sha256Bytes(await readFile(originalPath));
    if (currentDigest !== digest) {
      throw new PublishError("E_SOURCE_CHANGED", `Source changed while importing: ${originalPath}`, {
        kind: "conflict",
        details: { before: digest, after: currentDigest },
      });
    }
  }

  return {
    schemaVersion: 1,
    sourcePath,
    sourceDigest,
    sourceId: options.sourceId ?? `source-${safeIdentifier(path.basename(sourcePath, path.extname(sourcePath)))}`,
    frontmatter: parsed.data,
    body: applyReplacements(parsed.body, replacements),
    assets: [...assetsByDigest.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}
