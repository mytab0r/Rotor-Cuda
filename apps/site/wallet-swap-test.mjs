// SunSwap V2 wallet swap tests (apps/site/wallet-swap.js).
//
// Usage: node apps/site/wallet-swap-test.mjs
//
// No network and no DOM: the module under test is pure logic. The wasm swap
// encoder and its calldata vectors live in crates/rotor-wasm/src/tron.rs; this
// file covers the same-chain swap helpers: the TRX wrap in the path, the
// minimum-received bound, slippage parsing, the deadline, the quote TTL, the
// approve decision, the getAmountsOut ABI decode and the route caption.
//
// The module reads chain-scoped swap constants from the generated SSOT
// globals, exactly as wallet-tron.js reads its networks. The tests install a
// stand-in table BEFORE the require so they do not depend on data/chains.json
// landing first:
//   globalThis.RotorChains.bySlug[slug].wtrx  -> the wrapped TRX contract.
// The developer adds that key to data/chains.json and its generator; the value
// below is the real SunSwap WTRX contract.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const WTRX_ADDRESS = "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDC = "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8";

globalThis.RotorChains = {
  bySlug: {
    tron: {
      slug: "tron",
      name: "TRON",
      symbol: "TRX",
      decimals: 6,
      family: "tron",
      testnet: false,
      wtrx: WTRX_ADDRESS,
    },
    "tron-nile": {
      slug: "tron-nile",
      name: "TRON Nile",
      symbol: "TRX",
      decimals: 6,
      family: "tron",
      testnet: true,
      wtrx: WTRX_ADDRESS,
    },
  },
};
globalThis.RotorProviders = {
  byChain: { tron: [], "tron-nile": [] },
  find() {
    return null;
  },
};

const swap = require("./wallet-swap.js");

function u256(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

/* ABI uint256[] as a getAmountsOut constant call returns it:
 * [offset = 32][length][amount0..amountN-1]. */
function amountsBlob(values) {
  return [u256(32), u256(values.length), ...values.map(u256)].join("");
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* ------------------------------------------------- one mainnet arm control */

const walletSource = readFileSync(new URL("./wallet.js", import.meta.url), "utf8");
const walletHtml = readFileSync(new URL("./wallet.html", import.meta.url), "utf8");

test("the swap flow has no second mainnet arm state", () => {
  // One control per purpose: the send card's checkbox and state.mainnetArmed
  // are the only arm. The swap confirm calls the send gate's isMainnetArmed.
  assert.equal(walletSource.includes("swapArmed"), false,
    "wallet.js must not carry a second swap arm state");
  assert.equal(walletSource.includes("wallet-swap-armed"), false,
    "wallet.js must not reference a swap arm control");
  assert.match(walletSource, /assertTronMainnetArmed\(network, isMainnetArmed\(\)\)/,
    "the swap confirm must use the send gate's isMainnetArmed");
  assert.equal(walletHtml.includes("wallet-swap-armed"), false,
    "wallet.html must not render a swap arm control");
  assert.equal((walletHtml.match(/id="wallet-send-armed"/g) || []).length, 1,
    "wallet.html must render exactly one arm checkbox");
});

/* ------------------------------------------------------------- WTRX source */

test("WTRX is the wrapped-TRX contract from the SSOT chain data", () => {
  assert.equal(swap.WTRX, WTRX_ADDRESS);
});

/* ------------------------------------------------------------------ path */

test("buildPath wraps TRX at both ends and goes through WTRX between tokens", () => {
  // TRX -> token: the router gets WTRX as the input token.
  assert.deepEqual(swap.buildPath({ from: "", to: USDT, wtrx: WTRX_ADDRESS }), [
    WTRX_ADDRESS,
    USDT,
  ]);
  // token -> TRX: the router unwraps at the end.
  assert.deepEqual(swap.buildPath({ from: USDT, to: "", wtrx: WTRX_ADDRESS }), [
    USDT,
    WTRX_ADDRESS,
  ]);
  // token -> token: WTRX is the middle hop.
  assert.deepEqual(
    swap.buildPath({ from: USDT, to: USDC, wtrx: WTRX_ADDRESS }),
    [USDT, WTRX_ADDRESS, USDC]
  );
  // The caller-supplied wtrx is used, not a page-local copy.
  assert.deepEqual(swap.buildPath({ from: "", to: USDT, wtrx: "TWrapped" }), [
    "TWrapped",
    USDT,
  ]);
});

test("buildPath never inserts WTRX twice when WTRX is a selected token", () => {
  // WTRX is in the curated token list, so it can be the route end itself.
  assert.deepEqual(swap.buildPath({ from: WTRX_ADDRESS, to: USDT, wtrx: WTRX_ADDRESS }), [
    WTRX_ADDRESS,
    USDT,
  ]);
  assert.deepEqual(swap.buildPath({ from: USDT, to: WTRX_ADDRESS, wtrx: WTRX_ADDRESS }), [
    USDT,
    WTRX_ADDRESS,
  ]);
  // TRX <-> WTRX is wrapping, not a swap.
  assert.throws(
    () => swap.buildPath({ from: "", to: WTRX_ADDRESS, wtrx: WTRX_ADDRESS }),
    /same|wtrx|route/i
  );
  assert.throws(
    () => swap.buildPath({ from: WTRX_ADDRESS, to: "", wtrx: WTRX_ADDRESS }),
    /same|wtrx|route/i
  );
});

test("buildPath refuses a route whose ends are the same asset", () => {
  assert.throws(
    () => swap.buildPath({ from: USDT, to: USDT, wtrx: WTRX_ADDRESS }),
    /same|equal|route/i
  );
  // TRX -> TRX has no swap.
  assert.throws(
    () => swap.buildPath({ from: "", to: "", wtrx: WTRX_ADDRESS }),
    /same|equal|route/i
  );
});

/* --------------------------------------------------------- min received */

test("minReceived floors the quote by the slippage in basis points", () => {
  // Boundary 0 bps: no slippage, the full quote is the bound.
  assert.equal(swap.minReceived(1_000_000n, 0), 1_000_000n);
  // Boundary 5000 bps (50%): half the quote.
  assert.equal(swap.minReceived(1_000_000n, 5000), 500_000n);
  // A typical 0.5% bound.
  assert.equal(swap.minReceived(1_000_000n, 50), 995_000n);
  // The division floors, never rounds up: 9999 * 9950 / 10000 = 9949.005.
  assert.equal(swap.minReceived(9999n, 50), 9949n);
});

test("minReceived refuses a slippage outside 0..5000 bps or a fraction", () => {
  assert.throws(() => swap.minReceived(1_000_000n, -1), /slippage|bps|0|5000/i);
  assert.throws(() => swap.minReceived(1_000_000n, 5001), /slippage|bps|0|5000/i);
  assert.throws(() => swap.minReceived(1_000_000n, 50.5), /slippage|bps|integer/i);
  assert.throws(() => swap.minReceived(1_000_000n, "50"), /slippage|bps|BigInt/i);
});

/* ------------------------------------------------------------- slippage */

test("parseSlippage converts a percent string to basis points exactly", () => {
  assert.equal(swap.parseSlippage("0"), 0);
  assert.equal(swap.parseSlippage("0.5"), 50);
  assert.equal(swap.parseSlippage("1"), 100);
  assert.equal(swap.parseSlippage("12.34"), 1234);
  assert.equal(swap.parseSlippage("50"), 5000);
  assert.equal(swap.parseSlippage(" 2.5 "), 250);
});

test("parseSlippage rejects empty, negative, over-cap, sub-basis and non-numeric input", () => {
  assert.throws(() => swap.parseSlippage(""), /slippage|percent|number|empty/i);
  assert.throws(() => swap.parseSlippage("   "), /slippage|percent|number|empty/i);
  assert.throws(() => swap.parseSlippage("-1"), /slippage|negative|percent/i);
  assert.throws(() => swap.parseSlippage("50.01"), /slippage|50|percent/i);
  assert.throws(() => swap.parseSlippage("0.005"), /slippage|precision|basis/i);
  assert.throws(() => swap.parseSlippage("1.234"), /slippage|precision|basis/i);
  assert.throws(() => swap.parseSlippage("abc"), /slippage|percent|number/i);
  assert.throws(() => swap.parseSlippage("1e1"), /slippage|percent|number/i);
});

/* -------------------------------------------------------------- deadline */

test("deadlineFrom defaults to twenty minutes and stays ahead of now", () => {
  const now = 1_700_000_000_000;
  // BigInt or string both satisfy the numeric contract; the value is pinned.
  assert.equal(BigInt(swap.deadlineFrom(now)), 1_700_001_200_000n);
  assert.equal(BigInt(swap.deadlineFrom(1000, 5000)), 6000n);
  assert.ok(BigInt(swap.deadlineFrom(now)) > BigInt(now));
});

test("deadlineFrom refuses a non-positive time to live", () => {
  assert.throws(() => swap.deadlineFrom(1000, 0), /deadline|ttl|positive|future/i);
  assert.throws(() => swap.deadlineFrom(1000, -1), /deadline|ttl|positive|future/i);
});

/* ------------------------------------------------------------ quote TTL */

test("a quote exactly 60 seconds old is fresh and one second older is stale", () => {
  const quote = { fetchedAt: 1_000_000 };
  assert.doesNotThrow(() => swap.assertQuoteFresh(quote, 1_060_000));
  assert.throws(() => swap.assertQuoteFresh(quote, 1_060_001), /stale|expired|older than|quote/i);
  assert.throws(() => swap.assertQuoteFresh({}, 1_060_000), /quote|time|stale/i);
});

/* --------------------------------------------------------------- approve */

test("approveNeeded is true only when the allowance is below the amount", () => {
  assert.equal(swap.approveNeeded(0n, 1n), true);
  assert.equal(swap.approveNeeded(1_000_000n, 1_000_001n), true);
  assert.equal(swap.approveNeeded(1n, 1n), false);
  assert.equal(swap.approveNeeded(2n, 1n), false);
});

/* ------------------------------------------------- getAmountsOut decode */

test("parseAmountsOut decodes the uint256[] for a three-address route", () => {
  const blob = amountsBlob([1_000_000n, 3_400_000n, 3_399_320n]);
  const amounts = swap.parseAmountsOut(blob, 3);
  assert.deepEqual(amounts, [1_000_000n, 3_400_000n, 3_399_320n]);
  assert.ok(amounts.every((amount) => typeof amount === "bigint"), "amounts are BigInt");
});

test("parseAmountsOut accepts a 0x prefix and a two-address route", () => {
  const blob = "0x" + amountsBlob([1_000_000n, 2_500_000n]);
  assert.deepEqual(swap.parseAmountsOut(blob, 2), [1_000_000n, 2_500_000n]);
});

test("parseAmountsOut refuses a length that does not match the path", () => {
  // Two amounts for a three-address path: the route would skip a hop.
  const short = amountsBlob([1_000_000n, 3_400_000n]);
  assert.throws(() => swap.parseAmountsOut(short, 3), /length|path|amounts/i);

  // A declared length of three with only two amount words is truncated.
  const truncated = u256(32) + u256(3) + u256(1_000_000n) + u256(3_400_000n);
  assert.throws(() => swap.parseAmountsOut(truncated, 3), /length|path|amounts|truncat/i);

  // A malformed offset word is not the standard uint256[] return.
  const badOffset = u256(64) + u256(2) + u256(1_000_000n) + u256(2_500_000n);
  assert.throws(() => swap.parseAmountsOut(badOffset, 2), /offset|abi|amounts/i);

  // Non-hex data is not an ABI return.
  assert.throws(() => swap.parseAmountsOut("zz".repeat(128), 2), /hex|abi|amounts/i);
});

/* ------------------------------------------- rebuild after the approve */

function swapReview() {
  return {
    quote: { block: { timestamp: "1700000000000" } },
    swap: {
      feeLimitSun: 30000000n,
      request: {
        kind: "swap",
        owner_address: "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax",
        to_address: "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax",
        token_contract_address: "",
        router_address: "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax",
        path: [WTRX_ADDRESS, USDT].join(","),
        amount_in: "1000000",
        amount_out_min: "300000",
        deadline: "1700001200000",
        ref_block_bytes: "aaaa",
        ref_block_hash: "0102030405060708",
        expiration: "1700000090000",
        timestamp: "1700000000000",
        fee_limit: "30000000",
      },
    },
  };
}

function freshBlock(timestamp) {
  return {
    ref_block_bytes: "bbbb",
    ref_block_hash: "1112131415161718",
    timestamp: String(timestamp),
    expiration: String(timestamp + 90000),
  };
}

test("rebuildSwapStep keeps the reviewed amounts and path with fresh ref fields", () => {
  const review = swapReview();
  const out = swap.rebuildSwapStep(review, freshBlock(1_700_000_100_000));
  // Economic fields stay exactly as reviewed.
  for (const field of ["owner_address", "to_address", "token_contract_address",
    "router_address", "path", "amount_in", "amount_out_min"]) {
    assert.equal(out.request[field], review.swap.request[field], field);
  }
  assert.equal(out.request.fee_limit, review.swap.request.fee_limit);
  // Only the ref block and the deadline move.
  assert.equal(out.request.ref_block_bytes, "bbbb");
  assert.equal(out.request.ref_block_hash, "1112131415161718");
  assert.equal(out.request.timestamp, "1700000100000");
  assert.equal(out.request.expiration, "1700000190000");
  assert.equal(out.request.deadline, "1700001300000");
  assert.equal(out.feeLimitSun, review.swap.feeLimitSun);
  assert.equal(out.fixed, swap.fixedSwapFields(review.swap.request));
  // A mutated amount is a different pin.
  const mutated = swapReview();
  mutated.swap.request.amount_in = "2000000";
  assert.notEqual(swap.fixedSwapFields(mutated.swap.request), out.fixed);
});

test("rebuildSwapStep refuses a block older than the reviewed one", () => {
  assert.throws(
    () => swap.rebuildSwapStep(swapReview(), freshBlock(1_699_999_999_999)),
    /older|block|refus/i
  );
});

/* ---------------------------------------------------------------- route */

test("formatRoute renders the hop symbols with arrows", () => {
  assert.equal(
    swap.formatRoute([USDT, WTRX_ADDRESS, USDC], ["USDT", "WTRX", "USDC"]),
    "USDT → WTRX → USDC"
  );
  // A TRX swap shows the user-facing symbol, not the wrapped contract.
  assert.equal(swap.formatRoute([WTRX_ADDRESS, USDT], ["TRX", "USDT"]), "TRX → USDT");
  assert.throws(
    () => swap.formatRoute([USDT, WTRX_ADDRESS, USDC], ["USDT", "WTRX"]),
    /symbol|length|path/i
  );
});

/* ---------------------------------------------------------------- runner */

let failed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    console.log("ok - " + name);
  } catch (err) {
    failed += 1;
    console.error("not ok - " + name);
    console.error(err && err.stack ? err.stack : err);
  }
}
if (failed) {
  console.error("\n" + failed + " of " + cases.length + " wallet swap tests failed");
  process.exit(1);
}
console.log("\n" + cases.length + " wallet swap tests passed");
