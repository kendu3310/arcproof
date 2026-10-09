# Aernyth

**On-chain receipts for paid API calls on Arc.** Circle's x402 SDK settles the payment. Aernyth records what was delivered for it, in a form the provider cannot take back.

Live on Arc mainnet, behind **[aernyth.com](https://aernyth.com)**. On npm as [`aernyth`](https://www.npmjs.com/package/aernyth), published from this repository with provenance.

```sh
npm install aernyth
```

**[Try it](https://aernyth.com)** — drop in a 3D model (`.glb`) or a photo. You get the result back with a receipt signed for the exact bytes; your browser checks the signature at once, then checks the receipt's anchor on Arc mainnet a few seconds later, then checks the result itself — triangles recounted, or the image measured. No wallet needed; those runs are sponsored. The service can sleep when idle, so a first request after a quiet spell may take about a minute.

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

```sh
npm install aernyth
```

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

**USDC as native gas.** A receipt costs about **$0.001**, in the same asset as the payment — measured, not estimated: 49,559 gas at 21 gwei, $0.00104. At $0.02 per call that is about 5% of the price. It is also the design's ceiling: at $0.001 per call the receipt costs as much as the call, and at the sub-cent prices nanopayments exist for, one transaction per request does not work. See [*Batched receipts*](#batched-receipts).

**Sub-second deterministic finality.** The HTTP response is held until the receipt is mined, so the transaction hash travels back in the headers and the buyer can verify *before* acting on the bytes. On a chain with twelve-second blocks you cannot block an API response on a write, and this shape would not exist.

**x402 batching via Circle Gateway.** The buyer signs offchain and pays no gas per call, which is what makes per-request pricing viable at all. Aernyth composes with that rather than replacing it.

## Try it

Requires **Node 22+** (the code runs TypeScript directly via `--experimental-strip-types`).

```bash
git clone https://github.com/kendu3310/arcproof
cd arcproof                                  # the repository keeps its original name
npm install
git config core.hooksPath .githooks        # refuses to commit a key or a .env
npm test                                   # 63 tests, no keys needed

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

## The reference services

Two, deliberately unlike each other, so that the receipt is not mistaken for a feature of either. What differs between them is only the buyer's acceptance check — the promise a buyer can measure for itself. The receipt is the same.

**Images** — `examples/image-service`, at `/batched/image/resize` ($0.005). The result fits the requested box, keeps the original's shape to within a pixel of rounding, is never enlarged, is in the format asked for, and carries no EXIF (where location and camera serials live). `checkResize()` measures all of that from the two files with its own decoder; the demo page does the same with the browser's. A stretched, enlarged, mislabelled, needlessly small or EXIF-carrying result fails it — each case is a test.

**3D models** — `examples/glb-service` optimises GLB files, and **never removes geometry**.

Decimation is the obvious way to shrink a model and the wrong thing to sell to an agent: it breaks UV seams, distorts normals and wrecks rigs, and the buyer cannot see any of it. So the pipeline only runs transforms that leave topology alone — `dedup`, `prune`, and texture re-encoding, which is where nearly all of a GLB's size lives anyway. A guard throws if triangle or vertex counts ever change, so a future edit cannot quietly break the promise the receipt attests to.

Assets it cannot guarantee are refused rather than mangled: skinned meshes and morph targets both return `415` with a reason, so an agent can pick another provider instead of retrying into the same wall.

## Known limits

- **Ratios depend heavily on the source texture.** The fixture carries a smooth 2048px texture and lands near 14% of its original size. An earlier fixture used random noise — the worst case for PNG — and reached 4%, which flattered the pipeline badly. Treat any single number as a property of the asset, not of the service.
- **WebP output requires `EXT_texture_webp`.** Loaders without it cannot open the file, so `report.requiresExtensions` says so and `textureFormat: "png"` is available for older engines.
- **Budget enforcement is client-side.** It stops *this* agent overspending. It is not a custody control.
- **Receipts are written by the provider**, so they attest to what it committed to, not to whether that was any good. The registry is permissionless by design — a receipt from an address you did not pay proves nothing, which is why `verifyReceipt` takes `expectedProvider`.
- **Receipts are public.** Payer, provider, sizes and digests are on chain for anyone to read. A digest does not reveal a file, but anyone who already has a file can test whether it was the one you sent. Fine for 3D assets; not for private documents.
- **A batch not yet committed lives only in the provider's memory.** A restart in that second loses it. The buyers already hold their signatures, which is enough to anchor those receipts themselves through `BatchRegistry.anchor`. Committed batches lose nothing: their leaves are on chain.
- **Failure mode on a receipt write is to deliver anyway**, with `x-aernyth-error` set, because the buyer has already paid. Pass `strict: true` when an unprovable delivery is worse than none.

## Batched receipts

One transaction per receipt does not scale to sub-cent prices, so the provider can instead sign each receipt with EIP-712 and return the signature with the bytes, then anchor many receipts at once as one Merkle root:

```ts
const anchor = new BatchAnchor({ writer, registry: batchRegistry });
app.post("/batched/optimize", raw, gateway.require("$0.02"), withReceipt({ anchor }), handler);
app.get("/receipts/:requestId", receiptProofs(anchor));
```

On testnet, 20 concurrent requests were answered in a median of 163 ms instead of the 1,042 ms an immediate receipt takes, and went into one commit costing 1,207 gas a receipt instead of 49,559. The buyer checks the signature offline the moment the bytes arrive, then the Merkle proof once the batch is committed, and keeps both: if the provider never anchors, the buyer can anchor the signed receipt itself. **[The design](design/batched-receipts.md)** has the numbers, the checks, and what it gives up — chiefly, duplicate request ids are no longer refused on chain; two conflicting signatures become proof of equivocation instead. `BatchRegistry` is deployed on mainnet at [`0x54d6e7ef…0d74`](https://explorer.arc.io/address/0x54d6e7effde253f99c944b5a6f4421b590a80d74); the hosted service has batching on, at `/batched/optimize`, `/batched/image/resize` and their `/batched/demo/…` twins, with proofs at `/receipts/<requestId>`.

**The chain keeps the proofs, not the provider.** Every commit carries the batch's leaves in its calldata, after the two arguments the contract reads; Solidity ignores the extra bytes, so the contract did not change. Anyone can rebuild any proof from the commit transaction alone — `proofFromCommit()` — or find the batch holding a leaf by scanning the provider's commits — `findAnchorProof()`. The page does the same, in the browser, for every recent batch it lists. Measured on testnet ([`2026-10-09-leaves-testnet.json`](design/measurements/2026-10-09-leaves-testnet.json)): about 1,260 gas a leaf, so a batch of 20 costs 2,415 gas a receipt instead of 1,207, and a full batch of 256 costs 1,366. Still a twentieth of an immediate receipt, and nothing is lost when a provider restarts or disappears. `publishLeaves: false` turns it off.

## Next

[ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) job escrow and [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) agent identity are the natural next layers — a receipt is evidence, but it is not yet a dispute mechanism. Both were left out deliberately: Circle's ERC-8183 tutorial targets testnet and the standard is not in Arc's published mainnet address table, and depending on something that may not exist on mainnet was not a risk worth taking for a first proof.

## Layout

```
packages/aernyth/     the library: digests, receipt writer, Express middleware, verifier
contracts/             ReceiptRegistry.sol and BatchRegistry.sol, both live on mainnet — events, no owner
examples/glb-service/  a paid 3D-model service built on it, and the server hosting both services
examples/image-service/ a paid image resize, with the buyer's own check of the result
examples/buyer-agent/  an agent that pays, verifies, and enforces a budget in code
docs/                  the published verification page, and published runs under docs/runs/
design/                design notes and measurements
.github/workflows/     tests on every push, a provider-balance alert, npm publishing from a tag
scripts/               wallet, funding, deploy and smoke-test helpers
```

Licensed Apache-2.0.
