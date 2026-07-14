import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { PublishError } from "./errors";
import { ensureDirectoryWithin, isWithin, safeIdentifier } from "./path-policy";

export interface RunStorePaths {
  runRoot: string;
  packageRoot: string;
  articleJson: string;
  body: string;
  assetsRoot: string;
  receiptsRoot: string;
}

function revisionSegment(revision: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(revision);
  if (!match?.[1]) {
    throw new PublishError("E_REVISION", "revision must be a sha256 digest");
  }
  return match[1];
}

export async function createRunStore(
  runsRoot: string,
  articleId: string,
  revision: string,
): Promise<RunStorePaths> {
  if (!path.isAbsolute(runsRoot)) {
    throw new PublishError("E_RUN_ROOT", "runsRoot must be an absolute path");
  }
  const lexicalRunsRoot = path.resolve(runsRoot);
  const realRunsRoot = await ensureDirectoryWithin(path.dirname(lexicalRunsRoot), lexicalRunsRoot, "runs root");
  const articleSegment = safeIdentifier(articleId);
  const runRoot = path.join(realRunsRoot, articleSegment, revisionSegment(revision));
  if (!isWithin(realRunsRoot, runRoot)) {
    throw new PublishError("E_PATH_ESCAPE", "run directory escapes runsRoot");
  }

  const packageRoot = path.join(runRoot, "package");
  const assetsRoot = path.join(packageRoot, "assets");
  const receiptsRoot = path.join(runRoot, "receipts");
  await ensureDirectoryWithin(realRunsRoot, assetsRoot, "ArticlePackage assets directory");
  await ensureDirectoryWithin(realRunsRoot, receiptsRoot, "ArticlePackage receipts directory");

  return {
    runRoot,
    packageRoot,
    articleJson: path.join(packageRoot, "article.json"),
    body: path.join(packageRoot, "body.md"),
    assetsRoot,
    receiptsRoot,
  };
}

export const ensureRunStore = createRunStore;

export async function atomicWriteFile(
  targetPath: string,
  value: string | Uint8Array,
): Promise<void> {
  const parent = path.dirname(targetPath);
  await mkdir(parent, { recursive: true });
  const temporaryPath = path.join(
    parent,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);

    // Best-effort directory fsync makes the rename durable without reducing
    // portability on filesystems that do not permit opening directories.
    try {
      const directory = await open(parent, "r");
      await directory.sync();
      await directory.close();
    } catch {
      // The file rename itself is still atomic.
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
