/**
 * Content digests and request identifiers.
 *
 * Everything here is deterministic and computed off-chain on purpose. Arc's
 * PREVRANDAO opcode always returns 0, so there is no usable on-chain
 * randomness; a request id must therefore be derived, never drawn.
 */

import { keccak256, encodePacked, type Hex } from "viem";

export type Bytes = Uint8Array | Buffer;

/**
 * keccak256 of raw bytes — the digest recorded on-chain for both the request
 * body and the response body.
 *
 * The buyer can recompute this from the file it sent and the file it got back,
 * then compare against the `Receipt` event. That comparison is the entire
 * point of this package: it turns "trust the service" into "check the chain".
 */
export function digest(data: Bytes): Hex {
  // Buffer already extends Uint8Array and keccak256 reads only the view's own
  // bytes, so a pooled Buffer needs no copy here.
  return keccak256(data);
}

/**
 * Derive a request id from the payer, a nonce and the input digest.
 *
 * Including `inputHash` binds the id to the exact bytes paid for, so a
 * provider cannot quietly reuse one id across two different inputs. Including
 * `nonce` lets the same buyer submit the same file twice and still get two
 * distinct, separately provable receipts.
 */
export function deriveRequestId(params: {
  payer: `0x${string}`;
  nonce: bigint;
  inputHash: Hex;
}): Hex {
  return keccak256(
    encodePacked(
      ["address", "uint256", "bytes32"],
      [params.payer, params.nonce, params.inputHash],
    ),
  );
}

/**
 * Byte length as a uint64, guarded.
 *
 * ReceiptRegistry stores sizes as uint64 to keep the event cheap. Anything
 * that large is a bug upstream, not a file, so fail loudly rather than
 * silently truncating a number that is meant to be evidence.
 */
export function toUint64Size(byteLength: number): bigint {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new Error(`Invalid byte length: ${byteLength}`);
  }
  const value = BigInt(byteLength);
  if (value > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`Byte length ${byteLength} exceeds uint64`);
  }
  return value;
}
