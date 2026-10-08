/**
 * A Merkle tree over receipt leaves, with sorted-pair hashing.
 *
 * Sorted pairs are what OpenZeppelin's MerkleProof.verify expects, so a proof
 * produced here checks with that library, or with any of the many ports of
 * it, and nobody has to trust this file to verify one. An odd node at the end
 * of a level is carried up unchanged; its proof simply has no sibling at that
 * level, which a sorted-pair verifier handles without knowing about it.
 */

import { encodePacked, keccak256, type Hex } from "viem";

function hashPair(a: Hex, b: Hex): Hex {
  const [first, second] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(encodePacked(["bytes32", "bytes32"], [first, second]));
}

export interface MerkleTree {
  /** levels[0] is the leaves; the last level holds only the root. */
  levels: Hex[][];
  root: Hex;
}

export function buildTree(leaves: readonly Hex[]): MerkleTree {
  if (leaves.length === 0) throw new Error("a Merkle tree needs at least one leaf");
  const levels: Hex[][] = [[...leaves]];
  while (levels[levels.length - 1]!.length > 1) {
    const previous = levels[levels.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < previous.length; i += 2) {
      next.push(i + 1 < previous.length ? hashPair(previous[i]!, previous[i + 1]!) : previous[i]!);
    }
    levels.push(next);
  }
  return { levels, root: levels[levels.length - 1]![0]! };
}

/** The siblings from leaf `index` up to the root. */
export function proofFor(tree: MerkleTree, index: number): Hex[] {
  if (!Number.isInteger(index) || index < 0 || index >= tree.levels[0]!.length) {
    throw new Error(`leaf index ${index} is outside a tree of ${tree.levels[0]!.length}`);
  }
  const proof: Hex[] = [];
  let position = index;
  for (const level of tree.levels.slice(0, -1)) {
    const sibling = position ^ 1;
    if (sibling < level.length) proof.push(level[sibling]!);
    position >>= 1;
  }
  return proof;
}

export function verifyProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  return proof.reduce<Hex>(hashPair, leaf).toLowerCase() === root.toLowerCase();
}
