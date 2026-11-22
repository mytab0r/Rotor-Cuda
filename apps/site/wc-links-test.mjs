#!/usr/bin/env node
/* Tests for the WalletConnect deep-link helpers. No browser, no network. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

const source = readFileSync(fileURLToPath(new URL("./wc-links.js", import.meta.url)), "utf8");

globalThis.window = globalThis;
runInThisContext(source, { filename: "wc-links.js" });

const links = globalThis.RotorWcLinks;
assert.ok(links, "wc-links.js must expose RotorWcLinks");
assert.equal(typeof links.deepLink, "function", "deepLink must be a function");
assert.equal(typeof links.genericLink, "function", "genericLink must be a function");
assert.equal(typeof links.isMobile, "function", "isMobile must be a function");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}\n  ${err && err.stack ? err.stack : err}`);
  }
}

const URI = "wc:4f6a1e2d@2?relay-protocol=irn&symKey=00ff&expiryTimestamp=1760000000";

test("wallet list carries the four deep-link wallets", () => {
  const ids = links.wallets.map((wallet) => wallet.id);
  assert.deepEqual(ids, ["metamask", "trust", "rainbow", "coinbase"]);
  const names = links.wallets.map((wallet) => wallet.name);
  assert.deepEqual(names, ["MetaMask", "Trust Wallet", "Rainbow", "Coinbase Wallet"]);
});

test("each wallet uses its documented deep-link prefix", () => {
  const expected = {
    metamask: "https://metamask.app.link/wc?uri=",
    trust: "https://link.trustwallet.com/wc?uri=",
    rainbow: "https://rainbow.me/wc?uri=",
    coinbase: "https://go.cb-w.com/wc?uri="
  };
  for (const [id, prefix] of Object.entries(expected)) {
    const link = links.deepLink(id, URI);
    assert.ok(link.startsWith(prefix), `${id}: ${link}`);
    assert.equal(link, prefix + encodeURIComponent(URI), `${id} keeps the encoded URI`);
  }
});

test("the URI is encoded as one query value", () => {
  const link = links.deepLink("metamask", URI);
  assert.ok(link.includes("%3Frelay-protocol%3Dirn"), "the query separator is encoded");
  assert.ok(link.includes("%26symKey%3D00ff"), "the second parameter is encoded");
  assert.ok(!link.includes("relay-protocol=irn"), "the raw URI query never leaks into the link");
});

test("unknown wallets and missing URIs produce no link", () => {
  assert.equal(links.deepLink("phantom", URI), "");
  assert.equal(links.deepLink("metamask", ""), "");
  assert.equal(links.deepLink("metamask", null), "");
  assert.equal(links.deepLink("metamask", 42), "");
});

test("the generic link is the bare wc: URI", () => {
  assert.equal(links.genericLink(URI), URI);
  assert.equal(links.genericLink(""), "");
  assert.equal(links.genericLink(undefined), "");
});

test("mobile detection covers Android, iPhone and iPad", () => {
  assert.equal(links.isMobile("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36"), true);
  assert.equal(links.isMobile("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)"), true);
  assert.equal(links.isMobile("Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X)"), true);
});

test("desktop and empty agents are not mobile", () => {
  assert.equal(links.isMobile("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"), false);
  assert.equal(links.isMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), false);
  assert.equal(links.isMobile(""), false);
  assert.equal(links.isMobile(null), false);
  assert.equal(links.isMobile(undefined), false);
});

if (failed > 0) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log("wc-links: all tests passed");
