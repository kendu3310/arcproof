/**
 * Check every Subresource Integrity hash on the page against the real file.
 *
 * This exists because a wrong one shipped. The hash had been written to look
 * plausible rather than computed, so the browser refused to run js-sha3,
 * `sha3` was undefined, and the page's very first statement threw — taking
 * every handler on the page with it. Nothing rendered and nothing responded,
 * with no error anywhere a visitor would see.
 *
 * SRI fails exactly this way: silently and completely. Nothing short of
 * fetching the file and hashing it can tell you the value is right.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";

const page = readFileSync(
  resolve(import.meta.dirname, "../docs/index.html"),
  "utf8",
);

/** Every <script src> that carries an integrity attribute, in either order. */
function taggedScripts(html) {
  const found = [];
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    const src = tag.match(/\ssrc="([^"]+)"/)?.[1];
    const integrity = tag.match(/\sintegrity="([^"]+)"/)?.[1];
    if (src && integrity) found.push({ src, integrity });
  }
  return found;
}

const scripts = taggedScripts(page);

test("the page pins at least one external script", () => {
  // If this starts failing, either the CDN script went away or the integrity
  // attribute was dropped — and an unpinned CDN script is its own problem.
  assert.ok(scripts.length > 0, "no <script src> with integrity found");
});

for (const { src, integrity } of scripts) {
  test(`integrity matches the real file: ${src}`, async (t) => {
    let body;
    try {
      const response = await fetch(src, { signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 200, `${src} returned ${response.status}`);
      body = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      // Offline is not a failing hash. Skipping keeps the suite usable on a
      // plane; a wrong hash still fails the moment anyone runs it online.
      t.skip(`could not reach ${src}: ${error.message}`);
      return;
    }

    const [algorithm, expected] = integrity.split("-");
    assert.ok(
      ["sha256", "sha384", "sha512"].includes(algorithm),
      `unsupported algorithm ${algorithm}`,
    );

    const actual = createHash(algorithm).update(body).digest("base64");
    assert.equal(
      actual,
      expected,
      `integrity mismatch for ${src}\n  page says: ${algorithm}-${expected}\n  file is:   ${algorithm}-${actual}\n` +
        `A browser will refuse to execute this script, and the page will fail silently.`,
    );
  });
}

/**
 * A correct hash only guarantees the right file arrives. It says nothing about
 * calling it correctly, and the two failures look identical from the page: the
 * script loads, the first line throws, and every handler dies with it.
 *
 * js-sha3's UMD build assigns each function straight onto window. There is no
 * `sha3` namespace object in a browser — that form belongs to CommonJS — so
 * this loads the real file the way a browser would and checks the page is
 * using a name it actually exports.
 */
test("the page calls the hash library by a name it really exports", async (t) => {
  const script = scripts.find(({ src }) => src.includes("js-sha3"));
  if (!script) {
    t.skip("js-sha3 is no longer pinned on the page");
    return;
  }

  let code;
  try {
    const response = await fetch(script.src, { signal: AbortSignal.timeout(30_000) });
    code = await response.text();
  } catch (error) {
    t.skip(`could not reach ${script.src}: ${error.message}`);
    return;
  }

  // A browser is window plus no module system. Give it exactly that.
  const windowObject = {};
  const sandbox = { window: windowObject, self: windowObject };
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  runInContext(code, sandbox);

  assert.equal(
    typeof windowObject.keccak256,
    "function",
    "the browser build no longer exports keccak256",
  );
  assert.equal(
    typeof windowObject.sha3,
    "undefined",
    "a sha3 namespace now exists; the page could use it, but check before switching",
  );

  // The canonical keccak of empty input, as a last guard that this is the
  // Ethereum variant rather than NIST SHA-3.
  assert.equal(
    windowObject.keccak256(new Uint8Array()),
    "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );

  const body = page.split("<script>").pop();
  assert.ok(
    !/\bsha3\.keccak256\s*\(/.test(body),
    "the page calls sha3.keccak256(), which is undefined in a browser",
  );
});
