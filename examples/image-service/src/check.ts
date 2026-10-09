/**
 * The buyer's own check of a resize, made from the two files and nothing the
 * service said.
 *
 * This is the half a receipt cannot do. The receipt proves which bytes the
 * provider handed over; this decides whether those bytes are what was paid
 * for. An agent that runs it can refuse a bad result automatically, and the
 * receipt then pins that result on the provider who produced it.
 *
 * It decodes with sharp because that is what is at hand in Node. The demo page
 * makes the same measurements with the browser's own decoder.
 */

import sharp from "sharp";
import type { ImageFormat } from "./resize.ts";

export interface ResizeCheck {
  ok: boolean;
  problems: string[];
  before: { width: number; height: number };
  after: { width: number; height: number; format: string };
}

export async function checkResize(params: {
  input: Uint8Array;
  output: Uint8Array;
  box: { width: number; height: number };
  format: ImageFormat;
}): Promise<ResizeCheck> {
  const problems: string[] = [];
  const inMeta = await sharp(params.input).metadata();
  const outMeta = await sharp(params.output).metadata().catch(() => undefined);
  const turned = (inMeta.orientation ?? 1) >= 5;
  const before = {
    width: (turned ? inMeta.height : inMeta.width) ?? 0,
    height: (turned ? inMeta.width : inMeta.height) ?? 0,
  };
  if (!outMeta?.width || !outMeta.height || !outMeta.format) {
    return { ok: false, problems: ["the result is not a readable image"], before, after: { width: 0, height: 0, format: "unreadable" } };
  }
  const after = { width: outMeta.width, height: outMeta.height, format: outMeta.format };

  problems.push(...shapeProblems(before, after, params.box));
  if (after.format !== params.format) problems.push(`asked for ${params.format}, got ${after.format}`);
  // EXIF is where location and camera serials live. A colour profile may
  // survive; it describes the pixels, not the person.
  if (outMeta.exif) problems.push("the result still carries EXIF metadata");

  return { ok: problems.length === 0, problems, before, after };
}

/**
 * The geometric promise, as pure arithmetic so the page and this file can be
 * tested against the same cases: fits the box, never enlarged, shape kept.
 */
export function shapeProblems(
  before: { width: number; height: number },
  after: { width: number; height: number },
  box: { width: number; height: number },
): string[] {
  const problems: string[] = [];
  if (after.width > box.width || after.height > box.height) {
    problems.push(`${after.width}×${after.height} does not fit the ${box.width}×${box.height} box`);
  }
  if (after.width > before.width || after.height > before.height) {
    problems.push(`enlarged from ${before.width}×${before.height} to ${after.width}×${after.height}`);
  }
  // Rounding to whole pixels can move either edge by at most one pixel from
  // the exact scaled size. Anything more is distortion.
  const scale = after.width / before.width;
  if (Math.abs(before.height * scale - after.height) > 1 && Math.abs(after.height / before.height * before.width - after.width) > 1) {
    problems.push(`shape changed: ${before.width}×${before.height} became ${after.width}×${after.height}`);
  }
  // Inside fit means one edge touches the box, unless the original already fit.
  const fitsAlready = before.width <= box.width && before.height <= box.height;
  if (!fitsAlready && after.width !== box.width && after.height !== box.height) {
    problems.push(`made smaller than needed: ${after.width}×${after.height} touches neither edge of ${box.width}×${box.height}`);
  }
  if (fitsAlready && (after.width !== before.width || after.height !== before.height)) {
    problems.push(`already fit the box, yet resized from ${before.width}×${before.height} to ${after.width}×${after.height}`);
  }
  return problems;
}
