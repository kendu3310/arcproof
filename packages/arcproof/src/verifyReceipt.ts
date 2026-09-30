/**
 * Buyer-side verification.
 *
 * The provider's claim is worthless on its own; this reads the receipt back
 * off Arc and checks it against bytes the buyer hashes itself. A provider that
 * returns a degraded file cannot produce a matching outputHash, and one that
 * skips the write has no receipt at all.
 */

import { createPublicClient, http, parseEventLogs, type Address, type Hex } from "viem";
import { digest, type Bytes } from "./digest.ts";
import { receiptRegistryAbi, arcChain } from "./receipt.ts";
import type { ArcNetwork } from "./networks.ts";

export interface VerifyReceiptParams {
  network: ArcNetwork;
  registry: Address;
  /** Transaction hash from the `x-arcproof-tx` response header. */
  txHash: Hex;
  /** The exact bytes sent to the provider. */
  input: Bytes;
  /** The exact bytes received back. */
  output: Bytes;
  /** Expected provider address, from `x-arcproof-provider`. */
  expectedProvider?: Address;
  /** Expected payer, i.e. the buyer's own address. */
  expectedPayer?: Address;
}

export interface VerifiedReceipt {
  ok: boolean;
  /** Why verification failed. Empty when `ok` is true. */
  problems: string[];
  requestId?: Hex;
  provider?: Address;
  payer?: Address;
  inputHash?: Hex;
  outputHash?: Hex;
  bytesIn?: bigint;
  bytesOut?: bigint;
  explorerUrl: string;
}

export async function verifyReceipt(
  params: VerifyReceiptParams,
): Promise<VerifiedReceipt> {
  const client = createPublicClient({
    chain: arcChain(params.network),
    transport: http(params.network.rpcUrl),
  });

  const explorerUrl = `${params.network.explorerUrl}/tx/${params.txHash}`;
  const problems: string[] = [];

  const txReceipt = await client.getTransactionReceipt({ hash: params.txHash });

  if (txReceipt.status !== "success") {
    return { ok: false, problems: ["receipt transaction reverted"], explorerUrl };
  }

  const logs = parseEventLogs({
    abi: receiptRegistryAbi,
    eventName: "Receipt",
    logs: txReceipt.logs,
  });

  // Only logs from the registry we were told about count. Anyone can deploy a
  // contract that emits an identically shaped event, so the address the buyer
  // trusts has to be pinned, not read from the provider's own response.
  const log = logs.find(
    (candidate) =>
      candidate.address.toLowerCase() === params.registry.toLowerCase(),
  );

  if (!log) {
    return {
      ok: false,
      problems: [`no Receipt event from registry ${params.registry} in this transaction`],
      explorerUrl,
    };
  }

  const recorded = log.args;
  const localInput = digest(params.input);
  const localOutput = digest(params.output);

  if (recorded.inputHash !== localInput) {
    problems.push(
      `inputHash mismatch: chain says ${recorded.inputHash}, local bytes hash to ${localInput}`,
    );
  }
  if (recorded.outputHash !== localOutput) {
    problems.push(
      `outputHash mismatch: chain says ${recorded.outputHash}, local bytes hash to ${localOutput}`,
    );
  }
  if (recorded.bytesIn !== BigInt(params.input.byteLength)) {
    problems.push(
      `bytesIn mismatch: chain says ${recorded.bytesIn}, local input is ${params.input.byteLength}`,
    );
  }
  if (recorded.bytesOut !== BigInt(params.output.byteLength)) {
    problems.push(
      `bytesOut mismatch: chain says ${recorded.bytesOut}, local output is ${params.output.byteLength}`,
    );
  }
  if (
    params.expectedProvider &&
    recorded.provider.toLowerCase() !== params.expectedProvider.toLowerCase()
  ) {
    problems.push(
      `provider mismatch: receipt written by ${recorded.provider}, expected ${params.expectedProvider}`,
    );
  }
  if (
    params.expectedPayer &&
    recorded.payer.toLowerCase() !== params.expectedPayer.toLowerCase()
  ) {
    problems.push(
      `payer mismatch: receipt names ${recorded.payer}, expected ${params.expectedPayer}`,
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    requestId: recorded.requestId,
    provider: recorded.provider,
    payer: recorded.payer,
    inputHash: recorded.inputHash,
    outputHash: recorded.outputHash,
    bytesIn: recorded.bytesIn,
    bytesOut: recorded.bytesOut,
    explorerUrl,
  };
}
