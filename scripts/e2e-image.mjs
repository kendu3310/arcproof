/**
 * The image service, end to end, against a running reference server.
 *
 *   node --experimental-strip-types scripts/e2e-image.mjs [apiBase] [network]
 *
 * Posts a generated 3000×2000 photo carrying EXIF to the sponsored batched
 * route, then does what a buyer would: checks the provider's signature from
 * its own bytes, measures the result itself, waits for the proof, checks it
 * against the chain — and finally rebuilds the same proof from the chain alone,
 * as if the provider had forgotten it.
 */
import sharp from "sharp";
import { arcMainnet, arcTestnet, verifySignedReceipt, verifyAnchoredReceipt, proofFromCommit, findAnchorProof } from "aernyth";
import { checkResize } from "@aernyth/image-service";

const api = process.argv[2] ?? "http://localhost:3917";
const network = process.argv[3] === "arc" ? arcMainnet : arcTestnet;
const health = await (await fetch(`${api}/health`)).json();
const registry = health.batchRegistry;
const provider = health.provider; // a real buyer pins this; here it is the server under test
let failures = 0;
const check = (ok, label) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`); if (!ok) failures++; };

const input = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 90, b: 40 } } })
  .withMetadata({ exif: { IFD0: { Copyright: "aernyth e2e", Make: "TestCam" } } })
  .jpeg()
  .toBuffer();
const box = { width: 800, height: 800 };

const started = performance.now();
const response = await fetch(`${api}/batched/demo/image/resize?width=${box.width}&height=${box.height}&format=webp`, {
  method: "POST",
  headers: { "content-type": "image/jpeg" },
  body: input,
});
check(response.ok, `served: HTTP ${response.status}`);
if (!response.ok) { console.log(await response.text()); process.exit(1); }
const output = new Uint8Array(await response.arrayBuffer());
console.log(`  bytes back after ${Math.round(performance.now() - started)} ms: ${input.length} → ${output.length}`);
const h = (name) => response.headers.get(`x-aernyth-${name}`);

const signed = await verifySignedReceipt({
  network, registry, expectedProvider: provider, input, output,
  requestId: h("request-id"), payer: h("payer"), signature: h("signature"),
});
check(signed.ok, `signature checks from the buyer's own bytes ${signed.problems.join("; ")}`);

const quality = await checkResize({ input, output, box, format: "webp" });
check(quality.ok, `the buyer's own measurement: ${quality.before.width}×${quality.before.height} → ${quality.after.width}×${quality.after.height} ${quality.after.format} ${quality.problems.join("; ")}`);

const proofUrl = new URL(h("proof"), api);
let proof;
for (let i = 0; i < 60 && !proof; i++) {
  const answer = await (await fetch(proofUrl)).json();
  if (answer.status === "anchored") proof = answer.proof;
  else await new Promise((ok) => setTimeout(ok, 500));
}
check(Boolean(proof), `proof served ${proof ? network.explorerUrl + "/tx/" + proof.txHash : ""}`);
const anchored = await verifyAnchoredReceipt({ network, registry, expectedProvider: provider, leaf: signed.leaf, proof });
check(anchored.ok, `proof checks against the chain ${anchored.problems.join("; ")}`);

const rebuilt = await proofFromCommit({ network, registry, expectedProvider: provider, txHash: proof.txHash, leaf: signed.leaf });
check(rebuilt.root === proof.root && rebuilt.index === proof.index, "the same proof, rebuilt from the commit transaction alone");
const found = await findAnchorProof({ network, registry, expectedProvider: provider, leaf: signed.leaf, maxBlocks: 2000n });
check(found?.txHash === proof.txHash, "and found by scanning the provider's recent commits, without being told the transaction");

console.log(JSON.stringify({ requestId: h("request-id"), leaf: signed.leaf, txHash: proof.txHash }));
console.log(failures ? `${failures} FAILED` : "all checks passed");
process.exit(failures ? 1 : 0);
