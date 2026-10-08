/**
 * The browser's own check of a batched receipt.
 *
 * Nothing here comes from the aernyth package. The EIP-712 hashing is written
 * out by hand over js-sha3's keccak256, and signatures are recovered with
 * @noble/curves, so the page reaches its verdict without running any of the
 * provider's code. test/page-batched.test.mjs runs this exact file against the
 * package and against real mainnet data to show they agree.
 *
 * Two checks, at two moments:
 *   checkSignature — as soon as the bytes arrive: rebuild the receipt from the
 *     file you sent and the file you got, and recover who signed it
 *   checkAnchor — once the batch is committed: find the root in the pinned
 *     registry's Batch event and walk the Merkle proof up to it
 */
import { secp256k1 } from "@noble/curves/secp256k1";

const keccak = (bytes) => "0x" + globalThis.keccak256(bytes);
const text = (s) => keccak(new TextEncoder().encode(s));

function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** One 32-byte ABI word, from a hex value or a bigint/number. */
function word(value) {
  const hex = typeof value === "string" ? value.slice(2).toLowerCase() : BigInt(value).toString(16);
  return hex.padStart(64, "0");
}
const words = (...values) => hexToBytes(values.map(word).join(""));

const DOMAIN_TYPEHASH = text("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
const RECEIPT_TYPEHASH = text(
  "Receipt(bytes32 requestId,address payer,bytes32 inputHash,bytes32 outputHash,uint64 bytesIn,uint64 bytesOut)",
);
const BATCH_TOPIC = text("Batch(bytes32,address,uint32,uint64)");

export function domainSeparator(chainId, registry) {
  return keccak(words(DOMAIN_TYPEHASH, text("Aernyth"), text("2"), chainId, registry));
}

export function structHash(r) {
  return keccak(words(RECEIPT_TYPEHASH, r.requestId, r.payer, r.inputHash, r.outputHash, r.bytesIn, r.bytesOut));
}

/** The Merkle leaf: the struct hash, hashed again. */
export function leafOf(r) {
  return keccak(hexToBytes(structHash(r)));
}

export function digestOf(chainId, registry, r) {
  return keccak(hexToBytes("1901" + domainSeparator(chainId, registry).slice(2) + structHash(r).slice(2)));
}

/** The address whose key produced `signature` over `digest`. */
export function recoverSigner(digest, signature) {
  const sig = hexToBytes(signature);
  if (sig.length !== 65) throw new Error("a signature is 65 bytes");
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  const point = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(hexToBytes(digest));
  const pub = point.toRawBytes(false).slice(1); // drop the 0x04 prefix
  return "0x" + keccak(pub).slice(-40);
}

/**
 * Rebuild the receipt from the buyer's own bytes and check who signed it.
 * `provider` and `registry` must come from somewhere the page already trusts,
 * never from the response being checked.
 */
export function checkSignature({ chainId, registry, provider, requestId, payer, input, output, signature }) {
  const receipt = {
    requestId,
    payer,
    inputHash: keccak(input),
    outputHash: keccak(output),
    bytesIn: BigInt(input.length),
    bytesOut: BigInt(output.length),
  };
  let signer;
  try {
    signer = recoverSigner(digestOf(chainId, registry, receipt), signature);
  } catch (error) {
    return { ok: false, receipt, reason: `the signature is malformed: ${error.message}` };
  }
  const ok = signer.toLowerCase() === provider.toLowerCase();
  return {
    ok,
    receipt,
    signer,
    leaf: leafOf(receipt),
    ...(ok ? {} : { reason: `the signature over these bytes recovers to ${signer}, not the provider ${provider}` }),
  };
}

function hashPair(a, b) {
  const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak(hexToBytes(x.slice(2) + y.slice(2)));
}

export function verifyMerkle(leaf, proof, root) {
  return proof.reduce(hashPair, leaf).toLowerCase() === root.toLowerCase();
}

/** Poll the provider until the batch holding `path` is committed. */
export async function waitForProof(url, { tries = 60, everyMs = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const answer = await fetch(url).then((r) => r.json());
    if (answer.status === "anchored") return answer.proof;
    if (answer.status === "failed") throw new Error(`the provider's batch commit failed: ${answer.reason}`);
    await new Promise((ok) => setTimeout(ok, everyMs));
  }
  throw new Error(`no proof after ${(tries * everyMs) / 1000} s`);
}

/**
 * Find the root in the commit transaction, attributed to the provider and
 * emitted by the pinned registry, and walk the proof from our own leaf to it.
 * `rpc` is a JSON-RPC caller: (method, params) => result.
 */
export async function checkAnchor({ rpc, registry, provider, leaf, proof }) {
  if (proof.registry.toLowerCase() !== registry.toLowerCase()) {
    return { ok: false, reason: `the proof names registry ${proof.registry}, not ${registry}` };
  }
  const tx = await rpc("eth_getTransactionReceipt", [proof.txHash]);
  if (!tx) return { ok: false, reason: "the commit transaction is not on chain" };
  if (tx.status !== "0x1") return { ok: false, reason: "the commit transaction reverted" };

  const log = (tx.logs || []).find(
    (l) =>
      l.address.toLowerCase() === registry.toLowerCase() &&
      l.topics[0].toLowerCase() === BATCH_TOPIC.toLowerCase() &&
      l.topics[1].toLowerCase() === proof.root.toLowerCase(),
  );
  if (!log) return { ok: false, reason: "no Batch with that root from the registry in that transaction" };

  const committedBy = "0x" + log.topics[2].slice(26);
  if (committedBy.toLowerCase() !== provider.toLowerCase()) {
    return { ok: false, reason: `the batch was committed by ${committedBy}, not ${provider}` };
  }
  if (!verifyMerkle(leaf, proof.proof, proof.root)) {
    return { ok: false, reason: "the Merkle proof does not lead from this receipt to the committed root" };
  }
  const data = log.data.slice(2);
  return {
    ok: true,
    count: Number(BigInt("0x" + data.slice(0, 64))),
    timestamp: Number(BigInt("0x" + data.slice(64, 128))),
  };
}
