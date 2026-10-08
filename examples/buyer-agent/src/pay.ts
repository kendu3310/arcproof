/**
 * The 402 flow, driven manually so the raw response survives.
 *
 * GatewayClient.pay() is the convenient path, but it hands back parsed data
 * and drops the response headers. Both are fatal here: the receipt commits to
 * a digest of the exact bytes on the wire, and the tx hash to check it against
 * arrives in `x-arcproof-tx`. Re-serialising parsed JSON would produce a
 * different digest and look like the provider had cheated.
 */

import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import type { Account, Hex } from "viem";
import { Budget, usd, type PaymentTerms } from "./budget.ts";

export interface PaidResponse {
  response: Response;
  body: Buffer;
  paid: boolean;
  amount: bigint;
  terms?: PaymentTerms;
  /**
   * The nonce of the authorization this agent signed. It is what the receipt
   * must be bound to, and the agent holds it without asking the provider.
   */
  paymentNonce?: Hex;
  /** The settlement reference Circle's facilitator returned, if any. */
  settlement?: string;
}

export interface PayOptions {
  url: string;
  account: Account;
  budget: Budget;
  method?: string;
  body?: Buffer;
  contentType?: string;
  log?: (message: string) => void;
}

export async function payAndFetch(options: PayOptions): Promise<PaidResponse> {
  const { url, account, budget } = options;
  const log = options.log ?? (() => {});
  const method = options.method ?? "POST";
  const headers: Record<string, string> = {};
  if (options.contentType) headers["content-type"] = options.contentType;

  const first = await fetch(url, { method, headers, body: options.body });

  if (first.status !== 402) {
    return {
      response: first,
      body: Buffer.from(await first.arrayBuffer()),
      paid: false,
      amount: 0n,
    };
  }

  const header = first.headers.get("payment-required");
  if (!header) {
    throw new Error("server returned 402 without a PAYMENT-REQUIRED header");
  }

  const required = decodePaymentRequiredHeader(header);

  // Only the Gateway-batched option is payable from a Gateway balance. Any
  // other entry would need USDC sitting in the wallet and a separate on-chain
  // transfer per call, which is the cost model this whole approach avoids.
  const terms = required.accepts.find(
    (option) =>
      (option.extra as { name?: string } | undefined)?.name ===
      "GatewayWalletBatched",
  );

  if (!terms) {
    throw new Error(
      `server offers no Gateway-batched payment option (got: ${required.accepts
        .map((o) => o.scheme + "/" + o.network)
        .join(", ")})`,
    );
  }

  // Enforce limits BEFORE a signature exists. After this point the money is
  // committed and no check can undo it.
  const amount = budget.authorize(terms as unknown as PaymentTerms);
  log(`price ${usd(amount)} on ${terms.network} -> ${terms.payTo}: within budget`);

  const scheme = new BatchEvmScheme(account as never);
  const created = await scheme.createPaymentPayload(
    required.x402Version,
    terms as never,
  );

  // createPaymentPayload returns only { x402Version, payload }. The verifier
  // also needs `accepted` — the exact requirements this signature was made
  // against — otherwise it cannot tell which of the offered options the buyer
  // agreed to, and rejects with "Missing accepted requirements in payment".
  const signed = {
    ...created,
    accepted: terms,
    ...(required.resource ? { resource: required.resource } : {}),
  };

  const second = await fetch(url, {
    method,
    headers: {
      ...headers,
      "Payment-Signature": encodePaymentSignatureHeader(signed as never),
    },
    body: options.body,
  });

  const body = Buffer.from(await second.arrayBuffer());

  if (second.ok) budget.commit(amount);

  const paymentNonce = (created.payload as { authorization?: { nonce?: Hex } }).authorization?.nonce;
  const settlement = readSettlement(second.headers.get("payment-response"));

  return {
    response: second,
    body,
    paid: second.ok,
    amount,
    terms: terms as unknown as PaymentTerms,
    ...(paymentNonce ? { paymentNonce } : {}),
    ...(settlement ? { settlement } : {}),
  };
}

/** Pull the facilitator's settlement reference out of PAYMENT-RESPONSE. */
function readSettlement(header: string | null): string | undefined {
  if (!header) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { transaction?: unknown };
    return typeof parsed.transaction === "string" && parsed.transaction ? parsed.transaction : undefined;
  } catch {
    return undefined;
  }
}
