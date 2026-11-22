#!/usr/bin/env node
/* Tests for the pure balance-cache codec. No browser, no network. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cache = require("./balance-cache.js");

let failed = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        () => console.log(`ok - ${name}`),
        (err) => { failed += 1; console.error(`not ok - ${name}\n  ${err && err.stack ? err.stack : err}`); },
      );
    }
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}\n  ${err && err.stack ? err.stack : err}`);
  }
  return Promise.resolve();
}

const NOW = 1700000000000;

const tests = [
  test("cache key includes provider, chain and address", () => {
    assert.equal(cache.cacheKey("mempool", "bitcoin", "bc1q"), "mempool|bitcoin|bc1q");
  }),

  test("TTL is 60s for BTC and 30s for EVM, 60s for others", () => {
    assert.equal(cache.ttlFor("mempool"), 60000);
    assert.equal(cache.ttlFor("blockchain.info"), 60000);
    assert.equal(cache.ttlFor("evm"), 30000);
    assert.equal(cache.ttlFor("tronscan"), 60000);
    assert.equal(cache.ttlFor("solana"), 60000);
  }),

  test("fresh cache hit inside TTL", () => {
    const entry = cache.makeEntry({ balance: "42" }, "test", NOW - 5000);
    assert.equal(cache.isSuccess(entry), true);
    assert.equal(cache.isFresh(entry, 60000, NOW), true);
    assert.equal(cache.shouldRefresh(entry, 60000, NOW), false);
  }),

  test("cache miss and stale entry both need refresh", () => {
    assert.equal(cache.shouldRefresh(null, 60000, NOW), true);
    const stale = cache.makeEntry({ balance: "1" }, "test", NOW - 61000);
    assert.equal(cache.isStale(stale, 60000, NOW), true);
    assert.equal(cache.shouldRefresh(stale, 60000, NOW), true);
    const fresh = cache.makeEntry({ balance: "1" }, "test", NOW - 1000);
    assert.equal(cache.shouldRefresh(fresh, 60000, NOW), false);
  }),

  test("provider error is never a success and never replaces a good value", () => {
    const error = cache.makeErrorEntry("HTTP 429", "test", NOW);
    assert.equal(cache.isSuccess(error), false);
    assert.equal(cache.shouldRefresh(error, 60000, NOW), true);

    const good = cache.makeEntry({ balance: "7" }, "test", NOW - 30000);
    const merged = cache.mergeEntries(good, error);
    assert.equal(merged.value.balance, "7");
    assert.equal(merged.error, undefined);

    const onlyError = cache.mergeEntries(null, error);
    assert.equal(onlyError.error, "HTTP 429");
    assert.equal(cache.isSuccess(onlyError), false);
  }),

  test("refresh selects only failed or stale records", () => {
    const records = [
      { key: "fresh", entry: cache.makeEntry({ balance: "1" }, "p", NOW - 1000) },
      { key: "stale", entry: cache.makeEntry({ balance: "2" }, "p", NOW - 90000) },
      { key: "failed", entry: cache.makeErrorEntry("HTTP 500", "p", NOW - 10) },
      { key: "missing", entry: null },
    ];
    assert.deepEqual(cache.selectStale(records, 60000, NOW), ["stale", "failed", "missing"]);
  }),

  test("age labels are human and empty without an entry", () => {
    assert.equal(cache.ageLabel(null, NOW), "");
    assert.equal(cache.ageLabel(cache.makeEntry(1, "p", NOW - 500), NOW), "just now");
    assert.equal(cache.ageLabel(cache.makeEntry(1, "p", NOW - 12000), NOW), "12s ago");
    assert.equal(cache.ageLabel(cache.makeEntry(1, "p", NOW - 120000), NOW), "2m ago");
  }),

  test("relative time labels absolute timestamps for the TRON last-tx cell", () => {
    assert.equal(cache.relativeTime(NOW - 500, NOW), "just now");
    assert.equal(cache.relativeTime(NOW - 120000, NOW), "2m ago");
    assert.equal(cache.relativeTime(NOW - 7200000, NOW), "2h ago");
    assert.equal(cache.relativeTime(NOW - 3 * 86400000, NOW), "3d ago");
    assert.equal(cache.relativeTime(NOW + 1000, NOW), "");
    assert.equal(cache.relativeTime("not-a-number", NOW), "");
  }),

  test("limiter keeps concurrency bounded", async () => {
    const limit = 5;
    const run = cache.createLimiter(limit);
    let active = 0;
    let maxActive = 0;
    await Promise.all(Array.from({ length: 20 }, () => run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    })));
    assert.equal(maxActive, limit);
    assert.equal(active, 0);
  }),

  test("backoff grows exponentially with deterministic jitter", () => {
    const fixed = { random: () => 0.5, jitter: 0, baseDelay: 400, factor: 2, maxDelay: 8000 };
    assert.equal(cache.backoffDelay(0, fixed), 400);
    assert.equal(cache.backoffDelay(1, fixed), 800);
    assert.equal(cache.backoffDelay(2, fixed), 1600);
    const jittered = cache.backoffDelay(1, { random: () => 1, jitter: 0.5, baseDelay: 400, factor: 2 });
    assert.equal(jittered, 1200);
  }),

  test("withRetry retries a 500 once and then stops", async () => {
    let calls = 0;
    const err = new Error("HTTP 500");
    err.status = 500;
    await assert.rejects(
      cache.withRetry(async () => { calls += 1; throw err; }, { attempts: 2, baseDelay: 1, random: () => 0.5 }),
      /HTTP 500/,
    );
    assert.equal(calls, 2);
  }),

  test("withRetry does not retry a 400", async () => {
    let calls = 0;
    const err = new Error("HTTP 404");
    err.status = 404;
    await assert.rejects(cache.withRetry(async () => { calls += 1; throw err; }, { baseDelay: 1 }), /HTTP 404/);
    assert.equal(calls, 1);
  }),

  test("withRetry succeeds on the second transient attempt", async () => {
    let calls = 0;
    const result = await cache.withRetry(async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("network");
        throw err;
      }
      return "ok";
    }, { baseDelay: 1, random: () => 0.5 });
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  }),

  test("empty address is not a valid request target", () => {
    assert.equal(cache.hasAddress(""), false);
    assert.equal(cache.hasAddress("   "), false);
    assert.equal(cache.hasAddress("bc1qexample"), true);
  }),

  test("haskoin batch maps 60 rows by index and sums confirmed + unconfirmed", () => {
    const addresses = Array.from({ length: 60 }, (_, i) => `legacy${i}`);
    // The provider echoes CashAddr, not the legacy address that was sent.
    const rows = addresses.map((_, i) => ({
      address: `bitcoincash:qqq${i}`,
      confirmed: String(1000 + i),
      unconfirmed: i % 2 ? "-1" : "0",
      txs: i,
    }));
    const parsed = cache.parseHaskoinBchBatch(rows, addresses);
    assert.equal(parsed.length, 60);
    assert.deepEqual(parsed[0], { amount: "1000", tx: 0 });
    assert.deepEqual(parsed[1], { amount: "1000", tx: 1 });
    assert.deepEqual(parsed[59], { amount: "1058", tx: 59 });

    assert.deepEqual(cache.parseHaskoinBchBatch([{ confirmed: "42" }], ["a"]), [{ amount: "42", tx: null }]);
    assert.deepEqual(cache.parseHaskoinBchBatch([{}], ["a"]), [null], "a malformed row is null");
    assert.equal(cache.parseHaskoinBchBatch([{ confirmed: "1" }], ["a", "b"]), null, "length mismatch");
    assert.equal(cache.parseHaskoinBchBatch({ confirmed: "1" }, ["a"]), null, "non-array body");
    assert.equal(cache.parseHaskoinBchBatch([{ confirmed: "1" }], undefined), null, "missing request list");
    assert.deepEqual(
      cache.parseHaskoinBchBatch([{ confirmed: "1", unconfirmed: "-5" }], ["a"]),
      [{ amount: "0", tx: null }],
      "a negative net balance clamps to zero instead of going negative"
    );
  }),

  test("free-provider bodies decode to atomic amounts", () => {
    // XRPScan: drops in account_data.Balance, transaction count alongside.
    assert.deepEqual(
      cache.parseXrpAccount({ account_data: { Balance: "12345678", TransactionCount: 7 } }),
      { amount: "12345678", tx: 7 },
    );
    assert.equal(cache.parseXrpAccount({ balance_drops: "42" }).amount, "42");
    assert.equal(cache.parseXrpAccount({}), null);

    // Solana getBalance / getMultipleAccounts.
    assert.equal(
      cache.parseSolanaBalance({ result: { context: { slot: 1 }, value: 2039280 } }).amount,
      "2039280",
    );
    assert.deepEqual(
      cache.parseSolanaAccounts({ result: { value: [{ lamports: 5 }, null, {}] } }),
      ["5", "0", "0"],
    );
    assert.equal(cache.parseSolanaAccounts({ result: {} }), null);

    // Sui: GraphQL (live public shape) and the legacy JSON-RPC result.
    assert.equal(
      cache.parseSuiBalance({
        data: { address: { balance: { totalBalance: "1000000000" } } },
      }).amount,
      "1000000000",
    );
    assert.equal(
      cache.parseSuiBalance({ result: { coinType: "0x2::sui::SUI", totalBalance: "42" } })
        .amount,
      "42",
    );
    assert.equal(cache.parseSuiBalance({ data: { address: { balance: {} } } }), null);

    // TON Center: nanotons string, and an explicit failure body.
    assert.equal(cache.parseTonBalance({ ok: true, result: "250000000" }).amount, "250000000");
    assert.equal(cache.parseTonBalance({ ok: false, error: "invalid address" }), null);

    // BlockCypher balance: atomic units, final_* preferred over the raw fields.
    assert.deepEqual(
      cache.parseBlockcypherBalance({
        balance: 150000,
        final_balance: 175000,
        total_received: 900000,
        n_tx: 4,
        final_n_tx: 5,
      }),
      { amount: "175000", received: "900000", txs: 5 },
    );
    assert.deepEqual(cache.parseBlockcypherBalance({ balance: 42 }), {
      amount: "42",
      received: null,
      txs: null,
    });
    assert.equal(cache.parseBlockcypherBalance({ total_received: 10 }), null);

    // Haskoin BCH: one entry per address, satoshis split into confirmed and
    // (possibly negative) unconfirmed, plus the tx count.
    assert.deepEqual(
      cache.parseHaskoinBch([{ confirmed: 5593777459, unconfirmed: -500, txs: 11724 }]),
      { confirmed: "5593777459", unconfirmed: "-500", txs: 11724 },
    );
    assert.deepEqual(cache.parseHaskoinBch([{ confirmed: "42" }]), {
      confirmed: "42",
      unconfirmed: "0",
      txs: null,
    });
    assert.equal(cache.parseHaskoinBch([]), null);
    assert.equal(cache.parseHaskoinBch({ confirmed: 1 }), null);
    assert.equal(cache.parseHaskoinBch([{ txs: 3 }]), null);

    // Numeric shapes stay strings; negative/float values are not amounts.
    assert.equal(cache.atomicAmount(123), "123");
    assert.equal(cache.atomicAmount(-1), null);
    assert.equal(cache.atomicAmount(1.5), null);
  }),

  test("SoChain decimal coin strings convert to atomic units without floats", () => {
    // Valid: 8-decimal coin strings become satoshis as BigInt.
    assert.deepEqual(
      cache.parseSochainBalance({
        status: "success",
        data: { confirmed: "0.14201511", unconfirmed: "0.00000000" },
      }),
      { confirmed: 14201511n, unconfirmed: 0n },
    );
    assert.deepEqual(
      cache.parseSochainBalance({
        status: "success",
        data: { confirmed: "1234.5", unconfirmed: "0.25" },
      }),
      { confirmed: 123450000000n, unconfirmed: 25000000n },
    );

    // Zero is a real zero, not a missing balance.
    assert.deepEqual(
      cache.parseSochainBalance({
        status: "success",
        data: { confirmed: "0", unconfirmed: "0.00000000" },
      }),
      { confirmed: 0n, unconfirmed: 0n },
    );

    // Rounding: the fractional part truncates to 8 digits (no Number math).
    assert.equal(
      cache.parseSochainBalance({
        status: "success",
        data: { confirmed: "0.123456789", unconfirmed: "0" },
      }).confirmed,
      12345678n,
    );
    assert.equal(
      cache.parseSochainBalance({
        status: "success",
        data: { confirmed: "0.000000001", unconfirmed: "0" },
      }).confirmed,
      0n,
    );

    // Malformed bodies return null; the caller (parseProviderJson) throws, so a
    // provider error can never be cached as a zero balance.
    assert.equal(cache.parseSochainBalance({ status: "fail", data: {} }), null);
    assert.equal(cache.parseSochainBalance(null), null);
    assert.equal(cache.parseSochainBalance({ status: "success", data: [] }), null);
    assert.equal(
      cache.parseSochainBalance({ status: "success", data: { confirmed: "lots", unconfirmed: "0" } }),
      null,
    );
    assert.equal(
      cache.parseSochainBalance({ status: "success", data: { confirmed: "-1", unconfirmed: "0" } }),
      null,
    );
  }),
];

await Promise.all(tests);
if (failed) {
  console.error(`${failed} balance-cache test(s) failed`);
  process.exit(1);
}
console.log("balance-cache: all tests passed");
