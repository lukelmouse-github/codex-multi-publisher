import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { sha256Bytes } from "./canonical-json";
import { PublishError } from "./errors";
import { assertRealPathWithin, isWithin, safeIdentifier } from "./path-policy";
import type { AssetRole } from "./types";

export const WECHAT_BODY_IMAGE_MAX_BYTES = 1024 * 1024;

const JPEG_QUALITY_STEPS = [82, 74, 66, 58, 50, 42, 34] as const;
const MAX_WIDTH_STEPS = [2560, 2048, 1600, 1280, 1024, 800, 640, 480, 320, 240] as const;

export interface WechatImageInput {
  id: string;
  sourcePath: string;
  sourceRoot: string;
  destinationRoot: string;
  role: AssetRole;
  expectedSourceSha256?: string;
}

export interface FrozenWechatImage {
  id: string;
  role: AssetRole;
  path: string;
  absolutePath: string;
  sha256: string;
  sourceSha256: string;
  bytes: number;
  mediaType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  hasAlpha: boolean;
}

function imageError(code: string, message: string, details?: Record<string, unknown>): PublishError {
  return new PublishError(code, message, { kind: "validation", details });
}

function candidateWidths(width: number): number[] {
  const initial = Math.min(width, MAX_WIDTH_STEPS[0]);
  const values = new Set<number>([initial]);
  for (const candidate of MAX_WIDTH_STEPS) {
    if (candidate < initial) values.add(candidate);
  }
  return [...values].sort((left, right) => right - left);
}

async function encodePng(source: Buffer, width: number): Promise<Buffer> {
  return sharp(source, { failOn: "error", animated: false })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

async function encodeJpeg(source: Buffer, width: number, quality: number): Promise<Buffer> {
  return sharp(source, { failOn: "error", animated: false })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({
      quality,
      chromaSubsampling: "4:4:4",
      mozjpeg: false,
      optimiseCoding: true,
    })
    .toBuffer();
}

async function encodeWechatImage(
  source: Buffer,
  width: number,
  hasAlpha: boolean,
  enforceBodyLimit: boolean,
): Promise<{ buffer: Buffer; mediaType: "image/jpeg" | "image/png" }> {
  const widths = candidateWidths(width);

  if (hasAlpha) {
    for (const candidateWidth of widths) {
      const buffer = await encodePng(source, candidateWidth);
      if (!enforceBodyLimit || buffer.byteLength <= WECHAT_BODY_IMAGE_MAX_BYTES) {
        return { buffer, mediaType: "image/png" };
      }
    }
    throw imageError(
      "E_WECHAT_IMAGE_TOO_LARGE",
      "Transparent image cannot be reduced below the WeChat body-image limit without losing transparency",
      { maxBytes: WECHAT_BODY_IMAGE_MAX_BYTES },
    );
  }

  for (const candidateWidth of widths) {
    for (const quality of JPEG_QUALITY_STEPS) {
      const buffer = await encodeJpeg(source, candidateWidth, quality);
      if (!enforceBodyLimit || buffer.byteLength <= WECHAT_BODY_IMAGE_MAX_BYTES) {
        return { buffer, mediaType: "image/jpeg" };
      }
    }
  }

  throw imageError("E_WECHAT_IMAGE_TOO_LARGE", "Image cannot be reduced below the WeChat body-image limit", {
    maxBytes: WECHAT_BODY_IMAGE_MAX_BYTES,
  });
}

export async function deriveWechatImage(input: WechatImageInput): Promise<FrozenWechatImage> {
  if (!input.id) throw imageError("E_WECHAT_IMAGE_ID", "Image id is required");

  await mkdir(input.destinationRoot, { recursive: true });
  const sourcePath = await assertRealPathWithin(input.sourceRoot, input.sourcePath, `image ${input.id}`);
  const source = await readFile(sourcePath);
  const sourceSha256 = sha256Bytes(source);
  if (input.expectedSourceSha256 && input.expectedSourceSha256 !== sourceSha256) {
    throw imageError("E_WECHAT_SOURCE_DIGEST", `Source image digest changed for ${input.id}`, {
      id: input.id,
      expected: input.expectedSourceSha256,
      actual: sourceSha256,
    });
  }

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(source, { failOn: "error", animated: false }).metadata();
  } catch (error) {
    throw imageError("E_WECHAT_IMAGE_DECODE", `Cannot decode image ${input.id}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!metadata.width || !metadata.height) {
    throw imageError("E_WECHAT_IMAGE_DIMENSIONS", `Image ${input.id} has no usable dimensions`);
  }
  if ((metadata.pages ?? 1) > 1) {
    throw imageError("E_WECHAT_ANIMATED_IMAGE", `Animated image ${input.id} must be flattened explicitly before freezing`);
  }

  let hasAlpha = false;
  if (metadata.hasAlpha === true) {
    try {
      hasAlpha = !(await sharp(source, { failOn: "error", animated: false }).rotate().stats()).isOpaque;
    } catch (error) {
      throw imageError("E_WECHAT_IMAGE_DECODE", `Cannot inspect image alpha for ${input.id}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const enforceBodyLimit = input.role !== "cover";
  const encoded = await encodeWechatImage(source, metadata.width, hasAlpha, enforceBodyLimit);
  const outputMetadata = await sharp(encoded.buffer).metadata();
  if (!outputMetadata.width || !outputMetadata.height) {
    throw imageError("E_WECHAT_IMAGE_DIMENSIONS", `Derived image ${input.id} has no usable dimensions`);
  }

  const sha256 = sha256Bytes(encoded.buffer);
  const extension = encoded.mediaType === "image/png" ? ".png" : ".jpg";
  const digestSuffix = sha256.slice("sha256:".length, "sha256:".length + 16);
  const filename = `${safeIdentifier(input.id, "image")}-${digestSuffix}${extension}`;
  const relativePath = path.posix.join("assets", filename);
  const absolutePath = path.resolve(input.destinationRoot, filename);
  if (!isWithin(input.destinationRoot, absolutePath)) {
    throw imageError("E_PATH_ESCAPE", `Derived image path escapes the frozen asset root for ${input.id}`);
  }
  await writeFile(absolutePath, encoded.buffer, { flag: "wx" });

  if (enforceBodyLimit && encoded.buffer.byteLength > WECHAT_BODY_IMAGE_MAX_BYTES) {
    throw imageError("E_WECHAT_IMAGE_TOO_LARGE", `Derived image ${input.id} exceeds the WeChat body-image limit`, {
      bytes: encoded.buffer.byteLength,
      maxBytes: WECHAT_BODY_IMAGE_MAX_BYTES,
    });
  }

  return {
    id: input.id,
    role: input.role,
    path: relativePath,
    absolutePath,
    sha256,
    sourceSha256,
    bytes: encoded.buffer.byteLength,
    mediaType: encoded.mediaType,
    width: outputMetadata.width,
    height: outputMetadata.height,
    hasAlpha,
  };
}

export async function deriveWechatImages(inputs: WechatImageInput[]): Promise<FrozenWechatImage[]> {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.id)) {
      throw imageError("E_WECHAT_IMAGE_DUPLICATE", `Duplicate image id: ${input.id}`);
    }
    seen.add(input.id);
  }

  const output: FrozenWechatImage[] = [];
  for (const input of [...inputs].sort((left, right) => left.id.localeCompare(right.id))) {
    output.push(await deriveWechatImage(input));
  }
  return output;
}
