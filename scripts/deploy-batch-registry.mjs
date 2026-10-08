/**
 * Deploy BatchRegistry to the network named by ARC_NETWORK in .env.
 *
 *   node --experimental-strip-types scripts/deploy-batch-registry.mjs
 *
 * Refuses if BATCH_REGISTRY_ADDRESS_<NETWORK> is already set: a second
 * registry would strand every proof that points at the first. Pass --force
 * only when that is really what you want.
 *
 * After deploying it checks the contract it just created rather than trusting
 * the compiler: the domain separator must be bound to this chain and this
 * address, and the struct hash and Merkle leaf it computes must be exactly the
 * ones the package computes — otherwise every signature and proof the service
 * issues would fail to verify against it.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import solc from "solc";
import { createWalletClient, createPublicClient, http, keccak256, encodeAbiParameters, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcMainnet, arcTestnet, MIN_MAX_FEE_PER_GAS_WEI, batchRegistryEnvKey } from "../packages/aernyth/src/networks.ts";
import { arcChain } from "../packages/aernyth/src/receipt.ts";
import { receiptStructHash, receiptLeaf } from "../packages/aernyth/src/signed.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
if (!existsSync(envPath)) {
  console.error("No .env found.");
  process.exit(1);
}
const env = readFileSync(envPath, "utf8");
const read = (key) => env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim().replace(/^['"]|['"]$/g, "");

const network = read("ARC_NETWORK") === "arc" ? arcMainnet : arcTestnet;
const KEY = batchRegistryEnvKey(network);
const existing = read(KEY);
if (existing && !process.argv.includes("--force")) {
  console.error(`${KEY} is already set to ${existing}. A second registry would strand every proof pointing at the first.`);
  process.exit(1);
}

const compiled = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "BatchRegistry.sol": { content: readFileSync(resolve(root, "contracts/src/BatchRegistry.sol"), "utf8") } },
      settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
    }),
  ),
);
const errors = (compiled.errors ?? []).filter((e) => e.severity === "error");
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}
const { abi, evm } = compiled.contracts["BatchRegistry.sol"].BatchRegistry;

const account = privateKeyToAccount(read("PROVIDER_PRIVATE_KEY"));
const chain = arcChain(network);
const wallet = createWalletClient({ account, chain, transport: http(network.rpcUrl) });
const pub = createPublicClient({ chain, transport: http(network.rpcUrl) });

const fees = await pub.estimateFeesPerGas().catch(() => null);
const maxFeePerGas = fees?.maxFeePerGas && fees.maxFeePerGas > MIN_MAX_FEE_PER_GAS_WEI ? fees.maxFeePerGas : MIN_MAX_FEE_PER_GAS_WEI;

console.log(`deploying BatchRegistry to ${network.name} (chain ${network.chainId}) from ${account.address}`);
const hash = await wallet.deployContract({ abi, bytecode: `0x${evm.bytecode.object}`, maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n });
console.log(`  tx ${hash}`);
const mined = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
if (mined.status !== "success" || !mined.contractAddress) {
  console.error(`deployment failed: ${network.explorerUrl}/tx/${hash}`);
  process.exit(1);
}
const address = mined.contractAddress;
const cost = Number(mined.gasUsed * mined.effectiveGasPrice) / 1e18;
console.log(`  at ${address}, ${mined.gasUsed} gas, $${cost.toFixed(5)} USDC`);

/* --------------------------------------------- check what was deployed --- */

let ok = true;
const check = (name, pass) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
  ok &&= pass;
};

const expectedDomain = keccak256(
  encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [
      keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
      keccak256(toBytes("Aernyth")),
      keccak256(toBytes("2")),
      BigInt(network.chainId),
      address,
    ],
  ),
);
check(`domain separator is bound to chain ${network.chainId} and this address`,
  (await pub.readContract({ address, abi, functionName: "DOMAIN_SEPARATOR" })) === expectedDomain);

const sample = {
  requestId: `0x${randomBytes(32).toString("hex")}`,
  payer: account.address,
  inputHash: `0x${randomBytes(32).toString("hex")}`,
  outputHash: `0x${randomBytes(32).toString("hex")}`,
  bytesIn: 2066880n,
  bytesOut: 286932n,
};
check("struct hash matches the package", (await pub.readContract({ address, abi, functionName: "structHash", args: [sample] })) === receiptStructHash(sample));
check("Merkle leaf matches the package", (await pub.readContract({ address, abi, functionName: "leafOf", args: [sample] })) === receiptLeaf(sample));

if (!ok) {
  console.error("\nThe deployed contract disagrees with the package. Not writing it to .env.");
  process.exit(1);
}

const next = env.match(new RegExp(`^${KEY}=.*$`, "m"))
  ? env.replace(new RegExp(`^${KEY}=.*$`, "m"), `${KEY}=${address}`)
  : `${env.trimEnd()}\n${KEY}=${address}\n`;
writeFileSync(envPath, next, "utf8");

console.log(`
BatchRegistry deployed and checked

  ${KEY}=${address}

  explorer  ${network.explorerUrl}/address/${address}
  tx        ${network.explorerUrl}/tx/${hash}

Written to .env. Set the same variable on the hosting service to turn batching on there.`);
