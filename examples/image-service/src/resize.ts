/**
 * Image resizing with a promise narrow enough to check.
 *
 * The result fits inside the requested box, keeps the original's shape to
 * within a pixel of rounding, is never enlarged, is in the format asked for,
 * and carries no metadata — EXIF, GPS, camera serials — from the original.
 * Every part of that can be measured from the two files alone, which is what
 * check.ts does and what the demo page does in the browser. The service's own
 * report travels in a header for convenience and is never what a buyer should
 * rely on.
 */

import sharp, { type Metadata } from "sharp";

export type ImageFormat = "webp" | "jpeg" | "png";

export interface ResizeOptions {
  /** The box the result must fit inside, in pixels. */
  width: number;
  height: number;
  format: ImageFormat;
}

export interface ResizeReport {
  bytesIn: number;
  bytesOut: number;
  formatIn: string;
  formatOut: ImageFormat;
  /** As displayed: after applying the original's EXIF orientation. */
  widthIn: number;
  heightIn: number;
  widthOut: number;
  heightOut: number;
  box: { width: number; height: number };
}

export class UnsupportedImage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedImage";
  }
}

/**
 * A 512 MB instance decoding a 100-megapixel image runs out of memory before
 * it can say no, so anything larger is refused before decoding starts.
 */
export const MAX_INPUT_PIXELS = 40_000_000;
export const MIN_EDGE = 16;
export const MAX_EDGE = 4096;

const ACCEPTED = new Set(["jpeg", "png", "webp", "gif", "avif", "tiff"]);

/** Read and clamp resize options from a query string. */
export function resizeOptionsFrom(query: Record<string, unknown>): ResizeOptions {
  const edge = (value: unknown, fallback: number) => {
    const n = Math.round(Number(value ?? fallback));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(MAX_EDGE, Math.max(MIN_EDGE, n));
  };
  const format = String(query.format ?? "webp");
  return {
    width: edge(query.width, 1024),
    height: edge(query.height, 1024),
    format: format === "jpeg" || format === "png" ? format : "webp",
  };
}

export async function resizeImage(input: Buffer, options: ResizeOptions): Promise<{ output: Buffer; report: ResizeReport }> {
  let meta: Metadata;
  try {
    // Header only, no decoding, so the pixel limit can be reported as itself
    // rather than as "not an image".
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    throw new UnsupportedImage("not an image this service can read (JPEG, PNG, WebP, GIF, AVIF or TIFF)");
  }
  if (!meta.format || !ACCEPTED.has(meta.format) || !meta.width || !meta.height) {
    throw new UnsupportedImage(`unsupported image format: ${meta.format ?? "unknown"}`);
  }
  if (meta.width * meta.height > MAX_INPUT_PIXELS) {
    throw new UnsupportedImage(`image is ${meta.width}×${meta.height}; the limit is ${MAX_INPUT_PIXELS / 1e6} megapixels`);
  }
  if ((meta.pages ?? 1) > 1) {
    throw new UnsupportedImage("animated images are not supported: resizing would keep only the first frame");
  }

  // EXIF orientations 5–8 rotate by 90°, so the image as displayed has its
  // edges swapped relative to how it is stored.
  const turned = (meta.orientation ?? 1) >= 5;
  const widthIn = turned ? meta.height : meta.width;
  const heightIn = turned ? meta.width : meta.height;

  const pipeline = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate() // bake the orientation in; the metadata that described it is dropped
    .resize({ width: options.width, height: options.height, fit: "inside", withoutEnlargement: true });

  const encoded =
    options.format === "jpeg"
      ? pipeline.jpeg({ quality: 82, mozjpeg: true })
      : options.format === "png"
        ? pipeline.png({ compressionLevel: 9 })
        : pipeline.webp({ quality: 82 });

  const { data: output, info } = await encoded.toBuffer({ resolveWithObject: true });

  return {
    output,
    report: {
      bytesIn: input.byteLength,
      bytesOut: output.byteLength,
      formatIn: meta.format,
      formatOut: options.format,
      widthIn,
      heightIn,
      widthOut: info.width,
      heightOut: info.height,
      box: { width: options.width, height: options.height },
    },
  };
}
