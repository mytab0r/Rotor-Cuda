// Tests for the single amount module (apps/site/amount.js) and the migration
// of every first-party consumer onto it.
//
// Usage: node apps/site/amount-test.mjs
//
// No dependencies, no DOM, no network. The suite pins exact BigInt conversion
// at 0, 8, 9, 18 and 24 decimals, round trips, trailing-zero trimming, the
// display strings the five directory `coin()` call sites relied on, the
// sat/zat tiny-received rule, and the source-level rule that no consumer keeps
// a local formatter (the same class scripts/check-ssot.mjs gates).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
require("./amount.js");
const amount = globalThis.RotorAmount;

function assertEqual(actual, expected, message) {
  assert.equal(actual, expected, `${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}

function assertThrows(fn, needle, message) {
  let error = null;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error, `${message}: expected an error`);
  assert.ok(
    error.message.toLowerCase().includes(needle.toLowerCase()),
    `${message}: expected "${needle}" in "${error.message}"`,
  );
}

const TWO_53 = 9007199254740992n;
const TWO_256_MINUS_1 = (1n << 256n) - 1n;

/* ------------------------------------------------------------- module shape */

assert.ok(amount && typeof amount === "object", "amount.js exposes window.RotorAmount");
for (const name of ["formatUnits", "parseUnits", "coin", "receivedText"]) {
  assert.equal(typeof amount[name], "function", `RotorAmount.${name} is a function`);
}

/* --------------------------------------------------------------- formatUnits */

assertEqual(amount.formatUnits(0n, 0), "0", "zero at 0 decimals");
assertEqual(amount.formatUnits(0n, 18), "0", "zero at 18 decimals");
assertEqual(amount.formatUnits(1n, 8), "0.00000001", "one satoshi");
assertEqual(amount.formatUnits(50000n, 8), "0.0005", "trailing zeros are trimmed");
assertEqual(amount.formatUnits(150000000n, 8), "1.5", "trailing zero at the unit boundary");
assertEqual(amount.formatUnits(100000000n, 8), "1", "a whole unit prints without a fraction");
assertEqual(amount.formatUnits(1230000000000000000n, 18), "1.23", "18-decimal trailing zeros");
assertEqual(amount.formatUnits(11050000000000000n, 18), "0.01105", "wallet-evm fixture");
assertEqual(amount.formatUnits(10343145665n, 6), "10343.145665", "TRX fixture from key-tools");
assertEqual(amount.formatUnits(10343145665n, 18), "0.000000010343145665", "the same atomic amount at 18 decimals");
assertEqual(amount.formatUnits(1n, 9), "0.000000001", "9-decimal unit");
assertEqual(amount.formatUnits(1n, 24), "0.000000000000000000000001", "24-decimal unit");
assertEqual(amount.formatUnits(1n, 0), "1", "decimals 0 leaves the integer alone");
assertEqual(amount.formatUnits(TWO_53 + 1n, 0), "9007199254740993", "above 2^53 stays exact");
assertEqual(
  amount.formatUnits(TWO_256_MINUS_1, 0),
  "115792089237316195423570985008687907853269984665640564039457584007913129639935",
  "near 2^256 stays exact",
);
assertEqual(amount.formatUnits(123456789n, 0, { grouping: true }), "123,456,789", "optional grouping");
assertEqual(amount.formatUnits(1n, 6, { symbol: "TRX" }), "0.000001 TRX", "optional symbol suffix");
assertEqual(
  amount.formatUnits(1234567890000000000n, 18, { maximumFractionDigits: 6 }),
  "1.234567",
  "maximumFractionDigits truncates without rounding (the key.js micro-ETH rule)",
);
assertEqual(
  amount.formatUnits(150000000n, 8, { minimumFractionDigits: 4 }),
  "1.5000",
  "minimumFractionDigits pads the trimmed fraction",
);
assertThrows(() => amount.formatUnits(-1n, 8), "negative", "a negative amount fails loud");
assertThrows(() => amount.formatUnits(1n, -1), "non-negative", "a negative decimals value fails loud");
assertThrows(() => amount.formatUnits(1.5, 8), "integer", "a non-integer amount fails loud");
assertThrows(
  () => amount.formatUnits(Number(TWO_53) + 2, 8),
  "safe integer",
  "an unsafe Number amount fails loud instead of rounding silently",
);
assertThrows(() => amount.formatUnits(1n, 101), "at most 100", "an absurd decimals value fails loud");

/* --------------------------------------------------------------- parseUnits */

assertEqual(amount.parseUnits("0", 8).toString(), "0", "parse zero");
assertEqual(amount.parseUnits("1", 18).toString(), "1000000000000000000", "parse one ether");
assertEqual(amount.parseUnits("0.00000001", 8).toString(), "1", "parse one satoshi");
assertEqual(amount.parseUnits("0.000000001", 9).toString(), "1", "parse one 9-decimal unit");
assertEqual(amount.parseUnits("0.000000000000000001", 18).toString(), "1", "parse one wei");
assertEqual(amount.parseUnits("1.5", 9).toString(), "1500000000", "parse a 9-decimal fraction");
assertEqual(amount.parseUnits("1.5", 24).toString(), "1500000000000000000000000", "parse a 24-decimal fraction");
assertEqual(amount.parseUnits("12.34567890", 8).toString(), "1234567890", "trailing zeros parse exactly");
assertEqual(amount.parseUnits(" 0.1 ", 18).toString(), "100000000000000000", "surrounding whitespace is allowed");

assertThrows(() => amount.parseUnits("1.1234567", 6), "at most 6 decimal places", "too many fraction digits");
assertThrows(() => amount.parseUnits("1e3", 18), "plain decimal", "exponent notation is rejected");
assertThrows(() => amount.parseUnits("-1", 18), "plain decimal", "a sign is rejected");
assertThrows(() => amount.parseUnits("1,5", 18), "plain decimal", "a comma is rejected");
assertThrows(() => amount.parseUnits("", 18), "required", "an empty value is rejected");
assertThrows(() => amount.parseUnits(1, 18), "plain decimal number", "a number is rejected (no string coercion)");

/* ----------------------------------------------------- round trips and shape */

const VALUES = [
  0n,
  1n,
  7n,
  999n,
  10n ** 7n,
  10n ** 15n,
  TWO_53,
  TWO_53 + 1n,
  (1n << 255n) + 12345n,
  TWO_256_MINUS_1,
];
for (const decimals of [0, 6, 8, 9, 18, 24]) {
  for (const value of VALUES) {
    const text = amount.formatUnits(value, decimals);
    assert.match(text, /^\d+(\.\d+)?$/, `formatUnits output is a plain decimal: ${text}`);
    assert.ok(!/e/i.test(text), `formatUnits never emits an exponent: ${text}`);
    assertEqual(
      amount.parseUnits(text, decimals).toString(),
      value.toString(),
      `round trip at ${decimals} decimals`,
    );
  }
}

/* ------------------------------------------------------------------- coin */

assertEqual(amount.coin(0n, 8), "0", "coin zero");
assertEqual(amount.coin(1n, 8), "0.00000001", "coin one satoshi");
assertEqual(amount.coin(5000n, 8), "0.00005", "coin 5,000 sats");
assertEqual(amount.coin(50_000_000n, 8), "0.5", "coin half a bitcoin");
assertEqual(amount.coin(10_000n, 8), "0.0001", "coin at the received-text cut");
assertEqual(amount.coin(123456789n, 8), "1.23456789", "coin keeps all 8 BTC decimals");
assertEqual(amount.coin(1_500_000n, 6), "1.5", "coin at 6 decimals (TRX/XRP)");
assertEqual(amount.coin(1n, 6), "0.000001", "coin's smallest 6-decimal unit");
assertEqual(amount.coin(1n, 9), "<0.00000001", "coin marks a 9-decimal value below 1e-8");
assertEqual(amount.coin(10n, 9), "0", "coin rounds a 1e-8 value to 0 at 6 fraction digits (historical output)");
assertEqual(amount.coin(1_000_000_000n, 9), "1", "coin one 9-decimal unit");
assertEqual(amount.coin(1n, 18), "<0.00000001", "coin marks one wei");
assertEqual(amount.coin(10_000_000_000n, 18), "0", "coin rounds 1e-8 ether to 0 at 6 fraction digits");
assertEqual(amount.coin(10_000_000_000_000_000_000n, 18), "10", "coin ten ether");
assertEqual(amount.coin(1234567890123456789n, 18), "1.234568", "coin rounds 18-decimal display half-up");
assertEqual(amount.coin(1000000000000000001n, 18), "1", "coin trims a sub-display fraction");
assertEqual(amount.coin(1n, 24), "<0.00000001", "coin marks a 24-decimal value below 1e-8");
assertEqual(amount.coin(10n ** 24n, 24), "1", "coin one 24-decimal unit");

// These two values used to go through Number and lost precision. The old
// strings were "90,071,992.54740992" and a rounded ~1.1579e59 grouped number.
assertEqual(amount.coin(TWO_53 + 1n, 8), "90,071,992.54740993", "coin is exact above 2^53");
assertEqual(
  amount.coin(TWO_256_MINUS_1, 18),
  "115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457.584008",
  "coin is exact near 2^256",
);

/* ----------------------------------------------------------- receivedText */

assertEqual(amount.receivedText(1n, 8, "BTC", "sat"), "1 sat", "BTC-family tiny received renders in sat");
assertEqual(amount.receivedText(5000n, 8, "LTC", "sat"), "5000 sat", "Litecoin tiny received renders in sat");
assertEqual(amount.receivedText(1n, 8, "ZEC", "zat"), "1 zat", "Zcash tiny received renders in zat");
assertEqual(amount.receivedText(50_000_000n, 8, "BTC", "sat"), "0.5 BTC", "ordinary received keeps the coin unit");
assertEqual(amount.receivedText(10_000n, 8, "BTC", "sat"), "0.0001 BTC", "amount at the cut keeps the coin unit");
assertEqual(amount.receivedText(0n, 8, "BTC", "sat"), "0", "zero received stays zero");
assertEqual(amount.receivedText(1n, 18, "ETH", ""), "<0.00000001 ETH", "an EVM tiny received keeps the coin unit");
assertEqual(
  amount.receivedText(TWO_53 + 1n, 8, "BTC", "sat"),
  "90,071,992.54740993 BTC",
  "receivedText is exact for a large amount too",
);

/* ---------------------------------------- consumers no longer keep a copy */

const CONSUMERS = [
  "site.js",
  "tx-decoders.js",
  "wallet-btc.js",
  "wallet-evm.js",
  "wallet.js",
  "key.js",
  "send.js",
  "tron-tx.js",
  "browse.js",
  "brainwallet.js",
  "brainwallet-directory.js",
  "mnemonic-seeds.js",
  "seed-page.js",
  "key-tools.js",
];
for (const name of CONSUMERS) {
  const source = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
  assert.doesNotMatch(
    source,
    /^[ \t]*function\s+(formatUnits|formatUnits6|parseUnits|coin|formatEth)\s*\(/m,
    `${name} must not define a local amount formatter`,
  );
  assert.doesNotMatch(source, /Math\.pow\(\s*10\s*,/, `${name} must not use Number amount math`);
}

for (const name of ["browse.js", "brainwallet.js", "brainwallet-directory.js", "mnemonic-seeds.js", "seed-page.js"]) {
  const source = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
  assert.match(source, /AMOUNT\.coin\(/, `${name} calls RotorAmount.coin`);
}

console.log(`amount-test: ${CONSUMERS.length} consumers use RotorAmount, all vectors exact`);
