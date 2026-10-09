/**
 * A paid service on Arc, built from two independent layers.
 *
 *   gateway.require("$0.001")   Circle's SDK — collects the payment
 *   withReceipt({ writer })     Aernyth    — proves what was delivered
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
  RECEIPT_HEADERS,
  arcMainnet,
  arcTestnet,
  registryFromEnv,
  batchRegistryFromEnv,
  BatchAnchor,
  receiptProofs,
  registryEnvKey,
  type ArcNetwork,
} from "aernyth";
import { createPublicClient, http, parseUnits, type Address, type Hex } from "viem";
import { arcChain } from "aernyth";
import { optimizeGlb, UnsupportedAsset } from "./optimize.ts";
import { createDemoGuard } from "./demo.ts";
import { handleResize, REPORT_HEADER as IMAGE_REPORT_HEADER } from "@aernyth/image-service";

const network: ArcNetwork =
  process.env.ARC_NETWORK === "arc" ? arcMainnet : arcTestnet;

const sellerAddress = requiredAddress("SELLER_ADDRESS");
const privateKey = requiredHexKey("PROVIDER_PRIVATE_KEY");
const registry = (registryFromEnv(network) ??
  fail(
    `${registryEnvKey(network)} is not set. Deploy the registry to ${network.name} first:\n` +
      `  node --experimental-strip-types scripts/deploy-registry.mjs`,
  )) as Address;
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
  description: "Aernyth reference service",
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

// The demo runs on a 512 MB instance and anyone can call it, so it takes a
// smaller bite than the paid route does.
const demoBody = express.raw({ type: "*/*", limit: "24mb" });

// The published page lives on a different origin to this API, so the browser
// needs permission both to call it and to read the headers the receipt
// travels in. Without exposeHeaders the fetch succeeds and the page sees no
// receipt at all.
app.use((req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, payment-signature");
  // Built from the package's own list rather than typed out: a hand-kept copy
  // already fell behind once, when the payment-nonce header was added and
  // browsers silently could not read it.
  res.setHeader(
    "access-control-expose-headers",
    ["x-glb-report", IMAGE_REPORT_HEADER, "payment-response", ...Object.values(RECEIPT_HEADERS)].join(", "),
  );
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    network: network.name,
    chainId: network.chainId,
    registry,
    provider: writer.providerAddress,
    seller: sellerAddress,
    // Which commit is actually serving. Render sets this; a build that failed
    // leaves the previous deploy running, and without this there is no way to
    // tell from outside that the service is behind the repository.
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "local",
    batchRegistry: batchRegistryFromEnv(network) ?? null,
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

/**
 * The work itself. Shared by the paid route and the sponsored demo, because
 * the demo has to exercise the real path — one that skipped the on-chain
 * write, or ran a gentler pipeline, would demonstrate nothing.
 */
const handleOptimize: RequestHandler = async (req, res) => {
  try {
    const { output, report } = await optimizeGlb(req.body as Buffer, {
      maxTextureSize: Number(req.query.maxTextureSize ?? 1024),
    });

    res
      .type("model/gltf-binary")
      .setHeader("x-glb-report", JSON.stringify(report));
    res.send(output);
  } catch (error) {
    if (error instanceof UnsupportedAsset) {
      // Refusing costs the buyer the fee for a request we will not serve,
      // so say precisely why: a clear 415 lets an agent pick a different
      // provider instead of retrying into the same wall.
      res.status(415).json({ error: error.message });
      return;
    }
    console.error("[optimize]", error);
    res.status(500).json({ error: "optimisation failed" });
  }
};

/**
 * The real service: shrink a GLB without touching its geometry.
 *
 * The body is the optimised file and nothing else, because that is what the
 * receipt commits to. The before/after numbers travel in a header so they
 * cannot change the bytes being attested.
 */
app.post(
  "/optimize",
  rawBody,
  gateway.require("$0.02") as unknown as RequestHandler,
  receipts,
  handleOptimize,
);

/**
 * The same service, sponsored, so a visitor can watch it work without owning
 * USDC on Arc. Nobody has a wallet on a web page, and asking a reviewer to
 * acquire mainnet USDC before they can see anything would mean nobody ever
 * does.
 *
 * The receipt is written exactly as it is for a paying caller and names the
 * provider as payer, which is the truth: this one was paid for by us.
 */
const demoGuard = createDemoGuard({
  client: createPublicClient({ chain: arcChain(network), transport: http(network.rpcUrl) }),
  address: writer.providerAddress,
  perIpPerDay: 5,
  globalPerDay: 200,
  // Leave roughly a dollar behind so paying requests keep getting receipts
  // after the demo allowance is spent.
  minBalanceWei: parseUnits("1", 18),
});

app.get("/demo/status", (_req, res) => {
  void demoGuard.status().then((state) => res.json(state));
});

app.post(
  "/demo/optimize",
  demoBody,
  demoGuard.middleware,
  withReceipt({
    writer,
    payer: writer.providerAddress,
    onError: (error) => console.error("[demo receipt]", error),
  }),
  handleOptimize,
);

/**
 * Batched receipts, on when BATCH_REGISTRY_ADDRESS_<NETWORK> is set.
 *
 * The same two routes under /batched/: the response goes out as soon as the
 * receipt is signed, and receipts are anchored together a second or so later,
 * one transaction for up to 256. The proof is served from /receipts/<id>.
 * The unbatched routes are untouched, so turning this on changes nothing for
 * existing callers. See design/batched-receipts.md.
 */
const batchRegistry = batchRegistryFromEnv(network) as Address | undefined;
const anchor = batchRegistry
  ? new BatchAnchor({ writer, registry: batchRegistry, maxBatch: 256, maxWaitMs: 1000 })
  : undefined;

if (anchor) {
  app.post(
    "/batched/optimize",
    rawBody,
    gateway.require("$0.02") as unknown as RequestHandler,
    withReceipt({ anchor, onError: (error) => console.error("[batched receipt]", error) }),
    handleOptimize,
  );
  app.post(
    "/batched/demo/optimize",
    demoBody,
    demoGuard.middleware,
    withReceipt({ anchor, payer: writer.providerAddress, onError: (error) => console.error("[batched demo receipt]", error) }),
    handleOptimize,
  );
  app.get("/receipts/:requestId", receiptProofs(anchor));

  /**
   * A second service on the same receipts, so the receipt is not mistaken
   * for a feature of 3D optimisation. The buyer's acceptance check is
   * different — fits the box, keeps its shape, never enlarged, no EXIF — and
   * lives in examples/image-service; the receipt is identical.
   */
  app.post(
    "/batched/image/resize",
    rawBody,
    gateway.require("$0.005") as unknown as RequestHandler,
    withReceipt({ anchor, onError: (error) => console.error("[batched image receipt]", error) }),
    handleResize,
  );
  app.post(
    "/batched/demo/image/resize",
    demoBody,
    demoGuard.middleware,
    withReceipt({ anchor, payer: writer.providerAddress, onError: (error) => console.error("[batched demo image receipt]", error) }),
    handleResize,
  );
}

app.listen(port, () => {
  console.log(`reference service (3D models, images) on http://localhost:${port}`);
  console.log(`  network   ${network.name} (chain ${network.chainId})`);
  console.log(`  seller    ${sellerAddress}`);
  console.log(`  provider  ${writer.providerAddress}`);
  console.log(`  registry  ${registry}`);
  console.log(`  batching  ${anchor ? `on, BatchRegistry ${batchRegistry}` : "off"}`);
  console.log(`  facilitator ${facilitatorUrl}`);
});

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is not set. Check .env at the repository root.`);
  return value as string;
}

/**
 * Validate a private key at startup, with a message that says what is wrong.
 *
 * Passed straight to viem, a malformed key surfaces as "invalid private key,
 * expected hex or 32 bytes, got string" from inside elliptic-curve code —
 * eight frames deep, naming neither the variable nor the actual problem. The
 * usual causes are a missing 0x prefix or quotes picked up from a dashboard
 * paste, and both are two seconds to fix once you are told which one it is.
 */
function requiredHexKey(name: string): Hex {
  const raw = required(name).replace(/^["']|["']$/g, "").trim();

  if (!raw.startsWith("0x")) {
    fail(
      `${name} must start with 0x. Got ${raw.length} characters beginning "${raw.slice(0, 4)}…".
` +
        (/^[0-9a-fA-F]{64}$/.test(raw)
          ? `It looks like a valid key with the prefix missing — set it to 0x${raw.slice(0, 4)}…`
          : `Run: node scripts/copy-key.mjs`),
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    fail(
      `${name} is not a 32-byte hex key. Expected 0x followed by 64 hex characters; got ${raw.length} characters.
` +
        `A truncated paste is the usual cause. Run: node scripts/copy-key.mjs`,
    );
  }
  return raw as Hex;
}

function requiredAddress(name: string): Address {
  const raw = required(name).replace(/^["']|["']$/g, "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    fail(`${name} is not an address. Expected 0x followed by 40 hex characters; got "${raw}".`);
  }
  return raw as Address;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
