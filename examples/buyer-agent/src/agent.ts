/**
 * A buyer that pays for a service and then checks it was not cheated.
 *
 *   npm start --workspace examples/buyer-agent
 *
 * The sequence that matters:
 *   1. ask, get 402
 *   2. check the price against limits enforced in code
 *   3. sign, pay, receive
 *   4. read the receipt off Arc and compare it to the bytes actually received
 *
 * RECEIPT_MODE=batched uses /batched/optimize instead: step 4 becomes a
 * signature check the moment the bytes arrive, then a Merkle proof against a
 * root committed a second or so later, and the agent keeps the proof itself
 * under RECEIPT_DIR (default ./receipts) rather than relying on the provider
 * to keep serving it.
 *
 * Step 4 is the one nobody else does. Without it "the agent paid" is all you
 * can prove, and an agent has no eyes to judge whether a returned asset was
 * quietly degraded.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  verifyReceipt,
  verifySignedReceipt,
  verifyAnchoredReceipt,
  batchRegistryFromEnv,
  batchRegistryEnvKey,
  type AnchorProof,
  arcMainnet,
  arcTestnet,
  RECEIPT_HEADERS,
  registryFromEnv,
  registryEnvKey,
  digest,
  type ArcNetwork,
} from "aernyth";
import type { Address, Hex } from "viem";
import { Budget, BudgetExceeded, usd } from "./budget.ts";
import { payAndFetch } from "./pay.ts";

const network: ArcNetwork =
  process.env.ARC_NETWORK === "arc" ? arcMainnet : arcTestnet;

const buyerKey = required("BUYER_PRIVATE_KEY") as Hex;
const registry = (registryFromEnv(network) ??
  fail(`${registryEnvKey(network)} is not set for ${network.name}.`)) as Address;
const seller = required("SELLER_ADDRESS") as Address;
const serviceUrl = process.env.SERVICE_URL ?? "http://localhost:3000";

const account = privateKeyToAccount(buyerKey);
const batchedMode = process.env.RECEIPT_MODE === "batched";

const budget = new Budget({
  maxPerCall: 50_000n, // $0.05
  maxTotal: 200_000n, // $0.20
  allowedPayTo: [seller],
  allowedNetworks: [network.caip2],
});

console.log(`buyer     ${account.address}`);
console.log(`service   ${serviceUrl}`);
console.log(`network   ${network.name} (chain ${network.chainId})`);
console.log(
  `limits    ${usd(budget.limits.maxPerCall)} per call, ${usd(budget.limits.maxTotal)} total\n`,
);

const assetPath =
  process.env.ASSET ??
  resolve(import.meta.dirname, "../../glb-service/fixtures/sample.glb");

const payload = readFileSync(assetPath);
console.log(`asset     ${assetPath} (${(payload.byteLength / 1048576).toFixed(2)} MB)\n`);

const result = await payAndFetch({
  url: `${serviceUrl}${batchedMode ? "/batched" : ""}/optimize`,
  account,
  budget,
  body: payload,
  contentType: "model/gltf-binary",
  log: (message) => console.log(`  ${message}`),
});

if (!result.response.ok) {
  console.error(
    `request failed: HTTP ${result.response.status} ${result.body.toString("utf8").slice(0, 300)}`,
  );
  process.exit(1);
}

console.log(`  paid ${usd(result.amount)}, received ${result.body.byteLength} bytes`);

const reportHeader = result.response.headers.get("x-glb-report");
if (reportHeader) {
  const report = JSON.parse(reportHeader);
  console.log(
    `  ${(report.bytesIn / 1048576).toFixed(2)} MB -> ${(report.bytesOut / 1048576).toFixed(2)} MB ` +
      `(${(report.ratio * 100).toFixed(1)}% of original)`,
  );
  // The claim worth checking: geometry untouched. The service says so, and
  // the receipt below proves these are the bytes that claim describes.
  const geometryHeld =
    report.trianglesIn === report.trianglesOut &&
    report.verticesIn === report.verticesOut;
  console.log(
    `  triangles ${report.trianglesIn} -> ${report.trianglesOut}, ` +
      `vertices ${report.verticesIn} -> ${report.verticesOut} ` +
      `${geometryHeld ? "(unchanged, as promised)" : "(CHANGED — promise broken)"}`,
  );
  if (!geometryHeld) process.exit(1);
}

const txHash = result.response.headers.get(RECEIPT_HEADERS.tx) as Hex | null;
const receiptError = result.response.headers.get(RECEIPT_HEADERS.error);

if (receiptError) {
  console.error(`\nprovider could not record a receipt: ${receiptError}`);
  console.error("the bytes arrived, but this exchange is unproven");
  process.exit(1);
}

const signatureHeader = result.response.headers.get(RECEIPT_HEADERS.signature) as Hex | null;

if (signatureHeader) {
  await checkBatched(signatureHeader);
} else {
  if (!txHash) {
    console.error("\nno receipt header on the response — nothing to verify");
    process.exit(1);
  }

  console.log(`\nverifying receipt ${txHash}`);

  const verified = await verifyReceipt({
    network,
    registry,
    txHash,
    input: payload,
    output: result.body,
    expectedPayer: account.address,
    ...(result.paymentNonce ? { paymentNonce: result.paymentNonce } : {}),
  });

  if (!verified.ok) {
    console.error("  REJECTED");
    for (const problem of verified.problems) console.error(`    ${problem}`);
    process.exit(1);
  }

  console.log("  verified against the chain");
  console.log(`    provider   ${verified.provider}`);
  console.log(`    payer      ${verified.payer}`);
  console.log(`    bytes      ${verified.bytesIn} in, ${verified.bytesOut} out`);
  console.log(
    `    payment    ${verified.paymentBound ? `bound — request id derives from nonce ${result.paymentNonce}` : "NOT bound to this payment"}`,
  );
  if (result.settlement) console.log(`    settlement ${result.settlement}`);
  console.log(`    ${verified.explorerUrl}`);

  // Prove the check has teeth: the same receipt must reject a body that differs
  // by one byte. A verifier that never says no is decoration.
  const tampered = Buffer.from(result.body);
  tampered[0] = (tampered[0] ?? 0) ^ 0x01;

  const control = await verifyReceipt({
    network,
    registry,
    txHash,
    input: payload,
    output: tampered,
  });

  console.log(
    `\ncontrol: one flipped byte is ${control.ok ? "ACCEPTED — the check is broken" : "rejected"}`,
  );
  if (control.ok) process.exit(1);
}

// Keep the exact bytes that came back, so the run can be published and
// re-verified by someone who was not there.
if (process.env.OUTPUT) {
  writeFileSync(process.env.OUTPUT, result.body);
  console.log(`\nsaved the delivered bytes to ${process.env.OUTPUT}`);
}

console.log(`\nspent ${usd(budget.spent)}, ${usd(budget.remaining)} left`);

// Show the guard actually refuses, rather than asserting that it would.
try {
  budget.authorize({
    amount: "5000000", // $5.00
    payTo: seller,
    network: network.caip2,
    asset: "0x3600000000000000000000000000000000000000",
  });
  console.error("budget guard did NOT refuse an over-limit price");
  process.exit(1);
} catch (error) {
  if (!(error instanceof BudgetExceeded)) throw error;
  console.log(`guard refused $5.00 as expected: ${error.message}`);
}

console.log(`\ninput digest  ${digest(payload)}`);
console.log(`output digest ${digest(result.body)}`);

/**
 * The batched check: signature now, proof shortly, and the evidence kept.
 */
async function checkBatched(signature: Hex): Promise<void> {
  const batchRegistry = (batchRegistryFromEnv(network) ??
    fail(`${batchRegistryEnvKey(network)} is not set; the agent pins the batch registry it trusts.`)) as Address;
  const headers = result.response.headers;
  const provider = headers.get(RECEIPT_HEADERS.provider) as Address;
  const requestId = headers.get(RECEIPT_HEADERS.requestId) as Hex;
  const payer = headers.get(RECEIPT_HEADERS.payer) as Address;

  console.log(`\nchecking the signed receipt ${requestId}`);
  const signed = await verifySignedReceipt({
    network,
    registry: batchRegistry,
    expectedProvider: provider,
    input: payload,
    output: result.body,
    requestId,
    payer,
    signature,
    ...(result.paymentNonce ? { paymentNonce: result.paymentNonce } : {}),
  });
  if (!signed.ok || payer.toLowerCase() !== account.address.toLowerCase()) {
    console.error("  REJECTED");
    for (const problem of signed.problems) console.error(`    ${problem}`);
    if (payer.toLowerCase() !== account.address.toLowerCase()) console.error(`    receipt names ${payer} as payer, not this agent`);
    process.exit(1);
  }
  console.log(`  signed by   ${signed.signer} — checked offline, before the chain has it`);
  console.log(`  payment     ${signed.paymentBound ? `bound — request id derives from nonce ${result.paymentNonce}` : "NOT bound to this payment"}`);

  const tampered = Buffer.from(result.body);
  tampered[0] = (tampered[0] ?? 0) ^ 0x01;
  const control = await verifySignedReceipt({
    network, registry: batchRegistry, expectedProvider: provider, input: payload, output: tampered, requestId, payer, signature,
  });
  console.log(`  control: one flipped byte is ${control.ok ? "ACCEPTED — the check is broken" : "rejected"}`);
  if (control.ok) process.exit(1);

  console.log("\nwaiting for the batch to be anchored");
  const proofUrl = new URL(headers.get(RECEIPT_HEADERS.proof) ?? `/receipts/${requestId}`, serviceUrl);
  let proof: AnchorProof | undefined;
  for (let attempt = 0; attempt < 60 && !proof; attempt++) {
    const answer = await fetch(proofUrl).then((r) => r.json() as Promise<{ status: string; proof?: AnchorProof; reason?: string }>);
    if (answer.status === "anchored") proof = answer.proof;
    else if (answer.status === "failed") fail(`the provider's batch failed (${answer.reason}); the signed receipt can still be anchored with BatchRegistry.anchor`);
    else await new Promise((ok) => setTimeout(ok, 500));
  }
  if (!proof) fail("no proof after 30 s; keep the signed receipt and anchor it yourself if it never comes");

  // Keep the evidence before checking it: a proof is only useful if the buyer
  // still has it after the provider has forgotten it.
  const dir = process.env.RECEIPT_DIR ?? "receipts";
  mkdirSync(dir, { recursive: true });
  const bundle = resolve(dir, `${requestId}.json`);
  writeFileSync(
    bundle,
    JSON.stringify(
      { chainId: network.chainId, registry: batchRegistry, provider, receipt: signed.receipt, signature, leaf: signed.leaf, proof },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ) + "\n",
  );

  const anchored = await verifyAnchoredReceipt({ network, registry: batchRegistry, expectedProvider: provider, leaf: signed.leaf, proof });
  if (!anchored.ok) {
    console.error("  REJECTED");
    for (const problem of anchored.problems) console.error(`    ${problem}`);
    process.exit(1);
  }
  console.log(`  anchored    leaf ${proof.index + 1} of ${proof.count} under root ${proof.root.slice(0, 18)}…`);
  console.log(`              at ${new Date(Number(anchored.timestamp) * 1000).toISOString()}, ${anchored.explorerUrl}`);
  console.log(`  kept        ${bundle}`);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is not set. Check .env at the repository root.`);
  return value as string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
