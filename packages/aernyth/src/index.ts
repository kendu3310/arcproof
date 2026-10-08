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
  arcChain,
  type ReceiptData,
  type ReceiptWriterOptions,
} from "./receipt.ts";

export {
  withReceipt,
  RECEIPT_HEADERS,
  type WithReceiptOptions,
} from "./withReceipt.ts";

export {
  verifyReceipt,
  type VerifyReceiptParams,
  type VerifiedReceipt,
} from "./verifyReceipt.ts";
