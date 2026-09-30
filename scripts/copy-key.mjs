/**
 * Copy the provider private key from .env to the clipboard, without showing it.
 *
 * Selecting the key by hand in an editor is where it usually goes wrong: you
 * catch the `PROVIDER_PRIVATE_KEY=` prefix, or a trailing newline, or miss the
 * last character, and the wallet rejects the paste with an unhelpful error.
 * This reads the value, checks its shape, and puts exactly those characters on
 * the clipboard — nothing is printed.
 *
 *   node scripts/copy-key.mjs            # 0x-prefixed (what most wallets want)
 *   node scripts/copy-key.mjs --raw      # no 0x, for wallets that reject it
 *
 * Remember what this key is: the hot key your server signs with. Importing it
 * into a browser wallet is fine for looking at the balance, but keep the
 * balance small and never reuse this key for anything you care about.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");

if (!existsSync(envPath)) {
  console.error("No .env found. Run `node scripts/new-wallet.mjs` first.");
  process.exit(1);
}

const raw = readFileSync(envPath, "utf8")
  .match(/^PROVIDER_PRIVATE_KEY=(.*)$/m)?.[1]
  ?.trim();

if (!raw) {
  console.error("PROVIDER_PRIVATE_KEY is empty in .env.");
  process.exit(1);
}

// Validate before copying. A malformed key pasted into a wallet produces a
// generic "invalid private key" that tells you nothing about which end is at
// fault; better to find out here.
const withPrefix = raw.startsWith("0x") ? raw : `0x${raw}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
  console.error(
    `PROVIDER_PRIVATE_KEY is not a 32-byte hex key (got ${withPrefix.length} chars).\n` +
      `Expected 0x followed by 64 hex characters.`,
  );
  process.exit(1);
}

const account = privateKeyToAccount(withPrefix);
const wantRaw = process.argv.includes("--raw");
const toCopy = wantRaw ? withPrefix.slice(2) : withPrefix;

const copied = copyToClipboard(toCopy);

if (!copied) {
  console.error(
    "Could not reach the clipboard on this system.\n" +
      "Open .env in your editor and copy the value after the `=` by hand —\n" +
      "the value only, with no `PROVIDER_PRIVATE_KEY=` prefix and no trailing spaces.",
  );
  process.exit(1);
}

console.log(`Private key copied to clipboard${wantRaw ? " (no 0x prefix)" : ""}.

  address   ${account.address}

Paste it into MetaMask under: account menu -> Add account or hardware wallet
-> Import account -> Private Key. If the wallet rejects it, run this again
with --raw; some wallets refuse the 0x prefix.

Clear your clipboard when you are done — copy anything else over it.`);

function copyToClipboard(text) {
  const candidates =
    process.platform === "win32"
      ? [["clip", []]]
      : process.platform === "darwin"
        ? [["pbcopy", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];

  for (const [cmd, args] of candidates) {
    const result = spawnSync(cmd, args, { input: text });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}
