#!/usr/bin/env node
/* Tests for the pure vanity-search helpers. No browser, no network. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

const source = readFileSync(fileURLToPath(new URL("./vanity.js", import.meta.url)), "utf8");

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };
runInThisContext(source, { filename: "vanity.js" });

const math = globalThis.RotorVanityMath;
assert.ok(math, "vanity.js must expose RotorVanityMath before the DOM guard");

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

test("difficulty is alphabet^patternLength", () => {
  assert.equal(math.expectedAttempts(58, 3), 195112);
  assert.equal(math.expectedAttempts(16, 2), 256);
  assert.equal(math.expectedAttempts(32, 7), 34359738368);
});

test("empty or non-positive pattern length means one attempt", () => {
  assert.equal(math.expectedAttempts(58, 0), 1);
  assert.equal(math.expectedAttempts(58, -3), 1);
  assert.equal(math.expectedAttempts(58, ""), 1);
});

test("pattern length sums prefix and suffix", () => {
  assert.equal(math.patternLength("77", "abc"), 5);
  assert.equal(math.patternLength("777", ""), 3);
  assert.equal(math.patternLength("", ""), 0);
  assert.equal(math.expectedAttempts(58, math.patternLength("ab", "cd")), 58 ** 4);
});

test("alphabet size per chain", () => {
  assert.equal(math.alphabetFor("bitcoin-legacy"), 58);
  assert.equal(math.alphabetFor("bitcoin-segwit"), 32);
  assert.equal(math.alphabetFor("bitcoin-taproot"), 32);
  assert.equal(math.alphabetFor("ethereum"), 16);
  assert.equal(math.alphabetFor("tron"), 58);
  assert.equal(math.alphabetFor("solana"), 58);
  assert.equal(math.alphabetFor("unknown-chain"), 58);
});

test("ETA divides expected attempts by the current rate", () => {
  assert.equal(math.expectedSeconds(195112, 500), 390.224);
  assert.equal(math.expectedSeconds(1, 4), 0.25);
});

test("ETA is unknown without a positive, finite rate", () => {
  assert.equal(math.expectedSeconds(195112, 0), null);
  assert.equal(math.expectedSeconds(195112, -5), null);
  assert.equal(math.expectedSeconds(195112, NaN), null);
  assert.equal(math.expectedSeconds(195112, Infinity), null);
  assert.equal(math.expectedSeconds(195112), null);
  assert.equal(math.expectedSeconds(0, 500), null);
});

test("recent-entry sanitizer keeps public fields and drops secrets", () => {
  const raw = {
    chain: "tron",
    pattern: "T7",
    address: "TXYZ123",
    foundAt: 1700000000000,
    key: "secret-hex",
    wif: "secret-wif",
    priv_hex: "secret-priv-hex",
    privateKey: "secret-private-key",
    private: "secret-private",
  };
  const clean = math.sanitizeRecentEntry(raw);
  assert.deepEqual(clean, {
    chain: "tron",
    pattern: "T7",
    address: "TXYZ123",
    foundAt: 1700000000000,
  });
  assert.deepEqual(Object.keys(clean).sort(), ["address", "chain", "foundAt", "pattern"]);
  for (const value of Object.values(clean)) {
    assert.ok(!String(value).includes("secret"), "no secret may survive sanitizing");
  }
});

test("recent-entry sanitizer rejects entries without chain or address", () => {
  assert.equal(math.sanitizeRecentEntry(null), null);
  assert.equal(math.sanitizeRecentEntry("text"), null);
  assert.equal(math.sanitizeRecentEntry({}), null);
  assert.equal(math.sanitizeRecentEntry({ chain: "tron" }), null);
  assert.equal(math.sanitizeRecentEntry({ address: "TXYZ123" }), null);
  assert.equal(math.sanitizeRecentEntry({ chain: "", address: "TXYZ123" }), null);
});

test("recent-entry sanitizer normalizes corrupt fields", () => {
  const clean = math.sanitizeRecentEntry({
    chain: "solana",
    address: "SoLanaAddress",
    pattern: 42,
    foundAt: "yesterday",
  });
  assert.deepEqual(clean, {
    chain: "solana",
    pattern: "",
    address: "SoLanaAddress",
    foundAt: 0,
  });
  assert.equal(math.sanitizeRecentEntry({ chain: "solana", address: "x".repeat(200) }).address.length, 128);
});

if (failed) {
  console.error(`${failed} vanity test(s) failed`);
  process.exit(1);
}
console.log("vanity: all tests passed");
