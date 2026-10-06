# arcproof

**On-chain receipts for paid API calls on Arc.** Circle's x402 SDK settles the payment. arcproof proves what was delivered for it.

Live on Arc mainnet.

**[Try it](https://kendu3310.github.io/arcproof/)** — drop in a `.glb`, watch a receipt land on mainnet, and let your own browser check it. No wallet needed; those runs are sponsored. The service sleeps when idle, so the first request after a quiet spell takes about a minute to wake.

---

## The gap

Paying for something is a solved problem on Arc. Circle's `@circle-fin/x402-batching` handles it well: a buyer funds a Gateway balance once, signs EIP-3009 authorisations offchain, and settlement is batched on-chain. No gas per call, sub-cent prices, works from any Gateway-supported chain.

But search that SDK's entire public API — `dist/server/index.d.ts`, `dist/client/index.d.ts`, `dist/index.d.ts` — for `receipt`, `attest`, `proof`, `deliverable` or `integrity`:

```
0 results
```

A buyer can prove it paid. It cannot prove what it received.

That is tolerable while a human is in the loop. A person can open a 3D model and see that the normals are wrong. **An autonomous agent cannot.** It receives bytes and has no way to distinguish careful work from a service that quietly degraded the asset to save compute. The payment rail is trustless; everything after it is a promise.

arcproof closes that gap and nothing else. It does not touch money.

## How it works

Two independent middlewares, each doing one job:

```ts
app.post("/optimize",
  gateway.require("$0.02"),     // Circle's SDK — collects the payment
  withReceipt({ writer }),      // arcproof — proves the delivery
  optimizeHandler);
```

After the handler returns, arcproof hashes the exact request and response bodies, writes both digests to a contract on Arc, and returns the transaction hash in a response header. The buyer hashes its own copies and compares:

```ts
const verified = await verifyReceipt({
  network: arcMainnet,
  registry,
  txHash: response.headers.get("x-arcproof-tx"),
  input: whatISent,
  output: whatIGotBack,
});
```

One changed byte on either side and `verified.ok` is `false`. No trust in the provider is required at any point.

## Live on Arc mainnet

| | |
|---|---|
| Network | Arc mainnet, chain `5042` |
| `ReceiptRegistry` | [`0xac9e5859d9d85e7cd37dd852ed299edefbd6aece`](https://explorer.arc.io/address/0xac9e5859d9d85e7cd37dd852ed299edefbd6aece) |
| Deployed at | block 23,587,639 · [tx](https://explorer.arc.io/tx/0x76f5391d0e0bb5ae21caa7ad55e86a826864dd638adb95e41cba60ae8a60f56c) |
| A real receipt | [`0x1c86d9c2…c1ae`](https://explorer.arc.io/tx/0x1c86d9c233bfc97a4bfe454529983b88fe321d9c81d16ff7365dd9dc2a2cc1ae) |

That receipt records a real job: a buyer paid **$0.02 USDC**, sent a GLB, received a smaller one back, and verified against mainnet that those exact bytes were what the provider committed to.

The sample model that ships with this repository — a textured globe — goes from **1.97 MB to 0.27 MB**, with **9,216 triangles and 4,753 vertices on both sides**. Not one was removed.

## What it uses Arc for

Arc is not a deployment target of convenience here. Three of its properties are load-bearing:

**USDC as native gas.** The receipt write costs a fraction of a cent, in the same asset as the payment. A proof that costs more than the thing it proves is not a product; at $0.02 per call the proof has to be this cheap or the design collapses.

**Sub-second deterministic finality.** The HTTP response is held until the receipt is mined, so the transaction hash travels back in the headers and the buyer can verify *before* acting on the bytes. On a chain with twelve-second blocks you cannot block an API response on a write, and this shape would not exist.

**x402 batching via Circle Gateway.** The buyer signs offchain and pays no gas per call, which is what makes per-request pricing viable at all. arcproof composes with that rather than replacing it.

## Try it

Requires **Node 22+** (the code runs TypeScript directly via `--experimental-strip-types`).

```bash
git clone https://github.com/kendu3310/arcproof
cd arcproof
npm install
git config core.hooksPath .githooks        # refuses to commit a key or a .env
npm test                                   # 22 tests, no network or keys needed

cp .env.example .env
node scripts/new-wallet.mjs                # writes a fresh key to .env, never prints it
# fund the printed address: faucet.circle.com for testnet
node scripts/balance.mjs                   # confirm it arrived

node --experimental-strip-types scripts/deploy-registry.mjs
node --experimental-strip-types scripts/setup-buyer.mjs

npm start --workspace examples/glb-service   # terminal 1
npm start --workspace examples/buyer-agent   # terminal 2
```

`.env` defaults to `ARC_NETWORK=arcTestnet`. Set it to `arc` for mainnet, where the money is real.

The buyer agent prints the whole exchange: the price check, the payment, the before/after numbers, the on-chain verification, and two deliberate controls — a flipped byte is rejected, and the budget guard refuses an over-limit price.

## The reference service

`examples/glb-service` optimises GLB files, and **never removes geometry**.

Decimation is the obvious way to shrink a model and the wrong thing to sell to an agent: it breaks UV seams, distorts normals and wrecks rigs, and the buyer cannot see any of it. So the pipeline only runs transforms that leave topology alone — `dedup`, `prune`, and texture re-encoding, which is where nearly all of a GLB's size lives anyway. A guard throws if triangle or vertex counts ever change, so a future edit cannot quietly break the promise the receipt attests to.

Assets it cannot guarantee are refused rather than mangled: skinned meshes and morph targets both return `415` with a reason, so an agent can pick another provider instead of retrying into the same wall.

## Known limits

- **Ratios depend heavily on the source texture.** The fixture carries a smooth 2048px texture and lands near 14% of its original size. An earlier fixture used random noise — the worst case for PNG — and reached 4%, which flattered the pipeline badly. Treat any single number as a property of the asset, not of the service.
- **WebP output requires `EXT_texture_webp`.** Loaders without it cannot open the file, so `report.requiresExtensions` says so and `textureFormat: "png"` is available for older engines.
- **Budget enforcement is client-side.** It stops *this* agent overspending. It is not a custody control.
- **Receipts are written by the provider.** A provider that never calls the service cannot forge one for you, but the registry is permissionless by design — a receipt from an address you did not pay proves nothing, which is why `verifyReceipt` takes `expectedProvider`.
- **Failure mode on a receipt write is to deliver anyway**, with `x-arcproof-error` set, because the buyer has already paid. Pass `strict: true` when an unprovable delivery is worse than none.

## Not yet done

[ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) job escrow and [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) agent identity are the natural next layers — a receipt is evidence, but it is not yet a dispute mechanism. Both were left out deliberately: Circle's ERC-8183 tutorial targets testnet and the standard is not in Arc's published mainnet address table, and depending on something that may not exist on mainnet was not a risk worth taking for a first proof.

## Layout

```
packages/arcproof/     the library: digests, receipt writer, Express middleware, verifier
contracts/             ReceiptRegistry.sol — one event, replay-protected, no owner
examples/glb-service/  a real paid service built on it
examples/buyer-agent/  an agent that pays, verifies, and enforces a budget in code
docs/                  the published verification page
scripts/               wallet, funding, deploy and smoke-test helpers
```

Licensed Apache-2.0.
