/**
 * The second reference service, deliberately unlike the first.
 *
 * Aernyth's receipt is the same whatever the service does; what changes is the
 * buyer's acceptance check. For 3D models that is "triangles unchanged". For
 * images it is "fits the box, keeps its shape, never enlarged, no metadata".
 * Mount the handler behind a payment middleware and withReceipt(), exactly as
 * the GLB service does.
 */

import type { RequestHandler } from "express";
import { resizeImage, resizeOptionsFrom, UnsupportedImage } from "./resize.ts";

export { resizeImage, resizeOptionsFrom, UnsupportedImage, MAX_INPUT_PIXELS } from "./resize.ts";
export type { ResizeOptions, ResizeReport, ImageFormat } from "./resize.ts";
export { checkResize, shapeProblems, type ResizeCheck } from "./check.ts";

export const REPORT_HEADER = "x-image-report";

/**
 * POST raw image bytes; ?width=&height= set the box (default 1024×1024,
 * clamped to 16–4096) and ?format= picks webp (default), jpeg or png.
 * The body of the response is the image and nothing else, because that is
 * what the receipt commits to.
 */
export const handleResize: RequestHandler = async (req, res) => {
  try {
    const options = resizeOptionsFrom(req.query as Record<string, unknown>);
    const { output, report } = await resizeImage(req.body as Buffer, options);
    res.type(`image/${options.format}`).setHeader(REPORT_HEADER, JSON.stringify(report));
    res.send(output);
  } catch (error) {
    if (error instanceof UnsupportedImage) {
      res.status(415).json({ error: error.message });
      return;
    }
    console.error("[resize]", error);
    res.status(500).json({ error: "resize failed" });
  }
};
