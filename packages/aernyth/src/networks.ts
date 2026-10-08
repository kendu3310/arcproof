/**
 * Arc network constants.
 *
 * Every value here was read back from the chain or from the installed
 * @circle-fin/x402-batching@3.5.0 bundle on 2026-10-01 — not copied from a
 * docs page. Arc's own docs currently disagree with themselves about whether
 * mainnet exists (llms.txt still says "Testnet only"), so the chain is the
 * only source worth trusting.
 *
 *   eth_chainId @ https://rpc.mainnet.arc.io  ->  0x13b2  (5042)
 *   eth_chainId @ https://rpc.testnet.arc.io  ->  0x4cef52 (5042002)
 */

/** CAIP-2 network identifier, the form x402 uses on the wire. */
export type Caip2 = `eip155:${number}`;

export interface ArcNetwork {
  /** Key into CHAIN_CONFIGS of @circle-fin/x402-batching. Do not rename. */
  readonly key: "arc" | "arcTestnet";
  readonly name: string;
  readonly chainId: number;
  readonly caip2: Caip2;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  /**
   * USDC's ERC-20 interface. 6 decimals.
   *
   * Arc exposes one balance through two interfaces: native (18 decimals) and
   * ERC-20 (6 decimals). They are not two tokens. x402 and EIP-3009 go through
   * the ERC-20 side, so every amount in this codebase is 6-decimal atomic
   * units. Never record a balance from the 6-decimal view: it truncates
   * sub-cent fractions and you will book less than was actually transferred.
   */
  readonly usdc: `0x${string}`;
  readonly usdcDecimals: 6;
  readonly isTestnet: boolean;
}

export const arcMainnet: ArcNetwork = {
  key: "arc",
  name: "Arc",
  chainId: 5042,
  caip2: "eip155:5042",
  rpcUrl: "https://rpc.mainnet.arc.io",
  explorerUrl: "https://explorer.arc.io",
  usdc: "0x3600000000000000000000000000000000000000",
  usdcDecimals: 6,
  isTestnet: false,
};

export const arcTestnet: ArcNetwork = {
  key: "arcTestnet",
  name: "Arc Testnet",
  chainId: 5042002,
  caip2: "eip155:5042002",
  rpcUrl: "https://rpc.testnet.arc.io",
  explorerUrl: "https://explorer.testnet.arc.io",
  usdc: "0x3600000000000000000000000000000000000000",
  usdcDecimals: 6,
  isTestnet: true,
};

export const NETWORKS = { arc: arcMainnet, arcTestnet } as const;

/**
 * Arc's mempool rejects anything below a 20 Gwei maxFeePerGas. A transaction
 * submitted under the floor does not fail loudly — it sits pending forever,
 * which is far harder to debug than a revert. Every write in this package
 * passes at least this value.
 */
export const MIN_MAX_FEE_PER_GAS_WEI = 20_000_000_000n;

export function networkFor(chainId: number): ArcNetwork {
  if (chainId === arcMainnet.chainId) return arcMainnet;
  if (chainId === arcTestnet.chainId) return arcTestnet;
  throw new Error(
    `Unsupported chain ${chainId}. Aernyth targets Arc mainnet (5042) or Arc testnet (5042002).`,
  );
}

/**
 * Environment variable holding the registry address for a given network.
 *
 * Per-network on purpose. A single shared variable survives a switch from
 * testnet to mainnet unchanged, and the app then reads receipts from an
 * address that exists on the other chain — where it resolves to no contract at
 * all, or worse, to something unrelated. Naming the network makes the mistake
 * impossible to make silently.
 */
export function registryEnvKey(network: ArcNetwork): string {
  return `RECEIPT_REGISTRY_ADDRESS_${network.key.toUpperCase()}`;
}

/** Read the registry address for `network` from an environment map. */
export function registryFromEnv(
  network: ArcNetwork,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env[registryEnvKey(network)]?.trim() || undefined;
}

export function txUrl(network: ArcNetwork, txHash: string): string {
  return `${network.explorerUrl}/tx/${txHash}`;
}

export function addressUrl(network: ArcNetwork, address: string): string {
  return `${network.explorerUrl}/address/${address}`;
}
