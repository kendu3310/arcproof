/**
 * Buyer-side checks for batched receipts. Two of them, at two moments.
 *
 * verifySignedReceipt runs the instant the bytes arrive, offline. It rebuilds
 * the receipt from the buyer's own copies of the input and output, recovers
 * who signed it, and — given the payment nonce — checks the receipt was
 * written for this payment. Passing means the provider has irrevocably
 * committed to these bytes. It does not mean they are any good; see the
 * README's section on what a receipt proves.
 *
 * verifyAnchoredReceipt runs once the batch is committed. It reads the commit
 * transaction from Arc, finds the root in the pinned registry's Batch event,
 * checks the provider sent it, and walks the Merkle proof from the buyer's own
 * leaf up to that root. Passing adds a public timestamp to the signature.
 */

import { createPublicClient, http, parseEventLogs, type Address, type Hex } from "viem";
import { digest, type Bytes } from "./digest.ts";
import { requestIdForPayment } from "./payment.ts";
import { arcChain, type ReceiptData } from "./receipt.ts";
import { receiptDomain, receiptLeaf, recoverReceiptSigner } from "./signed.ts";
import { verifyProof } from "./merkle.ts";
import { batchRegistryAbi, type AnchorProof } from "./batch.ts";
import type { ArcNetwork } from "./networks.ts";

export interface VerifySignedParams {
  network: ArcNetwork;
  /** The BatchRegistry the buyer trusts. Pinned, never read from the response. */
  registry: Address;
  /** The provider the buyer paid. */
  expectedProvider: Address;
  input: Bytes;
  output: Bytes;
  /** From the response headers; the signature binds the provider to them. */
  requestId: Hex;
  payer: Address;
  signature: Hex;
  /** The nonce of the authorization the buyer signed, to check the binding. */
  paymentNonce?: Hex;
}

export interface VerifiedSigned {
  ok: boolean;
  problems: string[];
  /** The receipt as rebuilt from the buyer's own bytes. */
  receipt: ReceiptData;
  leaf: Hex;
  signer?: Address;
  paymentBound?: boolean;
}

export async function verifySignedReceipt(params: VerifySignedParams): Promise<VerifiedSigned> {
  const problems: string[] = [];
  const receipt: ReceiptData = {
    requestId: params.requestId,
    payer: params.payer,
    inputHash: digest(params.input),
    outputHash: digest(params.output),
    bytesIn: BigInt(params.input.byteLength),
    bytesOut: BigInt(params.output.byteLength),
  };

  let signer: Address | undefined;
  try {
    signer = await recoverReceiptSigner(receiptDomain(params.network.chainId, params.registry), receipt, params.signature);
  } catch (error) {
    problems.push(`signature is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A signature over different bytes recovers to some unrelated address, not
  // to an error — so a changed byte shows up here as a signer mismatch.
  if (signer && signer.toLowerCase() !== params.expectedProvider.toLowerCase()) {
    problems.push(
      `signature does not come from ${params.expectedProvider} over these bytes (it recovers to ${signer}); the bytes, the receipt fields or the signer differ`,
    );
  }

  let paymentBound: boolean | undefined;
  if (params.paymentNonce) {
    const expected = requestIdForPayment({
      payer: params.payer,
      paymentNonce: params.paymentNonce,
      inputHash: receipt.inputHash,
    });
    paymentBound = expected.toLowerCase() === params.requestId.toLowerCase();
    if (!paymentBound) problems.push(`receipt is not bound to this payment: id ${params.requestId}, payment derives ${expected}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    receipt,
    leaf: receiptLeaf(receipt),
    ...(signer ? { signer } : {}),
    ...(paymentBound === undefined ? {} : { paymentBound }),
  };
}

export interface VerifyAnchoredParams {
  network: ArcNetwork;
  /** The BatchRegistry the buyer trusts — a proof naming any other is refused. */
  registry: Address;
  expectedProvider: Address;
  /** The buyer's own leaf, from verifySignedReceipt. */
  leaf: Hex;
  proof: AnchorProof;
}

export interface VerifiedAnchored {
  ok: boolean;
  problems: string[];
  /** Block timestamp of the commit: when the receipt became public record. */
  timestamp?: bigint;
  explorerUrl: string;
}

export async function verifyAnchoredReceipt(params: VerifyAnchoredParams): Promise<VerifiedAnchored> {
  const explorerUrl = `${params.network.explorerUrl}/tx/${params.proof.txHash}`;
  const fail = (problem: string): VerifiedAnchored => ({ ok: false, problems: [problem], explorerUrl });

  if (params.proof.registry.toLowerCase() !== params.registry.toLowerCase()) {
    return fail(`proof names registry ${params.proof.registry}, not the trusted ${params.registry}`);
  }

  const client = createPublicClient({ chain: arcChain(params.network), transport: http(params.network.rpcUrl) });
  const tx = await client.getTransactionReceipt({ hash: params.proof.txHash });
  if (tx.status !== "success") return fail("commit transaction reverted");

  // Only Batch events from the pinned registry count: anyone can deploy a
  // contract emitting an identically shaped event.
  const batches = parseEventLogs({ abi: batchRegistryAbi, eventName: "Batch", logs: tx.logs }).filter(
    (log) => log.address.toLowerCase() === params.registry.toLowerCase(),
  );
  const batch = batches.find((log) => log.args.root.toLowerCase() === params.proof.root.toLowerCase());
  if (!batch) return fail(`no Batch with root ${params.proof.root} from ${params.registry} in that transaction`);

  const problems: string[] = [];
  if (batch.args.provider.toLowerCase() !== params.expectedProvider.toLowerCase()) {
    problems.push(`batch committed by ${batch.args.provider}, not ${params.expectedProvider}`);
  }
  if (!verifyProof(params.leaf, params.proof.proof, batch.args.root)) {
    problems.push("Merkle proof does not lead from this receipt's leaf to the committed root");
  }

  return { ok: problems.length === 0, problems, timestamp: batch.args.timestamp, explorerUrl };
}
