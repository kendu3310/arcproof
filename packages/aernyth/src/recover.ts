/**
 * Proofs that outlive the provider.
 *
 * BatchAnchor publishes every leaf of a batch in the commit transaction's
 * calldata, appended after the ABI-encoded arguments. BatchRegistry never reads
 * those bytes — Solidity's decoder ignores anything past the arguments it
 * expects — so the contract is unchanged, but the chain now keeps a copy of
 * every leaf. Rebuild the tree from them, check it reaches the root the Batch
 * event recorded, and a proof for any leaf follows. No provider, no server
 * memory, no disk.
 *
 * The bytes are not trusted for being on chain: a provider could append
 * anything. They are trusted only once they hash up to the committed root.
 */

import { createPublicClient, decodeFunctionData, http, parseEventLogs, toFunctionSelector, type Address, type Hex } from "viem";
import { batchRegistryAbi, type AnchorProof } from "./batch.ts";
import { buildTree, proofFor } from "./merkle.ts";
import { arcChain } from "./receipt.ts";
import type { ArcNetwork } from "./networks.ts";

const COMMIT_SELECTOR = toFunctionSelector("commit(bytes32,uint32)");
/** selector + bytes32 root + uint32 count, each argument padded to a word. */
const COMMIT_ARGS_HEX = 2 + 8 + 64 * 2;

/** The calldata suffix carrying a batch's leaves, in tree order. */
export function encodeLeaves(leaves: readonly Hex[]): Hex {
  return `0x${leaves.map((leaf) => leaf.slice(2)).join("")}`;
}

export interface DecodedCommit {
  root: Hex;
  count: number;
  /** Absent when the transaction carried no leaves, or not exactly `count` of them. */
  leaves?: Hex[];
}

/** Read a commit transaction's input: its root, its count, and the leaves appended after them. */
export function decodeCommit(input: Hex): DecodedCommit {
  if (input.slice(0, 10).toLowerCase() !== COMMIT_SELECTOR) throw new Error("not a BatchRegistry.commit call");
  const { args } = decodeFunctionData({ abi: batchRegistryAbi, data: `0x${input.slice(2, COMMIT_ARGS_HEX)}` });
  const [root, count] = args as readonly [Hex, number];
  const suffix = input.slice(COMMIT_ARGS_HEX);
  if (suffix.length !== count * 64) return { root, count };
  const leaves = Array.from({ length: count }, (_, i) => `0x${suffix.slice(i * 64, (i + 1) * 64)}` as Hex);
  return { root, count, leaves };
}

export interface ProofFromCommitParams {
  network: ArcNetwork;
  /** The BatchRegistry the buyer trusts. */
  registry: Address;
  /** The provider the buyer paid; a batch committed by anyone else is refused. */
  expectedProvider: Address;
  txHash: Hex;
  leaf: Hex;
}

/**
 * Rebuild the proof for `leaf` from a commit transaction alone.
 * Throws with the reason when the transaction cannot vouch for the leaf.
 */
export async function proofFromCommit(params: ProofFromCommitParams): Promise<AnchorProof> {
  const client = clientFor(params.network);
  const [tx, mined] = await Promise.all([
    client.getTransaction({ hash: params.txHash }),
    client.getTransactionReceipt({ hash: params.txHash }),
  ]);
  return proofFrom(params, tx.input, mined);
}

export interface FindAnchorProofParams {
  network: ArcNetwork;
  registry: Address;
  expectedProvider: Address;
  leaf: Hex;
  /**
   * A block at or before the commit: the head when the response arrived is
   * ideal. Omitted, the scan covers the most recent `maxBlocks` blocks.
   */
  fromBlock?: bigint;
  /** How many blocks to scan. Default 20,000, about three hours on Arc. */
  maxBlocks?: bigint;
}

/**
 * Find the batch holding `leaf` by scanning the provider's commits, for when
 * the commit transaction itself is not known — the provider restarted before
 * serving the proof, or stopped answering. Undefined when no batch in range
 * holds the leaf, which is the cue to anchor the signed receipt yourself.
 */
export async function findAnchorProof(params: FindAnchorProofParams): Promise<AnchorProof | undefined> {
  const client = clientFor(params.network);
  const head = await client.getBlockNumber();
  const span = params.maxBlocks ?? 20_000n;
  const start = params.fromBlock ?? (head > span ? head - span : 0n);
  const end = min(head, start + span);
  // The public RPC refuses eth_getLogs over more than ~5,000 blocks.
  for (let from = start; from <= end; from += 5_000n) {
    const logs = await client.getContractEvents({
      address: params.registry,
      abi: batchRegistryAbi,
      eventName: "Batch",
      args: { provider: params.expectedProvider },
      fromBlock: from,
      toBlock: min(end, from + 4_999n),
    });
    for (const log of logs) {
      const tx = await client.getTransaction({ hash: log.transactionHash });
      const leaves = safeDecode(tx.input)?.leaves;
      if (!leaves?.some((l) => l.toLowerCase() === params.leaf.toLowerCase())) continue;
      const mined = await client.getTransactionReceipt({ hash: log.transactionHash });
      return proofFrom({ ...params, txHash: log.transactionHash }, tx.input, mined);
    }
  }
  return undefined;
}

type Mined = Awaited<ReturnType<ReturnType<typeof clientFor>["getTransactionReceipt"]>>;

function proofFrom(params: ProofFromCommitParams, input: Hex, mined: Mined): AnchorProof {
  if (mined.status !== "success") throw new Error("the commit transaction reverted");
  if (mined.to?.toLowerCase() !== params.registry.toLowerCase()) throw new Error("the transaction is not a call to the trusted registry");

  const decoded = decodeCommit(input);
  // Only Batch events from the pinned registry count: anyone can deploy a
  // contract emitting an identically shaped event.
  const batch = parseEventLogs({ abi: batchRegistryAbi, eventName: "Batch", logs: mined.logs }).find(
    (log) =>
      log.address.toLowerCase() === params.registry.toLowerCase() &&
      log.args.root.toLowerCase() === decoded.root.toLowerCase(),
  );
  if (!batch) throw new Error("no Batch event for this root from the trusted registry");
  if (batch.args.provider.toLowerCase() !== params.expectedProvider.toLowerCase()) {
    throw new Error(`the batch was committed by ${batch.args.provider}, not ${params.expectedProvider}`);
  }
  if (!decoded.leaves) throw new Error("this commit did not publish its leaves, so the proof cannot be rebuilt from the chain");

  const tree = buildTree(decoded.leaves);
  if (tree.root.toLowerCase() !== decoded.root.toLowerCase()) {
    throw new Error("the leaves in the calldata do not hash to the committed root");
  }
  const index = decoded.leaves.findIndex((l) => l.toLowerCase() === params.leaf.toLowerCase());
  if (index < 0) throw new Error("this batch does not hold that leaf");

  return {
    registry: params.registry,
    txHash: mined.transactionHash,
    root: decoded.root,
    index,
    count: decoded.count,
    proof: proofFor(tree, index),
  };
}

function safeDecode(input: Hex): DecodedCommit | undefined {
  try {
    return decodeCommit(input);
  } catch {
    return undefined;
  }
}

function clientFor(network: ArcNetwork) {
  return createPublicClient({ chain: arcChain(network), transport: http(network.rpcUrl) });
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
