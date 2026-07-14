import path from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { PublishError } from "./errors";

export function assertSafeRelative(relativePath: string, label = "path"): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new PublishError("E_PATH", `${label} must be a non-empty relative path`);
  }
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new PublishError("E_PATH_ESCAPE", `${label} escapes its root`);
  }
  return normalized;
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function assertRealPathWithin(root: string, candidate: string, label = "path"): Promise<string> {
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!isWithin(realRoot, realCandidate)) {
    throw new PublishError("E_PATH_ESCAPE", `${label} resolves outside the allowed root`);
  }
  return realCandidate;
}

export async function assertPathWithinNoSymlinks(
  root: string,
  candidate: string,
  label = "path",
): Promise<void> {
  const lexicalRoot = path.resolve(root);
  const lexicalCandidate = path.resolve(candidate);
  if (!isWithin(lexicalRoot, lexicalCandidate)) {
    throw new PublishError("E_PATH_ESCAPE", `${label} escapes its allowed root`);
  }
  const realRoot = await realpath(lexicalRoot);
  const relative = path.relative(lexicalRoot, lexicalCandidate);
  let current = realRoot;
  const segments = relative ? relative.split(path.sep) : [];
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) {
      throw new PublishError("E_PATH_SYMLINK", `${label} crosses a symbolic link`);
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new PublishError("E_PATH_PARENT", `${label} has a non-directory ancestor`);
    }
  }
  const realCandidate = await realpath(current);
  if (!isWithin(realRoot, realCandidate)) {
    throw new PublishError("E_PATH_ESCAPE", `${label} resolves outside its allowed root`);
  }
}

export async function ensureDirectoryWithin(
  root: string,
  candidate: string,
  label = "directory",
): Promise<string> {
  const lexicalRoot = path.resolve(root);
  const lexicalCandidate = path.resolve(candidate);
  if (!isWithin(lexicalRoot, lexicalCandidate)) {
    throw new PublishError("E_PATH_ESCAPE", `${label} escapes its allowed root`);
  }
  const realRoot = await realpath(lexicalRoot);
  const relative = path.relative(lexicalRoot, lexicalCandidate);
  let current = realRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    let info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) {
      await mkdir(current);
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new PublishError("E_PATH_SYMLINK", `${label} must contain only real directories`);
    }
  }
  const result = await realpath(current);
  if (!isWithin(realRoot, result)) throw new PublishError("E_PATH_ESCAPE", `${label} escaped its allowed root`);
  return result;
}

export function safeIdentifier(value: string, fallback = "article"): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}
