// TRON mainnet and Nile wallet codec tests (apps/site/wallet-tron.js).
//
// Usage: node apps/site/wallet-tron-test.mjs
//
// No network and no DOM: the module under test is pure logic. The wasm
// encodings (TRX and TRC-20) and their signed vectors live in
// crates/rotor-wasm/src/tron.rs; this file covers the network descriptors,
// the mainnet arm gate, the provider allowlist, the review TTL and the
// amount/base-unit conversion.

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("./chains.generated.js");
require("./amount.js");
const tron = require("./wallet-tron.js");

const TRX_DECIMALS = 6;

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function failureMessage(fn) {
  try {
    const value = fn();
    return "resolved: " + String(value);
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
}

/* ----------------------------------------------------- network descriptors */

test("the network table offers TRON mainnet and Nile from the SSOT data", () => {
  const slugs = tron.tronNetworks().map((network) => network.slug);
  assert.deepEqual(slugs, ["tron", "tron-nile"]);

  const mainnet = tron.tronNetworkBySlug("tron");
  const nile = tron.tronNetworkBySlug("tron-nile");
  assert.ok(mainnet, "TRON mainnet descriptor");
  assert.ok(nile, "TRON Nile descriptor");
  assert.equal(mainnet.testnet, false);
  assert.equal(mainnet.symbol, "TRX");
  assert.equal(mainnet.decimals, TRX_DECIMALS);
  assert.equal(nile.testnet, true);
  assert.equal(nile.symbol, "TRX");
  assert.equal(tron.tronNetworkBySlug("tron-shasta"), null);

  // The provider list is the declared node list, not a page-local copy.
  const declared = globalThis.RotorProviders.byChain.tron.map((provider) => provider.url);
  for (const provider of mainnet.providers) {
    assert.ok(declared.includes(provider.url), provider.url + " is not declared for tron");
  }
  const mainnetIds = mainnet.providers.map((provider) => provider.id);
  assert.ok(mainnetIds.includes("trongrid"), "trongrid must be offered");
  assert.ok(mainnetIds.includes("publicnode"), "publicnode must be offered");
  assert.equal(
    globalThis.RotorProviders.find("tron", "trongrid").url,
    "https://api.trongrid.io"
  );
  assert.equal(
    globalThis.RotorProviders.find("tron", "publicnode").url,
    "https://tron-rpc.publicnode.com"
  );

  const nileDeclared = globalThis.RotorProviders.byChain["tron-nile"]
    .map((provider) => provider.url);
  for (const provider of nile.providers) {
    assert.ok(nileDeclared.includes(provider.url), provider.url + " is not declared for Nile");
  }
  assert.equal(nile.providers[0].id, "nileex");
});

/* ---------------------------------------------------------- mainnet arm */

test("an unarmed TRON mainnet transfer is refused and Nile stays selectable", () => {
  const mainnet = tron.tronNetworkBySlug("tron");
  const nile = tron.tronNetworkBySlug("tron-nile");

  assert.throws(() => tron.assertTronMainnetArmed(mainnet, false), /Mainnet signing is not armed/);
  assert.throws(() => tron.assertTronMainnetArmed(mainnet, undefined), /Mainnet signing is not armed/);
  assert.doesNotThrow(() => tron.assertTronMainnetArmed(mainnet, true));
  assert.doesNotThrow(() => tron.assertTronMainnetArmed(nile, false));

  const message = failureMessage(() => tron.assertTronMainnetArmed(mainnet, false));
  assert.match(message, /TRX/);
  assert.match(message, /TRON/);
});

/* ------------------------------------------------------ provider allowlist */

test("a user-supplied endpoint is refused by the provider allowlist", () => {
  const mainnet = tron.tronNetworkBySlug("tron");
  const nile = tron.tronNetworkBySlug("tron-nile");

  const allowed = tron.assertTronProvider(mainnet, "https://api.trongrid.io");
  assert.equal(allowed.id, "trongrid");
  assert.equal(tron.assertTronProvider(mainnet, "https://tron-rpc.publicnode.com").id, "publicnode");

  assert.throws(
    () => tron.assertTronProvider(mainnet, "https://evil.example/rpc"),
    /not a declared TRON provider/
  );
  // A provider declared for another TRON network is not a mainnet provider.
  const nileUrl = nile.providers[0].url;
  assert.throws(
    () => tron.assertTronProvider(mainnet, nileUrl),
    /not a declared TRON provider/
  );
  assert.equal(tron.assertTronProvider(nile, nileUrl).id, "nileex");
});

/* ---------------------------------------------------------- review expiry */

test("a review older than 60 seconds is refused at confirm", () => {
  assert.equal(tron.TRON_REVIEW_TTL_MS, 60000);

  const review = { builtAt: 1_000_000 };
  // Exactly 60 seconds old is still inside the window.
  assert.doesNotThrow(() => tron.assertReviewFresh(review, 1_060_000));
  // One millisecond past the window is refused.
  assert.throws(() => tron.assertReviewFresh(review, 1_060_001), /(stale|expired|older than)/i);
  assert.throws(() => tron.assertReviewFresh(review, 1_500_000), /(stale|expired|older than)/i);
});

/* ---------------------------------------------------- amount and base units */

test("TRX base units are 6 decimals and parse without floats", () => {
  assert.equal(tron.TRON_DECIMALS, TRX_DECIMALS);
  assert.equal(tron.parseTronAmount("1", TRX_DECIMALS), 1_000_000n);
  assert.equal(tron.parseTronAmount("0.000001", TRX_DECIMALS), 1n);
  assert.equal(tron.parseTronAmount("1.5", TRX_DECIMALS), 1_500_000n);
  assert.equal(tron.parseTronAmount(" 2 ", TRX_DECIMALS), 2_000_000n);

  assert.equal(tron.formatTronAmount(1_000_000n, TRX_DECIMALS), "1");
  assert.equal(tron.formatTronAmount(1n, TRX_DECIMALS), "0.000001");
  assert.equal(tron.formatTronAmount(1_500_000n, TRX_DECIMALS), "1.5");

  assert.throws(() => tron.parseTronAmount("-1", TRX_DECIMALS));
  assert.throws(() => tron.parseTronAmount("0.0000001", TRX_DECIMALS));
  assert.throws(() => tron.parseTronAmount("1e6", TRX_DECIMALS));
  assert.throws(() => tron.parseTronAmount("", TRX_DECIMALS));

  // A TRC-20 amount is also raw base units; the decimals come from the token.
  assert.equal(tron.parseTronAmount("1.5", 18), 1_500_000_000_000_000_000n);
  assert.equal(tron.formatTronAmount(1_500_000_000_000_000_000n, 18), "1.5");
});

let failed = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    console.log("ok - " + name);
  } catch (err) {
    failed += 1;
    console.error("not ok - " + name);
    console.error(err && err.stack ? err.stack : err);
  }
}
if (failed) {
  console.error("\n" + failed + " of " + cases.length + " wallet tron tests failed");
  process.exit(1);
}
console.log("\n" + cases.length + " wallet tron tests passed");
