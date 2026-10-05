/**
 * End-to-end proof that the receipt mechanism works — and that it fails when
 * it should.
 *
 *   node --experimental-strip-types scripts/smoke-receipt.mjs
 *
 * A receipt that always verifies proves nothing. The test that matters is the
 * negative one: change a single byte of the "delivered" file and verification
 * must reject it. That is the whole product in one assertion.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { arcMainnet, arcTestnet, registryEnvKey } from "../packages/arcproof/src/networks.ts";
import { ReceiptWriter } from "../packages/arcproof/src/receipt.ts";
import { verifyReceipt } from "../packages/arcproof/src/verifyReceipt.ts";
import { digest, deriveRequestId } from "../packages/arcproof/src/digest.ts";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
if (!existsSync(envPath)) {
  console.error("No .env found.");
  process.exit(1);
}
const env = readFileSync(envPath, "utf8");
const read = (key) => env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();

const privateKey = read("PROVIDER_PRIVATE_KEY");
const network = read("ARC_NETWORK") === "arc" ? arcMainnet : arcTestnet;
const registry = read(registryEnvKey(network));

if (!registry) {
  console.error(`${registryEnvKey(network)} is empty. Run scripts/deploy-registry.mjs.`);
  process.exit(1);
}

const provider = privateKeyToAccount(privateKey).address;

/**
 * Stands in for the buyer; only the address matters to a receipt.
 *
 * Read from .env rather than written here. A personal address baked into a
 * public repository is not a secret, but it does permanently tie that wallet
 * to this project in something search engines index, and nobody chooses that
 * on purpose.
 */
const payer =
  read("BUYER_PRIVATE_KEY") !== undefined
    ? privateKeyToAccount(read("BUYER_PRIVATE_KEY")).address
    : provider;

const input = Buffer.from("a 40MB model, pretend", "utf8");
const output = Buffer.from("a 12MB model, pretend", "utf8");

const inputHash = digest(input);
const outputHash = digest(output);
const requestId = deriveRequestId({
  payer,
  nonce: BigInt(`0x${randomBytes(16).toString("hex")}`),
  inputHash,
});

const writer = new ReceiptWriter({ network, registry, privateKey });

console.log(`network   ${network.name} (chain ${network.chainId})`);
console.log(`registry  ${registry}`);
console.log(`provider  ${provider}\n`);

console.log("writing receipt…");
const started = Date.now();
const txHash = await writer.record({
  requestId,
  payer,
  inputHash,
  outputHash,
  bytesIn: BigInt(input.byteLength),
  bytesOut: BigInt(output.byteLength),
});
console.log(`  mined in ${Date.now() - started}ms`);
console.log(`  ${network.explorerUrl}/tx/${txHash}\n`);

let failures = 0;

// ---- honest delivery must verify -----------------------------------------
const honest = await verifyReceipt({
  network,
  registry,
  txHash,
  input,
  output,
  expectedProvider: provider,
  expectedPayer: payer,
});
report("honest delivery verifies", honest.ok, honest.problems);

// ---- a tampered byte must NOT verify -------------------------------------
const tampered = Buffer.from(output);
tampered[0] = tampered[0] ^ 0x01;
const caught = await verifyReceipt({ network, registry, txHash, input, output: tampered });
report("one flipped byte is rejected", !caught.ok, caught.ok ? ["accepted a tampered file"] : []);
if (!caught.ok) console.log(`      ${caught.problems[0]}`);

// ---- wrong provider must NOT verify --------------------------------------
const impostor = await verifyReceipt({
  network,
  registry,
  txHash,
  input,
  output,
  expectedProvider: "0x0000000000000000000000000000000000000001",
});
report("receipt from another provider is rejected", !impostor.ok, []);

// ---- a receipt from an unrelated registry must NOT be accepted ------------
const wrongRegistry = await verifyReceipt({
  network,
  registry: "0x0000000000000000000000000000000000000002",
  txHash,
  input,
  output,
});
report("receipt from an untrusted registry is rejected", !wrongRegistry.ok, []);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

function report(label, passed, problems) {
  console.log(`  ${passed ? "ok  " : "FAIL"}  ${label}`);
  if (!passed) {
    failures += 1;
    for (const problem of problems) console.log(`        ${problem}`);
  }
}
