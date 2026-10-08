# Batched receipts — design

Status: **built, and run end to end on Arc testnet; off on mainnet.**
[`contracts/src/BatchRegistry.sol`](../contracts/src/BatchRegistry.sol) is
deployed on testnet at `0xb0f2c2454e8cc3d3e69250e6cebe50c568f1f837`. The
package implements it (`BatchAnchor`, `withReceipt({ anchor })`,
`verifySignedReceipt`, `verifyAnchoredReceipt`), the reference service turns it
on when `BATCH_REGISTRY_ADDRESS_<NETWORK>` is set, and the buyer agent handles
it with `RECEIPT_MODE=batched`. Nothing on mainnet uses it yet.

End to end on testnet ([`scripts/e2e-batch.mjs`](../scripts/e2e-batch.mjs)): 20
concurrent requests were answered in a median of **163 ms** against **1,042 ms**
for one immediate-mode request held for its block, all 20 went into **one**
commit of 24,148 gas — **1,207 gas a receipt** against 49,559 — and every
signature and every Merkle proof checked. A real x402 payment through the
batched route came back signed, payment-bound and anchored, and the evidence
the agent kept was enough on its own to anchor the receipt from the buyer's
account. Every number below is *measured*, on mainnet for
today's registry and on testnet for this one, by
[`scripts/measure-batch.mjs`](../scripts/measure-batch.mjs); the raw results are
in [`measurements/`](measurements/).

## The problem

Every receipt today is its own transaction.

| | |
|---|---|
| Gas per receipt | 49,559 *(measured, two mainnet receipts)* |
| Cost per receipt | $0.00104 at 21 gwei *(measured)* |
| Share of a $0.02 call | ~5% |
| Share of a $0.001 call | ~104% |
| Share of a $0.0001 call | ~1,040% |

Nanopayments exist for the bottom two rows, and so does most of Arc's pitch.
One transaction per request cannot serve them.

Where the gas goes *(estimated; sums to within 0.3% of the measured figure)*:

| | gas | |
|---|---:|---|
| Transaction base | 21,000 | unavoidable per transaction |
| `recorded[requestId] = true` | 22,100 | **45%** — the duplicate-id guard |
| `Receipt` event, 4 topics + 160 bytes | 3,155 | the evidence itself |
| Calldata | ~3,100 | |

The evidence costs about 3,000 gas. Nearly everything else is overhead that
batching amortises — the base fee — or that a different guarantee can
replace — the storage write.

## What has to survive

| Property | Today | Batched |
|---|---|---|
| Provider cannot deny the delivery | tx signed by provider | **EIP-712 signature** by provider, plus root committed by provider |
| Buyer verifies without trusting the provider | yes | yes |
| Bound to the payment | `requestId` from the EIP-3009 nonce | unchanged |
| Public, timestamped record | event in the receipt's own tx | root in a batch tx, leaf proven by Merkle path |
| Evidence available when the bytes arrive | yes — response held until mined | **signature yes; chain anchor a moment later** |
| One receipt per request id | **prevented** on chain | **not prevented; equivocation provable** (below) |

Two rows change, and both changes are deliberate.

## The idea in one paragraph

A signed receipt already gives non-repudiation, at zero gas. If the provider
signs `(requestId, payer, inputHash, outputHash, bytesIn, bytesOut)` with
EIP-712 and hands the signature over with the bytes, anyone can later recover
the provider's address from it, and the provider cannot say it sent something
else. What the chain adds on top is **time and publicity**: proof the
commitment existed by a certain block, visible to people who were not party to
the exchange. Those do not need a transaction each. So: sign every receipt
immediately, and anchor them on chain in batches a second or two later, as one
Merkle root.

## Flow

```
request  ──►  provider serves bytes
              │
              ├─ signs receipt (EIP-712)              ── in the response, now
              │
              └─ adds leaf to the open batch
                    │
          every T ms or N leaves, whichever first
                    │
                    ▼
              commit(root, count)  ── one Arc tx for the whole batch
                    │
buyer fetches  GET /receipts/{requestId}  →  { root, commitTx, proof[] }
```

The response carries everything the buyer needs to check non-repudiation at
once. The anchor follows; Arc's half-second blocks are what make a window of a
second or two practical, and on a chain with twelve-second blocks this window
would be uncomfortable.

At low traffic a batch holds one leaf and costs what a receipt costs today. The
saving appears exactly where it is needed: at volume.

## Formats

**EIP-712 domain:** `name "Aernyth"`, `version "2"`, `chainId`,
`verifyingContract` = the batch registry. Binding the signature to chain and
contract stops a receipt signed for testnet from being replayed as a mainnet
one.

**Struct:**

```solidity
struct Receipt {
    bytes32 requestId;   // keccak256(payer, paymentNonce, inputHash), as today
    address payer;
    bytes32 inputHash;
    bytes32 outputHash;
    uint64  bytesIn;
    uint64  bytesOut;
}
```

**Leaf:** `keccak256(abi.encodePacked(structHash(receipt)))` — the EIP-712
struct hash, hashed again. One value serves both the signature and the tree,
and because the struct hash includes the type hash, a leaf cannot collide with
any other kind of data. Hashing twice keeps a leaf from ever being the same
length as an internal node, which closes the second-preimage attack on Merkle
proofs.

**Tree:** sorted-pair hashing, as in OpenZeppelin's `MerkleProof`. Verifiers
exist in every language people will build agents in, so nobody has to trust
ours.

## Contract

```solidity
event Batch(bytes32 indexed root, address indexed provider, uint32 count, uint64 timestamp);
event Anchored(bytes32 indexed requestId, address indexed provider, address indexed payer,
               bytes32 inputHash, bytes32 outputHash, uint64 bytesIn, uint64 bytesOut, uint64 timestamp);

/// The provider commits a batch. msg.sender is the provider: only its key can.
function commit(bytes32 root, uint32 count) external;

/// Anyone anchors a single receipt the provider signed. See "If the provider
/// stops anchoring".
function anchor(Receipt calldata receipt, address provider, bytes calldata signature) external;
```

No storage at all — events only. Roots are found by transaction hash, the way
receipts already are, because the public RPC refuses `eth_getLogs` across more
than ~5,000 blocks.

`commit` costs **24,160 gas whatever the batch size** — the root is 32 bytes
whether it covers one receipt or 256. The estimate before measuring was 25,300;
it was 5% high. Priced at mainnet's 21 gwei:

| | gas per receipt | cost per receipt | vs today |
|---|---:|---:|---:|
| Today, one transaction each | 49,559 | $0.001041 | — |
| Batch of 1 | 24,160 | $0.000507 | 2× cheaper |
| Batch of 16 | 1,510 | $0.000032 | 33× |
| Batch of 256 | 94 | $0.000002 | 527× |
| `anchor`, one receipt, sent by the buyer | 34,157 | $0.000717 | 1.5× |

What that does to a call's price:

| price per call | receipt today | batch of 16 | batch of 256 |
|---:|---:|---:|---:|
| $0.02 | 5% | 0.2% | 0.01% |
| $0.001 | 104% | 3% | 0.2% |
| $0.0001 | 1,041% | 32% | 2% |

Sub-cent calls become viable, but only at volume — at a tenth of a cent, a
provider needs a batch of about 16 inside its window before the receipt stops
costing a meaningful share of the price. A quiet provider pays what a single
receipt costs, which is still half of today.

Even the fallback is cheaper than now: anchoring a single signed receipt from
outside costs less than `ReceiptRegistry.record`, because it writes no storage.

## If the provider stops anchoring

A provider could sign receipts and then never commit the root. The buyer still
holds a signature it cannot repudiate, but has no public timestamp.

`anchor()` closes that hole. It verifies the provider's EIP-712 signature with
`ecrecover` and emits the receipt — paid for by whoever calls it. A buyer whose
receipt has not appeared in a batch after a reasonable delay anchors it
itself. The provider loses the ability to keep a delivery off the record by
doing nothing.

## What gets weaker, and why that is acceptable

**Duplicate request ids are no longer refused on chain.** Today the registry
rejects a second receipt under an id it has seen. That costs 22,100 gas per
receipt, and a batch commit cannot check its leaves without paying it per leaf.

What replaces it: a provider that signs two different receipts for the same
paid request has produced two signatures over conflicting statements. Either
one, shown beside the other, is a public and attributable proof of
equivocation. The buyer holds the one that matches its bytes. Prevention
becomes detection — the property a reputation system or an arbiter actually
consumes.

**The chain anchor arrives after the bytes.** The signature does not, so the
non-repudiation a buyer needs before acting is there immediately. A buyer that
insists on the anchor before acting can wait for it: one window plus one
block.

## Settled on testnet

Checked by `scripts/measure-batch.mjs` against the deployed contract, all
passing:

- JavaScript (viem) and Solidity agree on the struct hash, the EIP-712 digest
  and the Merkle leaf. A verifier that hashed differently from the contract
  would prove nothing.
- The root read back from the `Batch` event is the root built off chain, and
  the batch is attributed to the provider.
- A proof for one receipt out of 256 (8 siblings) reaches that root, and the
  same proof fails if one field of the receipt changes.
- `anchor` succeeds when sent by an account other than the provider, and
  `ecrecover` on Arc recovers the provider.
- `anchor` refuses a signature by the wrong key, a receipt altered after
  signing, and the malleable twin `(r, n − s)` of a valid signature.

## Still open

- Window policy: fixed T, fixed N, or both. Start with both — T = 1 s,
  N = 256 — and measure.
- Where proofs live. `GET /receipts/{id}` puts the provider in charge of
  serving its own evidence; a provider that goes offline takes the proofs with
  it. The buyer should store its proof the moment it has one, and the reference
  client should do that by default.
- Whether "hold the response until anchored" survives as an option for callers
  that want the old behaviour. Probably yes, as `mode: "immediate"`, on the
  existing registry.

## Not in scope

Escrow, disputes and arbitration. This design produces evidence that a dispute
process would consume — equivocation proofs, payment-bound signed receipts —
and deliberately stops there.
