/**
 * Ties a receipt to the payment that bought it.
 *
 * A receipt names a payer, but a payer can buy the same thing many times, so
 * a payer alone does not say which purchase a receipt belongs to. Something
 * from the payment itself has to go into the request id.
 *
 * The obvious candidate is a settlement transaction hash, and it does not
 * exist: Circle's Gateway batches settlement, so when the service answers no
 * on-chain transfer has happened yet. The settlement reference the SDK does
 * hand over comes from a remote API that documents neither its format nor
 * whether it is unique per request.
 *
 * The EIP-3009 authorization nonce has neither problem. It is 32 random bytes
 * the buyer generated and signed, it travels in the request, and Gateway
 * refuses to settle the same nonce twice — that refusal is the whole of
 * EIP-3009's replay protection, so uniqueness is guaranteed by the protocol
 * rather than hoped for. And the buyer already holds it, so it can recompute
 * the request id without trusting anything the provider says.
 */

import type { Address, Hex } from "viem";
import { deriveRequestId } from "./digest.ts";

/** The request header x402 v2 carries the signed payment in. */
export const PAYMENT_HEADER = "payment-signature";

export interface PaymentAuthorization {
  /** The address that signed the authorization — the payer. */
  from: Address;
  /** The authorization's bytes32 nonce. */
  nonce: Hex;
}

/**
 * Read the authorization out of a `Payment-Signature` header.
 *
 * Returns undefined rather than throwing on anything malformed. The payment
 * middleware has already accepted or rejected the payment by the time this
 * runs; all that is at stake here is whether the receipt can be bound to it,
 * and the caller decides what an unbound receipt means.
 */
export function readPaymentAuthorization(
  header: string | string[] | undefined,
): PaymentAuthorization | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }

  const authorization = (decoded as { payload?: { authorization?: unknown } })?.payload
    ?.authorization as { from?: unknown; nonce?: unknown } | undefined;

  const from = authorization?.from;
  const nonce = authorization?.nonce;
  if (typeof from !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(from)) return undefined;
  if (typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return undefined;

  return { from: from as Address, nonce: nonce.toLowerCase() as Hex };
}

/**
 * The request id for a paid request: the payer, the payment's nonce and the
 * input, and nothing the provider chose.
 *
 * Both sides compute it. The provider records it; the buyer recomputes it from
 * its own signed nonce and its own copy of the input, and a receipt carrying
 * any other id was not written for that payment.
 */
export function requestIdForPayment(params: {
  payer: Address;
  paymentNonce: Hex;
  inputHash: Hex;
}): Hex {
  return deriveRequestId({
    payer: params.payer,
    nonce: BigInt(params.paymentNonce),
    inputHash: params.inputHash,
  });
}
