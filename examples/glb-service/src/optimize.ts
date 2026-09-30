/**
 * GLB optimisation that will not quietly damage your asset.
 *
 * The obvious way to shrink a model is to throw away triangles. It is also the
 * wrong thing to sell to an autonomous buyer: decimation breaks UV seams,
 * distorts normals and wrecks skinned meshes, and an agent has no eyes to
 * notice. So this pipeline never touches geometry. Vertex and triangle counts
 * come out exactly as they went in, and the report says so in numbers the
 * buyer can check.
 *
 * Nearly all of a typical GLB is texture data, so re-encoding textures is
 * where the size goes anyway. What is given up is only image precision, which
 * is visible, bounded and reversible by asking for a larger `maxTextureSize`.
 */

import { NodeIO, type Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, textureCompress } from "@gltf-transform/functions";
import sharp from "sharp";

export interface OptimizeOptions {
  /** Longest edge allowed for any texture, in pixels. */
  maxTextureSize?: number;
  /** Output image format. WebP is understood by glTF via EXT_texture_webp. */
  textureFormat?: "webp" | "jpeg" | "png";
}

export interface OptimizeReport {
  bytesIn: number;
  bytesOut: number;
  ratio: number;
  /** Must equal `trianglesOut`. The whole promise of this service. */
  trianglesIn: number;
  trianglesOut: number;
  verticesIn: number;
  verticesOut: number;
  meshes: number;
  materials: number;
  texturesIn: number;
  texturesOut: number;
  steps: string[];
  /**
   * glTF extensions the output declares as required.
   *
   * Re-encoding textures to WebP makes the file unreadable to any loader
   * without EXT_texture_webp. A smaller file that the buyer's engine cannot
   * open is not an optimisation, and an agent has no way to discover this by
   * looking at the bytes — so it is stated.
   */
  requiresExtensions: string[];
}

export class UnsupportedAsset extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedAsset";
  }
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

export async function optimizeGlb(
  input: Buffer,
  options: OptimizeOptions = {},
): Promise<{ output: Buffer; report: OptimizeReport }> {
  const maxTextureSize = options.maxTextureSize ?? 1024;
  const textureFormat = options.textureFormat ?? "webp";

  let document: Document;
  try {
    document = await io.readBinary(new Uint8Array(input));
  } catch (error) {
    throw new UnsupportedAsset(
      `not a readable GLB: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  refuseWhatWeCannotDoSafely(document);

  const before = measure(document);

  await document.transform(
    // Merge identical accessors, materials and textures that appear more than
    // once. Nothing is lost: the duplicates were already the same bytes.
    dedup(),
    // Drop resources nothing references. Also lossless — unreachable data
    // cannot affect what is rendered.
    prune(),
    textureCompress({
      encoder: sharp,
      targetFormat: textureFormat,
      resize: [maxTextureSize, maxTextureSize],
      resizeFilter: "lanczos3",
    }),
  );

  const after = measure(document);
  const output = Buffer.from(await io.writeBinary(document));

  // A guard, not a comment. If a future change to this pipeline starts
  // removing geometry, the service must fail loudly rather than hand back a
  // receipt attesting to a promise it has stopped keeping.
  if (after.triangles !== before.triangles || after.vertices !== before.vertices) {
    throw new Error(
      `pipeline altered geometry: ${before.triangles}->${after.triangles} triangles, ` +
        `${before.vertices}->${after.vertices} vertices. Refusing to return it.`,
    );
  }

  return {
    output,
    report: {
      bytesIn: input.byteLength,
      bytesOut: output.byteLength,
      ratio: Number((output.byteLength / input.byteLength).toFixed(4)),
      trianglesIn: before.triangles,
      trianglesOut: after.triangles,
      verticesIn: before.vertices,
      verticesOut: after.vertices,
      meshes: after.meshes,
      materials: after.materials,
      texturesIn: before.textures,
      texturesOut: after.textures,
      steps: [
        "dedup",
        "prune",
        `textureCompress(${textureFormat}, max ${maxTextureSize}px)`,
      ],
      requiresExtensions: document
        .getRoot()
        .listExtensionsRequired()
        .map((extension) => extension.extensionName)
        .sort(),
    },
  };
}

/**
 * Refuse assets this pipeline cannot guarantee for.
 *
 * Saying no is better than returning something subtly broken. A buyer that
 * gets an error can choose another provider; a buyer that gets a quietly
 * mangled rig finds out in front of players.
 */
function refuseWhatWeCannotDoSafely(document: Document): void {
  const root = document.getRoot();

  if (root.listSkins().length > 0) {
    throw new UnsupportedAsset(
      "asset contains skinned meshes. This service does not process rigs yet, " +
        "because verifying that a skeleton survived re-encoding needs more than a byte digest.",
    );
  }

  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.listTargets().length > 0) {
        throw new UnsupportedAsset(
          `mesh "${mesh.getName() || "(unnamed)"}" has morph targets, which this service does not process yet.`,
        );
      }
    }
  }
}

function measure(document: Document) {
  const root = document.getRoot();
  let triangles = 0;
  let vertices = 0;

  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      const indices = primitive.getIndices();
      const count = indices ? indices.getCount() : (position?.getCount() ?? 0);
      // Only TRIANGLES (mode 4) is counted as triangles; other modes are rare
      // in game assets and counting them wrongly would make the report lie.
      if (primitive.getMode() === 4) triangles += Math.floor(count / 3);
      vertices += position?.getCount() ?? 0;
    }
  }

  return {
    triangles,
    vertices,
    meshes: root.listMeshes().length,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
  };
}
