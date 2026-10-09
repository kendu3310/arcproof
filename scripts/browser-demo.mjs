/**
 * Drop a file into the page's demo in a real, throwaway headless Chrome, and
 * report what a visitor would see.
 *
 *   node scripts/browser-demo.mjs <pageUrl> <file> [waitMs]
 *
 * Like browser-probe.mjs, it starts Chrome with a fresh temporary profile and
 * drives it over the DevTools protocol. It hands the file to the demo's file
 * input, waits, then prints every step with its state, the verdict text, and
 * any console errors. For checking the parts of the demo that need a browser:
 * image decoding, the 3D preview, real cross-origin fetches.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [url, file, wait] = process.argv.slice(2);
if (!url || !file) {
  console.error("usage: node scripts/browser-demo.mjs <pageUrl> <file> [waitMs]");
  process.exit(2);
}
const waitMs = Number(wait ?? 20000);
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = mkdtempSync(join(tmpdir(), "demo-"));
const port = 9300 + Math.floor(Math.random() * 500);

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  target = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((t) => t.find((x) => x.type === "page")).catch(() => undefined);
}
if (!target) throw new Error("Chrome did not start");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else events.push(msg);
});
const send = (method, params = {}) => new Promise((ok) => { const n = ++id; pending.set(n, ok); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send("Runtime.enable");
await send("Page.enable");
await send("DOM.enable");
await send("Page.navigate", { url });
// Let the page load its config and wake the service before dropping anything.
for (let i = 0; i < 60; i++) {
  await sleep(500);
  if (await evaluate(`!!document.getElementById("demoPill") && !/checking/.test(document.getElementById("demoPill").textContent)`)) break;
}

const { root } = (await send("DOM.getDocument")).result;
const { nodeId } = (await send("DOM.querySelector", { nodeId: root.nodeId, selector: "#demoFile" })).result;
await send("DOM.setFileInputFiles", { nodeId, files: [resolve(file)] });
await sleep(waitMs);

const report = await evaluate(`({
  pill: document.getElementById("demoPill")?.textContent,
  steps: [...document.querySelectorAll("#demoOut .steps li")].map((li) => (li.className || "pending") + "  " + li.textContent.trim()),
  grid: document.querySelector("#demoOut .grid4")?.innerText.replace(/\\s+/g, " "),
  verdict: (document.getElementById("batchVerdict") || document.getElementById("demoDetail"))?.innerText.replace(/\\s+/g, " ").slice(0, 900),
  preview: document.getElementById("viewerBox")?.innerText.replace(/\\s+/g, " ").slice(0, 500),
  batches: [...document.querySelectorAll("#batchList .rc")].slice(0, 3).map((r) => r.innerText.replace(/\\s+/g, " ").slice(0, 200)),
  batchNote: document.querySelector("#batchList > .panel")?.innerText,
})`);
report.consoleErrors = events
  .filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error"))
  .map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.args?.map((a) => a.value ?? a.description).join(" "))
  .slice(0, 5);
console.log(JSON.stringify(report, null, 2));

ws.close();
chrome.kill();
await sleep(500);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
