# aernyth

On-chain delivery receipts for paid API calls on [Arc](https://arc.network).

Circle's [`@circle-fin/x402-batching`](https://www.npmjs.com/package/@circle-fin/x402-batching) settles an x402 payment, so a buyer can prove it paid. Nothing proves what it received. Aernyth commits the provider, on Arc, to the exact bytes it returned for that input and that payment. It does not touch money.

```sh
npm install aernyth
```

Node 22 or later. `express` is an optional peer, needed only for the middleware.

**Before relying on it, read [what a receipt proves](https://github.com/kendu3310/arcproof#what-a-receipt-proves-and-what-it-does-not).** In short: the provider writes the receipt, so a passing check means "this is what they committed to", never "this is good output". Quality checks are the buyer's to run.

## Provider: immediate mode

One transaction per receipt. The response waits for it, about a second on Arc, so the tx hash travels with the bytes.

```ts
import express from "express";
import { ReceiptWriter, withReceipt, arcMainnet } from "aernyth";

const writer = new ReceiptWriter({
  network: arcMainnet,
  registry: "0xac9e5859d9d85e7cd37dd852ed299edefbd6aece", // ReceiptRegistry, Arc mainnet
  privateKey: process.env.PROVIDER_PRIVATE_KEY as `0x${string}`,
});

app.post("/optimize",
  express.raw({ type: "*/*", limit: "16mb" }),
  gateway.require("$0.02"),     // Circle: takes the payment
  withReceipt({ writer }),      // Aernyth: records what was delivered
  handler);
```

The handler replies with `res.send(buffer)`, which is what the middleware intercepts and hashes. The response gains `x-aernyth-*` headers (`RECEIPT_HEADERS` lists them).

## Provider: batched mode

The receipt is signed (EIP-712) and returned at once, then anchored with others as one Merkle root, at most 256 receipts or 1 s later. Measured on Arc: 24,148 gas per batch, against 49,559 per immediate receipt.

```ts
import { BatchAnchor, receiptProofs } from "aernyth";

const anchor = new BatchAnchor({
  writer,
  registry: "0x54d6e7effde253f99c944b5a6f4421b590a80d74", // BatchRegistry, Arc mainnet
});

app.post("/optimize", raw, gateway.require("$0.02"), withReceipt({ anchor }), handler);
app.get("/receipts/:requestId", receiptProofs(anchor));
```

Pending batches and proofs are held in memory. A restart loses the ones not yet served. Buyers still hold the signature and can anchor it themselves through `BatchRegistry.anchor`.

## Buyer

Hash your own copies and check them against the chain. Pin the registry and the provider you paid: never take them from the response.

```ts
import { verifyReceipt, arcMainnet } from "aernyth";

const result = await verifyReceipt({
  network: arcMainnet,
  registry: "0xac9e5859d9d85e7cd37dd852ed299edefbd6aece",
  expectedProvider: PROVIDER,
  txHash: response.headers.get("x-aernyth-tx") as `0x${string}`,
  input: sent,
  output: received,
  paymentNonce,               // the EIP-3009 nonce you signed: binds the receipt to this payment
});
if (!result.ok) console.log(result.problems);
```

Batched receipts: `verifySignedReceipt` checks the signature offline the moment the bytes arrive. `verifyAnchoredReceipt` checks the Merkle proof from `x-aernyth-proof` once the batch is committed. Keep both the signature and the proof.

`readPaymentAuthorization(header)` reads `{ from, nonce }` out of the `Payment-Signature` header you sent.

## Receipts are public

Payer, provider, sizes and digests are on chain for anyone to read. A digest does not reveal a file, but anyone who already has a file can test whether it was yours.

## Links

- Live demo and receipt checker: https://aernyth.com
- Source, contracts, design notes and measurements: https://github.com/kendu3310/arcproof

Apache-2.0
