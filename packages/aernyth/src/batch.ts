/**
 * Batched receipts: sign each one now, anchor many at once a moment later.
 *
 * Writing every receipt as its own transaction costs 49,559 gas, about $0.001,
 * which is more than the whole price of a sub-cent call. Here each receipt is
 * signed the moment the response goes out — the signature alone already stops
 * the provider denying the delivery — and its leaf joins an open batch. When
 * the batch reaches `maxBatch` leaves or `maxWaitMs` passes, one Merkle root
 * goes to BatchRegistry for all of them: 24,160 gas whatever the count, so 94
 * gas a receipt at 256. Measured on Arc testnet; see design/batched-receipts.md.
 *
 * What a buyer gets, and when:
 *   - with the bytes: the signature, which it can check offline at once
 *   - a second or so later: the root's transaction and its Merkle proof, from
 *     lookup() — or, if the provider never anchors, nothing, and it can anchor
 *     the signed receipt itself through BatchRegistry.anchor
 *
 * Every commit also carries the batch's leaves in its calldata, after the
 * arguments the contract reads. That makes the chain the store: any proof can
 * be rebuilt from the commit transaction alone (see recover.ts), so a provider
 * that restarts, or vanishes, takes nothing with it. Proofs are additionally
 * cached in memory, which only saves the lookup. What a restart can still lose
 * is a batch not yet committed; its buyers hold signatures and can anchor them
 * themselves through BatchRegistry.anchor.
 */

import type { Address, Hex } from "viem";
import type { ReceiptData, ReceiptWriter } from "./receipt.ts";
import type { ArcNetwork } from "./networks.ts";
import { buildTree, proofFor } from "./merkle.ts";
import { receiptDomain, receiptLeaf, type ReceiptDomain } from "./signed.ts";

export const batchRegistryAbi = [
  {
    type: "function",
    name: "commit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "count", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "anchor",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "receipt",
        type: "tuple",
        components: [
          { name: "requestId", type: "bytes32" },
          { name: "payer", type: "address" },
          { name: "inputHash", type: "bytes32" },
          { name: "outputHash", type: "bytes32" },
          { name: "bytesIn", type: "uint64" },
          { name: "bytesOut", type: "uint64" },
        ],
      },
      { name: "provider", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Batch",
    inputs: [
      { name: "root", type: "bytes32", indexed: true },
      { name: "provider", type: "address", indexed: true },
      { name: "count", type: "uint32", indexed: false },
      { name: "timestamp", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Anchored",
    inputs: [
      { name: "requestId", type: "bytes32", indexed: true },
      { name: "provider", type: "address", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "inputHash", type: "bytes32", indexed: false },
      { name: "outputHash", type: "bytes32", indexed: false },
      { name: "bytesIn", type: "uint64", indexed: false },
      { name: "bytesOut", type: "uint64", indexed: false },
      { name: "timestamp", type: "uint64", indexed: false },
    ],
  },
] as const;

/** Everything a buyer needs to show its receipt is in a committed batch. */
export interface AnchorProof {
  registry: Address;
  /** The transaction that committed the root. */
  txHash: Hex;
  root: Hex;
  /** Position of this receipt's leaf, and how many leaves the batch holds. */
  index: number;
  count: number;
  /** Sibling hashes from the leaf to the root, sorted-pair. */
  proof: Hex[];
}

export type AnchorStatus =
  | { status: "pending" }
  | { status: "anchored"; proof: AnchorProof }
  | { status: "failed"; reason: string };

export interface SignedReceipt {
  receipt: ReceiptData;
  leaf: Hex;
  signature: Hex;
  /** Settles when the batch holding this receipt is committed, or fails to be. */
  anchored: Promise<AnchorProof>;
}

export interface BatchAnchorOptions {
  /** The provider's writer. Commits go through its queue, so they never race receipts for a nonce. */
  writer: ReceiptWriter;
  /** BatchRegistry address on the writer's network. */
  registry: Address;
  /** Commit as soon as this many receipts are waiting. Default 256. */
  maxBatch?: number;
  /** Commit at most this long after the first receipt of a batch arrives. Default 1000 ms. */
  maxWaitMs?: number;
  /** How many settled receipts to remember for lookup(). Default 10,000. */
  keep?: number;
  /**
   * Publish each batch's leaves in the commit's calldata so proofs can be
   * rebuilt from the chain. Default true. Costs calldata gas per leaf; see
   * design/batched-receipts.md for the measured figure.
   */
  publishLeaves?: boolean;
}

interface Waiting {
  receipt: ReceiptData;
  leaf: Hex;
  resolve: (proof: AnchorProof) => void;
  reject: (error: Error) => void;
}

export class BatchAnchor {
  readonly network: ArcNetwork;
  readonly registry: Address;
  readonly providerAddress: Address;
  readonly domain: ReceiptDomain;

  #writer: ReceiptWriter;
  #maxBatch: number;
  #maxWaitMs: number;
  #keep: number;
  #publishLeaves: boolean;
  #waiting: Waiting[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #status = new Map<string, AnchorStatus>();
  #inFlight = new Set<Promise<void>>();

  constructor(options: BatchAnchorOptions) {
    this.#writer = options.writer;
    this.network = options.writer.network;
    this.registry = options.registry;
    this.providerAddress = options.writer.providerAddress;
    this.domain = receiptDomain(options.writer.network.chainId, options.registry);
    this.#maxBatch = options.maxBatch ?? 256;
    this.#maxWaitMs = options.maxWaitMs ?? 1000;
    this.#keep = options.keep ?? 10_000;
    this.#publishLeaves = options.publishLeaves ?? true;
    if (this.#maxBatch < 1 || this.#maxBatch > 0xffffffff) throw new Error("maxBatch must be between 1 and 2^32-1");
  }

  /**
   * Sign a receipt and queue it for the next batch. Returns once signed — the
   * caller can send the bytes and the signature without waiting for the chain.
   */
  async add(receipt: ReceiptData): Promise<SignedReceipt> {
    const signature = await this.#writer.signReceipt(this.domain, receipt);
    const leaf = receiptLeaf(receipt);

    let resolve!: (proof: AnchorProof) => void;
    let reject!: (error: Error) => void;
    const anchored = new Promise<AnchorProof>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    // Nobody is obliged to await this; an unobserved failure must not take
    // the process down.
    anchored.catch(() => undefined);

    this.#remember(receipt.requestId, { status: "pending" });
    this.#waiting.push({ receipt, leaf, resolve, reject });

    if (this.#waiting.length >= this.#maxBatch) {
      this.#flushNow();
    } else if (!this.#timer) {
      this.#timer = setTimeout(() => this.#flushNow(), this.#maxWaitMs);
    }

    return { receipt, leaf, signature, anchored };
  }

  /** What is known about a receipt: pending, anchored with its proof, or failed. */
  lookup(requestId: Hex): AnchorStatus | undefined {
    return this.#status.get(requestId.toLowerCase());
  }

  /** Commit whatever is waiting and wait for every commit in flight. */
  async flush(): Promise<void> {
    this.#flushNow();
    await Promise.allSettled([...this.#inFlight]);
  }

  #flushNow(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#waiting.length === 0) return;

    // add() flushes the moment the queue reaches maxBatch, so it never holds
    // more than one batch: everything waiting goes.
    const batch = this.#waiting.splice(0);
    const run = this.#commit(batch).finally(() => this.#inFlight.delete(run));
    this.#inFlight.add(run);
  }

  async #commit(batch: Waiting[]): Promise<void> {
    const tree = buildTree(batch.map((w) => w.leaf));
    try {
      const txHash = await this.#writer.send({
        address: this.registry,
        abi: batchRegistryAbi,
        functionName: "commit",
        args: [tree.root, batch.length],
        ...(this.#publishLeaves ? { dataSuffix: `0x${batch.map((w) => w.leaf.slice(2)).join("")}` as Hex } : {}),
      });
      batch.forEach((waiting, index) => {
        const proof: AnchorProof = {
          registry: this.registry,
          txHash,
          root: tree.root,
          index,
          count: batch.length,
          proof: proofFor(tree, index),
        };
        this.#remember(waiting.receipt.requestId, { status: "anchored", proof });
        waiting.resolve(proof);
      });
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      for (const waiting of batch) {
        this.#remember(waiting.receipt.requestId, { status: "failed", reason });
        waiting.reject(new Error(`batch commit failed: ${reason}`));
      }
    }
  }

  #remember(requestId: Hex, status: AnchorStatus): void {
    const key = requestId.toLowerCase();
    this.#status.delete(key); // re-insert so the newest status is the youngest entry
    this.#status.set(key, status);
    while (this.#status.size > this.#keep) {
      const oldest = this.#status.keys().next().value;
      if (oldest === undefined) break;
      this.#status.delete(oldest);
    }
  }
}
