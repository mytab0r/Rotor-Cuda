// Pure tests for the wallet portfolio summary math: per-chain BigInt sums,
// loaded-vs-zero honesty, unpriced-chain exclusion, stale prices and display.
//
// Usage: node apps/site/wallet-summary-test.mjs

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("./chains.generated.js");
require("./amount.js");
require("./key-tools.js");
const summary = require("./wallet-summary.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

function row(chain, label, symbol, decimals, amount, state) {
  return { chain, label, symbol, decimals, amount, state };
}

const ETH = 1000000000000000000n;

// ---------------------------------------------------------- per-chain totals

const rows = [
  row("ethereum", "Ethereum", "ETH", 18, 1500000000000000000n, "ok"),
  row("ethereum", "Ethereum", "ETH", 18, 500000000000000000n, "ok"),
  row("bitcoin", "Bitcoin", "BTC", 8, 100000000n, "ok"),
  row("bitcoin-testnet", "Bitcoin testnet", "BTC", 8, 50000000n, "ok"),
  row("tron", "TRON", "TRX", 6, 2000000n, "ok"),
  row("solana", "Solana", "SOL", 9, null, "loading"),
  row("polygon", "Polygon", "POL", 18, null, "error"),
  row("xrp", "XRP", "XRP", 6, null, "missing"),
];
const totals = summary.aggregate(rows);
assertEqual(totals.total, 8, "all rows count toward M");
assertEqual(totals.loaded, 5, "only ok rows are loaded");
assertEqual(totals.loading, 1, "loading rows are counted separately");
assertEqual(totals.failed, 1, "failed rows are counted separately");
assertEqual(totals.pending, 1, "missing rows are counted separately");
assertEqual(totals.perChain.length, 4, "one per-chain total per loaded chain");
assertEqual(totals.perChain[0].chain, "ethereum", "chain order follows the rows");
assertEqual(totals.perChain[0].amount, 2000000000000000000n, "ETH totals sum exactly with BigInt");
assertEqual(totals.perChain[0].addresses, 2, "two loaded ETH rows");
assertEqual(totals.perChain[1].amount, 100000000n, "BTC total");
assertEqual(totals.perChain[3].amount, 2000000n, "TRX total");
assertEqual(summary.loadedLine(totals), "5 of 8 balances loaded", "loaded line");
assertEqual(summary.loadedLine(summary.aggregate([row("bitcoin", "Bitcoin", "BTC", 8, 1n, "ok")])),
  "1 of 1 balance loaded", "singular loaded line");

assertEqual(summary.formatNative(2000000000000000000n, 18, "ETH"), "2 ETH", "native ETH total");
assertEqual(summary.formatNative(1234567890n, 8, "BTC"), "12.3456789 BTC", "native BTC total");
assertEqual(summary.formatNative(1n, 18, "ETH"), "<0.00000001 ETH", "tiny native total");
assertEqual(summary.formatNative(0n, 18, "ETH"), "0 ETH", "a loaded zero native total");

// --------------------------------------------------------------- USD totals

const prices = { ETH: "3000", BTC: "60000", TRX: "0.25" };
const fiat = summary.fiat(totals, prices, "fresh");
assertEqual(fiat.state, "partial", "a loaded chain without a price makes the total partial");
assertEqual(fiat.cents, 6600050n, "2 ETH at 3000 + 1 BTC at 60000 + 2 TRX at 0.25");
assertEqual(summary.totalText(fiat), "$66,000.50", "formatted USD total");
assertEqual(fiat.included, 3, "three priced chains are included");
assertEqual(fiat.excluded.length, 1, "one chain is excluded");
assertEqual(fiat.excluded[0].chain, "bitcoin-testnet", "Bitcoin testnet is the excluded chain");
assertEqual(fiat.excluded[0].label, "Bitcoin testnet", "the excluded chain keeps its label");

// Testnet BTC carries the BTC symbol but has no market of its own: it must be
// named as excluded, never priced at the mainnet ticker.
const testnetOnly = summary.aggregate([
  row("bitcoin-testnet", "Bitcoin testnet", "BTC", 8, 50000000n, "ok"),
]);
const testnetFiat = summary.fiat(testnetOnly, prices, "fresh");
assertEqual(testnetFiat.state, "unpriced", "only unpriced chains loaded");
assertEqual(testnetFiat.cents, null, "no invented USD value");
assertEqual(summary.totalText(testnetFiat), "—", "unpriced total prints —, not $0.00");
assertEqual(testnetFiat.excluded[0].label, "Bitcoin testnet", "unpriced chain named");

// ------------------------------------------------- zero loaded vs zero balance

const unloaded = summary.aggregate([
  row("ethereum", "Ethereum", "ETH", 18, null, "missing"),
  row("ethereum", "Ethereum", "ETH", 18, null, "loading"),
]);
assertEqual(unloaded.loaded, 0, "nothing loaded");
const unloadedFiat = summary.fiat(unloaded, prices, "fresh");
assertEqual(unloadedFiat.state, "empty", "an empty summary is a distinct state");
assertEqual(unloadedFiat.cents, null, "nothing loaded has no USD value");
assertEqual(summary.totalText(unloadedFiat), "—", "nothing loaded never prints $0.00");
assertEqual(unloaded.perChain.length, 0, "no per-chain total is invented");

const zeroBalance = summary.aggregate([
  row("ethereum", "Ethereum", "ETH", 18, 0n, "ok"),
]);
assertEqual(zeroBalance.loaded, 1, "a loaded zero still counts as loaded");
assertEqual(zeroBalance.perChain[0].amount, 0n, "a loaded zero is a real zero");
const zeroFiat = summary.fiat(zeroBalance, prices, "fresh");
assertEqual(zeroFiat.state, "ready", "a loaded zero has a real USD value");
assertEqual(zeroFiat.cents, 0n, "zero cents");
assertEqual(summary.totalText(zeroFiat), "$0.00", "a loaded zero prints $0.00");

// -------------------------------------------------------- stale and offline

const stale = summary.fiat(totals, prices, "stale");
assertEqual(stale.state, "stale", "a stale cache is stale");
assertEqual(stale.cents, null, "stale prices do not produce a fiat value");
assertEqual(stale.reason, "prices-stale", "stale reason");
assertEqual(summary.totalText(stale), "—", "stale total prints —");
assertEqual(stale.excluded.length, totals.perChain.length, "stale USD names every loaded chain as excluded");
assert(
  stale.excluded.some((item) => item.label === "Bitcoin testnet"),
  "stale USD names the unpriced testnet chain",
);
assertEqual(totals.perChain[0].amount, 2000000000000000000n, "native totals survive a stale ticker");

const offline = summary.fiat(totals, null, "unavailable");
assertEqual(offline.state, "unavailable", "an unreachable ticker is unavailable");
assertEqual(offline.cents, null, "no offline fiat value");
assertEqual(summary.totalText(offline), "—", "offline total prints —");
assertEqual(offline.excluded.length, totals.perChain.length, "offline USD names every loaded chain as excluded");

const loading = summary.fiat(totals, null, "loading");
assertEqual(loading.state, "loading", "a pending ticker is loading");
assertEqual(summary.totalText(loading), "…", "a pending total is not a value");

// ------------------------------------------------------ address not derived

assertEqual(summary.loadState(null), "error", "a missing address is an error row");
assertEqual(summary.loadState({ error: "boom" }), "error", "a derivation error is an error row");
assertEqual(summary.loadState({ address: "0xabc" }), "ready", "a derived address is ready");
const noAddress = summary.aggregate([
  row("ethereum", "Ethereum", "ETH", 18, null, "error"),
]);
assertEqual(noAddress.loaded, 0, "a row without a derived address is not loaded");
assertEqual(noAddress.failed, 1, "a row without a derived address is counted as failed");
assertEqual(noAddress.perChain.length, 0, "a row without a derived address adds no native total");
const noAddressFiat = summary.fiat(noAddress, prices, "fresh");
assertEqual(noAddressFiat.state, "empty", "a row without a derived address is an empty total");
assertEqual(summary.totalText(noAddressFiat), "—", "a row without a derived address never prints $0.00");

// ------------------------------------------------------------- bad amounts

const badAmount = summary.aggregate([
  row("ethereum", "Ethereum", "ETH", 18, "not-a-number", "ok"),
]);
assertEqual(badAmount.loaded, 0, "an unparseable amount is not loaded");
assertEqual(badAmount.failed, 1, "an unparseable amount is counted as failed");

assertEqual(summary.formatTime(0), "", "no timestamp");
assert(/UTC$/.test(summary.formatTime(1700000000000)), "timestamp is formatted in UTC");

for (const amount of [0n, ETH]) {
  const single = summary.aggregate([row("ethereum", "Ethereum", "ETH", 18, amount, "ok")]);
  assertEqual(summary.fiat(single, {}, "fresh").state, "unpriced", "an empty price table is unpriced");
}

console.log("wallet-summary-test: ok");
