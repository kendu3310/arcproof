# Aernyth

**On-chain receipts for paid API calls on Arc.** Circle's x402 SDK settles the payment. Aernyth records what was delivered for it, in a form the provider cannot take back.

Live on Arc mainnet, behind **[aernyth.com](https://aernyth.com)**.

**[Try it](https://aernyth.com)** — drop in a `.glb`, watch a receipt land on mainnet, and let your own browser check it. No wallet needed; those runs are sponsored. The service sleeps when idle, so the first request after a quiet spell takes about a minute to wake.

---

## The gap

Paying for something is a solved problem on Arc. Circle's `@circle-fin/x402-batching` handles it well: a buyer funds a Gateway balance once, signs EIP-3009 authorisations offchain, and settlement is batched on-chain. No gas per call, sub-cent prices, works from any Gateway-supported chain.

But search that SDK's entire public API — `dist/server/index.d.ts`, `dist/client/index.d.ts`, `dist/index.d.ts` — for `receipt`, `attest`, `proof`, `deliverable` or `integrity`:

```
0 results
```

A buyer can prove it paid. It cannot prove what it received.

That is tolerable while a human is in the loop. A person can open a 3D model and see that the normals are wrong. **An autonomous agent cannot.** It receives bytes, and if they turn out to be bad there is nothing that ties them to the provider: the provider can say it sent something else, and nobody can show otherwise.

Aernyth fixes that part and nothing else. It does not touch money, and it does not judge quality — see [what a receipt proves](#what-a-receipt-proves-and-what-it-does-not), which is the section to read before trusting any of this.

## How it works

Two independent middlewares, each doing one job:

```ts
app.post("/optimize",
  gateway.require("$0.02"),     // Circle's SDK — collects the payment
  withReceipt({ writer }),      // Aernyth — proves the delivery
  optimizeHandler);
```

After the handler returns, Aernyth hashes the exact request and response bodies, writes both digests to a contract on Arc, and returns the transaction hash in a response header. The buyer hashes its own copies and compares:

```ts
const verified = await verifyReceipt({
  network: arcMainnet,
  registry,
  txHash: response.headers.get("x-aernyth-tx"),
  input: whatISent,
  output: whatIGotBack,
});
```

One changed byte on either side and `verified.ok` is `false`. Pass the nonce of the payment you signed as `paymentNonce` and it also fails a receipt that was not written for that payment.

## What a receipt proves, and what it does not

The provider writes the receipt. Hold on to that, because everything follows from it.

**A passing check proves** the provider committed — in a transaction only its key could sign, and which it cannot revise — to having returned exactly these bytes, for exactly that input, to this payer, for this payment. Afterwards it cannot claim it sent something else. Anyone holding the two files can show what it delivered.

**A passing check does not prove the output is any good.** A provider that returns a broken file and records the broken file's hash passes every check `verifyReceipt` makes. Matching digests mean "this is what they committed to", not "this is what you wanted".

**What a failing check catches:** bytes changed between the provider's commitment and you, a provider whose served output differs from what it logged, and a receipt lifted from some other payment.

Quality is a separate check, made against the content and run by the buyer. The reference service shows the pattern: its promise is that geometry is never removed, and the demo page does not take the service's word for that — it loads both models and recounts the triangles itself. A check like that is what lets an agent reject bad output automatically; the receipt is what makes the rejection stick to the provider who caused it.

## Binding a receipt to its payment

A receipt names its payer, but a payer can buy the same thing many times, so the payer alone does not say which purchase a receipt belongs to.

The request id is therefore derived from the payment itself:

```
requestId = keccak256(abi.encodePacked(address payer, uint256 nonce, bytes32 inputHash))
```

where `nonce` is the EIP-3009 authorization nonce in the buyer's `Payment-Signature` header. The buyer generated it and signed it, and Gateway will not settle the same nonce twice — that is EIP-3009's replay protection — so no other payment can produce the same id. The buyer recomputes it from values it already holds, trusting nothing the provider sent.

The settlement reference Circle's SDK exposes looks like the natural anchor and is not one. Its doc comment calls it a transaction hash; on mainnet it comes back as a UUID, because Gateway settles in batches and nothing has moved on chain when the service answers. Only Circle can look it up.

Binding costs nothing: the bound receipt below used 49,559 gas, the same as an unbound one.

## Live on Arc mainnet

| | |
|---|---|
| Network | Arc mainnet, chain `5042` |
| `ReceiptRegistry` | [`0xac9e5859d9d85e7cd37dd852ed299edefbd6aece`](https://explorer.arc.io/address/0xac9e5859d9d85e7cd37dd852ed299edefbd6aece) |
| Deployed at | block 23,587,639 · [tx](https://explorer.arc.io/tx/0x76f5391d0e0bb5ae21caa7ad55e86a826864dd638adb95e41cba60ae8a60f56c) |
| A paid, bound receipt | [`0x88b3f321…5feb6cc6`](https://aernyth.com/?tx=0x88b3f3210115fab48f6f71c809b1e454389faadbb6fcc242657d920c5feb6cc6#verify) |

That receipt records a real job: a buyer paid **$0.02 USDC** for the globe in this repo and received a smaller one back. **[Both files, the transcript and a walkthrough for checking it by hand](docs/runs/2026-10-08-paid/)** are published, so you can confirm it with any keccak256 and any RPC — none of this repository's code required.

The sample model that ships with this repository — a textured globe — goes from **1.97 MB to 0.27 MB**, with **9,216 triangles and 4,753 vertices on both sides**. Not one was removed.

## What it uses Arc for

Arc is not a deployment target of convenience here. Three of its properties are load-bearing:

**USDC as native gas.** A receipt costs about **$0.001**, in the same asset as the payment — measured, not estimated: 49,559 gas at 21 gwei, $0.00104. At $0.02 per call that is about 5% of the price. It is also the design's ceiling: at $0.001 per call the receipt costs as much as the call, and at the sub-cent prices nanopayments exist for, one transaction per request does not work. See *Not yet done*.

**Sub-second deterministic finality.** The HTTP response is held until the receipt is mined, so the transaction hash travels back in the headers and the buyer can verify *before* acting on the bytes. On a chain with twelve-second blocks you cannot block an API response on a write, and this shape would not exist.

**x402 batching via Circle Gateway.** The buyer signs offchain and pays no gas per call, which is what makes per-request pricing viable at all. Aernyth composes with that rather than replacing it.

## Try it

Requires **Node 22+** (the code runs TypeScript directly via `--experimental-strip-types`).

```bash
git clone https://github.com/kendu3310/arcproof
cd arcproof                                  # the repository keeps its original name
npm install
git config core.hooksPath .githooks        # refuses to commit a key or a .env
npm test                                   # 32 tests, no network or keys needed

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
- **Receipts are written by the provider**, so they attest to what it committed to, not to whether that was any good. The registry is permissionless by design — a receipt from an address you did not pay proves nothing, which is why `verifyReceipt` takes `expectedProvider`.
- **Receipts are public.** Payer, provider, sizes and digests are on chain for anyone to read. A digest does not reveal a file, but anyone who already has a file can test whether it was the one you sent. Fine for 3D assets; not for private documents.
- **Failure mode on a receipt write is to deliver anyway**, with `x-aernyth-error` set, because the buyer has already paid. Pass `strict: true` when an unprovable delivery is worse than none.

## Not yet done

**One transaction per receipt does not scale to sub-cent prices.** The fix is to batch: collect receipts for a second or two, write one Merkle root, and hand each buyer its leaf and proof. A batch of N cuts the cost per receipt by N, at the price of the receipt arriving shortly after the bytes rather than with them. Arc's half-second blocks are what make a window that short practical. Not built yet — **[the design](design/batched-receipts.md)** comes first, including what it gives up and why.

[ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) job escrow and [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) agent identity are the natural next layers — a receipt is evidence, but it is not yet a dispute mechanism. Both were left out deliberately: Circle's ERC-8183 tutorial targets testnet and the standard is not in Arc's published mainnet address table, and depending on something that may not exist on mainnet was not a risk worth taking for a first proof.

## Layout

```
packages/aernyth/     the library: digests, receipt writer, Express middleware, verifier
contracts/             ReceiptRegistry.sol — one event, replay-protected, no owner
examples/glb-service/  a real paid service built on it
examples/buyer-agent/  an agent that pays, verifies, and enforces a budget in code
docs/                  the published verification page, and published runs under docs/runs/
design/                proposals not yet built
scripts/               wallet, funding, deploy and smoke-test helpers
```

Licensed Apache-2.0.
