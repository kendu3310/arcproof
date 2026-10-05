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
import type { ReceiptWriter } from "./receipt.ts";
import type { Address, Hex } from "viem";

/** Headers the buyer reads to verify the exchange. */
export const RECEIPT_HEADERS = {
  requestId: "x-arcproof-request-id",
  input: "x-arcproof-input",
  output: "x-arcproof-output",
  tx: "x-arcproof-tx",
  registry: "x-arcproof-registry",
  provider: "x-arcproof-provider",
  error: "x-arcproof-error",
} as const;

export interface WithReceiptOptions {
  writer: ReceiptWriter;
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
   * `x-arcproof-error` set at least leaves them with the goods and an honest
   * signal that this particular exchange is unproven. Set true when an
   * unprovable delivery is worse than no delivery.
   */
  strict?: boolean;
  onError?: (error: unknown) => void;
}

export function withReceipt(options: WithReceiptOptions): RequestHandler {
  const { writer, strict = false } = options;
  const getInput = options.getInput ?? defaultGetInput;

  return function receiptMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
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
          "arcproof: no verified payment on the request. Mount withReceipt() after gateway.require(), or pass `payer` for a sponsored route.",
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
    const requestId = deriveRequestId({ payer, nonce: randomNonce(), inputHash });

    res.setHeader(RECEIPT_HEADERS.requestId, requestId);
    res.setHeader(RECEIPT_HEADERS.input, inputHash);
    res.setHeader(RECEIPT_HEADERS.registry, writer.registry);
    res.setHeader(RECEIPT_HEADERS.provider, writer.providerAddress);

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

      void writer
        .record({
          requestId,
          payer,
          inputHash,
          outputHash,
          bytesIn: toUint64Size(input.byteLength),
          bytesOut: toUint64Size(output.byteLength),
        })
        .then((txHash) => {
          res.setHeader(RECEIPT_HEADERS.tx, txHash);
        })
        .catch((error: unknown) => {
          options.onError?.(error);
          if (strict) {
            res.statusCode = 502;
            return;
          }
          res.setHeader(
            RECEIPT_HEADERS.error,
            String(error instanceof Error ? error.message : error).slice(0, 200),
          );
        })
        .finally(() => {
          if (strict && res.statusCode === 502) {
            send({ error: "arcproof: receipt could not be recorded" } as never);
          } else {
            send(body as never);
          }
        });

      return res;
    } as Response["send"];

    next();
  };
}

function defaultGetInput(req: Request): Bytes {
  if (Buffer.isBuffer(req.body)) return req.body;
  throw new Error(
    "arcproof: req.body is not a Buffer. Mount express.raw() on this route, or pass getInput().",
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
