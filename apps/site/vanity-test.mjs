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

test("thread count is cores minus one, clamped to 1..4", () => {
  assert.equal(math.threadCount(undefined), 1);
  assert.equal(math.threadCount(NaN), 1);
  assert.equal(math.threadCount(0), 1);
  assert.equal(math.threadCount(1), 1);
  assert.equal(math.threadCount(2), 1);
  assert.equal(math.threadCount(3), 2);
  assert.equal(math.threadCount(8), 4);
  assert.equal(math.threadCount(64), 4);
  assert.equal(math.threadCount("6"), 4);
});

test("pattern normalization mirrors the search rule", () => {
  const evm = math.patternFor({ field: "evm", lower: true }, " A1b2 ", "");
  assert.deepEqual(evm, { prefix: "0xa1b2", suffix: "", lower: true });
  assert.equal(math.patternFor({ field: "evm", lower: true }, "0xAB", "").prefix, "0xab");
  const btc = math.patternFor({ field: "btc_p2pkh", alphabet: 58 }, "AbC", "xY");
  assert.deepEqual(btc, { prefix: "AbC", suffix: "xY", lower: false });
});

test("address matching keeps EVM case-insensitive and base58 case-sensitive", () => {
  const evm = math.patternFor({ field: "evm", lower: true }, "aB", "Cd");
  assert.equal(math.addressMatches("0xAbCdefCd", evm), true);
  assert.equal(math.addressMatches("0xAbCdefce", evm), false);
  const btc = math.patternFor({ field: "btc_p2pkh", alphabet: 58 }, "1Ab", "");
  assert.equal(math.addressMatches("1Abcdef", btc), true);
  assert.equal(math.addressMatches("1abcdef", btc), false);
  assert.equal(math.addressMatches("x1Ab", btc), false);
  const tail = math.patternFor({ field: "solana", alphabet: 58 }, "", "xyz");
  assert.equal(math.addressMatches("abcxyz", tail), true);
  assert.equal(math.addressMatches("xyzabc", tail), false);
  assert.equal(math.addressMatches("abc", math.patternFor({}, "", "")), true);
});

test("worker messages are sanitized to known fields", () => {
  assert.deepEqual(math.sanitizeWorkerMessage({ type: "progress", attempts: 12.9 }), {
    type: "progress",
    attempts: 12,
  });
  assert.equal(math.sanitizeWorkerMessage({ type: "progress", attempts: -1 }), null);
  assert.equal(math.sanitizeWorkerMessage({ type: "progress", attempts: "many" }), null);
  assert.equal(math.sanitizeWorkerMessage(null), null);
  assert.equal(math.sanitizeWorkerMessage("match"), null);
  assert.equal(math.sanitizeWorkerMessage({ type: "unknown" }), null);
});

test("worker match sanitizer keeps the key only in the returned report", () => {
  const clean = math.sanitizeWorkerMessage({
    type: "match",
    address: "TXYZ123",
    attempts: 7,
    report: {
      priv_hex: "aa".repeat(32),
      wif_compressed: "Lsecret",
      addresses: [{ id: "tron", address: "TXYZ123" }],
      extra: "drop-me",
    },
    wif: "float-wif",
  });
  assert.equal(clean.type, "match");
  assert.equal(clean.address, "TXYZ123");
  assert.equal(clean.attempts, 7);
  assert.deepEqual(Object.keys(clean.report).sort(), ["priv_hex", "wif_compressed"]);
  assert.equal(clean.wif, undefined);
  assert.equal(clean.report.extra, undefined);
  assert.equal(math.sanitizeWorkerMessage({ type: "match", report: {} }), null);
  assert.equal(
    math.sanitizeWorkerMessage({ type: "match", address: "x", report: { wif_compressed: "only" } }),
    null,
    "a match without priv_hex is not renderable",
  );
  assert.equal(
    math.sanitizeWorkerMessage({ type: "match", address: "a".repeat(200), report: { priv_hex: "ab" } })
      .address.length,
    128,
  );
});

test("worker error messages are bounded text", () => {
  assert.deepEqual(math.sanitizeWorkerMessage({ type: "error", message: "boom" }), {
    type: "error",
    message: "boom",
  });
  assert.equal(math.sanitizeWorkerMessage({ type: "error" }).message, "worker error");
  assert.equal(math.sanitizeWorkerMessage({ type: "error", message: "x".repeat(500) }).message.length, 200);
});

if (failed) {
  console.error(`${failed} vanity test(s) failed`);
  process.exit(1);
}
console.log("vanity: all tests passed");
