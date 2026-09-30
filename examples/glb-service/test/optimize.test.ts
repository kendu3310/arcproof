import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { optimizeGlb, UnsupportedAsset } from "../src/optimize.ts";

const fixture = resolve(import.meta.dirname, "../fixtures/sample.glb");

test("geometry survives optimisation untouched", async () => {
  const input = readFileSync(fixture);
  const { report } = await optimizeGlb(input);

  // The service's entire promise, asserted rather than described.
  assert.equal(report.trianglesOut, report.trianglesIn);
  assert.equal(report.verticesOut, report.verticesIn);
});

test("the file actually gets smaller", async () => {
  const input = readFileSync(fixture);
  const { output, report } = await optimizeGlb(input);

  assert.ok(output.byteLength < input.byteLength, "output should be smaller");
  assert.equal(report.bytesOut, output.byteLength);
  assert.equal(report.bytesIn, input.byteLength);
});

test("the output is still a readable GLB", async () => {
  // Shrinking a file into something no engine can load would satisfy every
  // size assertion above and be worthless.
  const { output } = await optimizeGlb(readFileSync(fixture));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.readBinary(new Uint8Array(output));
  assert.equal(document.getRoot().listMeshes().length, 1);
});

test("the report declares which extensions the output needs", async () => {
  // Reading the output requires EXT_texture_webp. A loader without it fails
  // outright, so the buyer has to be told rather than left to find out in
  // their engine.
  const { output, report } = await optimizeGlb(readFileSync(fixture));

  assert.ok(
    report.requiresExtensions.includes("EXT_texture_webp"),
    `expected EXT_texture_webp in ${JSON.stringify(report.requiresExtensions)}`,
  );

  await assert.rejects(
    () => new NodeIO().readBinary(new Uint8Array(output)),
    /EXT_texture_webp/,
    "a loader without the extension should fail, which is why we declare it",
  );
});

test("png output needs no extension at all", async () => {
  // The escape hatch for buyers whose engine predates WebP.
  const { output, report } = await optimizeGlb(readFileSync(fixture), {
    textureFormat: "png",
  });
  assert.deepEqual(report.requiresExtensions, []);
  await new NodeIO().readBinary(new Uint8Array(output));
});

test("a larger maxTextureSize yields a larger file", async () => {
  const input = readFileSync(fixture);
  const small = await optimizeGlb(input, { maxTextureSize: 256 });
  const large = await optimizeGlb(input, { maxTextureSize: 2048 });
  assert.ok(
    large.output.byteLength > small.output.byteLength,
    "texture budget should control output size",
  );
});

test("skinned meshes are refused, not mangled", async () => {
  const glb = await buildSkinnedGlb();
  await assert.rejects(
    () => optimizeGlb(glb),
    (error: unknown) => error instanceof UnsupportedAsset && /skinned/i.test((error as Error).message),
    "a rigged asset must be refused explicitly",
  );
});

test("morph targets are refused, not mangled", async () => {
  const glb = await buildMorphGlb();
  await assert.rejects(
    () => optimizeGlb(glb),
    (error: unknown) => error instanceof UnsupportedAsset && /morph/i.test((error as Error).message),
  );
});

test("a non-GLB payload is refused with a clear reason", async () => {
  await assert.rejects(
    () => optimizeGlb(Buffer.from("this is not a model")),
    (error: unknown) => error instanceof UnsupportedAsset,
  );
});

async function buildSkinnedGlb(): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const primitive = trianglePrimitive(document, buffer);
  const mesh = document.createMesh("rigged").addPrimitive(primitive);
  const joint = document.createNode("joint");
  const skin = document.createSkin("armature").addJoint(joint);
  const node = document.createNode("rigged").setMesh(mesh).setSkin(skin);
  document.createScene().addChild(node).addChild(joint);
  return Buffer.from(await new NodeIO().writeBinary(document));
}

async function buildMorphGlb(): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const primitive = trianglePrimitive(document, buffer);
  const target = document
    .createPrimitiveTarget("shape")
    .setAttribute(
      "POSITION",
      document
        .createAccessor()
        .setType("VEC3")
        .setArray(new Float32Array([0, 0.5, 0, 0, 0, 0, 0, 0, 0]))
        .setBuffer(buffer),
    );
  primitive.addTarget(target);
  const mesh = document.createMesh("blendshape").addPrimitive(primitive);
  document.createScene().addChild(document.createNode().setMesh(mesh));
  return Buffer.from(await new NodeIO().writeBinary(document));
}

function trianglePrimitive(document: Document, buffer: ReturnType<Document["createBuffer"]>) {
  return document
    .createPrimitive()
    .setAttribute(
      "POSITION",
      document
        .createAccessor()
        .setType("VEC3")
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
        .setBuffer(buffer),
    );
}
