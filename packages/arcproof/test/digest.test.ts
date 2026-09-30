import { test } from "node:test";
import assert from "node:assert/strict";
import { digest, deriveRequestId, toUint64Size } from "../src/digest.ts";

// Known-answer test. If this ever drifts, the hashing library changed under us
// and every receipt already on-chain becomes unverifiable — so pin it.
const KECCAK_EMPTY =
  "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

test("digest matches the canonical keccak256 of empty input", () => {
  assert.equal(digest(new Uint8Array()), KECCAK_EMPTY);
});

test("digest agrees across Buffer and Uint8Array views of the same bytes", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  assert.equal(digest(bytes), digest(Buffer.from(bytes)));
});

test("digest of a pooled Buffer slice covers only that slice", () => {
  // Buffer.from(...).subarray() is a view into a larger pooled ArrayBuffer.
  // Hashing the backing buffer instead of the view would silently produce the
  // wrong digest for every small request body.
  const pooled = Buffer.from([9, 9, 1, 2, 3, 9, 9]).subarray(2, 5);
  assert.equal(digest(pooled), digest(new Uint8Array([1, 2, 3])));
});

test("digest changes when a single byte changes", () => {
  assert.notEqual(digest(new Uint8Array([1])), digest(new Uint8Array([2])));
});

const PAYER = "0x1111111111111111111111111111111111111111" as const;

test("requestId is deterministic for identical inputs", () => {
  const inputHash = digest(new Uint8Array([7]));
  const a = deriveRequestId({ payer: PAYER, nonce: 1n, inputHash });
  const b = deriveRequestId({ payer: PAYER, nonce: 1n, inputHash });
  assert.equal(a, b);
});

test("requestId is bound to the input digest", () => {
  // A provider must not be able to reuse one id across two different inputs.
  const a = deriveRequestId({
    payer: PAYER,
    nonce: 1n,
    inputHash: digest(new Uint8Array([7])),
  });
  const b = deriveRequestId({
    payer: PAYER,
    nonce: 1n,
    inputHash: digest(new Uint8Array([8])),
  });
  assert.notEqual(a, b);
});

test("requestId separates repeat submissions of the same file", () => {
  const inputHash = digest(new Uint8Array([7]));
  const first = deriveRequestId({ payer: PAYER, nonce: 1n, inputHash });
  const second = deriveRequestId({ payer: PAYER, nonce: 2n, inputHash });
  assert.notEqual(first, second);
});

test("toUint64Size rejects values that would truncate", () => {
  assert.equal(toUint64Size(0), 0n);
  assert.equal(toUint64Size(40 * 1024 * 1024), 41_943_040n);
  assert.throws(() => toUint64Size(-1), /Invalid byte length/);
  assert.throws(() => toUint64Size(1.5), /Invalid byte length/);
});
