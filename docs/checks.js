/**
 * The browser's own check of a resized image.
 *
 * Like batched.js, nothing here comes from the service or the package. Both
 * files are decoded with the browser's image decoder, and the format and EXIF
 * are read straight out of the bytes. test/page-checks.test.mjs holds the
 * arithmetic to the same cases as examples/image-service/src/check.ts.
 */

/** Fits the box, never enlarged, shape kept to a pixel, and no smaller than needed. */
export function shapeProblems(before, after, box) {
  const problems = [];
  if (after.width > box.width || after.height > box.height) {
    problems.push(`${after.width}×${after.height} does not fit the ${box.width}×${box.height} box`);
  }
  if (after.width > before.width || after.height > before.height) {
    problems.push(`enlarged from ${before.width}×${before.height} to ${after.width}×${after.height}`);
  }
  // Rounding to whole pixels can move either edge by at most one pixel from
  // the exact scaled size. Anything more is distortion.
  const scale = after.width / before.width;
  if (Math.abs(before.height * scale - after.height) > 1 && Math.abs((after.height / before.height) * before.width - after.width) > 1) {
    problems.push(`shape changed: ${before.width}×${before.height} became ${after.width}×${after.height}`);
  }
  const fitsAlready = before.width <= box.width && before.height <= box.height;
  if (!fitsAlready && after.width !== box.width && after.height !== box.height) {
    problems.push(`made smaller than needed: ${after.width}×${after.height} touches neither edge of ${box.width}×${box.height}`);
  }
  if (fitsAlready && (after.width !== before.width || after.height !== before.height)) {
    problems.push(`already fit the box, yet resized from ${before.width}×${before.height} to ${after.width}×${after.height}`);
  }
  return problems;
}

const ascii = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));

/** The container format, from its magic bytes. */
export function sniffFormat(bytes) {
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "png";
  return "unknown";
}

/** Whether the file carries EXIF — where location and camera serials live. */
export function hasExif(bytes) {
  const format = sniffFormat(bytes);
  if (format === "webp") {
    // RIFF chunks: a fourcc, a little-endian length, the data padded to even.
    for (let at = 12; at + 8 <= bytes.length; ) {
      const size = bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24);
      if (ascii(bytes, at, 4) === "EXIF") return true;
      at += 8 + size + (size & 1);
    }
    return false;
  }
  if (format === "jpeg") {
    // Segments until the image data starts; EXIF is an APP1 segment tagged "Exif".
    for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff; ) {
      const marker = bytes[at + 1];
      const size = (bytes[at + 2] << 8) | bytes[at + 3];
      if (marker === 0xe1 && ascii(bytes, at + 4, 4) === "Exif") return true;
      if (marker === 0xda) return false;
      at += 2 + size;
    }
    return false;
  }
  if (format === "png") {
    for (let at = 8; at + 8 <= bytes.length; ) {
      const size = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
      if (ascii(bytes, at + 4, 4) === "eXIf") return true;
      at += 12 + size;
    }
  }
  return false;
}

/** Width and height as displayed, with any EXIF orientation applied. */
async function measure(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: "from-image" });
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

export async function checkResize({ input, output, box, format }) {
  const before = await measure(input).catch(() => {
    throw new Error("your browser cannot decode the image you sent, so it cannot be measured here");
  });
  const after = { width: 0, height: 0, format: sniffFormat(output), exif: hasExif(output) };
  try {
    Object.assign(after, await measure(output));
  } catch {
    return { ok: false, problems: ["the result is not an image your browser can read"], before, after };
  }
  const problems = shapeProblems(before, after, box);
  if (after.format !== format) problems.push(`asked for ${format}, got ${after.format}`);
  if (after.exif) problems.push("the result still carries EXIF metadata");
  return { ok: problems.length === 0, problems, before, after };
}
