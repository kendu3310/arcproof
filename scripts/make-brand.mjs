/**
 * Turn the hand-made artwork in brand-source/ into the files the page serves.
 *
 *   node scripts/make-brand.mjs
 *
 * Nothing here is cosmetic tidying. Each step fixes something measured in the
 * source files, and the reasons are recorded next to the code that depends on
 * them — re-exporting the artwork without re-reading this will undo the fixes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (n) => join(root, "brand-source", `${n}.png`);
const out = (name) => join(root, "docs", name);

const report = [];
const emit = async (name, pipeline) => {
  const { size, width, height } = await pipeline.toFile(out(name));
  report.push(`${name.padEnd(20)} ${String(width + "x" + height).padEnd(12)} ${(size / 1024).toFixed(0)} KB`);
};

/* ------------------------------------------------------------ backgrounds --- */
// Served at their native size. Both arrived smaller than the 2560x1440 and
// 1170x2532 asked for, and upscaling here would only bake in the softness and
// cost bytes; letting the browser stretch them keeps the file small and looks
// no worse. Space imagery is nearly all low-frequency, which is why it holds up.

await emit("bg-desktop.webp", sharp(src(1)).webp({ quality: 82 }));
await emit("bg-mobile.webp", sharp(src(2)).webp({ quality: 82 }));

/* ------------------------------------------------------------------ marks --- */
// 3.png is the soft version and 6.png the high-contrast one. The large hero
// reads better soft; at 26px in the nav the soft one turns to mush, so each
// goes where it survives. Both are trimmed to their artwork because the source
// canvases carry ~50px of empty margin that would otherwise shrink the mark
// inside its own box and knock it off the baseline.

await emit("mark.webp", sharp(src(3)).trim({ threshold: 6 }).resize({ width: 700 }).webp({ quality: 90 }));
await emit("mark-nav.webp", sharp(src(6)).trim({ threshold: 6 }).resize({ width: 180 }).webp({ quality: 92 }));

/* --------------------------------------------------------------- wordmark --- */
/**
 * 4.png carries its halo in the colour channels but not in alpha: the alpha is
 * almost binary — 79.5% fully clear, 8.7% fully opaque, under 3% in between —
 * so the halo is invisible when the file is composited normally.
 *
 * Two attempts at reviving it from the colour channels both failed the same
 * way. Brightness-as-coverage paints the faint grey halo straight onto the
 * page and the wordmark sits in a grey box; dividing the colour back out
 * fixes the grey but amplifies the near-black noise into a bright haze with
 * the same rectangular edge. The halo in the source is a rectangle, so any
 * reconstruction of it is a rectangle.
 *
 * So only the letters are kept, and the glow is drawn by CSS instead, where it
 * radiates from the glyphs themselves and has no edge to show. That also takes
 * the file from 167 KB to a fraction of it.
 */
await emit(
  "wordmark.webp",
  sharp(src(4)).trim({ threshold: 6 }).resize({ width: 1200 }).webp({ quality: 88 }),
);

/* ------------------------------------------------------------- the tile --- */
/**
 * 8.png was exported with the editor's transparency checkerboard flattened
 * into the pixels — the grid is real image data, not transparency, and would
 * show up on the page as a grey plaid. The tile itself is the only region
 * that is either coloured or dark, which is how these bounds were found.
 */
const TILE = { left: 155, top: 155, width: 944, height: 944 };
const tile = await sharp(src(8)).extract(TILE).toBuffer();

/** Round the corners by hand, since cropping a rounded tile out of a square
 *  leaves four triangles of checkerboard behind. */
const rounded = (size, radius) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
       <rect width="${size}" height="${size}" rx="${radius}" fill="#fff"/>
     </svg>`,
  );

for (const [name, size] of [["tile-128.webp", 128], ["icon-256.png", 256]]) {
  const body = sharp(tile).resize(size, size).composite([{ input: rounded(size, Math.round(size * 0.22)), blend: "dest-in" }]);
  await emit(name, name.endsWith(".webp") ? body.webp({ quality: 92 }) : body.png({ compressionLevel: 9, palette: true, colors: 128 }));
}

// iOS applies its own rounded mask, so this one stays square and opaque —
// rounding it here would clip the corners twice.
await emit(
  "icon-180.png",
  sharp(tile).resize(180, 180).flatten({ background: "#060a18" }).png({ compressionLevel: 9, palette: true, colors: 128 }),
);

/* -------------------------------------------------------- the step icons --- */
/**
 * Rendered at 64px rather than the 26px the drawn line icons used. These are
 * illustrations, not glyphs: side by side at 26, 40, 56 and 72px, all three
 * dissolve into a blue smudge below 40 and only resolve from 56 up. Exported
 * at 3x so they stay sharp on a dense screen.
 */
for (const [n, name] of [[1, "step-upload"], [2, "step-process"], [3, "step-prove"]]) {
  await emit(
    `${name}.webp`,
    sharp(join(root, "brand-source", `icon${n}.png`))
      .trim({ threshold: 6 })
      .resize(192, 192, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 88 }),
  );
}

/* ------------------------------------------------------------ social card --- */
// 1731x909 is 1.904:1 and the card wants 1.905:1, so this is a straight
// downscale with no crop. The text in it is part of the artwork, which is fine
// here and only here: a social card is never read by a screen reader and never
// reflows.
await emit("og.jpg", sharp(src(5)).resize(1200, 630).jpeg({ quality: 86, mozjpeg: true }));

console.log(report.join("\n"));
console.log(`\ntotal ${(report.reduce((n, line) => n + Number(line.match(/(\d+) KB$/)[1]), 0) / 1024).toFixed(2)} MB on disk`);
