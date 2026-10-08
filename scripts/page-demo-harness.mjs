/**
 * Run the page's own demo code against the live service, without a browser.
 *
 *   node --experimental-strip-types scripts/page-demo-harness.mjs
 *
 * Extracts runDemo and its helpers from docs/index.html verbatim, gives them a
 * stand-in DOM that records what would have been shown, and points them at the
 * real API and the real Arc RPC. What it prints is what a visitor would read.
 * Uses one sponsored demo run.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "docs/index.html"), "utf8");
const config = JSON.parse(readFileSync(resolve(root, "docs/receipts.json"), "utf8"));

// js-sha3, loaded the way the browser loads it.
const sha3 = await fetch("https://cdnjs.cloudflare.com/ajax/libs/js-sha3/0.9.3/sha3.min.js").then((r) => r.text());
const win = {};
const box = { window: win, self: win };
box.globalThis = box;
createContext(box);
runInContext(sha3, box);
globalThis.keccak256 = win.keccak256;
const batched = await import("../docs/batched.js");

const grab = (name) => {
  const start = html.indexOf(name);
  if (start < 0) throw new Error(`not found in the page: ${name}`);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unbalanced: ${name}`);
};
const constLine = (name) => html.match(new RegExp(`const ${name} = .*;`))[0];

const code = [
  grab("async function runDemo(file)"),
  grab("function startSteps(steps)"),
  grab("async function failedResponse(response, mark)"),
  grab("function resultGrid(input, output, report, receiptCell)"),
  grab("function resultTail(output, report)"),
  html.match(/const geometryHeld = \(report\) =>\s*[^;]+;/)[0],
  grab("async function runDemoBatched(input)"),
  grab("async function runDemoImmediate(input)"),
  grab("async function rpc(method, params)"),
  grab("async function loadReceipt(txHash)"),
  grab("function fmtBytes(value)"),
  constLine("short"),
  constLine("ICON_LINK"),
].join("\n").replace('await import("./batched.js")', "__batched");

// A stand-in DOM: every element remembers its classes, text and HTML.
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) {
    const node = {
      id, classes: new Set(), text: "", html: "", className: "",
      classList: { add: (c) => node.classes.add(c) },
      scrollIntoView() {},
      insertAdjacentHTML(_where, more) { node.html += more; },
      set innerHTML(v) {
        node.html = v;
        for (const m of v.matchAll(/id="([^"]+)"/g)) elements.delete(m[1]);
        for (const m of v.matchAll(/<li id="(step\d)">([^<]*)<\/li>/g)) element(m[1]).text = m[2];
      },
      get innerHTML() { return node.html; },
      set textContent(v) { node.text = v; },
    };
    elements.set(id, node);
  }
  return elements.get(id);
};

const ctx = {
  el: element, config, apiBase: config.api, __batched: batched, keccak256: win.keccak256,
  fetch, performance, URL, Blob, BigInt, JSON, Math, Number, String, TextEncoder, Uint8Array, Promise, setTimeout, console,
  showModels: async () => undefined, loadDemoStatus: async () => undefined,
};
ctx.globalThis = ctx;
createContext(ctx);
runInContext(code, ctx);

const input = readFileSync(resolve(root, "examples/glb-service/fixtures/sample.glb"));
console.log(`running the page's runDemo() against ${config.api} …\n`);
await ctx.runDemo({ arrayBuffer: async () => input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) });

const strip = (s) => s.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
for (let i = 0; i < 4; i++) {
  const step = elements.get(`step${i}`);
  if (step) console.log(`  ${step.classes.has("done") ? "●" : step.classes.has("fail") ? "✗" : "○"} ${step.text}`);
}
const verdict = elements.get("batchVerdict") ?? null;
console.log(`\nverdict (${verdict?.className || "from demoDetail"}):`);
console.log("  " + strip(verdict?.html ?? elements.get("demoDetail")?.html ?? "(nothing)").replace(/(.{1,110})(\s|$)/g, "$1\n  "));
console.log("receipt cell: " + strip(elements.get("receiptCell")?.html ?? "(none)"));
