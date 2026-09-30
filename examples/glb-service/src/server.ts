/**
 * A paid service on Arc, built from two independent layers.
 *
 *   gateway.require("$0.001")   Circle's SDK — collects the payment
 *   withReceipt({ writer })     arcproof    — proves what was delivered
 *
 * Neither knows about the other. That separation is the point: payment on Arc
 * is a solved problem with an official SDK, so this repository does not
 * reimplement it. What the SDK has no concept of is the deliverable, and an
 * autonomous buyer cannot inspect a returned file to judge whether it was
 * handled honestly.
 */

import express, { type RequestHandler } from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import {
  ReceiptWriter,
  withReceipt,
  arcMainnet,
  arcTestnet,
  type ArcNetwork,
} from "arcproof";
import type { Address, Hex } from "viem";

const network: ArcNetwork =
  process.env.ARC_NETWORK === "arc" ? arcMainnet : arcTestnet;

const sellerAddress = required("SELLER_ADDRESS") as Address;
const privateKey = required("PROVIDER_PRIVATE_KEY") as Hex;
const registry = required("RECEIPT_REGISTRY_ADDRESS") as Address;
const port = Number(process.env.PORT ?? 3000);

/**
 * The facilitator defaults to mainnet even when every other setting says
 * testnet, and the resulting failure does not mention the mismatch. Pin it
 * to the network we are actually on.
 */
const facilitatorUrl = network.isTestnet
  ? "https://gateway-api-testnet.circle.com"
  : "https://gateway-api.circle.com";

const gateway = createGatewayMiddleware({
  sellerAddress,
  networks: [network.caip2],
  facilitatorUrl,
  description: "arcproof reference service",
});

const writer = new ReceiptWriter({ network, registry, privateKey });

const receipts = withReceipt({
  writer,
  onError: (error) => console.error("[receipt]", error),
});

const app = express();

// Paid routes read their input as raw bytes. The receipt has to cover exactly
// what arrived on the wire — parse it first and the digest would describe a
// re-serialisation, not the request.
const rawBody = express.raw({ type: "*/*", limit: "64mb" });

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    network: network.name,
    chainId: network.chainId,
    registry,
    provider: writer.providerAddress,
    seller: sellerAddress,
  });
});

/**
 * Smallest possible paid exchange: pay, send bytes, get the same bytes back.
 * Useless as a service, which is why it is a good test — any digest mismatch
 * here is the plumbing's fault and nothing else's.
 */
app.post(
  "/echo",
  rawBody,
  gateway.require("$0.001") as unknown as RequestHandler,
  receipts,
  (req, res) => {
    res.type("application/octet-stream").send(req.body);
  },
);

app.listen(port, () => {
  console.log(`glb-service on http://localhost:${port}`);
  console.log(`  network   ${network.name} (chain ${network.chainId})`);
  console.log(`  seller    ${sellerAddress}`);
  console.log(`  provider  ${writer.providerAddress}`);
  console.log(`  registry  ${registry}`);
  console.log(`  facilitator ${facilitatorUrl}`);
});

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set. Check .env at the repository root.`);
    process.exit(1);
  }
  return value;
}
