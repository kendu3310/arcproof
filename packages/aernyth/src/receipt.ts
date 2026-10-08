/**
 * Writing receipts to ReceiptRegistry on Arc.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  defineChain,
  type Hex,
  type Address,
  type Chain,
  type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MIN_MAX_FEE_PER_GAS_WEI, type ArcNetwork } from "./networks.ts";
import { signReceipt, type ReceiptDomain } from "./signed.ts";

export const receiptRegistryAbi = [
  {
    type: "function",
    name: "record",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "bytes32" },
      { name: "payer", type: "address" },
      { name: "inputHash", type: "bytes32" },
      { name: "outputHash", type: "bytes32" },
      { name: "bytesIn", type: "uint64" },
      { name: "bytesOut", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "recorded",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "Receipt",
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

export interface ReceiptData {
  requestId: Hex;
  payer: Address;
  inputHash: Hex;
  outputHash: Hex;
  bytesIn: bigint;
  bytesOut: bigint;
}

/** A contract write, without fees: the queue sets those. */
export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

export interface ReceiptWriterOptions {
  network: ArcNetwork;
  registry: Address;
  privateKey: Hex;
  /**
   * How long to wait for the transaction to be mined before giving up.
   *
   * Arc finalises in under a second, so this is generous. It exists because a
   * transaction rejected by the runtime blocklist burns gas without producing
   * a receipt, and without a deadline the wait would simply never return.
   */
  confirmationTimeoutMs?: number;
}

/**
 * Did this fail before the transaction reached the mempool?
 *
 * Only then is a retry safe. viem surfaces these as message text rather than
 * typed errors, so matching on the text is what is available.
 */
function isPreSubmitFailure(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("nonce") ||
    message.includes("replacement transaction underpriced") ||
    message.includes("already known") ||
    message.includes("fetch failed") ||
    message.includes("socket") ||
    message.includes("econnreset") ||
    message.includes("timeout") && message.includes("request")
  );
}

export function arcChain(network: ArcNetwork): Chain {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [network.rpcUrl] } },
    blockExplorers: {
      default: { name: `${network.name} Explorer`, url: network.explorerUrl },
    },
    ...(network.isTestnet ? { testnet: true } : {}),
  });
}

/**
 * Records receipts on-chain, one at a time.
 *
 * Writes are serialised through a promise chain. Two paid requests finishing
 * together would otherwise be assigned the same nonce and one of them would be
 * dropped — which, for a package whose whole job is producing evidence, means
 * silently losing the evidence for a request the buyer already paid for.
 */
export class ReceiptWriter {
  readonly network: ArcNetwork;
  readonly registry: Address;
  readonly providerAddress: Address;

  #account;
  #wallet;
  #publicClient;
  #timeoutMs: number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: ReceiptWriterOptions) {
    const chain = arcChain(options.network);
    const account = privateKeyToAccount(options.privateKey);

    this.network = options.network;
    this.registry = options.registry;
    this.providerAddress = account.address;
    this.#account = account;
    this.#timeoutMs = options.confirmationTimeoutMs ?? 30_000;
    this.#wallet = createWalletClient({
      account,
      chain,
      transport: http(options.network.rpcUrl),
    });
    this.#publicClient = createPublicClient({
      chain,
      transport: http(options.network.rpcUrl),
    });
  }

  /**
   * Sign a receipt with the provider's key, EIP-712. The key itself never
   * leaves this object; whoever needs a signature asks for one here.
   */
  signReceipt(domain: ReceiptDomain, receipt: ReceiptData): Promise<Hex> {
    return signReceipt(this.#account, domain, receipt);
  }

  /** Write one receipt and wait for it to be mined. Returns the tx hash. */
  async record(data: ReceiptData): Promise<Hex> {
    return this.send({
      address: this.registry,
      abi: receiptRegistryAbi,
      functionName: "record",
      args: [
        data.requestId,
        data.payer,
        data.inputHash,
        data.outputHash,
        data.bytesIn,
        data.bytesOut,
      ],
    });
  }

  /**
   * Send any contract call from the provider's key, through the same queue
   * as receipts, and wait for it to be mined.
   *
   * Everything that signs with this key has to come through here. A batch
   * commit sent from a second wallet client would race this one for nonces,
   * and the loser's evidence would vanish — the failure this queue exists to
   * prevent.
   */
  async send(call: ContractCall): Promise<Hex> {
    const run = this.#queue.then(() => this.#sendWithRetry(call));
    // Keep the chain alive even when a write fails, so one bad request does
    // not wedge every later one behind a rejected promise.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #sendWithRetry(call: ContractCall): Promise<Hex> {
    try {
      return await this.#submit(call);
    } catch (error) {
      // One retry, and only for failures that happen before the transaction
      // is accepted — a stale nonce, a dropped RPC connection. Those are
      // ordinary when two instances briefly share a wallet, which is exactly
      // what a rolling redeploy produces.
      //
      // Nothing is retried once a transaction is in flight. The registry
      // rejects a duplicate requestId, so a second attempt after a successful
      // first one reverts, and the buyer would be told the delivery was
      // unproven when it was in fact already proven.
      if (!isPreSubmitFailure(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 800));
      return await this.#submit(call);
    }
  }

  async #submit(call: ContractCall): Promise<Hex> {
    const fees = await this.#publicClient.estimateFeesPerGas().catch(() => null);

    // Arc's mempool enforces a 20 Gwei floor on maxFeePerGas. Below it a
    // transaction is not rejected — it sits pending indefinitely, which looks
    // like a hang rather than an error.
    const maxFeePerGas =
      fees?.maxFeePerGas && fees.maxFeePerGas > MIN_MAX_FEE_PER_GAS_WEI
        ? fees.maxFeePerGas
        : MIN_MAX_FEE_PER_GAS_WEI;

    // The call is typed loosely at this boundary so one queue can carry any
    // contract; each caller passes an abi it declared as const.
    const hash = await this.#wallet.writeContract({
      ...call,
      maxFeePerGas,
      maxPriorityFeePerGas: 1_000_000_000n,
    } as never);

    const receipt = await this.#publicClient.waitForTransactionReceipt({
      hash,
      timeout: this.#timeoutMs,
    });

    if (receipt.status !== "success") {
      throw new Error(
        `Transaction reverted: ${this.network.explorerUrl}/tx/${hash}`,
      );
    }

    return hash;
  }
}
