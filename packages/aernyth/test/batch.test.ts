import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Request, Response } from "express";
import type { Address, Hex } from "viem";

import { buildTree, proofFor, verifyProof } from "../src/merkle.ts";
import { receiptDomain, receiptLeaf, recoverReceiptSigner, signReceipt } from "../src/signed.ts";
import { BatchAnchor } from "../src/batch.ts";
import { verifySignedReceipt } from "../src/verifyBatch.ts";
import { withReceipt, receiptProofs, RECEIPT_HEADERS } from "../src/withReceipt.ts";
import { arcTestnet } from "../src/networks.ts";
import { digest } from "../src/digest.ts";
import type { ContractCall, ReceiptData, ReceiptWriter } from "../src/receipt.ts";

const REGISTRY = "0xb0f2c2454e8cc3d3e69250e6cebe50c568f1f837" as Address;
const rand32 = (): Hex => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
const receiptOf = (payer: Address): ReceiptData => ({
  requestId: rand32(),
  payer,
  inputHash: rand32(),
  outputHash: rand32(),
  bytesIn: 1000n,
  bytesOut: 100n,
});

/** A writer that signs for real and records commits instead of sending them. */
function fakeWriter(behaviour: { fail?: boolean; hang?: boolean } = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const commits: ContractCall[] = [];
  const writer = {
    network: arcTestnet,
    providerAddress: account.address,
    registry: REGISTRY,
    signReceipt: (domain: never, receipt: ReceiptData) => signReceipt(account, domain, receipt),
    send: async (call: ContractCall) => {
      commits.push(call);
      if (behaviour.hang) return new Promise<Hex>(() => undefined);
      if (behaviour.fail) throw new Error("rpc refused the commit");
      return `0x${String(commits.length).padStart(64, "0")}` as Hex;
    },
  } as unknown as ReceiptWriter;
  return { writer, commits, account };
}

/* ----------------------------------------------------------------- merkle */

test("every leaf's proof reaches the root, for every tree size up to 33 and at 256", () => {
  for (const size of [...Array.from({ length: 33 }, (_, i) => i + 1), 256]) {
    const leaves = Array.from({ length: size }, rand32);
    const tree = buildTree(leaves);
    leaves.forEach((leaf, i) => {
      assert.ok(verifyProof(leaf, proofFor(tree, i), tree.root), `size ${size}, leaf ${i}`);
    });
  }
});

test("a proof does not carry a different leaf, or reach a different root", () => {
  const leaves = Array.from({ length: 9 }, rand32);
  const tree = buildTree(leaves);
  const proof = proofFor(tree, 4);
  assert.equal(verifyProof(rand32(), proof, tree.root), false);
  assert.equal(verifyProof(leaves[4]!, proof, buildTree(Array.from({ length: 9 }, rand32)).root), false);
  assert.equal(verifyProof(leaves[5]!, proof, tree.root), false);
});

/* -------------------------------------------------------------- signatures */

test("a signed receipt recovers to its signer, and to someone else once any field changes", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const domain = receiptDomain(arcTestnet.chainId, REGISTRY);
  const receipt = receiptOf(account.address);
  const signature = await signReceipt(account, domain, receipt);

  assert.equal(await recoverReceiptSigner(domain, receipt, signature), account.address);
  for (const field of ["requestId", "inputHash", "outputHash"] as const) {
    const changed = { ...receipt, [field]: rand32() };
    assert.notEqual(await recoverReceiptSigner(domain, changed, signature), account.address, field);
  }
  assert.notEqual(await recoverReceiptSigner(domain, { ...receipt, bytesOut: 101n }, signature), account.address);
});

test("a receipt signed for testnet does not verify as mainnet, or against another registry", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const receipt = receiptOf(account.address);
  const signature = await signReceipt(account, receiptDomain(arcTestnet.chainId, REGISTRY), receipt);
  assert.notEqual(await recoverReceiptSigner(receiptDomain(5042, REGISTRY), receipt, signature), account.address);
  assert.notEqual(
    await recoverReceiptSigner(receiptDomain(arcTestnet.chainId, "0x0000000000000000000000000000000000000001"), receipt, signature),
    account.address,
  );
});

/* ------------------------------------------------------------ the batcher */

test("a full batch commits at once, and every receipt's proof reaches the committed root", async () => {
  const { writer, commits } = fakeWriter();
  const anchor = new BatchAnchor({ writer, registry: REGISTRY, maxBatch: 4, maxWaitMs: 60_000 });
  const signed = await Promise.all(Array.from({ length: 4 }, () => anchor.add(receiptOf(writer.providerAddress))));
  const proofs = await Promise.all(signed.map((s) => s.anchored));

  assert.equal(commits.length, 1);
  const [root, count] = commits[0]!.args as [Hex, number];
  assert.equal(count, 4);
  proofs.forEach((proof, i) => {
    assert.equal(proof.root, root);
    assert.equal(proof.count, 4);
    assert.ok(verifyProof(signed[i]!.leaf, proof.proof, root));
    assert.equal(anchor.lookup(signed[i]!.receipt.requestId)?.status, "anchored");
  });
});

test("a part-filled batch commits when the window closes", async () => {
  const { writer, commits } = fakeWriter();
  const anchor = new BatchAnchor({ writer, registry: REGISTRY, maxBatch: 256, maxWaitMs: 40 });
  const a = await anchor.add(receiptOf(writer.providerAddress));
  const b = await anchor.add(receiptOf(writer.providerAddress));
  assert.equal(commits.length, 0, "nothing goes out before the window closes");
  assert.equal(anchor.lookup(a.receipt.requestId)?.status, "pending");
  await Promise.all([a.anchored, b.anchored]);
  assert.equal(commits.length, 1);
  assert.equal((commits[0]!.args as [Hex, number])[1], 2);
});

test("receipts arriving together still never make a batch bigger than maxBatch", async () => {
  const { writer, commits } = fakeWriter();
  const anchor = new BatchAnchor({ writer, registry: REGISTRY, maxBatch: 3, maxWaitMs: 60_000 });
  const signed = await Promise.all(Array.from({ length: 7 }, () => anchor.add(receiptOf(writer.providerAddress))));
  await anchor.flush();
  await Promise.all(signed.map((s) => s.anchored));
  assert.deepEqual(commits.map((c) => (c.args as [Hex, number])[1]), [3, 3, 1]);
});

test("a failed commit fails every receipt in it, and says why", async () => {
  const { writer } = fakeWriter({ fail: true });
  const anchor = new BatchAnchor({ writer, registry: REGISTRY, maxBatch: 2 });
  const [a, b] = await Promise.all([anchor.add(receiptOf(writer.providerAddress)), anchor.add(receiptOf(writer.providerAddress))]);
  await assert.rejects(a!.anchored, /batch commit failed: rpc refused the commit/);
  await assert.rejects(b!.anchored, /rpc refused/);
  const status = anchor.lookup(a!.receipt.requestId);
  assert.equal(status?.status, "failed");
});

test("only the most recent receipts are remembered", async () => {
  const { writer } = fakeWriter();
  const anchor = new BatchAnchor({ writer, registry: REGISTRY, maxBatch: 1, keep: 2 });
  const signed = [];
  for (let i = 0; i < 3; i++) signed.push(await anchor.add(receiptOf(writer.providerAddress)));
  await anchor.flush();
  assert.equal(anchor.lookup(signed[0]!.receipt.requestId), undefined);
  assert.equal(anchor.lookup(signed[2]!.receipt.requestId)?.status, "anchored");
});

/* ------------------------------------------------------- the middleware */

async function serveBatched(anchor: BatchAnchor, sponsor: Address) {
  const headers: Record<string, string> = {};
  const input = Buffer.from("model bytes");
  const output = Buffer.from("optimised bytes");
  const middleware = withReceipt({ anchor, payer: sponsor });
  await new Promise<void>((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string) { headers[name] = value; },
      send() { resolve(); return res; },
    } as unknown as Response;
    middleware({ headers: {}, body: input } as Request, res, (error?: unknown) => {
      if (error) return reject(error);
      res.send(output);
    });
  });
  return { headers, input, output };
}

test("batched mode answers with a signature the buyer can check from its own bytes", async () => {
  const { writer } = fakeWriter();
  const anchor = new BatchAnchor({ writer, registry: REGISTRY, maxWaitMs: 60_000 });
  const { headers, input, output } = await serveBatched(anchor, writer.providerAddress);

  assert.equal(headers[RECEIPT_HEADERS.tx], undefined, "no transaction yet, by design");
  assert.match(headers[RECEIPT_HEADERS.signature] ?? "", /^0x[0-9a-f]{130}$/);
  assert.equal(headers[RECEIPT_HEADERS.proof], `/receipts/${headers[RECEIPT_HEADERS.requestId]}`);

  const check = (out: Buffer) =>
    verifySignedReceipt({
      network: arcTestnet,
      registry: REGISTRY,
      expectedProvider: writer.providerAddress,
      input,
      output: out,
      requestId: headers[RECEIPT_HEADERS.requestId] as Hex,
      payer: headers[RECEIPT_HEADERS.payer] as Address,
      signature: headers[RECEIPT_HEADERS.signature] as Hex,
    });

  const good = await check(output);
  assert.ok(good.ok, good.problems.join("; "));
  assert.equal(good.leaf, receiptLeaf(good.receipt));

  const flipped = Buffer.from(output);
  flipped[0]! ^= 1;
  const bad = await check(flipped);
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0] ?? "", /does not come from/);
  await anchor.flush();
});

test("batched mode does not hold the response for the chain", async () => {
  // A commit that never confirms must not keep the buyer waiting: the bytes
  // and the signature go out regardless.
  const { writer } = fakeWriter({ hang: true });
  const anchor = new BatchAnchor({ writer, registry: REGISTRY, maxBatch: 1 });
  const started = Date.now();
  const { headers } = await serveBatched(anchor, writer.providerAddress);
  assert.ok(headers[RECEIPT_HEADERS.signature]);
  assert.ok(Date.now() - started < 2000);
});

test("withReceipt refuses to guess between immediate and batched", () => {
  const { writer } = fakeWriter();
  const anchor = new BatchAnchor({ writer, registry: REGISTRY });
  assert.throws(() => withReceipt({}), /exactly one/);
  assert.throws(() => withReceipt({ writer, anchor }), /exactly one/);
});

test("the proof endpoint says pending, anchored, unknown, or rejects a malformed id", async () => {
  const { writer } = fakeWriter();
  const anchor = new BatchAnchor({ writer, registry: REGISTRY, maxBatch: 2, maxWaitMs: 60_000 });
  const handler = receiptProofs(anchor);
  const call = (id: string) => {
    let status = 0;
    let body: unknown;
    const res = {
      status(code: number) { status = code; return res; },
      json(value: unknown) { body = value; return res; },
    } as unknown as Response;
    handler({ params: { requestId: id } } as unknown as Request, res, () => undefined);
    return { status, body: body as { status: string } };
  };

  const first = await anchor.add(receiptOf(writer.providerAddress));
  assert.equal(call(first.receipt.requestId).status, 202);
  await anchor.add(receiptOf(writer.providerAddress));
  await first.anchored;
  const done = call(first.receipt.requestId);
  assert.equal(done.status, 200);
  assert.equal(done.body.status, "anchored");
  assert.equal(call(rand32()).status, 404);
  assert.equal(call("0x1234").status, 400);
});

test("a buyer can check binding to its payment from the signed receipt alone", async () => {
  const { writer } = fakeWriter();
  const domain = receiptDomain(arcTestnet.chainId, REGISTRY);
  const buyer = privateKeyToAccount(generatePrivateKey()).address;
  const nonce = rand32();
  const input = Buffer.from("in");
  const output = Buffer.from("out");
  const { requestIdForPayment } = await import("../src/payment.ts");
  const requestId = requestIdForPayment({ payer: buyer, paymentNonce: nonce, inputHash: digest(input) });
  const receipt: ReceiptData = { requestId, payer: buyer, inputHash: digest(input), outputHash: digest(output), bytesIn: 2n, bytesOut: 3n };
  const signature = await writer.signReceipt(domain, receipt);

  const params = { network: arcTestnet, registry: REGISTRY, expectedProvider: writer.providerAddress, input, output, requestId, payer: buyer, signature };
  assert.equal((await verifySignedReceipt({ ...params, paymentNonce: nonce })).paymentBound, true);
  const other = await verifySignedReceipt({ ...params, paymentNonce: rand32() });
  assert.equal(other.paymentBound, false);
  assert.equal(other.ok, false);
});
