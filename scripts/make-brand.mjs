/**
 * Build the brand assets from vector sources.
 *
 * Everything the page shows is drawn here or in CSS — there is no photograph
 * and no stock art, so there is no licence to honour and nothing to go stale.
 * Run it after changing the mark:
 *
 *   node scripts/make-brand.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const docs = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");

const GRADIENTS = `
  <linearGradient id="aw" x1="0.15" y1="0.05" x2="0.95" y2="1">
    <stop offset="0" stop-color="#a9c6ff"/><stop offset="0.38" stop-color="#4f7cff"/><stop offset="1" stop-color="#8b5cf6"/>
  </linearGradient>
  <linearGradient id="ab" x1="0.55" y1="0" x2="0.1" y2="1">
    <stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="#e2e9fb"/><stop offset="1" stop-color="#aebff2"/>
  </linearGradient>`;

/** The mark itself, in a 0–100 box. Two blades meeting at a point. */
const MARK = `
  <path d="M50 3 C74 27 89 59 98 96 L73 96 C65 63 57 37 46 14 Z" fill="url(#aw)"/>
  <path d="M50 3 L61 27 L29 96 L3 96 Z" fill="url(#ab)"/>`;

/**
 * A tab favicon is rendered at 16px. The bare mark loses its left blade at that
 * size, so the icon gets a dark plate and generous padding — it reads as a shape
 * rather than a smudge.
 */
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>${GRADIENTS}</defs>
  <rect width="128" height="128" rx="28" fill="#0a1026"/>
  <g transform="translate(26 26) scale(0.76)">${MARK}</g>
</svg>`;

writeFileSync(join(docs, "icon.svg"), icon);

await sharp(Buffer.from(icon), { density: 600 }).resize(180, 180).png().toFile(join(docs, "icon-180.png"));

/* --------------------------------------------------------------------- og --- */

// The same starfield the page uses, at the seed the page uses, so the social
// card and the site are visibly the same place.
let seed = 20260107;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const stars = Array.from({ length: 150 }, () =>
  `<circle cx="${Math.round(rnd() * 1200)}" cy="${Math.round(rnd() * 630)}" r="${(0.6 + rnd() * 1.4).toFixed(1)}" opacity="${(0.15 + rnd() * 0.55).toFixed(1)}"/>`,
).join("");

const og = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    ${GRADIENTS}
    <!-- userSpaceOnUse, not the default bounding box: librsvg leaves a visible
         seam at the edge of the object box when the outermost stop is
         transparent, and it showed up as a rectangle across the artwork. -->
    <radialGradient id="limb" gradientUnits="userSpaceOnUse" cx="600" cy="1330" r="1000">
      <stop offset="0" stop-color="#080d20"/><stop offset="0.965" stop-color="#0b1330"/>
      <stop offset="0.982" stop-color="#a8c6ff"/><stop offset="0.995" stop-color="#4f7cff" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#4f7cff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="hl" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#6f93ff"/><stop offset="1" stop-color="#a78bfa"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="#060a18"/>
  <g fill="#dbe4ff">${stars}</g>
  <circle cx="600" cy="1330" r="1000" fill="url(#limb)"/>

  <g transform="translate(548 56) scale(1.04)">${MARK}</g>

  <text x="600" y="258" text-anchor="middle" fill="#e8ecf8"
        font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="54" font-weight="600" letter-spacing="13">AERNYTH</text>
  <text x="600" y="300" text-anchor="middle" fill="#95a1c4"
        font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="21" letter-spacing="5">VERIFIABLE DIGITAL DELIVERY</text>

  <text x="600" y="404" text-anchor="middle" fill="#ffffff"
        font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="54" font-weight="700">Paying is easy.</text>
  <text x="600" y="472" text-anchor="middle" fill="url(#hl)"
        font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="54" font-weight="700">Proving delivery is the real problem.</text>

  <text x="600" y="556" text-anchor="middle" fill="#95a1c4"
        font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="24">Onchain receipts for paid API calls · Arc mainnet</text>
</svg>`;

const { size } = await sharp(Buffer.from(og), { density: 150 }).png({ compressionLevel: 9, palette: true, colors: 128, dither: 0.6 }).toFile(join(docs, "og.png"));

console.log(`docs/icon.svg, docs/icon-180.png, docs/og.png (${(size / 1024).toFixed(0)} KB)`);
