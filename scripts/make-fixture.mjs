/**
 * Build a GLB fixture to exercise the optimiser and to look like something.
 *
 *   node scripts/make-fixture.mjs
 *
 * Generated rather than downloaded, so the test is hermetic and no licence
 * question arises.
 *
 * It replaces an earlier fixture — a cube wrapped in random noise — that was
 * wrong twice over. Twelve triangles made "geometry unchanged" a claim about
 * nothing, and random noise is the worst case for PNG, so the original file
 * was enormous and the compression ratio flattered the service badly. A sphere
 * with ~9,000 triangles under a smooth, structured texture is both harder to
 * fake and closer to what real art does under the same pipeline.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "examples/glb-service/fixtures");
mkdirSync(outDir, { recursive: true });

const TEX = 2048;
const SEG_U = 96;
const SEG_V = 48;

/* ---------------------------------------------------------------- texture */

// A deterministic generator, so the fixture is byte-identical on every machine
// and a digest quoted in the README or a test stays true.
let seed = 0x6d2b79f5;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

/** Smooth value noise: a coarse random lattice, bilinearly interpolated. */
function valueNoise(size, cells) {
  const lattice = Array.from({ length: (cells + 1) * (cells + 1) }, random);
  const at = (x, y) => lattice[(y % (cells + 1)) * (cells + 1) + (x % (cells + 1))];
  const smooth = (t) => t * t * (3 - 2 * t);

  const field = new Float32Array(size * size);
  const scale = cells / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const fy = y * scale;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = smooth(fx - x0);
      const ty = smooth(fy - y0);

      const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      field[y * size + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return field;
}

const coarse = valueNoise(TEX, 8);
const medium = valueNoise(TEX, 24);
const fine = valueNoise(TEX, 64);

const pixels = Buffer.alloc(TEX * TEX * 3);
for (let y = 0; y < TEX; y++) {
  for (let x = 0; x < TEX; x++) {
    const i = y * TEX + x;
    const height = coarse[i] * 0.6 + medium[i] * 0.3 + fine[i] * 0.1;

    // Latitude shading, so the poles differ from the equator and the texture
    // is obviously a texture rather than a wash of colour.
    const latitude = Math.abs(y / TEX - 0.5) * 2;
    const h = height - latitude * 0.22;

    let r, g, b;
    if (h < 0.38) {
      const depth = h / 0.38;
      r = 12 + depth * 20;
      g = 48 + depth * 70;
      b = 110 + depth * 90;
    } else if (h < 0.44) {
      r = 198 + fine[i] * 40;
      g = 182 + fine[i] * 40;
      b = 128;
    } else if (h < 0.62) {
      const t = (h - 0.44) / 0.18;
      r = 70 - t * 30 + fine[i] * 25;
      g = 130 - t * 35 + fine[i] * 30;
      b = 60 - t * 20;
    } else {
      const t = Math.min(1, (h - 0.62) / 0.3);
      r = 120 + t * 120;
      g = 118 + t * 125;
      b = 110 + t * 130;
    }

    const o = i * 3;
    pixels[o] = Math.max(0, Math.min(255, r));
    pixels[o + 1] = Math.max(0, Math.min(255, g));
    pixels[o + 2] = Math.max(0, Math.min(255, b));
  }
}

const png = await sharp(pixels, { raw: { width: TEX, height: TEX, channels: 3 } })
  .png({ compressionLevel: 9 })
  .toBuffer();

/* --------------------------------------------------------------- geometry */

const positions = [];
const normals = [];
const uvs = [];
const indices = [];

for (let v = 0; v <= SEG_V; v++) {
  const phi = (v / SEG_V) * Math.PI;
  for (let u = 0; u <= SEG_U; u++) {
    const theta = (u / SEG_U) * Math.PI * 2;
    const x = Math.sin(phi) * Math.cos(theta);
    const y = Math.cos(phi);
    const z = Math.sin(phi) * Math.sin(theta);
    positions.push(x, y, z);
    normals.push(x, y, z); // unit sphere: the position is the normal
    uvs.push(u / SEG_U, v / SEG_V);
  }
}

for (let v = 0; v < SEG_V; v++) {
  for (let u = 0; u < SEG_U; u++) {
    const a = v * (SEG_U + 1) + u;
    const b = a + SEG_U + 1;
    // Counter-clockwise seen from outside. Reversed, every triangle faces
    // inward and the sphere renders as nothing at all from the outside —
    // which is exactly what the first version of this file did.
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
}

/* ------------------------------------------------------------------- glTF */

const document = new Document();
const buffer = document.createBuffer();

const texture = document
  .createTexture("surface")
  .setImage(new Uint8Array(png))
  .setMimeType("image/png");

const material = document
  .createMaterial("surface")
  .setBaseColorTexture(texture)
  .setRoughnessFactor(0.85)
  .setMetallicFactor(0.05);

const primitive = document
  .createPrimitive()
  .setAttribute("POSITION", accessor("VEC3", new Float32Array(positions)))
  .setAttribute("NORMAL", accessor("VEC3", new Float32Array(normals)))
  .setAttribute("TEXCOORD_0", accessor("VEC2", new Float32Array(uvs)))
  .setIndices(accessor("SCALAR", new Uint32Array(indices)))
  .setMaterial(material);

const mesh = document.createMesh("globe").addPrimitive(primitive);
document.createScene("scene").addChild(document.createNode("globe").setMesh(mesh));

const glb = await new NodeIO().writeBinary(document);
const outPath = resolve(outDir, "sample.glb");
writeFileSync(outPath, glb);

console.log(`wrote ${outPath}`);
console.log(`  ${(glb.byteLength / 1024 / 1024).toFixed(2)} MB`);
console.log(`  ${indices.length / 3} triangles, ${positions.length / 3} vertices`);
console.log(`  one ${TEX}x${TEX} texture`);

function accessor(type, array) {
  return document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
}
