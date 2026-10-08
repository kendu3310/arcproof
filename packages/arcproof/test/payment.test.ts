import { test } from "node:test";
import assert from "node:assert/strict";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Request, Response } from "express";
import type { Hex } from "viem";

import { digest } from "../src/digest.ts";
import { readPaymentAuthorization, requestIdForPayment } from "../src/payment.ts";
import { withReceipt, RECEIPT_HEADERS } from "../src/withReceipt.ts";
import type { ReceiptData, ReceiptWriter } from "../src/receipt.ts";

/**
 * The headers in these tests are signed by Circle's own client, not built by
 * hand. A hand-built header would only prove this code agrees with my reading
 * of the format; the real one fails these tests the day the SDK changes it.
 */
const TERMS = {
  scheme: "exact",
  network: "eip155:5042",
  amount: "20000",
  asset: "0x3600000000000000000000000000000000000000",
  payTo: "0x09311F49F9C8473E1AAA8165F4FD84780912bdDc",
  maxTimeoutSeconds: 60,
  extra: {
    name: "GatewayWalletBatched",
    version: "1",
    verifyingContract: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
  },
};

async function signedPayment() {
  const account = privateKeyToAccount(generatePrivateKey());
  const created = await new BatchEvmScheme(account as never).createPaymentPayload(2, TERMS as never);
  const nonce = (created.payload as { authorization: { nonce: Hex } }).authorization.nonce;
  const header = encodePaymentSignatureHeader({ ...created, accepted: TERMS } as never);
  return { payer: account.address, nonce, header };
}

/* ------------------------------------------------------------------ reading */

test("reads the payer and nonce out of a header the real SDK signed", async () => {
  const { payer, nonce, header } = await signedPayment();
  const authorization = readPaymentAuthorization(header);
  assert.ok(authorization);
  assert.equal(authorization.from.toLowerCase(), payer.toLowerCase());
  assert.equal(authorization.nonce, nonce.toLowerCase());
});

test("returns nothing for headers it cannot read, rather than throwing", () => {
  for (const bad of [undefined, "", "not base64 json", Buffer.from("{}").toString("base64"),
    Buffer.from(JSON.stringify({ payload: { authorization: { from: "0x12", nonce: "0x34" } } })).toString("base64")]) {
    assert.equal(readPaymentAuthorization(bad), undefined, `accepted ${String(bad)}`);
  }
});

test("two payments for the same file by the same buyer get different request ids", async () => {
  // The nonce is what keeps a repeat purchase from colliding with the first
  // one — the registry refuses a second receipt under an id it has seen.
  const first = await signedPayment();
  const inputHash = digest(new Uint8Array([1, 2, 3]));
  const a = requestIdForPayment({ payer: first.payer, paymentNonce: first.nonce, inputHash });
  const second = await signedPayment();
  const b = requestIdForPayment({ payer: first.payer, paymentNonce: second.nonce, inputHash });
  assert.notEqual(a, b);
});

/* ------------------------------------------------------------- middleware */

interface Served {
  recorded: ReceiptData | undefined;
  headers: Record<string, string>;
  errors: Error[];
}

/** Run withReceipt over one request, the way Express would, with a fake chain. */
async function serve(req: Partial<Request>, options: { payer?: `0x${string}` } = {}): Promise<Served> {
  const served: Served = { recorded: undefined, headers: {}, errors: [] };

  const writer = {
    registry: "0xac9e5859d9d85e7cd37dd852ed299edefbd6aece",
    providerAddress: "0x48A93E9e4D2B7bC7Cd585c5c2493770265410EaD",
    record: async (data: ReceiptData) => {
      served.recorded = data;
      return `0x${"ab".repeat(32)}` as Hex;
    },
  } as unknown as ReceiptWriter;

  const middleware = withReceipt({
    writer,
    ...(options.payer ? { payer: options.payer } : {}),
    onError: (error) => served.errors.push(error as Error),
  });

  await new Promise<void>((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string) { served.headers[name] = value; },
      send() { resolve(); return res; },
    } as unknown as Response;

    middleware({ headers: {}, body: Buffer.from("model bytes"), ...req } as Request, res, (error?: unknown) => {
      if (error) return reject(error);
      // the handler
      res.send(Buffer.from("optimised bytes"));
    });
  });

  return served;
}

test("a paid receipt carries the request id the buyer can derive from its own payment", async () => {
  const { payer, nonce, header } = await signedPayment();
  const served = await serve({
    headers: { "payment-signature": header },
    payment: { verified: true, payer },
  } as never);

  const expected = requestIdForPayment({
    payer,
    paymentNonce: nonce,
    inputHash: digest(Buffer.from("model bytes")),
  });
  assert.equal(served.recorded?.requestId, expected);
  assert.equal(served.headers[RECEIPT_HEADERS.paymentNonce], nonce.toLowerCase());
  assert.deepEqual(served.errors, []);
});

test("a payment signed by someone other than the verified payer is not bound to", async () => {
  // Binding to it would write a receipt that claims one buyer's payment paid
  // for another buyer's request.
  const signed = await signedPayment();
  const other = privateKeyToAccount(generatePrivateKey()).address;
  const served = await serve({
    headers: { "payment-signature": signed.header },
    payment: { verified: true, payer: other },
  } as never);

  assert.notEqual(
    served.recorded?.requestId,
    requestIdForPayment({ payer: other, paymentNonce: signed.nonce, inputHash: digest(Buffer.from("model bytes")) }),
  );
  assert.equal(served.headers[RECEIPT_HEADERS.paymentNonce], undefined);
  assert.match(served.errors[0]?.message ?? "", /left unbound/);
});

test("an unreadable payment still gets served, unbound, and the operator is told", async () => {
  // The buyer has paid by now. Withholding the goods over a header format
  // would cost them money for this code's failure to read it.
  const payer = privateKeyToAccount(generatePrivateKey()).address;
  const served = await serve({
    headers: { "payment-signature": "garbage" },
    payment: { verified: true, payer },
  } as never);

  assert.ok(served.recorded, "the delivery still got a receipt");
  assert.equal(served.headers[RECEIPT_HEADERS.paymentNonce], undefined);
  assert.match(served.errors[0]?.message ?? "", /could not read the payment authorization/);
});

test("a sponsored request is never bound, and that is not reported as a fault", async () => {
  const sponsor = "0x48A93E9e4D2B7bC7Cd585c5c2493770265410EaD";
  const served = await serve({}, { payer: sponsor });

  assert.ok(served.recorded);
  assert.equal(served.recorded.payer, sponsor);
  assert.equal(served.headers[RECEIPT_HEADERS.paymentNonce], undefined);
  assert.deepEqual(served.errors, []);
});
