import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { sha256Bytes } from "../src/canonical-json";
import { PublishError } from "../src/errors";
import {
  WECHAT_BODY_IMAGE_MAX_BYTES,
  deriveWechatImage,
  deriveWechatImages,
} from "../src/wechat-images";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "publish-article-wechat-images-"));
  cleanup.push(root);
  return root;
}

async function writeOpaqueWebp(file: string, width = 320, height = 180): Promise<Buffer> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 5, g: 150, b: 105 } },
  })
    .webp({ lossless: true })
    .toBuffer();
  await writeFile(file, buffer);
  return buffer;
}

async function writeTransparentWebp(file: string): Promise<Buffer> {
  const buffer = await sharp({
    create: { width: 96, height: 64, channels: 4, background: { r: 5, g: 150, b: 105, alpha: 0.35 } },
  })
    .webp({ lossless: true })
    .toBuffer();
  await writeFile(file, buffer);
  return buffer;
}

describe("deriveWechatImage", () => {
  test("derives opaque WebP to deterministic JPEG", async () => {
    const root = await tempRoot();
    const sourceRoot = path.join(root, "package");
    await mkdir(sourceRoot, { recursive: true });
    const sourcePath = path.join(sourceRoot, "opaque.webp");
    const source = await writeOpaqueWebp(sourcePath);

    const first = await deriveWechatImage({
      id: "inline-opaque",
      sourcePath,
      sourceRoot,
      destinationRoot: path.join(root, "first", "assets"),
      role: "inline",
      expectedSourceSha256: sha256Bytes(source),
    });
    const second = await deriveWechatImage({
      id: "inline-opaque",
      sourcePath,
      sourceRoot,
      destinationRoot: path.join(root, "second", "assets"),
      role: "inline",
      expectedSourceSha256: sha256Bytes(source),
    });

    expect(first.mediaType).toBe("image/jpeg");
    expect(first.path).toMatch(/^assets\/inline-opaque-[a-f0-9]{16}\.jpg$/);
    expect(first.sha256).toBe(second.sha256);
    expect(await readFile(first.absolutePath)).toEqual(await readFile(second.absolutePath));
    expect(first.bytes).toBeLessThanOrEqual(WECHAT_BODY_IMAGE_MAX_BYTES);
    expect((await sharp(first.absolutePath).metadata()).format).toBe("jpeg");
  });

  test("preserves transparency by deriving PNG", async () => {
    const root = await tempRoot();
    const sourceRoot = path.join(root, "package");
    await mkdir(sourceRoot, { recursive: true });
    const sourcePath = path.join(sourceRoot, "transparent.webp");
    const source = await writeTransparentWebp(sourcePath);

    const result = await deriveWechatImage({
      id: "inline-transparent",
      sourcePath,
      sourceRoot,
      destinationRoot: path.join(root, "frozen", "assets"),
      role: "inline",
      expectedSourceSha256: sha256Bytes(source),
    });

    const metadata = await sharp(result.absolutePath).metadata();
    expect(result.mediaType).toBe("image/png");
    expect(result.path).toMatch(/\.png$/);
    expect(metadata.format).toBe("png");
    expect(metadata.hasAlpha).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(WECHAT_BODY_IMAGE_MAX_BYTES);
  });

  test("treats a fully opaque alpha channel as JPEG-compatible", async () => {
    const root = await tempRoot();
    const sourceRoot = path.join(root, "package");
    await mkdir(sourceRoot, { recursive: true });
    const sourcePath = path.join(sourceRoot, "opaque-rgba.png");
    const source = await sharp({
      create: { width: 96, height: 64, channels: 4, background: { r: 5, g: 150, b: 105, alpha: 1 } },
    })
      .png()
      .toBuffer();
    await writeFile(sourcePath, source);

    const result = await deriveWechatImage({
      id: "opaque-rgba",
      sourcePath,
      sourceRoot,
      destinationRoot: path.join(root, "frozen", "assets"),
      role: "inline",
      expectedSourceSha256: sha256Bytes(source),
    });

    expect(result.mediaType).toBe("image/jpeg");
    expect(result.hasAlpha).toBe(false);
  });

  test("compresses a noisy body image below one MiB", async () => {
    const root = await tempRoot();
    const sourceRoot = path.join(root, "package");
    await mkdir(sourceRoot, { recursive: true });
    const width = 1200;
    const height = 1200;
    const raw = Buffer.alloc(width * height * 3);
    let state = 0x12345678;
    for (let index = 0; index < raw.length; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      raw[index] = state >>> 24;
    }
    const source = await sharp(raw, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
    expect(source.byteLength).toBeGreaterThan(WECHAT_BODY_IMAGE_MAX_BYTES);
    const sourcePath = path.join(sourceRoot, "noise.webp");
    await writeFile(sourcePath, source);

    const result = await deriveWechatImage({
      id: "noise",
      sourcePath,
      sourceRoot,
      destinationRoot: path.join(root, "frozen", "assets"),
      role: "inline",
      expectedSourceSha256: sha256Bytes(source),
    });

    expect(result.mediaType).toBe("image/jpeg");
    expect(result.bytes).toBeLessThanOrEqual(WECHAT_BODY_IMAGE_MAX_BYTES);
  }, 20_000);

  test("rejects path escape, digest drift, corrupt files, and duplicate ids", async () => {
    const root = await tempRoot();
    const sourceRoot = path.join(root, "package");
    await mkdir(sourceRoot, { recursive: true });
    const outside = path.join(root, "outside.webp");
    await writeOpaqueWebp(outside);

    await expect(
      deriveWechatImage({
        id: "outside",
        sourcePath: outside,
        sourceRoot,
        destinationRoot: path.join(root, "frozen", "assets"),
        role: "inline",
      }),
    ).rejects.toBeInstanceOf(PublishError);

    const valid = path.join(sourceRoot, "valid.webp");
    await writeOpaqueWebp(valid);
    await expect(
      deriveWechatImage({
        id: "drift",
        sourcePath: valid,
        sourceRoot,
        destinationRoot: path.join(root, "drift", "assets"),
        role: "inline",
        expectedSourceSha256: sha256Bytes("different"),
      }),
    ).rejects.toMatchObject({ data: { code: "E_WECHAT_SOURCE_DIGEST" } });

    const corrupt = path.join(sourceRoot, "corrupt.webp");
    await writeFile(corrupt, "not an image");
    await expect(
      deriveWechatImage({
        id: "corrupt",
        sourcePath: corrupt,
        sourceRoot,
        destinationRoot: path.join(root, "corrupt", "assets"),
        role: "inline",
      }),
    ).rejects.toMatchObject({ data: { code: "E_WECHAT_IMAGE_DECODE" } });

    await expect(
      deriveWechatImages([
        { id: "same", sourcePath: valid, sourceRoot, destinationRoot: path.join(root, "a"), role: "inline" },
        { id: "same", sourcePath: valid, sourceRoot, destinationRoot: path.join(root, "b"), role: "inline" },
      ]),
    ).rejects.toMatchObject({ data: { code: "E_WECHAT_IMAGE_DUPLICATE" } });
  });
});
