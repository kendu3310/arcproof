/**
 * Measure design/batched-receipts.md on Arc testnet instead of trusting its
 * arithmetic.
 *
 *   node --experimental-strip-types scripts/measure-batch.mjs
 *
 * Deploys a fresh BatchRegistry to testnet — never mainnet — and then:
 *
 *   - checks the JavaScript and the Solidity agree on the struct hash, the
 *     EIP-712 digest and the Merkle leaf, since a verifier that hashes
 *     differently from the contract proves nothing
 *   - commits roots over 1, 16 and 256 receipts and records the gas of each
 *   - checks a Merkle proof for one of the 256 against the root read back
 *     from the chain
 *   - anchors one signed receipt from the *buyer's* account, to show anyone
 *     can, and that ecrecover on Arc recovers the provider
 *   - and checks the contract refuses a signature from the wrong key, a
 *     receipt altered after signing, and the malleable twin of a valid
 *     signature
 *
 * Results go to design/measurements/. Nothing is written to .env.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import solc from "solc";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  encodePacked,
  hashTypedData,
  parseEventLogs,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, MIN_MAX_FEE_PER_GAS_WEI } from "../packages/aernyth/src/networks.ts";
import { arcChain } from "../packages/aernyth/src/receipt.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = readFileSync(resolve(root, ".env"), "utf8");
const read = (key) => env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim().replace(/^['"]|['"]$/g, "");

const network = arcTestnet; // fixed: this script spends testnet USDC only
const chain = arcChain(network);
const provider = privateKeyToAccount(read("PROVIDER_PRIVATE_KEY"));
const buyer = privateKeyToAccount(read("BUYER_PRIVATE_KEY"));
const pub = createPublicClient({ chain, transport: http(network.rpcUrl) });
const asProvider = createWalletClient({ account: provider, chain, transport: http(network.rpcUrl) });
const asBuyer = createWalletClient({ account: buyer, chain, transport: http(network.rpcUrl) });
const fees = { maxFeePerGas: MIN_MAX_FEE_PER_GAS_WEI * 2n, maxPriorityFeePerGas: 1_000_000_000n };

const results = { network: network.name, chainId: network.chainId, date: new Date().toISOString(), checks: [], gas: {} };
const check = (name, ok, detail = "") => {
  results.checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) process.exitCode = 1;
};

/* ------------------------------------------------------------- compile --- */

const compiled = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "BatchRegistry.sol": { content: readFileSync(resolve(root, "contracts/src/BatchRegistry.sol"), "utf8") } },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: "cancun",
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      },
    }),
  ),
);
const errors = (compiled.errors ?? []).filter((e) => e.severity === "error");
if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
const { abi, evm } = compiled.contracts["BatchRegistry.sol"].BatchRegistry;

/* -------------------------------------------------------------- deploy --- */

console.log(`deploying BatchRegistry to ${network.name} (chain ${network.chainId}) from ${provider.address}`);
const deployHash = await asProvider.deployContract({ abi, bytecode: `0x${evm.bytecode.object}`, ...fees });
const deployed = await pub.waitForTransactionReceipt({ hash: deployHash, timeout: 60_000 });
const registry = deployed.contractAddress;
results.registry = registry;
results.gas.deploy = Number(deployed.gasUsed);
console.log(`  at ${registry}, ${deployed.gasUsed} gas\n`);

/* ------------------------------------------------------- hashing parity --- */

const TYPEHASH = keccak256(
  new TextEncoder().encode(
    "Receipt(bytes32 requestId,address payer,bytes32 inputHash,bytes32 outputHash,uint64 bytesIn,uint64 bytesOut)",
  ),
);
const domain = { name: "Aernyth", version: "2", chainId: network.chainId, verifyingContract: registry };
const types = {
  Receipt: [
    { name: "requestId", type: "bytes32" },
    { name: "payer", type: "address" },
    { name: "inputHash", type: "bytes32" },
    { name: "outputHash", type: "bytes32" },
    { name: "bytesIn", type: "uint64" },
    { name: "bytesOut", type: "uint64" },
  ],
};

const rand32 = () => `0x${randomBytes(32).toString("hex")}`;
const makeReceipt = () => ({
  requestId: rand32(),
  payer: buyer.address,
  inputHash: rand32(),
  outputHash: rand32(),
  bytesIn: BigInt(1 + Math.floor(Math.random() * 5_000_000)),
  bytesOut: BigInt(1 + Math.floor(Math.random() * 1_000_000)),
});
const structHash = (r) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }],
      [TYPEHASH, r.requestId, r.payer, r.inputHash, r.outputHash, r.bytesIn, r.bytesOut],
    ),
  );
const leafOf = (r) => keccak256(encodePacked(["bytes32"], [structHash(r)]));
const asTuple = (r) => ({ ...r });

console.log("hashing parity, JavaScript against the deployed contract");
const sample = makeReceipt();
const [onStruct, onDigest, onLeaf] = await Promise.all([
  pub.readContract({ address: registry, abi, functionName: "structHash", args: [asTuple(sample)] }),
  pub.readContract({ address: registry, abi, functionName: "digestOf", args: [asTuple(sample)] }),
  pub.readContract({ address: registry, abi, functionName: "leafOf", args: [asTuple(sample)] }),
]);
check("struct hash matches", onStruct === structHash(sample));
check("EIP-712 digest matches viem's hashTypedData", onDigest === hashTypedData({ domain, types, primaryType: "Receipt", message: sample }));
check("Merkle leaf matches", onLeaf === leafOf(sample));

/* ------------------------------------------------------------- merkle --- */

// Sorted-pair hashing, as OpenZeppelin's MerkleProof expects, so a verifier in
// any language can check these proofs without this code. An odd node is
// carried up a level unchanged.
const pair = (a, b) => keccak256(encodePacked(["bytes32", "bytes32"], a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]));
function buildTree(leaves) {
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const prev = levels.at(-1);
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? pair(prev[i], prev[i + 1]) : prev[i]);
    levels.push(next);
  }
  return levels;
}
function proofFor(levels, index) {
  const proof = [];
  for (const level of levels.slice(0, -1)) {
    const sibling = index ^ 1;
    if (sibling < level.length) proof.push(level[sibling]);
    index >>= 1;
  }
  return proof;
}
const verifyProof = (leaf, proof, rootHash) => proof.reduce(pair, leaf) === rootHash;

/* -------------------------------------------------------------- commit --- */

console.log("\ncommitting batches");
results.gas.commit = {};
let kept;
for (const n of [1, 16, 256]) {
  const receipts = Array.from({ length: n }, makeReceipt);
  const levels = buildTree(receipts.map(leafOf));
  const rootHash = levels.at(-1)[0];
  const hash = await asProvider.writeContract({ address: registry, abi, functionName: "commit", args: [rootHash, n], ...fees });
  const mined = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  const price = mined.effectiveGasPrice;
  results.gas.commit[n] = { gas: Number(mined.gasUsed), gwei: Number(price) / 1e9, tx: hash };
  console.log(`  ${String(n).padStart(3)} receipts  ${mined.gasUsed} gas  ${hash}`);
  if (n === 256) kept = { receipts, levels, rootHash, hash };
}

console.log("\nproving one receipt out of 256 against the root on chain");
const committed = await pub.getTransactionReceipt({ hash: kept.hash });
const [batch] = parseEventLogs({ abi, eventName: "Batch", logs: committed.logs });
check("root on chain is the root built here", batch.args.root === kept.rootHash);
check("batch attributed to the provider", batch.args.provider.toLowerCase() === provider.address.toLowerCase());
const index = 137;
const proof = proofFor(kept.levels, index);
check(`proof for receipt #${index} reaches the root`, verifyProof(leafOf(kept.receipts[index]), proof, batch.args.root), `${proof.length} siblings`);
const forged = { ...kept.receipts[index], bytesOut: kept.receipts[index].bytesOut + 1n };
check("same proof rejects that receipt with one field changed", !verifyProof(leafOf(forged), proof, batch.args.root));

/* -------------------------------------------------------------- anchor --- */

console.log("\nanchoring a single signed receipt from the buyer's account");
const single = makeReceipt();
const signature = await provider.signTypedData({ domain, types, primaryType: "Receipt", message: single });
const anchorHash = await asBuyer.writeContract({
  address: registry, abi, functionName: "anchor", args: [asTuple(single), provider.address, signature], ...fees,
});
const anchored = await pub.waitForTransactionReceipt({ hash: anchorHash, timeout: 60_000 });
results.gas.anchor = { gas: Number(anchored.gasUsed), gwei: Number(anchored.effectiveGasPrice) / 1e9, tx: anchorHash };
const [event] = parseEventLogs({ abi, eventName: "Anchored", logs: anchored.logs });
check("anchor succeeded when sent by someone other than the provider", anchored.status === "success", `${anchored.gasUsed} gas`);
check("ecrecover on Arc recovered the provider", event?.args.provider.toLowerCase() === provider.address.toLowerCase());

const refuses = async (name, args) => {
  try {
    await pub.simulateContract({ account: buyer, address: registry, abi, functionName: "anchor", args });
    check(name, false, "the contract accepted it");
  } catch (error) {
    check(name, /BadSignature/.test(String(error?.shortMessage ?? error) + String(error?.cause ?? "")), "reverted BadSignature");
  }
};
const wrongKey = await buyer.signTypedData({ domain, types, primaryType: "Receipt", message: single });
await refuses("refuses a signature by a key other than the named provider", [asTuple(single), provider.address, wrongKey]);
await refuses("refuses a receipt changed after it was signed", [asTuple({ ...single, bytesOut: single.bytesOut + 1n }), provider.address, signature]);

// The malleable twin: (r, n - s) with v flipped recovers the same address on
// a contract that does not check. Accepting it would give one receipt two
// distinct valid signatures.
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const r = signature.slice(2, 66);
const s = BigInt(`0x${signature.slice(66, 130)}`);
const v = parseInt(signature.slice(130, 132), 16);
const twin = `0x${r}${(N - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
await refuses("refuses the malleable twin of a valid signature", [asTuple(single), provider.address, twin]);

/* ------------------------------------------------------------- results --- */

const PER_RECEIPT_TODAY = 49_559; // measured on mainnet, ReceiptRegistry.record
const gwei = 21n; // mainnet's effective price on the measured receipts
const usd = (gas) => Number(BigInt(gas) * gwei * 1_000_000_000n) / 1e18;

console.log("\ncost per receipt, priced at mainnet's 21 gwei");
console.log(`  today, one tx each          ${PER_RECEIPT_TODAY} gas   $${usd(PER_RECEIPT_TODAY).toFixed(6)}`);
for (const [n, { gas }] of Object.entries(results.gas.commit)) {
  console.log(`  batch of ${n.padStart(3)}               ${String(Math.round(gas / n)).padStart(5)} gas   $${usd(Math.round(gas / n)).toFixed(6)}`);
}
console.log(`  anchor, one by the buyer    ${results.gas.anchor.gas} gas   $${usd(results.gas.anchor.gas).toFixed(6)}`);

const balance = await pub.getBalance({ address: provider.address });
console.log(`\nprovider testnet balance afterwards: ${formatUnits(balance, 18)} USDC`);

mkdirSync(resolve(root, "design/measurements"), { recursive: true });
const out = resolve(root, `design/measurements/${results.date.slice(0, 10)}-testnet.json`);
writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
console.log(`written to ${out.replace(root, ".").replaceAll("\\", "/")}`);
