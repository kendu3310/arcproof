/**
 * Tests for the published verification page.
 *
 * The page does its hashing with js-sha3 loaded from a CDN, while everything
 * else in this repository uses viem. If those two ever disagree the page would
 * tell every honest visitor their file does not match — a failure that looks
 * like the provider cheating rather than like a library swap. So the agreement
 * is pinned here rather than assumed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256, toHex } from "viem";
import sha3 from "js-sha3";

const root = resolve(import.meta.dirname, "..");
const page = readFileSync(resolve(root, "docs/index.html"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(root, "docs/receipts.json"), "utf8"));
const solidity = readFileSync(resolve(root, "contracts/src/ReceiptRegistry.sol"), "utf8");

/** The topic0 of the Receipt event as actually emitted on Arc mainnet. */
const ON_CHAIN_TOPIC0 =
  "0x55ecbf478ef3d3d706ad808d83ad90b05feb572643e193e0232d3a33b4354c5d";

test("the page's hash function agrees with viem", () => {
  const cases = [
    new Uint8Array(),
    new TextEncoder().encode("abc"),
    new Uint8Array([0, 1, 2, 3, 255]),
  ];
  for (const bytes of cases) {
    assert.equal("0x" + sha3.keccak256(bytes), keccak256(bytes));
  }
});

test("the page's event signature matches what the contract emits", () => {
  const signature = page.match(/const EVENT_SIG = "([^"]+)"/)?.[1];
  assert.ok(signature, "EVENT_SIG not found in docs/index.html");

  // Derived, not copied: if the Solidity event ever gains or reorders a field,
  // the page stops finding its own logs and this fails before anyone ships it.
  assert.equal(keccak256(toHex(signature)), ON_CHAIN_TOPIC0);
});

test("the contract still declares the event the page looks for", () => {
  for (const field of ["requestId", "provider", "payer", "inputHash", "outputHash"]) {
    assert.ok(solidity.includes(field), `ReceiptRegistry.sol no longer mentions ${field}`);
  }
});

test("the manifest points at the deployed mainnet registry", () => {
  assert.equal(manifest.network.chainId, 5042);
  assert.match(manifest.registry.address, /^0x[0-9a-f]{40}$/);
  assert.ok(manifest.receipts.length > 0, "no receipts listed");
  for (const entry of manifest.receipts) {
    assert.match(entry.txHash, /^0x[0-9a-f]{64}$/);
  }
});

test("the published fixture hashes to the digest recorded on chain", () => {
  // Ties the committed sample file to the receipt the page shows. If the
  // fixture is ever regenerated and changes by a byte, the page would call it
  // a mismatch, and this says so first.
  const fixture = readFileSync(resolve(root, "examples/glb-service/fixtures/sample.glb"));
  assert.equal(
    keccak256(fixture),
    "0x69fa9f4d1fbb7bcf2dee0607ed1653043c9ffe8577b394d3209837aa7ad3e46a",
  );
});
