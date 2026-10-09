/**
 * The page measures a resized image with its own code (docs/checks.js), the
 * image service's buyer check with sharp (examples/image-service/src/check.ts).
 * They must reach the same verdicts, or one of them is wrong about the promise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import * as page from "../docs/checks.js";
import { shapeProblems } from "../examples/image-service/src/check.ts";
import { resizeImage } from "../examples/image-service/src/resize.ts";

test("the page and the service agree on the shape rules, case by case", () => {
  const box = { width: 800, height: 800 };

  for (let i = 0; i < 4000; i++) {
    const before = { width: 1 + Math.floor(Math.random() * 5000), height: 1 + Math.floor(Math.random() * 5000) };
    const after = { width: 1 + Math.floor(Math.random() * 1200), height: 1 + Math.floor(Math.random() * 1200) };
    const verdictPage = page.shapeProblems(before, after, box);
    assert.deepEqual(verdictPage, shapeProblems(before, after, box), JSON.stringify({ before, after }));
  }
  // And on what the real resizer produces: always clean.
  for (const [w, h] of [[4000, 3000], [3000, 4000], [801, 13], [13, 801], [800, 800], [300, 200], [5000, 7]]) {
    const scale = Math.min(1, 800 / w, 800 / h);
    const after = { width: Math.round(w * scale), height: Math.round(h * scale) };
    assert.deepEqual(page.shapeProblems({ width: w, height: h }, after, box), [], `${w}×${h}`);
  }
});

test("the page sniffs format and finds EXIF in the bytes the way sharp reports them", async () => {
  const base = sharp({ create: { width: 64, height: 48, channels: 3, background: "teal" } });
  const exif = { IFD0: { Copyright: "someone", Make: "TestCam" } };
  for (const format of ["webp", "jpeg", "png"]) {
    const clean = await base.clone()[format]().toBuffer();
    const leaky = await base.clone().withMetadata({ exif })[format]().toBuffer();
    assert.equal(page.sniffFormat(new Uint8Array(clean)), format);
    assert.equal(page.hasExif(new Uint8Array(clean)), Boolean((await sharp(clean).metadata()).exif), `${format} clean`);
    assert.equal(page.hasExif(new Uint8Array(leaky)), Boolean((await sharp(leaky).metadata()).exif), `${format} with EXIF`);
    assert.equal(page.hasExif(new Uint8Array(leaky)), true, `${format}: sharp did write EXIF`);
  }
});

test("what the service returns passes the page's byte checks", async () => {
  const input = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "orange" } })
    .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "x" } } })
    .jpeg()
    .toBuffer();
  const { output } = await resizeImage(input, { width: 800, height: 800, format: "webp" });
  assert.equal(page.sniffFormat(new Uint8Array(output)), "webp");
  assert.equal(page.hasExif(new Uint8Array(output)), false);
});
