/**
 * What publishing a batch's leaves in calldata costs, and whether a proof can
 * be rebuilt from the chain alone afterwards. Arc testnet.
 *
 *   node --experimental-strip-types scripts/measure-leaves.mjs
 *
 * Commits batches of 1, 20 and 256 receipts with leaves published, and one of
 * 20 without, against the testnet BatchRegistry. For each it reads gasUsed
 * from the chain, then throws away everything the anchor knew and rebuilds a
 * proof twice — from the commit transaction, and by scanning for it — and
 * checks both against the chain with verifyAnchoredReceipt.
 *
 * Testnet only. Spends a little testnet USDC from the provider key.
 * Results go to design/measurements/<date>-leaves-testnet.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "../packages/aernyth/src/networks.ts";
import { ReceiptWriter, arcChain } from "../packages/aernyth/src/receipt.ts";
import { BatchAnchor } from "../packages/aernyth/src/batch.ts";
import { proofFromCommit, findAnchorProof } from "../packages/aernyth/src/recover.ts";
import { verifyAnchoredReceipt } from "../packages/aernyth/src/verifyBatch.ts";

const BATCH_REGISTRY = "0xb0f2c2454e8cc3d3e69250e6cebe50c568f1f837";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = readFileSync(resolve(root, ".env"), "utf8");
const read = (key) => env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim().replace(/^['"]|['"]$/g, "");

const network = arcTestnet;
const writer = new ReceiptWriter({ network, registry: read("RECEIPT_REGISTRY_ADDRESS_ARCTESTNET"), privateKey: read("PROVIDER_PRIVATE_KEY") });
const client = createPublicClient({ chain: arcChain(network), transport: http(network.rpcUrl) });
const rand = () => `0x${randomBytes(32).toString("hex")}`;
const receipt = () => ({ requestId: rand(), payer: writer.providerAddress, inputHash: rand(), outputHash: rand(), bytesIn: 1000n, bytesOut: 100n });

const results = [];
let failures = 0;
const check = (ok, label) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`); if (!ok) failures++; };

for (const [size, publishLeaves] of [[1, true], [20, true], [256, true], [20, false]]) {
  const before = await client.getBlockNumber();
  // A fresh anchor per run, so nothing below can lean on its memory.
  const anchor = new BatchAnchor({ writer, registry: BATCH_REGISTRY, maxBatch: size, maxWaitMs: 60_000, publishLeaves });
  const signed = await Promise.all(Array.from({ length: size }, () => anchor.add(receipt())));
  const proof = await signed[0].anchored;
  const mined = await client.getTransactionReceipt({ hash: proof.txHash });
  const gas = Number(mined.gasUsed);
  console.log(`${size} receipts, leaves ${publishLeaves ? "published" : "not published"}: ${gas} gas, ${Math.round(gas / size)} a receipt  ${network.explorerUrl}/tx/${proof.txHash}`);

  const target = signed[size - 1];
  const params = { network, registry: BATCH_REGISTRY, expectedProvider: writer.providerAddress, leaf: target.leaf };
  if (publishLeaves) {
    const fromTx = await proofFromCommit({ ...params, txHash: proof.txHash });
    const anchored = await verifyAnchoredReceipt({ ...params, proof: fromTx });
    check(anchored.ok, `proof rebuilt from the commit transaction verifies against the chain (leaf ${size - 1} of ${size})`);
    const found = await findAnchorProof({ ...params, fromBlock: before });
    check(found?.txHash === proof.txHash && found.index === size - 1, "the scan finds the same batch and position without being told the transaction");
    const stranger = await findAnchorProof({ ...params, leaf: rand(), fromBlock: before, maxBlocks: 200n });
    check(stranger === undefined, "a leaf in no batch is not found");
  } else {
    const refused = await proofFromCommit({ ...params, txHash: proof.txHash }).then(() => "accepted", (e) => e.message);
    check(/did not publish its leaves/.test(refused), `a root-only commit says it cannot rebuild a proof (${refused})`);
  }
  results.push({ size, publishLeaves, gasUsed: gas, perReceipt: Math.round(gas / size), txHash: proof.txHash });
}

const out = resolve(root, `design/measurements/${new Date().toISOString().slice(0, 10)}-leaves-testnet.json`);
writeFileSync(out, JSON.stringify({ network: network.name, chainId: network.chainId, registry: BATCH_REGISTRY, results }, null, 2) + "\n");
console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"} — written to ${out}`);
process.exit(failures ? 1 : 0);
