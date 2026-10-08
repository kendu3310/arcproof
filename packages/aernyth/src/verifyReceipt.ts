/**
 * Buyer-side verification.
 *
 * Reads the receipt back off Arc and checks it against bytes the buyer hashes
 * itself.
 *
 * Be exact about what a pass means. The provider writes the receipt, so a
 * provider that returns a bad file and records that bad file's hash passes
 * every check here. A match does not say the output is good. It says the
 * provider has publicly and irrevocably committed to having delivered exactly
 * these bytes, for exactly this input, to this payer — which is what lets
 * anyone else hold it to that delivery later. Whether the bytes are any good
 * is a separate question, answered by checks the buyer runs on the content
 * itself; see the geometry recount on the demo page for one.
 *
 * What a mismatch does catch: bytes altered between the provider's commitment
 * and the buyer, a provider whose served output differs from what it logged,
 * and — with `paymentNonce` — a receipt that was not written for this payment.
 */

import { createPublicClient, http, parseEventLogs, type Address, type Hex } from "viem";
import { digest, type Bytes } from "./digest.ts";
import { requestIdForPayment } from "./payment.ts";
import { receiptRegistryAbi, arcChain } from "./receipt.ts";
import type { ArcNetwork } from "./networks.ts";

export interface VerifyReceiptParams {
  network: ArcNetwork;
  registry: Address;
  /** Transaction hash from the `x-aernyth-tx` response header. */
  txHash: Hex;
  /** The exact bytes sent to the provider. */
  input: Bytes;
  /** The exact bytes received back. */
  output: Bytes;
  /** Expected provider address, from `x-aernyth-provider`. */
  expectedProvider?: Address;
  /** Expected payer, i.e. the buyer's own address. */
  expectedPayer?: Address;
  /**
   * The nonce of the EIP-3009 authorization the buyer signed to pay for this
   * request. When given, the receipt must carry the request id derived from
   * it — proof that it was written for this payment and not lifted from
   * another one. The buyer generated this value, so checking it trusts
   * nothing the provider said.
   */
  paymentNonce?: Hex;
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
  /** True when `paymentNonce` was given and the receipt is bound to it. */
  paymentBound?: boolean;
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

  let paymentBound: boolean | undefined;
  if (params.paymentNonce) {
    const expected = requestIdForPayment({
      payer: params.expectedPayer ?? recorded.payer,
      paymentNonce: params.paymentNonce,
      inputHash: localInput,
    });
    paymentBound = expected.toLowerCase() === recorded.requestId.toLowerCase();
    if (!paymentBound) {
      problems.push(
        `receipt is not bound to this payment: its request id is ${recorded.requestId}, the payment derives ${expected}`,
      );
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    ...(paymentBound === undefined ? {} : { paymentBound }),
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
