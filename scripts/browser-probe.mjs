/**
 * Open a page in a real, throwaway headless Chrome and report what happened.
 *
 *   node scripts/browser-probe.mjs https://aernyth.com/
 *
 * Starts Chrome with a fresh temporary profile — never the user's own — and
 * drives it over the DevTools protocol using Node's built-in WebSocket. Prints
 * the address the page ends up on, how far it scrolled, any console errors,
 * and every history change the page made, with the call stack that made it.
 * For the class of bug a Node test cannot see because it needs a browser.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2] ?? "https://aernyth.com/";
const waitMs = Number(process.argv[3] ?? 8000);
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = mkdtempSync(join(tmpdir(), "probe-"));
const port = 9300 + Math.floor(Math.random() * 500);

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1440,900", "about:blank",
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

await send("Runtime.enable");
await send("Page.enable");
// Record every history change, with where it came from, before any page script runs.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__history = [];
    for (const m of ["pushState", "replaceState"]) {
      const real = history[m].bind(history);
      history[m] = (...a) => { window.__history.push({ m, url: String(a[2]), stack: new Error().stack.split("\\n").slice(2, 5).join(" | ") }); return real(...a); };
    }`,
});
await send("Page.navigate", { url });
await sleep(waitMs);

const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;
const report = {
  requested: url,
  landedOn: await evaluate("location.href"),
  scrollY: await evaluate("Math.round(scrollY)"),
  historyChanges: await evaluate("window.__history"),
  consoleErrors: events
    .filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error"))
    .map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.args?.map((a) => a.value ?? a.description).join(" "))
    .slice(0, 5),
};
console.log(JSON.stringify(report, null, 2));

ws.close();
chrome.kill();
await sleep(500);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
