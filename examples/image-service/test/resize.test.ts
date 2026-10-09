import { test } from "node:test";
import assert from "node:assert/strict";
import sharp, { type Sharp } from "sharp";
import { resizeImage, UnsupportedImage, MAX_INPUT_PIXELS } from "../src/resize.ts";
import { checkResize, shapeProblems } from "../src/check.ts";

const photo = (width: number, height: number, extra: (s: Sharp) => Sharp = (s) => s) =>
  extra(sharp({ create: { width, height, channels: 3, background: { r: 40, g: 120, b: 200 } } }).jpeg()).toBuffer();

const box = { width: 1024, height: 1024 };

test("a large landscape photo fits the box, keeps its shape, and passes the buyer's check", async () => {
  const input = await photo(4000, 3000);
  const { output, report } = await resizeImage(input, { ...box, format: "webp" });
  assert.deepEqual([report.widthOut, report.heightOut], [1024, 768]);
  const check = await checkResize({ input, output, box, format: "webp" });
  assert.ok(check.ok, check.problems.join("; "));
  assert.deepEqual(check.after, { width: 1024, height: 768, format: "webp" });
});

test("EXIF orientation is applied, and the metadata that carried it is gone", async () => {
  // Stored 4000×3000 but tagged "rotate 90°": displayed as a 3000×4000 portrait.
  const input = await photo(4000, 3000, (s) => s.withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "someone" } } }));
  const { output, report } = await resizeImage(input, { ...box, format: "jpeg" });
  assert.deepEqual([report.widthIn, report.heightIn, report.widthOut, report.heightOut], [3000, 4000, 768, 1024]);
  const meta = await sharp(output).metadata();
  assert.equal(meta.exif, undefined);
  assert.ok((await checkResize({ input, output, box, format: "jpeg" })).ok);
});

test("an image that already fits is not enlarged", async () => {
  const input = await photo(300, 200);
  const { output, report } = await resizeImage(input, { ...box, format: "png" });
  assert.deepEqual([report.widthOut, report.heightOut], [300, 200]);
  assert.ok((await checkResize({ input, output, box, format: "png" })).ok);
});

test("the buyer's check catches a stretched, an enlarged, a mislabelled and a leaky result", async () => {
  const input = await photo(4000, 3000);
  const stretched = await sharp(input).resize(1024, 1024, { fit: "fill" }).webp().toBuffer();
  assert.match((await checkResize({ input, output: stretched, box, format: "webp" })).problems.join(), /shape changed/);

  const small = await photo(300, 200);
  const enlarged = await sharp(small).resize(600, 400).webp().toBuffer();
  assert.match((await checkResize({ input: small, output: enlarged, box, format: "webp" })).problems.join(), /enlarged|already fit/);

  const jpeg = await sharp(input).resize(1024, 768).jpeg().toBuffer();
  assert.match((await checkResize({ input, output: jpeg, box, format: "webp" })).problems.join(), /asked for webp, got jpeg/);

  const leaky = await sharp(input).resize(1024, 768).withMetadata({ exif: { IFD0: { Copyright: "someone" } } }).webp().toBuffer();
  assert.match((await checkResize({ input, output: leaky, box, format: "webp" })).problems.join(), /EXIF/);

  const lazy = await sharp(input).resize(400, 300).webp().toBuffer();
  assert.match((await checkResize({ input, output: lazy, box, format: "webp" })).problems.join(), /smaller than needed/);

  const garbage = new Uint8Array([1, 2, 3, 4]);
  assert.equal((await checkResize({ input, output: garbage, box, format: "webp" })).ok, false);
});

test("not an image, or too many pixels: refused with a reason", async () => {
  await assert.rejects(resizeImage(Buffer.from("definitely not a picture"), { ...box, format: "webp" }), UnsupportedImage);

  const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1;
  const huge = await sharp({ create: { width: side, height: side, channels: 3, background: "white" } }).png({ compressionLevel: 9 }).toBuffer();
  await assert.rejects(resizeImage(huge, { ...box, format: "webp" }), /megapixels/);
});

test("shape arithmetic: exact cases the page shares", () => {
  assert.deepEqual(shapeProblems({ width: 4000, height: 3000 }, { width: 1024, height: 768 }, box), []);
  assert.deepEqual(shapeProblems({ width: 3001, height: 4000 }, { width: 768, height: 1024 }, box), []);
  assert.deepEqual(shapeProblems({ width: 1000, height: 1 }, { width: 1000, height: 1 }, box), []);
  assert.deepEqual(shapeProblems({ width: 5000, height: 7 }, { width: 1024, height: 1 }, box), []);
  assert.equal(shapeProblems({ width: 4000, height: 3000 }, { width: 1024, height: 1024 }, box).length > 0, true);
});
