/**
 * Express middleware that records an on-chain receipt for a served request.
 *
 * Sits *after* a payment middleware, not instead of one:
 *
 *   app.post("/optimize",
 *     gateway.require("$0.02"),     // Circle's SDK: takes the money
 *     withReceipt({ writer }),      // this: proves what was handed back
 *     handler);
 *
 * The response is held until the receipt is mined, so the tx hash can travel
 * back in the headers and the buyer can verify before it does anything with
 * the bytes. That is only reasonable because Arc finalises in under a second —
 * on a chain with twelve-second blocks you could not block an HTTP response on
 * a write, and this design would not exist.
 */

import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { digest, deriveRequestId, toUint64Size, type Bytes } from "./digest.ts";
import { PAYMENT_HEADER, readPaymentAuthorization, requestIdForPayment } from "./payment.ts";
import type { ReceiptWriter } from "./receipt.ts";
import type { BatchAnchor } from "./batch.ts";
import { findAnchorProof } from "./recover.ts";
import type { Address, Hex } from "viem";

/** Headers the buyer reads to verify the exchange. */
export const RECEIPT_HEADERS = {
  requestId: "x-aernyth-request-id",
  input: "x-aernyth-input",
  output: "x-aernyth-output",
  tx: "x-aernyth-tx",
  registry: "x-aernyth-registry",
  provider: "x-aernyth-provider",
  /**
   * The payment nonce the request id was derived from. Present only when the
   * receipt is bound to a payment; the buyer already holds this value, so it
   * is a convenience, never a source of trust.
   */
  paymentNonce: "x-aernyth-payment-nonce",
  /** Batched mode: the provider's EIP-712 signature over the receipt. */
  signature: "x-aernyth-signature",
  /** Batched mode: the payer the receipt names, needed to rebuild it. */
  payer: "x-aernyth-payer",
  /** Batched mode: where the Merkle proof can be fetched once the batch commits. */
  proof: "x-aernyth-proof",
  error: "x-aernyth-error",
} as const;

export interface WithReceiptOptions {
  /**
   * Immediate mode: one transaction per receipt, and the response is held
   * until it is mined so the tx hash travels with the bytes.
   */
  writer?: ReceiptWriter;
  /**
   * Batched mode: the receipt is signed and the response goes out at once;
   * the receipt is anchored with others a moment later. Pass exactly one of
   * `writer` or `anchor`.
   */
  anchor?: BatchAnchor;
  /** Batched mode: the path a buyer fetches its proof from. Defaults to /receipts/<requestId>. */
  proofPath?: (requestId: Hex) => string;
  /**
   * Bytes to treat as the request input. Defaults to `req.body` when it is a
   * Buffer, which is what `express.raw()` produces.
   */
  getInput?: (req: Request) => Bytes;
  /**
   * Who to record as having paid. Defaults to the payer the payment
   * middleware verified.
   *
   * Override it for routes that are served without a payment — a sponsored
   * free trial, say. The receipt stays exactly as real and as checkable; it
   * just names whoever actually footed the bill, which on a sponsored request
   * is the provider. Recording a zero address instead would produce something
   * that looks like evidence and establishes nothing.
   */
  payer?: Address | ((req: Request) => Address | undefined);
  /**
   * Fail the request when the receipt cannot be written.
   *
   * Defaults to false, and the default is the uncomfortable choice. The buyer
   * has already paid by the time the handler runs, so refusing to hand over
   * the result costs them money and gives them nothing. Delivering it with
   * `x-aernyth-error` set at least leaves them with the goods and an honest
   * signal that this particular exchange is unproven. Set true when an
   * unprovable delivery is worse than no delivery.
   */
  strict?: boolean;
  onError?: (error: unknown) => void;
}

export function withReceipt(options: WithReceiptOptions): RequestHandler {
  const { writer, anchor, strict = false } = options;
  if (Boolean(writer) === Boolean(anchor)) {
    throw new Error("aernyth: withReceipt() takes exactly one of `writer` (immediate) or `anchor` (batched)");
  }
  const registry = anchor ? anchor.registry : writer!.registry;
  const providerAddress = anchor ? anchor.providerAddress : writer!.providerAddress;
  const proofPath = options.proofPath ?? ((requestId: Hex) => `/receipts/${requestId}`);
  const getInput = options.getInput ?? defaultGetInput;

  return function receiptMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const sponsored = options.payer !== undefined;
    const payer =
      typeof options.payer === "function"
        ? options.payer(req)
        : (options.payer ?? readPayer(req));

    if (!payer) {
      // No payment context means this middleware is mounted in the wrong
      // place. Saying so beats emitting receipts with a zero payer, which
      // would look valid and prove nothing.
      next(
        new Error(
          "aernyth: no verified payment on the request. Mount withReceipt() after gateway.require(), or pass `payer` for a sponsored route.",
        ),
      );
      return;
    }

    let input: Bytes;
    try {
      input = getInput(req);
    } catch (error) {
      next(error);
      return;
    }

    const inputHash = digest(input);

    // A paid request's id comes from the payment itself, so the receipt can be
    // matched to the purchase that caused it. A sponsored request has no
    // payment to bind to and keeps a random nonce.
    let requestId: Hex;
    const authorization = sponsored ? undefined : readPaymentAuthorization(req.headers[PAYMENT_HEADER]);

    if (authorization && authorization.from.toLowerCase() === payer.toLowerCase()) {
      requestId = requestIdForPayment({ payer, paymentNonce: authorization.nonce, inputHash });
      res.setHeader(RECEIPT_HEADERS.paymentNonce, authorization.nonce);
    } else {
      requestId = deriveRequestId({ payer, nonce: randomNonce(), inputHash });
      if (!sponsored) {
        // The money has already moved by now, so refusing to serve would only
        // punish the buyer for a format this code failed to read. Serve, leave
        // the receipt unbound — the missing payment-nonce header says so, and a
        // buyer that checks the binding will see it fail — and tell the
        // operator, because this means the payment SDK changed underneath us.
        options.onError?.(
          new Error(
            authorization
              ? `aernyth: payment signed by ${authorization.from} but verified for ${payer}; receipt left unbound`
              : "aernyth: could not read the payment authorization; receipt left unbound",
          ),
        );
      }
    }

    res.setHeader(RECEIPT_HEADERS.requestId, requestId);
    res.setHeader(RECEIPT_HEADERS.input, inputHash);
    res.setHeader(RECEIPT_HEADERS.registry, registry);
    res.setHeader(RECEIPT_HEADERS.provider, providerAddress);

    const send = res.send.bind(res);
    let intercepted = false;

    res.send = function patchedSend(body?: unknown): Response {
      // Express's res.json() delegates to res.send(); guard against the
      // re-entry that would otherwise record the same response twice.
      if (intercepted) return send(body as never);
      intercepted = true;

      // Errors are not deliveries. Recording a receipt for a 500 would attest
      // that the buyer received something they did not.
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return send(body as never);
      }

      const output = toBytes(body);
      const outputHash = digest(output);
      res.setHeader(RECEIPT_HEADERS.output, outputHash);

      const receipt = {
        requestId,
        payer,
        inputHash,
        outputHash,
        bytesIn: toUint64Size(input.byteLength),
        bytesOut: toUint64Size(output.byteLength),
      };

      // Batched: wait only for the signature, which takes milliseconds, and
      // let the chain catch up afterwards. Immediate: wait for the block.
      const recorded: Promise<void> = anchor
        ? anchor.add(receipt).then((signed) => {
            res.setHeader(RECEIPT_HEADERS.signature, signed.signature);
            res.setHeader(RECEIPT_HEADERS.payer, payer);
            res.setHeader(RECEIPT_HEADERS.proof, proofPath(requestId));
          })
        : writer!.record(receipt).then((txHash) => {
            res.setHeader(RECEIPT_HEADERS.tx, txHash);
          });

      void recorded
        .catch((error: unknown) => {
          options.onError?.(error);
          if (strict) {
            res.statusCode = 502;
            return;
          }
          // Always a non-empty reason. An empty header reads to the caller
          // exactly like no header at all, which is the difference between
          // "the provider says it could not record this" and "something ate
          // the headers in transit" — two problems with different fixes.
          const reason =
            (error instanceof Error ? error.message : String(error)).trim() ||
            "the receipt write failed without a message";
          res.setHeader(RECEIPT_HEADERS.error, reason.slice(0, 200));
        })
        .finally(() => {
          if (strict && res.statusCode === 502) {
            send({ error: "aernyth: receipt could not be recorded" } as never);
          } else {
            send(body as never);
          }
        });

      return res;
    } as Response["send"];

    next();
  };
}

/**
 * Serves batched proofs: GET <proofPath> → 200 anchored with its proof, 202
 * while the batch is still open, 200 with status "failed" when the commit
 * failed (the buyer should then anchor its signed receipt itself), 404 when
 * this provider has no memory of the id.
 *
 * Memory does not survive a restart, but the chain does. A buyer that adds
 * `?leaf=0x…` gets its proof rebuilt from the leaves published in the
 * provider's recent commits, about the last forty minutes of blocks, when the
 * id is no longer in memory.
 */
export function receiptProofs(anchor: BatchAnchor, options: { lookbackBlocks?: bigint } = {}): RequestHandler {
  return async (req, res) => {
    const id = String(req.params.requestId ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
      res.status(400).json({ error: "request id must be 0x followed by 64 hex digits" });
      return;
    }
    const known = anchor.lookup(id as Hex);
    if (known) {
      res.status(known.status === "pending" ? 202 : 200).json(known);
      return;
    }
    const leaf = typeof req.query?.leaf === "string" ? req.query.leaf : undefined;
    if (!leaf || !/^0x[0-9a-fA-F]{64}$/.test(leaf)) {
      res.status(404).json({ status: "unknown" });
      return;
    }
    try {
      const proof = await findAnchorProof({
        network: anchor.network,
        registry: anchor.registry,
        expectedProvider: anchor.providerAddress,
        leaf: leaf as Hex,
        maxBlocks: options.lookbackBlocks ?? 4_999n,
      });
      if (proof) res.json({ status: "anchored", proof, recovered: "from the commit's calldata" });
      else res.status(404).json({ status: "unknown" });
    } catch (error) {
      res.status(502).json({ status: "unknown", error: error instanceof Error ? error.message : String(error) });
    }
  };
}

function defaultGetInput(req: Request): Bytes {
  if (Buffer.isBuffer(req.body)) return req.body;
  throw new Error(
    "aernyth: req.body is not a Buffer. Mount express.raw() on this route, or pass getInput().",
  );
}

function readPayer(req: Request): Address | undefined {
  const payment = (req as Request & { payment?: { verified?: boolean; payer?: string } })
    .payment;
  if (!payment?.verified) return undefined;
  const payer = payment.payer;
  return payer && /^0x[0-9a-fA-F]{40}$/.test(payer) ? (payer as Address) : undefined;
}

function toBytes(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  // Matches what Express itself would serialise, so the digest covers exactly
  // the bytes that go over the wire.
  return Buffer.from(JSON.stringify(body) ?? "", "utf8");
}

function randomNonce(): bigint {
  return BigInt(`0x${randomBytes(16).toString("hex")}`);
}

export type { Hex };
