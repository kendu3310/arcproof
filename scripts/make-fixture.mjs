/**
 * Build a GLB fixture to exercise the optimiser.
 *
 *   node scripts/make-fixture.mjs
 *
 * Generated rather than downloaded so the test is hermetic and the licence
 * question never arises. The texture is 2048px of noise on purpose: a flat
 * colour would compress to nothing and flatter the pipeline into looking far
 * better than it is on real art.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "examples/glb-service/fixtures");
mkdirSync(outDir, { recursive: true });

const SIZE = 2048;

// Deterministic noise, so the fixture is byte-identical on every machine and
// a digest recorded in the README stays true.
const pixels = Buffer.alloc(SIZE * SIZE * 3);
let seed = 0x2f6e2b1;
for (let i = 0; i < pixels.length; i++) {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  pixels[i] = seed >>> 24;
}

const png = await sharp(pixels, { raw: { width: SIZE, height: SIZE, channels: 3 } })
  .png({ compressionLevel: 6 })
  .toBuffer();

const document = new Document();
const buffer = document.createBuffer();

// A unit cube: 24 vertices so each face has its own normals and UVs, 12
// triangles. Small geometry, large texture — the shape of a real game asset.
const positions = new Float32Array([
  -1,-1, 1,  1,-1, 1,  1, 1, 1, -1, 1, 1,
  -1,-1,-1, -1, 1,-1,  1, 1,-1,  1,-1,-1,
  -1, 1,-1, -1, 1, 1,  1, 1, 1,  1, 1,-1,
  -1,-1,-1,  1,-1,-1,  1,-1, 1, -1,-1, 1,
   1,-1,-1,  1, 1,-1,  1, 1, 1,  1,-1, 1,
  -1,-1,-1, -1,-1, 1, -1, 1, 1, -1, 1,-1,
]);

const normals = new Float32Array(24 * 3);
const faceNormals = [[0,0,1],[0,0,-1],[0,1,0],[0,-1,0],[1,0,0],[-1,0,0]];
for (let face = 0; face < 6; face++) {
  for (let v = 0; v < 4; v++) {
    const base = (face * 4 + v) * 3;
    normals[base] = faceNormals[face][0];
    normals[base + 1] = faceNormals[face][1];
    normals[base + 2] = faceNormals[face][2];
  }
}

const uvs = new Float32Array(24 * 2);
for (let face = 0; face < 6; face++) {
  const corners = [0, 0, 1, 0, 1, 1, 0, 1];
  for (let i = 0; i < 8; i++) uvs[face * 8 + i] = corners[i];
}

const indices = new Uint16Array(36);
for (let face = 0; face < 6; face++) {
  const o = face * 4;
  indices.set([o, o + 1, o + 2, o, o + 2, o + 3], face * 6);
}

const texture = document
  .createTexture("surface")
  .setImage(new Uint8Array(png))
  .setMimeType("image/png");

const material = document
  .createMaterial("surface")
  .setBaseColorTexture(texture)
  .setRoughnessFactor(0.8)
  .setMetallicFactor(0.1);

const primitive = document
  .createPrimitive()
  .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(positions).setBuffer(buffer))
  .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setArray(normals).setBuffer(buffer))
  .setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setArray(uvs).setBuffer(buffer))
  .setIndices(document.createAccessor().setType("SCALAR").setArray(indices).setBuffer(buffer))
  .setMaterial(material);

const mesh = document.createMesh("crate").addPrimitive(primitive);
const node = document.createNode("crate").setMesh(mesh);
document.createScene("scene").addChild(node);

const glb = await new NodeIO().writeBinary(document);
const outPath = resolve(outDir, "sample.glb");
writeFileSync(outPath, glb);

console.log(`wrote ${outPath}`);
console.log(`  ${(glb.byteLength / 1024 / 1024).toFixed(2)} MB`);
console.log(`  12 triangles, 24 vertices, one ${SIZE}x${SIZE} texture`);
