// Transaction-history parser and formatting tests for the cabinet wallet
// (apps/site/wallet-history.js).
//
// Usage: node apps/site/wallet-history-test.mjs
//
// No network and no DOM. Fixtures mirror the real provider shapes:
//  - Bitcoin: mempool.space `/api/address/<addr>/txs` (vin[].prevout.value,
//    vout[].scriptpubkey_address/value, fee, status.confirmed/block_time).
//  - TRON: the coordinator's normalized answer; the raw TronScan shape is
//    pinned in src/coordinator/mod.rs unit tests.

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("./chains.generated.js");
require("./amount.js");
const history = require("./wallet-history.js");

const BTC = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const SENDER = "bc1qsender0000000000000000000000000000000000";
const RECIPIENT = "bc1qrecipient000000000000000000000000000000000";
const TRON_A = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_B = "TGzrB1LxU6e3H8767tpDw8nFmj4UrnV4iB";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* -------------------------------------------------------------- bitcoin in */

test("BTC incoming counts only the outputs that pay the address", () => {
  const txs = [{
    txid: "aa".repeat(32),
    vin: [{ prevout: { scriptpubkey_address: SENDER, value: 120000 } }],
    vout: [
      { scriptpubkey_address: BTC, value: 50000 },
      { scriptpubkey_address: SENDER, value: 69000 }
    ],
    fee: 1000,
    status: { confirmed: true, block_time: 1700000000 }
  }];
  const rows = history.parseBtcTxs(BTC, txs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, "in");
  assert.equal(rows[0].amountAtomic, "50000");
  assert.equal(rows[0].counterparty, SENDER);
  assert.equal(rows[0].confirmed, true);
  assert.equal(rows[0].timestamp, 1700000000000);
  assert.equal(rows[0].feeAtomic, undefined, "the receiver pays no fee");
});

/* ------------------------------------------------------------- bitcoin out */

test("BTC outgoing excludes change and reports the fee", () => {
  const txs = [{
    txid: "bb".repeat(32),
    vin: [
      { prevout: { scriptpubkey_address: BTC, value: 60000 } },
      { prevout: { scriptpubkey_address: BTC, value: 40000 } }
    ],
    vout: [
      { scriptpubkey_address: RECIPIENT, value: 60000 },
      { scriptpubkey_address: BTC, value: 30000 }
    ],
    fee: 10000,
    status: { confirmed: true, block_time: 1700000100 }
  }];
  const rows = history.parseBtcTxs(BTC, txs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, "out");
  assert.equal(rows[0].amountAtomic, "60000", "100000 in - 30000 change - 10000 fee");
  assert.equal(rows[0].counterparty, RECIPIENT);
  assert.equal(rows[0].feeAtomic, "10000");
  assert.equal(rows[0].timestamp, 1700000100000);
});

test("BTC direction is outgoing for a self-transfer and amount is zero", () => {
  const txs = [{
    txid: "cc".repeat(32),
    vin: [{ prevout: { scriptpubkey_address: BTC, value: 10000 } }],
    vout: [{ scriptpubkey_address: BTC, value: 9000 }],
    fee: 1000,
    status: { confirmed: true, block_time: 1700000200 }
  }];
  const rows = history.parseBtcTxs(BTC, txs);
  assert.equal(rows[0].direction, "out");
  assert.equal(rows[0].amountAtomic, "0");
  assert.equal(rows[0].counterparty, "");
  assert.equal(rows[0].feeAtomic, "1000");
});

test("BTC unconfirmed rows are pending with no timestamp", () => {
  const txs = [{
    txid: "dd".repeat(32),
    vin: [{ prevout: { scriptpubkey_address: SENDER, value: 1000 } }],
    vout: [{ scriptpubkey_address: BTC, value: 900 }],
    fee: 100,
    status: { confirmed: false }
  }];
  const rows = history.parseBtcTxs(BTC, txs);
  assert.equal(rows[0].confirmed, false);
  assert.equal(rows[0].timestamp, null);
  assert.equal(history.formatTime(rows[0].timestamp), "Pending");
  assert.equal(history.statusLabel(rows[0].confirmed), "Pending");
});

test("BTC skips malformed rows and caps at 50", () => {
  const txs = [];
  for (let i = 0; i < 60; i += 1) {
    txs.push({
      txid: String(i).padStart(64, "0"),
      vin: [{ prevout: { scriptpubkey_address: SENDER, value: 1000 } }],
      vout: [{ scriptpubkey_address: BTC, value: 900 }],
      status: { confirmed: true, block_time: 1700000000 + i }
    });
  }
  txs.unshift({ txid: "" });
  txs.unshift(null);
  const rows = history.parseBtcTxs(BTC, txs);
  assert.equal(rows.length, history.MAX_TXS);
});

/* ------------------------------------------------------------------- tron */

test("TRON normalized rows keep in/out, native amount and pending state", () => {
  const payload = {
    chain: "tron",
    address: TRON_A,
    source: "tronscan",
    transactions: [
      {
        txid: "t1", timestamp: 1795348446000, direction: "in",
        amountSun: "2000000", counterparty: TRON_B, confirmed: true
      },
      {
        txid: "t2", timestamp: 1795348000000, direction: "out",
        amountSun: "1500000", counterparty: TRON_B, confirmed: true, fee: "100000"
      },
      {
        txid: "t3", timestamp: null, direction: "out",
        amountSun: "0", counterparty: "", confirmed: false
      }
    ]
  };
  const rows = history.parseTronPayload(TRON_A, payload);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].direction, "in");
  assert.equal(rows[0].amountAtomic, "2000000");
  assert.equal(rows[1].direction, "out");
  assert.equal(rows[1].feeAtomic, "100000");
  assert.equal(rows[2].confirmed, false);
  assert.equal(rows[2].timestamp, null);
});

test("TRON skips malformed rows, defaults a bad direction to out and caps at 50", () => {
  const transactions = [];
  for (let i = 0; i < 60; i += 1) {
    transactions.push({ txid: "tx" + i, timestamp: 1, direction: "in", amountSun: "1", confirmed: true });
  }
  transactions.unshift({ txid: "", direction: "in" });
  transactions.unshift({ txid: "bad-amount", amountSun: "-5", direction: "sideways" });
  const rows = history.parseTronPayload(TRON_A, { transactions });
  assert.equal(rows.length, history.MAX_TXS);
  assert.equal(rows[0].direction, "out");
  assert.equal(rows[0].amountAtomic, "0");
});

/* -------------------------------------------------------------- formatting */

test("native units use RotorAmount for BTC and TRX", () => {
  assert.equal(history.formatNative("100000000", "bitcoin"), "1 BTC");
  assert.equal(history.formatNative("1", "bitcoin"), "0.00000001 BTC");
  assert.equal(history.formatNative("100000000", "bitcoin-testnet"), "1 BTC");
  assert.equal(history.formatNative("1500000", "tron"), "1.5 TRX");
  assert.throws(() => history.formatNative("-1", "tron"), /non-negative/);
});

test("time and truncation helpers are deterministic", () => {
  assert.equal(history.formatTime(1700000000000), "2023-11-14 22:13 UTC");
  assert.equal(history.truncateMiddle(TRON_A, 6, 4), "TR7NHq…Lj6t");
  assert.equal(history.truncateMiddle("short"), "short");
  assert.equal(history.directionLabel("in"), "In");
  assert.equal(history.directionLabel("out"), "Out");
});

/* ------------------------------------------------------------------- evm */

test("EVM chains return the honest unavailable state and no provider", () => {
  for (const slug of ["ethereum", "bnb", "arbitrum", "optimism", "base", "polygon", "avalanche", "zksync"]) {
    const info = history.support(slug);
    assert.equal(info.kind, "evm", slug);
    assert.equal(info.message, history.EVM_UNAVAILABLE, slug);
    assert.equal(info.docsHref, "/docs", slug);
  }
  assert.match(history.EVM_UNAVAILABLE, /indexer or an API key/);
  assert.match(history.EVM_UNAVAILABLE, /does not ship one/);
});

test("BTC, TRON and the remaining chains are classified honestly", () => {
  assert.equal(history.support("bitcoin").kind, "btc");
  assert.equal(history.support("bitcoin-testnet").kind, "btc");
  assert.equal(history.support("tron").kind, "tron");
  for (const slug of ["litecoin", "dogecoin", "xrp", "solana", "sui", "ton", "bitcoin-cash", "zcash"]) {
    const info = history.support(slug);
    assert.equal(info.kind, "other", slug);
    assert.equal(info.message, history.OTHER_UNAVAILABLE, slug);
  }
});

test("BTC history URLs use the right mempool.space network", () => {
  assert.equal(
    history.btcTxsUrl("bitcoin", BTC),
    "https://mempool.space/api/address/" + BTC + "/txs"
  );
  assert.equal(
    history.btcTxsUrl("bitcoin-testnet", "tb1qexample"),
    "https://mempool.space/testnet/api/address/tb1qexample/txs"
  );
});

/* ------------------------------------------------------------------- run */

let failed = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    console.log("ok   " + name);
  } catch (err) {
    failed += 1;
    console.error("FAIL " + name + ": " + (err && err.message ? err.message : err));
  }
}
if (failed) {
  console.error(failed + " of " + cases.length + " history tests failed");
  process.exit(1);
}
console.log(cases.length + " history tests passed");
