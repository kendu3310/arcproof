/**
 * Read the provider wallet's USDC balance on Arc, through both interfaces.
 *
 * USDC on Arc is one balance behind two views: a native one with 18 decimals
 * and an ERC-20 one with 6. Reading only the ERC-20 view is how you convince
 * yourself a funded wallet is empty, because that view truncates anything below
 * a millionth of a dollar and returns 0 for dust. This prints both and checks
 * they agree, so a mismatch surfaces here rather than as a mystery later.
 *
 *   node scripts/balance.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, formatUnits, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const NETWORKS = [
  {
    name: "Arc mainnet",
    chainId: 5042,
    rpcUrl: "https://rpc.mainnet.arc.io",
    explorer: "https://explorer.arc.io",
  },
  {
    name: "Arc testnet",
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.io",
    explorer: "https://explorer.testnet.arc.io",
  },
];

const USDC = "0x3600000000000000000000000000000000000000";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
if (!existsSync(envPath)) {
  console.error("No .env found. Run `node scripts/new-wallet.mjs` first.");
  process.exit(1);
}
const env = readFileSync(envPath, "utf8");
const key = env.match(/^PROVIDER_PRIVATE_KEY=(.*)$/m)?.[1]?.trim();
if (!key) {
  console.error("PROVIDER_PRIVATE_KEY is empty in .env.");
  process.exit(1);
}

const provider = privateKeyToAccount(key).address;
const seller = env.match(/^SELLER_ADDRESS=(.*)$/m)?.[1]?.trim();

console.log(`provider  ${provider}`);
console.log(`seller    ${seller || "(not set)"}\n`);

for (const network of NETWORKS) {
  const client = createPublicClient({
    chain: {
      id: network.chainId,
      name: network.name,
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [network.rpcUrl] } },
    },
    transport: http(network.rpcUrl),
  });

  try {
    const [native, erc20] = await Promise.all([
      client.getBalance({ address: provider }),
      client.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [provider],
      }),
    ]);

    // The native value carries 12 more digits of precision. Truncating it to
    // 6 decimals must reproduce the ERC-20 view exactly; if it does not, one
    // of the two reads is pointed at the wrong thing.
    const expectedErc20 = native / 1_000_000_000_000n;
    const agree = expectedErc20 === erc20;

    console.log(`${network.name} (chain ${network.chainId})`);
    console.log(`  native 18dp   ${formatUnits(native, 18)} USDC`);
    console.log(`  erc20  6dp    ${formatUnits(erc20, 6)} USDC`);
    console.log(`  views agree   ${agree ? "yes" : `NO (erc20 expected ${expectedErc20}, got ${erc20})`}`);
    console.log(
      `  status        ${native === 0n ? "EMPTY — fund this wallet" : "funded"}`,
    );
    console.log(`  ${network.explorer}/address/${provider}\n`);
  } catch (error) {
    console.log(`${network.name} (chain ${network.chainId})`);
    console.log(`  unreachable: ${error.shortMessage ?? error.message}\n`);
  }
}
