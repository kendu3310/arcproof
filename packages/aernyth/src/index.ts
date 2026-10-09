/**
 * Aernyth — on-chain receipts for paid API calls on Arc.
 *
 * Circle's @circle-fin/x402-batching settles the payment. It has no notion of
 * a deliverable: nothing in its public API mentions receipts, attestation or
 * integrity. So a buyer can prove it paid, and cannot prove what it got.
 *
 * Aernyth fills exactly that gap and nothing else. It does not handle money.
 */

export {
  arcMainnet,
  arcTestnet,
  networkFor,
  registryEnvKey,
  registryFromEnv,
  batchRegistryEnvKey,
  batchRegistryFromEnv,
  txUrl,
  addressUrl,
  NETWORKS,
  MIN_MAX_FEE_PER_GAS_WEI,
  type ArcNetwork,
  type Caip2,
} from "./networks.ts";

export {
  digest,
  deriveRequestId,
  toUint64Size,
  type Bytes,
} from "./digest.ts";

export {
  readPaymentAuthorization,
  requestIdForPayment,
  PAYMENT_HEADER,
  type PaymentAuthorization,
} from "./payment.ts";

export {
  ReceiptWriter,
  receiptRegistryAbi,
  type ContractCall,
  arcChain,
  type ReceiptData,
  type ReceiptWriterOptions,
} from "./receipt.ts";

export {
  BatchAnchor,
  batchRegistryAbi,
  type AnchorProof,
  type AnchorStatus,
  type SignedReceipt,
  type BatchAnchorOptions,
} from "./batch.ts";

export {
  receiptDomain,
  receiptStructHash,
  receiptLeaf,
  receiptDigest,
  signReceipt,
  recoverReceiptSigner,
  RECEIPT_TYPES,
  type ReceiptDomain,
} from "./signed.ts";

export {
  encodeLeaves,
  decodeCommit,
  proofFromCommit,
  findAnchorProof,
  type DecodedCommit,
  type ProofFromCommitParams,
  type FindAnchorProofParams,
} from "./recover.ts";

export { buildTree, proofFor, verifyProof, type MerkleTree } from "./merkle.ts";

export {
  verifySignedReceipt,
  verifyAnchoredReceipt,
  type VerifySignedParams,
  type VerifiedSigned,
  type VerifyAnchoredParams,
  type VerifiedAnchored,
} from "./verifyBatch.ts";

export {
  withReceipt,
  receiptProofs,
  RECEIPT_HEADERS,
  type WithReceiptOptions,
} from "./withReceipt.ts";

export {
  verifyReceipt,
  type VerifyReceiptParams,
  type VerifiedReceipt,
} from "./verifyReceipt.ts";
