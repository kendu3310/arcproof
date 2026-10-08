# Batched receipts — design

Status: **proposed, not built.** Nothing here is deployed. Numbers marked
*measured* came from Arc mainnet; numbers marked *estimated* are arithmetic
that has to be confirmed on testnet before anyone relies on it.

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

**EIP-712 domain:** `name "arcproof"`, `version "2"`, `chainId`,
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

**Leaf:** `keccak256(bytes.concat(keccak256(abi.encode(receipt))))`. Hashing
twice keeps a leaf from ever being the same length as an internal node, which
closes the second-preimage attack on Merkle proofs.

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

*Estimated* `commit`: base 21,000 + `LOG3` with 64 bytes ≈ 2,000 + calldata ≈
800 + overhead ≈ 1,500 — **about 25,000 gas, $0.0005 per batch**. Per receipt:

| leaves per batch | cost per receipt |
|---:|---:|
| 1 | ~$0.0005 *(half of today, from dropping the storage write)* |
| 10 | ~$0.00005 |
| 100 | ~$0.000005 |

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

## To settle before writing code

- Measure `commit` and `anchor` on Arc testnet. The table above is arithmetic.
- Confirm `ecrecover` behaves as on Ethereum on Arc. It should; check anyway.
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
