/**
 * Signed receipts: the provider's EIP-712 signature over what it delivered.
 *
 * A signature on its own already gives the property that matters most — the
 * provider cannot later deny having delivered these bytes for that input — at
 * no gas at all. What the chain adds is a public timestamp, and that can be
 * batched; see batch.ts and design/batched-receipts.md.
 *
 * The domain is bound to the chain and to the BatchRegistry contract, so a
 * receipt signed for testnet cannot be passed off as a mainnet one. Every
 * hash here is the same one BatchRegistry computes; scripts/measure-batch.mjs
 * checks that against the deployed contract.
 */

import {
  encodeAbiParameters,
  encodePacked,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import type { ReceiptData } from "./receipt.ts";

export const RECEIPT_TYPES = {
  Receipt: [
    { name: "requestId", type: "bytes32" },
    { name: "payer", type: "address" },
    { name: "inputHash", type: "bytes32" },
    { name: "outputHash", type: "bytes32" },
    { name: "bytesIn", type: "uint64" },
    { name: "bytesOut", type: "uint64" },
  ],
} as const;

const RECEIPT_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "Receipt(bytes32 requestId,address payer,bytes32 inputHash,bytes32 outputHash,uint64 bytesIn,uint64 bytesOut)",
  ),
);

export interface ReceiptDomain {
  name: "Aernyth";
  version: "2";
  chainId: number;
  verifyingContract: Address;
}

export function receiptDomain(chainId: number, batchRegistry: Address): ReceiptDomain {
  return { name: "Aernyth", version: "2", chainId, verifyingContract: batchRegistry };
}

/** The EIP-712 struct hash, as BatchRegistry.structHash computes it. */
export function receiptStructHash(receipt: ReceiptData): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "uint64" },
      ],
      [
        RECEIPT_TYPEHASH,
        receipt.requestId,
        receipt.payer,
        receipt.inputHash,
        receipt.outputHash,
        receipt.bytesIn,
        receipt.bytesOut,
      ],
    ),
  );
}

/**
 * The Merkle leaf: the struct hash hashed again. One value serves the
 * signature and the tree, and hashing twice means a leaf is never the same
 * shape as an inner node — the second-preimage trick on Merkle proofs needs
 * exactly that.
 */
export function receiptLeaf(receipt: ReceiptData): Hex {
  return keccak256(encodePacked(["bytes32"], [receiptStructHash(receipt)]));
}

/** The digest the provider signs. */
export function receiptDigest(domain: ReceiptDomain, receipt: ReceiptData): Hex {
  return hashTypedData({ domain, types: RECEIPT_TYPES, primaryType: "Receipt", message: receipt });
}

export function signReceipt(
  account: LocalAccount,
  domain: ReceiptDomain,
  receipt: ReceiptData,
): Promise<Hex> {
  return account.signTypedData({ domain, types: RECEIPT_TYPES, primaryType: "Receipt", message: receipt });
}

/** Who signed this receipt. Throws on a malformed signature. */
export function recoverReceiptSigner(
  domain: ReceiptDomain,
  receipt: ReceiptData,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({
    domain,
    types: RECEIPT_TYPES,
    primaryType: "Receipt",
    message: receipt,
    signature,
  });
}
