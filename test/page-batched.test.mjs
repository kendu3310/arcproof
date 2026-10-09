/**
 * The page checks batched receipts with its own hand-written EIP-712 hashing
 * (docs/batched.js), deliberately sharing no code with the package. That is
 * only worth anything if the two agree exactly, so this runs the page's file
 * — the real one, with the real js-sha3 build the page loads — beside the
 * package and compares every value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  receiptDomain,
  receiptStructHash,
  receiptLeaf,
  receiptDigest,
  signReceipt,
} from "../packages/aernyth/src/signed.ts";
import { buildTree, proofFor } from "../packages/aernyth/src/merkle.ts";
import { digest } from "../packages/aernyth/src/digest.ts";

const SHA3 = "https://cdnjs.cloudflare.com/ajax/libs/js-sha3/0.9.3/sha3.min.js";
const CHAIN = 5042;
const REGISTRY = "0x54d6e7effde253f99c944b5a6f4421b590a80d74";

let page;
test.before(async () => {
  // Load js-sha3 exactly as the browser does: a window, no module system.
  const source = await fetch(SHA3, { signal: AbortSignal.timeout(30_000) })
    .then((r) => r.text())
    .catch(() => undefined);
  if (!source) return;
  const win = {};
  const box = { window: win, self: win };
  box.globalThis = box;
  createContext(box);
  runInContext(source, box);
  globalThis.keccak256 = win.keccak256;
  page = await import("../docs/batched.js");
});

const hex32 = () => `0x${randomBytes(32).toString("hex")}`;
const receiptFor = (payer) => ({
  requestId: hex32(),
  payer,
  inputHash: hex32(),
  outputHash: hex32(),
  bytesIn: BigInt(randomBytes(4).readUInt32BE()),
  bytesOut: BigInt(randomBytes(3).readUIntBE(0, 3)),
});

test("the page and the package agree on struct hash, leaf and signing digest", (t) => {
  if (!page) return t.skip("js-sha3 unreachable");
  const domain = receiptDomain(CHAIN, REGISTRY);
  for (let i = 0; i < 25; i++) {
    const r = receiptFor(privateKeyToAccount(generatePrivateKey()).address);
    assert.equal(page.structHash(r), receiptStructHash(r));
    assert.equal(page.leafOf(r), receiptLeaf(r));
    assert.equal(page.digestOf(CHAIN, REGISTRY, r), receiptDigest(domain, r));
  }
});

test("the page recovers the provider from a signature the package made, from the buyer's own bytes", async (t) => {
  if (!page) return t.skip("js-sha3 unreachable");
  const provider = privateKeyToAccount(generatePrivateKey());
  const input = randomBytes(5000);
  const output = randomBytes(700);
  const requestId = hex32();
  const payer = provider.address;
  const receipt = { requestId, payer, inputHash: digest(input), outputHash: digest(output), bytesIn: 5000n, bytesOut: 700n };
  const signature = await signReceipt(provider, receiptDomain(CHAIN, REGISTRY), receipt);

  const base = { chainId: CHAIN, registry: REGISTRY, provider: provider.address, requestId, payer, input, output, signature };
  const good = page.checkSignature(base);
  assert.ok(good.ok, good.reason);
  assert.equal(good.leaf, receiptLeaf(receipt));

  const flipped = Buffer.from(output);
  flipped[0] ^= 1;
  assert.equal(page.checkSignature({ ...base, output: flipped }).ok, false, "one changed byte");
  assert.equal(page.checkSignature({ ...base, provider: privateKeyToAccount(generatePrivateKey()).address }).ok, false, "someone else's key");
  assert.equal(page.checkSignature({ ...base, chainId: 5042002 }).ok, false, "signed for another chain");
  assert.equal(page.checkSignature({ ...base, signature: "0x1234" }).ok, false, "malformed");
});

test("the page accepts the package's Merkle proofs and nothing else", (t) => {
  if (!page) return t.skip("js-sha3 unreachable");
  for (const size of [1, 2, 3, 7, 20, 256]) {
    const leaves = Array.from({ length: size }, hex32);
    const tree = buildTree(leaves);
    for (const i of [0, size - 1, Math.floor(size / 2)]) {
      assert.ok(page.verifyMerkle(leaves[i], proofFor(tree, i), tree.root), `size ${size} leaf ${i}`);
      if (size > 1) assert.equal(page.verifyMerkle(hex32(), proofFor(tree, i), tree.root), false);
    }
  }
});

test("the page reads a Batch log only from the pinned registry and the right provider", async (t) => {
  if (!page) return t.skip("js-sha3 unreachable");
  const provider = privateKeyToAccount(generatePrivateKey()).address;
  const leaves = Array.from({ length: 5 }, hex32);
  const tree = buildTree(leaves);
  const topic0 = "0x" + globalThis.keccak256("Batch(bytes32,address,uint32,uint64)");
  const pad = (v) => v.toString(16).padStart(64, "0");
  const log = (address, by) => ({
    address,
    topics: [topic0, tree.root, "0x" + by.slice(2).toLowerCase().padStart(64, "0")],
    data: "0x" + pad(5n) + pad(1791500000n),
  });
  const rpcWith = (logs) => async () => ({ status: "0x1", logs });
  const proof = { registry: REGISTRY, txHash: hex32(), root: tree.root, index: 3, count: 5, proof: proofFor(tree, 3) };
  const args = { registry: REGISTRY, provider, leaf: leaves[3], proof };

  const good = await page.checkAnchor({ ...args, rpc: rpcWith([log(REGISTRY, provider)]) });
  assert.ok(good.ok, good.reason);
  assert.equal(good.count, 5);

  const elsewhere = await page.checkAnchor({ ...args, rpc: rpcWith([log("0x0000000000000000000000000000000000000001", provider)]) });
  assert.equal(elsewhere.ok, false, "same event from another contract");
  const impostor = await page.checkAnchor({ ...args, rpc: rpcWith([log(REGISTRY, privateKeyToAccount(generatePrivateKey()).address)]) });
  assert.equal(impostor.ok, false, "committed by someone else");
  const wrongLeaf = await page.checkAnchor({ ...args, leaf: leaves[2], rpc: rpcWith([log(REGISTRY, provider)]) });
  assert.equal(wrongLeaf.ok, false, "another receipt's proof");
});

test("the page reads a commit's published leaves and rebuilds its root exactly as the package does", async (t) => {
  if (!page) return t.skip("js-sha3 could not be fetched");
  const { encodeFunctionData } = await import("viem");
  const { batchRegistryAbi } = await import("../packages/aernyth/src/batch.ts");
  const { decodeCommit, encodeLeaves } = await import("../packages/aernyth/src/recover.ts");
  for (const size of [1, 2, 3, 7, 20, 256]) {
    const leaves = Array.from({ length: size }, () => `0x${randomBytes(32).toString("hex")}`);
    const tree = buildTree(leaves);
    const input = encodeFunctionData({ abi: batchRegistryAbi, functionName: "commit", args: [tree.root, size] }) + encodeLeaves(leaves).slice(2);
    const ours = page.decodeCommit(input);
    assert.deepEqual(ours, decodeCommit(input), `size ${size}`);
    assert.equal(page.merkleRoot(ours.leaves), tree.root, `size ${size}`);
  }
  const rootOnly = encodeFunctionData({ abi: batchRegistryAbi, functionName: "commit", args: [`0x${"ab".repeat(32)}`, 3] });
  assert.equal(page.decodeCommit(rootOnly).leaves, undefined);
});
