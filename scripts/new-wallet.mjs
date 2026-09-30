/**
 * Generate a fresh provider wallet and write it straight into .env.
 *
 * The private key is never printed. Anything printed to a terminal lives on in
 * scrollback, in the editor's output pane, and in any screen recording or
 * screenshot taken afterwards — which is exactly how keys leak. So the key goes
 * from crypto.getRandomValues into the file and nowhere else; only the public
 * address comes back to you.
 *
 *   node scripts/new-wallet.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
const examplePath = resolve(root, ".env.example");

const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

// Refuse to clobber a key that may already hold money. Overwriting a funded
// key loses the funds permanently: there is no recovery and no undo.
const current = existing.match(/^PROVIDER_PRIVATE_KEY=(.*)$/m)?.[1]?.trim();
if (current) {
  const account = privateKeyToAccount(current);
  console.error(
    `.env already has a PROVIDER_PRIVATE_KEY (address ${account.address}).\n` +
      `Refusing to overwrite it — if that wallet holds USDC, replacing the key\n` +
      `loses it for good. Delete the line by hand first if you really mean to.`,
  );
  process.exit(1);
}

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

const base = existing || readFileSync(examplePath, "utf8");
const next = base.includes("PROVIDER_PRIVATE_KEY=")
  ? base.replace(/^PROVIDER_PRIVATE_KEY=.*$/m, `PROVIDER_PRIVATE_KEY=${privateKey}`)
  : `${base.trimEnd()}\nPROVIDER_PRIVATE_KEY=${privateKey}\n`;

writeFileSync(envPath, next, { encoding: "utf8", mode: 0o600 });

console.log(`Wrote a new provider wallet to .env

  address   ${account.address}

Fund it with a small amount of USDC on Arc — a few dollars is plenty, since
gas targets about $0.001 per transfer. This wallet signs automatically inside
the server, so assume its key can leak and keep the balance small.

  mainnet   https://explorer.arc.io/address/${account.address}
  testnet   https://explorer.testnet.arc.io/address/${account.address}
            faucet: https://faucet.circle.com

The private key is in .env, which is gitignored. It was not printed here.`);
