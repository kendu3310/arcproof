/**
 * Batched receipts, end to end, on Arc testnet.
 *
 *   node --experimental-strip-types scripts/e2e-batch.mjs
 *
 * Runs a real HTTP server using withReceipt({ anchor }) against the
 * BatchRegistry deployed on testnet, fires concurrent requests at it, and
 * checks what a buyer would check: every signature offline from its own
 * bytes, then every Merkle proof against the root on chain. It also times
 * one immediate-mode request beside them, since not holding the response for
 * a block is half the point.
 *
 * Testnet only. Spends a little testnet USDC from the provider key.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import express from "express";
import { createPublicClient, http } from "viem";
import { arcTestnet, registryFromEnv } from "../packages/aernyth/src/networks.ts";
import { ReceiptWriter, arcChain } from "../packages/aernyth/src/receipt.ts";
import { BatchAnchor, batchRegistryAbi } from "../packages/aernyth/src/batch.ts";
import { withReceipt, receiptProofs, RECEIPT_HEADERS } from "../packages/aernyth/src/withReceipt.ts";
import { verifySignedReceipt, verifyAnchoredReceipt } from "../packages/aernyth/src/verifyBatch.ts";
import { receiptStructHash, receiptLeaf } from "../packages/aernyth/src/signed.ts";

const BATCH_REGISTRY = "0xb0f2c2454e8cc3d3e69250e6cebe50c568f1f837";
const REQUESTS = 20;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = readFileSync(resolve(root, ".env"), "utf8");
const read = (key) => env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim().replace(/^['"]|['"]$/g, "");
process.env.RECEIPT_REGISTRY_ADDRESS_ARCTESTNET ??= read("RECEIPT_REGISTRY_ADDRESS_ARCTESTNET");

const network = arcTestnet;
const writer = new ReceiptWriter({
  network,
  registry: registryFromEnv(network),
  privateKey: read("PROVIDER_PRIVATE_KEY"),
});
const anchor = new BatchAnchor({ writer, registry: BATCH_REGISTRY, maxBatch: 256, maxWaitMs: 1000 });
const provider = writer.providerAddress;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

/* ------------------------------------------- package hashes vs contract --- */

console.log("the package's own hashing against the deployed contract");
const pub = createPublicClient({ chain: arcChain(network), transport: http(network.rpcUrl) });
const sample = {
  requestId: `0x${randomBytes(32).toString("hex")}`,
  payer: provider,
  inputHash: `0x${randomBytes(32).toString("hex")}`,
  outputHash: `0x${randomBytes(32).toString("hex")}`,
  bytesIn: 123456n,
  bytesOut: 7890n,
};
const abiWithViews = [
  ...batchRegistryAbi,
  ...["structHash", "leafOf"].map((name) => ({
    type: "function", name, stateMutability: "pure",
    inputs: batchRegistryAbi.find((f) => f.name === "anchor").inputs.slice(0, 1),
    outputs: [{ name: "", type: "bytes32" }],
  })),
];
check("receiptStructHash() equals BatchRegistry.structHash()",
  (await pub.readContract({ address: BATCH_REGISTRY, abi: abiWithViews, functionName: "structHash", args: [sample] })) === receiptStructHash(sample));
check("receiptLeaf() equals BatchRegistry.leafOf()",
  (await pub.readContract({ address: BATCH_REGISTRY, abi: abiWithViews, functionName: "leafOf", args: [sample] })) === receiptLeaf(sample));

/* ------------------------------------------------------------- server --- */

const app = express();
const body = express.raw({ type: "*/*", limit: "1mb" });
const reverse = (req, res) => res.status(200).send(Buffer.from(req.body).reverse());
app.post("/batched", body, withReceipt({ anchor, payer: provider }), reverse);
app.post("/immediate", body, withReceipt({ writer, payer: provider }), reverse);
app.get("/receipts/:requestId", receiptProofs(anchor));
const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const post = async (path, input) => {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, { method: "POST", body: input, headers: { "content-type": "application/octet-stream" } });
  const output = Buffer.from(await response.arrayBuffer());
  return { response, output, ms: performance.now() - started };
};

/* ------------------------------------------------------------ batched --- */

console.log(`\n${REQUESTS} concurrent requests, batched`);
const inputs = Array.from({ length: REQUESTS }, () => randomBytes(64 + Math.floor(Math.random() * 4000)));
const served = await Promise.all(inputs.map((input) => post("/batched", input)));
const latencies = served.map((s) => s.ms).sort((a, b) => a - b);
check("every response is a 200 with a signature and no transaction yet",
  served.every((s) => s.response.ok && s.response.headers.get(RECEIPT_HEADERS.signature) && !s.response.headers.get(RECEIPT_HEADERS.tx)));
console.log(`        latency  median ${latencies[REQUESTS >> 1].toFixed(0)} ms, worst ${latencies.at(-1).toFixed(0)} ms`);

const signedChecks = await Promise.all(
  served.map((s, i) =>
    verifySignedReceipt({
      network,
      registry: BATCH_REGISTRY,
      expectedProvider: provider,
      input: inputs[i],
      output: s.output,
      requestId: s.response.headers.get(RECEIPT_HEADERS.requestId),
      payer: s.response.headers.get(RECEIPT_HEADERS.payer),
      signature: s.response.headers.get(RECEIPT_HEADERS.signature),
    }),
  ),
);
check("every signature checks out offline against the buyer's own bytes", signedChecks.every((c) => c.ok),
  signedChecks.flatMap((c) => c.problems).slice(0, 1).join(""));

/* --------------------------------------------------- wait for the chain --- */

console.log("\nwaiting for the batch to be committed");
const fetchProof = async (path) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const r = await fetch(`${base}${path}`);
    if (r.status === 200) return r.json();
    await new Promise((ok) => setTimeout(ok, 500));
  }
  return { status: "timed out" };
};
const answered = await Promise.all(served.map((s) => fetchProof(s.response.headers.get(RECEIPT_HEADERS.proof))));
check("every request's proof became available", answered.every((a) => a.status === "anchored"),
  answered.find((a) => a.status !== "anchored")?.status ?? "");

const commits = [...new Set(answered.map((a) => a.proof?.txHash))];
check(`all ${REQUESTS} receipts went into one commit`, commits.length === 1, `${commits.length} commit transaction(s)`);

const anchoredChecks = await Promise.all(
  answered.map((a, i) =>
    verifyAnchoredReceipt({ network, registry: BATCH_REGISTRY, expectedProvider: provider, leaf: signedChecks[i].leaf, proof: a.proof }),
  ),
);
check("every Merkle proof reaches the root committed on chain by the provider", anchoredChecks.every((c) => c.ok),
  anchoredChecks.flatMap((c) => c.problems).slice(0, 1).join(""));

const commitTx = await pub.getTransactionReceipt({ hash: commits[0] });
console.log(`        commit ${commits[0]}  ${commitTx.gasUsed} gas for ${REQUESTS} receipts = ${Math.round(Number(commitTx.gasUsed) / REQUESTS)} each`);

/* -------------------------------------------------- the checks say no --- */

console.log("\nthe checks refuse what they should");
const swapped = { ...answered[0].proof, proof: answered[1].proof.proof };
check("a proof belonging to another receipt is refused",
  !(await verifyAnchoredReceipt({ network, registry: BATCH_REGISTRY, expectedProvider: provider, leaf: signedChecks[0].leaf, proof: swapped })).ok);
check("a proof naming another registry is refused",
  !(await verifyAnchoredReceipt({ network, registry: "0x0000000000000000000000000000000000000001", expectedProvider: provider, leaf: signedChecks[0].leaf, proof: answered[0].proof })).ok);
check("a commit attributed to another provider is refused",
  !(await verifyAnchoredReceipt({ network, registry: BATCH_REGISTRY, expectedProvider: "0x0000000000000000000000000000000000000002", leaf: signedChecks[0].leaf, proof: answered[0].proof })).ok);

/* ---------------------------------------------------------- immediate --- */

console.log("\none immediate-mode request, for comparison");
const immediate = await post("/immediate", randomBytes(512));
check("immediate mode still works beside batched, sharing one transaction queue", immediate.response.ok && Boolean(immediate.response.headers.get(RECEIPT_HEADERS.tx)));
console.log(`        latency  ${immediate.ms.toFixed(0)} ms (held until the block)`);

server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
