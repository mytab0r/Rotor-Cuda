// Pure tests for the top-10 asset list: data validation, rank/network order,
// exact BigInt USD math, the explicit USDT peg, honest not-loaded/unavailable
// rows and the shared ticker symbols.
//
// Usage: node apps/site/wallet-assets-test.mjs

import fs from "node:fs";
import { createRequire } from "node:module";

import { validateAssets } from "../../scripts/lib/assets.mjs";

const require = createRequire(import.meta.url);
require("./chains.generated.js");
require("./amount.js");
require("./key-tools.js");
require("./assets.generated.js");
const assetsApi = require("./wallet-assets.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

function assertThrows(fn, pattern, message) {
  let error = null;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  if (!error) throw new Error(`${message}: no error thrown`);
  if (!pattern.test(String(error.message))) {
    throw new Error(`${message}: unexpected error ${error.message}`);
  }
}

const data = JSON.parse(
  fs.readFileSync(new URL("../../data/assets.json", import.meta.url), "utf8"),
);
const chains = Object.values(globalThis.RotorChains.bySlug);
const normalized = validateAssets(data, chains);
const generated = globalThis.RotorAssetsData;
const prices = {
  BTC: "60000",
  ETH: "3000",
  BNB: "600",
  SOL: "150",
  XRP: "0.5",
  USDC: "1",
  DOGE: "0.1",
  TRX: "0.1",
  BCH: "400",
};

/* ------------------------------------------------------------- data SSOT */

assertEqual(normalized.assets.length, 10, "top-10 asset count");
assertEqual(generated.assets.length, 10, "generated asset count");
assertEqual(
  normalized.assets.map((asset) => asset.rank).join(","),
  "1,2,3,4,5,6,7,8,9,10",
  "ranks are the contiguous 1..10 order",
);
const marketRanks = new Set();
const symbols = new Set();
for (const asset of normalized.assets) {
  assert(!marketRanks.has(asset.marketCapRank), `marketCapRank ${asset.marketCapRank} is unique`);
  marketRanks.add(asset.marketCapRank);
  assert(!symbols.has(asset.symbol), `symbol ${asset.symbol} is unique`);
  symbols.add(asset.symbol);
  assert(asset.networks.length > 0, `${asset.symbol} has at least one network`);
  for (const network of asset.networks) {
    assert(
      globalThis.RotorChains.bySlug[network.chain],
      `${asset.symbol} network ${network.chain} is a supported chain`,
    );
  }
  if (asset.ticker) {
    assertEqual(
      globalThis.RotorKeyTools.tickerFor(asset.ticker),
      asset.ticker,
      `${asset.symbol} ticker ${asset.ticker} is in the shared ticker table`,
    );
  } else {
    assertEqual(asset.pegUsd, "1", `${asset.symbol} without a ticker uses the explicit peg`);
  }
}

const usdt = normalized.assets.find((asset) => asset.symbol === "USDT");
assertEqual(usdt.chain, "tron", "USDT is read on TRON");
assertEqual(usdt.contracts.tron, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "USDT TRC-20 contract");
assertEqual(usdt.balance, "token", "USDT is a token entry");
const usdc = normalized.assets.find((asset) => asset.symbol === "USDC");
assertEqual(usdc.chain, "evm", "USDC is the EVM multi-chain entry");
assertEqual(Object.keys(usdc.contracts).length, 5, "USDC declares five EVM contracts");
assertEqual(usdc.balance, "token", "USDC is a token entry");

/* ---------------------------------------------------- validation failures */

function clone() {
  return JSON.parse(JSON.stringify(data));
}
{
  const broken = clone();
  broken.assets[1].rank = 1;
  assertThrows(() => validateAssets(broken, chains), /rank 1 is repeated/, "duplicate rank");
}
{
  const broken = clone();
  broken.assets[0].chain = "not-a-chain";
  assertThrows(() => validateAssets(broken, chains), /unknown chain/, "unknown chain slug");
}
{
  const broken = clone();
  broken.assets[2].ticker = null;
  broken.assets[2].pegUsd = null;
  assertThrows(() => validateAssets(broken, chains), /exactly one price source/, "missing price source");
}
{
  const broken = clone();
  broken.assets[9].symbol = "TRX";
  assertThrows(() => validateAssets(broken, chains), /symbol TRX is repeated/, "duplicate symbol");
}
{
  const broken = clone();
  broken.assets[0].contracts = { bitcoin: "0x0000000000000000000000000000000000000001" };
  assertThrows(() => validateAssets(broken, chains), /must not declare contracts/, "native with a contract");
}

/* --------------------------------------------------------- row ordering */

const empty = assetsApi.buildRows(generated.assets, {}, prices, "fresh");
assertEqual(empty.rows.length, 14, "14 asset-network rows");
let previous = 0;
for (const row of empty.rows) {
  assert(row.rank >= previous, `rows ascend by rank (${previous} -> ${row.rank})`);
  previous = row.rank;
  assertEqual(row.balanceText, "not loaded", `${row.symbol} ${row.chain} starts not loaded`);
  assertEqual(row.usdText, "—", `${row.symbol} ${row.chain} starts without USD`);
}
assertEqual(empty.totalText, "—", "nothing loaded is not $0.00");
assertEqual(empty.loaded, 0, "nothing loaded");
assertEqual(empty.missing, 14, "all rows are missing");

/* ------------------------------------------------------- exact USD math */

function key(symbol, chain, contract) {
  const asset = generated.assets.find((item) => item.symbol === symbol);
  return asset.rank + "|" + chain + "|" + (contract || "native");
}

const states = {};
states[key("BTC", "bitcoin")] = { state: "ok", amount: 100000000n };
states[key("ETH", "ethereum")] = { state: "ok", amount: 1500000000000000000n };
states[key("USDT", "tron", usdt.contracts.tron)] = { state: "ok", amount: 5000000n };
states[key("USDC", "ethereum", usdc.contracts.ethereum)] = { state: "ok", amount: 2000000n };
states[key("USDC", "base", usdc.contracts.base)] = { state: "ok", amount: 0n };
states[key("TRX", "tron")] = { state: "ok", amount: 1000000n };

const loaded = assetsApi.buildRows(generated.assets, states, prices, "fresh");
const byRow = {};
for (const row of loaded.rows) byRow[`${row.symbol}|${row.chain}`] = row;

assertEqual(byRow["BTC|bitcoin"].balanceText, "1 BTC", "BTC balance text");
assertEqual(byRow["BTC|bitcoin"].usdText, "$60,000.00", "BTC USD");
assertEqual(byRow["ETH|ethereum"].usdText, "$4,500.00", "ETH USD");
assertEqual(byRow["USDT|tron"].balanceText, "5 USDT", "USDT balance text");
assertEqual(byRow["USDT|tron"].usdText, "$5.00", "USDT explicit peg");
assertEqual(byRow["USDC|ethereum"].usdText, "$2.00", "USDC USD");
assertEqual(byRow["USDC|base"].usdText, "$0.00", "a loaded zero is a real $0.00");
assertEqual(byRow["TRX|tron"].usdText, "$0.10", "TRX USD");
assertEqual(loaded.loaded, 6, "six loaded rows");
assertEqual(loaded.totalText, "$64,507.10", "exact BigInt USD total");
assertEqual(
  loaded.totalCents,
  6450710n,
  "total cents stay an exact integer (no float)",
);
assertEqual(byRow["BNB|bnb"].balanceText, "not loaded", "an unloaded row stays not loaded");
assertEqual(loaded.missing, 8, "eight rows have no balance");

/* A zero-decimal token with a tiny price rounds half up through BigInt. */
const tiny = {};
tiny[key("USDC", "ethereum", usdc.contracts.ethereum)] = { state: "ok", amount: 1n };
const tinyRows = assetsApi.buildRows(generated.assets, tiny, { USDC: "0.000000005" }, "fresh");
assertEqual(
  tinyRows.rows.find((row) => row.symbol === "USDC" && row.chain === "ethereum").usdText,
  "$0.00",
  "a 1-atomic-unit token at a tiny price rounds to zero cents, not a fraction",
);

/* --------------------------------------------------- honest non-values */

const stale = assetsApi.buildRows(generated.assets, states, prices, "stale");
assertEqual(stale.totalText, "—", "a stale ticker hides the USD total");
const staleBtc = stale.rows.find((row) => row.symbol === "BTC");
assertEqual(staleBtc.balanceText, "1 BTC", "a stale ticker keeps the native amount");
assertEqual(staleBtc.usdText, "—", "a stale ticker never becomes a USD value");

const errored = Object.assign({}, states);
errored[key("BTC", "bitcoin")] = { state: "error", detail: "HTTP 503" };
const withError = assetsApi.buildRows(generated.assets, errored, prices, "fresh");
assertEqual(
  withError.rows.find((row) => row.symbol === "BTC").balanceText,
  "lookup failed",
  "a failed row says lookup failed",
);
assertEqual(
  withError.rows.find((row) => row.symbol === "BTC").balanceTitle,
  "HTTP 503",
  "a failed row carries the provider reason",
);
assertEqual(withError.totalText, "$4,507.10", "a failed row is not counted as zero");

const unavailable = {};
unavailable[key("BCH", "bitcoin-cash")] = { state: "unavailable" };
const withUnavailable = assetsApi.buildRows(generated.assets, unavailable, prices, "fresh");
assertEqual(
  withUnavailable.rows.find((row) => row.symbol === "BCH").balanceText,
  "unavailable",
  "an asset without a read path says unavailable",
);
assertEqual(withUnavailable.unavailable, 1, "unavailable rows are counted");

assertEqual(
  assetsApi.buildRows(generated.assets, {}, {}, "fresh").totalText,
  "—",
  "an empty ticker table is not a zero total",
);

/* ------------------------------------------------- provider body decoders */

assertEqual(
  assetsApi.parseTronTokenBalance({ trc20: [{ "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t": "5" }] }, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),
  "5",
  "TronScan TRC-20 amount",
);
assertEqual(assetsApi.parseTronTokenBalance({ trc20: [] }, "T"), "0", "no TRC-20 row is a real zero");
assertEqual(assetsApi.parseTronTokenBalance({ address: "T", balance: 1 }, "T"), "0", "activated account without the token");
assertEqual(assetsApi.parseTronTokenBalance({ nope: true }, "T"), null, "unrelated body is not zero");
assertEqual(assetsApi.parseEvmBalance("0x"), null, "empty eth_call data is not zero");
assertEqual(assetsApi.parseEvmBalance("0xzz"), null, "non-hex eth_call data is not a balance");
assertEqual(
  assetsApi.parseEvmBalance("0x" + "0".repeat(63) + "2"),
  2n,
  "eth_call balanceOf word parses as BigInt",
);

console.log("wallet-assets-test: ok");
