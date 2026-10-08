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
 * Step 4 is the one nobody else does. Without it "the agent paid" is all you
 * can prove, and an agent has no eyes to judge whether a returned asset was
 * quietly degraded.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  verifyReceipt,
  arcMainnet,
  arcTestnet,
  RECEIPT_HEADERS,
  registryFromEnv,
  registryEnvKey,
  digest,
  type ArcNetwork,
} from "arcproof";
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
  url: `${serviceUrl}/optimize`,
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

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is not set. Check .env at the repository root.`);
  return value as string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
