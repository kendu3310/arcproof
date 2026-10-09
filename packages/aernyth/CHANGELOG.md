# Changelog

## 0.2.1

- `ReceiptWriter` retries when the RPC rate-limits it ("Request exceeds defined limit" on Arc's public RPC), backing off up to three times. Broadcast and confirmation are now separate phases: only a failure before a transaction hash exists can cause a resend; a failure while waiting only waits again, so nothing is ever sent twice. Seen on mainnet, where a batch commit was lost to a rate limit.

## 0.2.0

- Batch commits publish their leaves in calldata, after the arguments the contract reads. `BatchRegistry` is unchanged. Proofs can now be rebuilt from the chain alone, so a provider restart or disappearance loses nothing that was committed. About 1,260 gas a leaf on Arc; `publishLeaves: false` turns it off.
- New: `proofFromCommit`, `findAnchorProof`, `decodeCommit`, `encodeLeaves`.
- `receiptProofs` rebuilds a proof from recent commits when the id is no longer in memory and the buyer passes `?leaf=0x…`.
- `BatchAnchor` exposes `network`. `ContractCall` accepts `dataSuffix`.

## 0.1.0

First release: immediate receipts (`ReceiptWriter`, `withReceipt`, `verifyReceipt`), payment binding, and batched receipts (`BatchAnchor`, `verifySignedReceipt`, `verifyAnchoredReceipt`).
