/**
 * Serve docs/ locally so the page can be opened before it is published.
 *
 *   node scripts/serve-docs.mjs
 *   → http://localhost:4000/?api=http://localhost:3000
 *
 * Opening docs/index.html straight from the filesystem does not work: fetch()
 * on a file:// page is blocked, so receipts.json never loads and the page sits
 * empty with no visible reason.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const docs = resolve(fileURLToPath(new URL("../docs", import.meta.url)));
const port = Number(process.argv[2] ?? 4000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;

  // normalize() collapses `..`, so a request cannot climb out of docs/.
  const path = resolve(docs, "." + normalize(requested));
  if (!path.startsWith(docs)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}).listen(port, () => {
  console.log(`docs on http://localhost:${port}`);
  console.log(`  with a local service: http://localhost:${port}/?api=http://localhost:3000`);
});
