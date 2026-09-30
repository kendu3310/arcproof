/**
 * Prepare a buyer wallet: create it, fund it from the provider, and move part
 * of that into Gateway so it can pay.
 *
 *   node --experimental-strip-types scripts/setup-buyer.mjs [amount]
 *
 * The buyer is a separate wallet on purpose. If the provider paid itself, the
 * receipt would name the same address as payer and provider and would
 * demonstrate nothing about a real exchange.
 *
 * Note the two-step funding. USDC in the wallet cannot be spent through x402
 * batching; the buyer must first deposit into the Gateway Wallet contract, and
 * payments are then signed offchain against that balance and settled in bulk.
 * That deposit is the step people miss, and the resulting failure looks like an
 * unfunded wallet even though the balance is plainly there.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, createPublicClient, http, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { arcMainnet, arcTestnet, MIN_MAX_FEE_PER_GAS_WEI } from "../packages/arcproof/src/networks.ts";
import { arcChain } from "../packages/arcproof/src/receipt.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
if (!existsSync(envPath)) {
  console.error("No .env found.");
  process.exit(1);
}

let env = readFileSync(envPath, "utf8");
const read = (key) => env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
const upsert = (key, value) => {
  env = env.includes(`${key}=`)
    ? env.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`)
    : `${env.trimEnd()}\n${key}=${value}\n`;
  writeFileSync(envPath, env, "utf8");
};

const network = read("ARC_NETWORK") === "arc" ? arcMainnet : arcTestnet;
const providerKey = read("PROVIDER_PRIVATE_KEY");
const topUp = process.argv[2] ?? "2";

let buyerKey = read("BUYER_PRIVATE_KEY");
if (!buyerKey) {
  buyerKey = generatePrivateKey();
  upsert("BUYER_PRIVATE_KEY", buyerKey);
  console.log("created a new buyer wallet (key written to .env, not printed)");
}

const buyer = privateKeyToAccount(buyerKey);
const provider = privateKeyToAccount(providerKey);
const chain = arcChain(network);
const publicClient = createPublicClient({ chain, transport: http(network.rpcUrl) });

console.log(`network   ${network.name} (chain ${network.chainId})`);
console.log(`provider  ${provider.address}`);
console.log(`buyer     ${buyer.address}\n`);

// ---- fund the buyer's wallet if it is short -------------------------------

const want = parseUnits(topUp, 18);
const buyerBalance = await publicClient.getBalance({ address: buyer.address });

if (buyerBalance < want) {
  const missing = want - buyerBalance;
  const providerBalance = await publicClient.getBalance({ address: provider.address });
  if (providerBalance <= missing) {
    console.error(
      `provider holds ${formatUnits(providerBalance, 18)} USDC, not enough to send ${formatUnits(missing, 18)}.`,
    );
    process.exit(1);
  }

  const wallet = createWalletClient({ account: provider, chain, transport: http(network.rpcUrl) });
  const fees = await publicClient.estimateFeesPerGas().catch(() => null);
  const maxFeePerGas =
    fees?.maxFeePerGas && fees.maxFeePerGas > MIN_MAX_FEE_PER_GAS_WEI
      ? fees.maxFeePerGas
      : MIN_MAX_FEE_PER_GAS_WEI;

  console.log(`sending ${formatUnits(missing, 18)} USDC to the buyer…`);
  const hash = await wallet.sendTransaction({
    to: buyer.address,
    value: missing,
    maxFeePerGas,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  console.log(`  ${network.explorerUrl}/tx/${hash}`);
} else {
  console.log(`buyer wallet already holds ${formatUnits(buyerBalance, 18)} USDC`);
}

// ---- move it into Gateway so x402 batching can spend it -------------------

const gateway = new GatewayClient({
  chain: network.key,
  privateKey: buyerKey,
  rpcUrl: network.rpcUrl,
});

const before = await gateway.getBalances();
console.log(`\ngateway available: ${before.gateway.formattedAvailable} USDC`);

const depositTarget = "1";
if (Number(before.gateway.formattedAvailable) < Number(depositTarget)) {
  console.log(`depositing ${depositTarget} USDC into the Gateway Wallet…`);
  const result = await gateway.deposit(depositTarget);
  // JSON.stringify throws on the BigInt fields this result carries.
  console.log(
    `  ${JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value))}`,
  );

  const after = await gateway.getBalances();
  console.log(`gateway available now: ${after.gateway.formattedAvailable} USDC`);
} else {
  console.log("gateway balance is already sufficient");
}

console.log(`\nbuyer ready: ${buyer.address}`);
console.log(`  ${network.explorerUrl}/address/${buyer.address}`);
