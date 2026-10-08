/**
 * Compile and deploy ReceiptRegistry to the network named in .env.
 *
 *   node scripts/deploy-registry.mjs
 *
 * Writes the deployed address back into .env as RECEIPT_REGISTRY_ADDRESS, and
 * refuses to redeploy over an existing one. A second registry would split the
 * evidence across two addresses, and every receipt already written to the first
 * would look absent to a buyer checking the second.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcMainnet, arcTestnet, MIN_MAX_FEE_PER_GAS_WEI, registryEnvKey } from "../packages/aernyth/src/networks.ts";
import { arcChain } from "../packages/aernyth/src/receipt.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
const sourcePath = resolve(root, "contracts/src/ReceiptRegistry.sol");

if (!existsSync(envPath)) {
  console.error("No .env found. Run `node scripts/new-wallet.mjs` first.");
  process.exit(1);
}

const env = readFileSync(envPath, "utf8");
const read = (key) => env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();

const networkKeyEarly = read("ARC_NETWORK") ?? "arcTestnet";
const networkEarly = networkKeyEarly === "arc" ? arcMainnet : arcTestnet;
const REGISTRY_KEY = registryEnvKey(networkEarly);
const existing = read(REGISTRY_KEY);
if (existing && !process.argv.includes("--force")) {
  console.error(
    `${REGISTRY_KEY} is already set to ${existing}.\n` +
      `Deploying again would strand every receipt written to the old address.\n` +
      `Pass --force only if you are certain you want a second registry.`,
  );
  process.exit(1);
}

const privateKey = read("PROVIDER_PRIVATE_KEY");
if (!privateKey) {
  console.error("PROVIDER_PRIVATE_KEY is empty in .env.");
  process.exit(1);
}

const network = networkEarly;

// ---------------------------------------------------------------- compile

const source = readFileSync(sourcePath, "utf8");
const input = {
  language: "Solidity",
  sources: { "ReceiptRegistry.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (output.errors ?? []).filter((e) => e.severity === "error");
if (errors.length > 0) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}
for (const warning of output.errors ?? []) {
  console.warn(warning.formattedMessage.trimEnd());
}

const artifact = output.contracts["ReceiptRegistry.sol"].ReceiptRegistry;
const bytecode = `0x${artifact.evm.bytecode.object}`;
console.log(`compiled ReceiptRegistry — ${(bytecode.length - 2) / 2} bytes of bytecode`);

// ---------------------------------------------------------------- deploy

const account = privateKeyToAccount(privateKey);
const chain = arcChain(network);
const wallet = createWalletClient({ account, chain, transport: http(network.rpcUrl) });
const publicClient = createPublicClient({ chain, transport: http(network.rpcUrl) });

const balance = await publicClient.getBalance({ address: account.address });
if (balance === 0n) {
  console.error(
    `${account.address} holds no USDC on ${network.name}.\n` +
      `Gas on Arc is paid in USDC, so deployment cannot proceed.`,
  );
  process.exit(1);
}

const fees = await publicClient.estimateFeesPerGas().catch(() => null);
// Arc rejects nothing below the 20 Gwei floor — it just never mines it.
const maxFeePerGas =
  fees?.maxFeePerGas && fees.maxFeePerGas > MIN_MAX_FEE_PER_GAS_WEI
    ? fees.maxFeePerGas
    : MIN_MAX_FEE_PER_GAS_WEI;

console.log(`deploying to ${network.name} (chain ${network.chainId}) from ${account.address}`);

const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode,
  args: [],
  maxFeePerGas,
  maxPriorityFeePerGas: 1_000_000_000n,
});

console.log(`  tx ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });

if (receipt.status !== "success" || !receipt.contractAddress) {
  console.error(`Deployment failed: ${network.explorerUrl}/tx/${hash}`);
  process.exit(1);
}

const address = receipt.contractAddress;

const next = env.includes(`${REGISTRY_KEY}=`)
  ? env.replace(new RegExp(`^${REGISTRY_KEY}=.*$`, "m"), `${REGISTRY_KEY}=${address}`)
  : `${env.trimEnd()}\n${REGISTRY_KEY}=${address}\n`;
writeFileSync(envPath, next, "utf8");

console.log(`
ReceiptRegistry deployed

  address   ${address}
  gas used  ${receipt.gasUsed}
  explorer  ${network.explorerUrl}/address/${address}
  tx        ${network.explorerUrl}/tx/${hash}

Written to .env as ${REGISTRY_KEY}.`);
