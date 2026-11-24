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

/* ------------------------------------------------- network discrimination */

test("the picker value distinguishes TRON from an EVM chain id", () => {
  assert.equal(tron.tronOptionValue("tron"), "tron:tron");
  assert.equal(tron.tronNetworkFromOption("tron:tron").slug, "tron");
  assert.equal(tron.tronNetworkFromOption("tron:tron-nile").testnet, true);
  assert.equal(tron.tronNetworkFromOption("evm:1"), null);
  assert.equal(tron.tronNetworkFromOption("11155111"), null);
  assert.equal(tron.tronNetworkFromOption("tron:tron-shasta"), null);
  assert.equal(tron.tronNetworkFromOption(undefined), null);
});

/* ----------------------------------------------------- provider failover */

test("the declared failover order is kept and a preferred provider goes first", () => {
  const mainnet = tron.tronNetworkBySlug("tron");
  assert.deepEqual(
    tron.tronProviderOrder(mainnet, null).map((provider) => provider.id),
    ["trongrid", "publicnode"]
  );
  assert.deepEqual(
    tron.tronProviderOrder(mainnet, "https://tron-rpc.publicnode.com")
      .map((provider) => provider.id),
    ["publicnode", "trongrid"]
  );
  assert.throws(
    () => tron.tronProviderOrder(mainnet, "https://evil.example/rpc"),
    /not a declared TRON provider/
  );
});

test("getnowblock fails over in order and stops at the first valid response", async () => {
  const mainnet = tron.tronNetworkBySlug("tron");
  const blockID = "00".repeat(6) + "aabb" + "0102030405060708" + "11".repeat(16);
  const calls = [];
  const fetchJson = (url) => {
    calls.push(url);
    if (url.indexOf("api.trongrid.io") >= 0) {
      return Promise.reject(new Error("HTTP 503"));
    }
    return Promise.resolve({
      blockID: blockID.toUpperCase(),
      block_header: { raw_data: { number: 99, timestamp: 1700000000000 } },
    });
  };
  const result = await tron.fetchNowBlock(mainnet, fetchJson, null);
  assert.deepEqual(calls, [
    "https://api.trongrid.io/wallet/getnowblock",
    "https://tron-rpc.publicnode.com/wallet/getnowblock",
  ]);
  assert.equal(result.provider.id, "publicnode");
  assert.equal(result.block.ref_block_bytes, "aabb");
});

test("getnowblock reports every declared provider when all fail, with no retry", async () => {
  const mainnet = tron.tronNetworkBySlug("tron");
  const calls = [];
  await assert.rejects(
    () => tron.fetchNowBlock(mainnet, (url) => {
      calls.push(url);
      return Promise.reject(new Error("down"));
    }, null),
    /No declared TRON provider answered getnowblock.*tried 2 endpoints/
  );
  assert.equal(calls.length, 2);
});

/* ------------------------------------------------------- ref block parsing */

test("the ref block fields derive from blockID and the on-chain window beats the review TTL", () => {
  const blockID = "00".repeat(6) + "aabb" + "0102030405060708" + "11".repeat(16);
  assert.equal(blockID.length, 64);
  const block = tron.parseNowBlock({
    blockID,
    block_header: { raw_data: { number: 123456, timestamp: 1700000000000 } },
  });
  assert.equal(block.blockID, blockID);
  assert.equal(block.blockNumber, "123456");
  assert.equal(block.ref_block_bytes, "aabb");
  assert.equal(block.ref_block_hash, "0102030405060708");
  assert.equal(block.timestamp, "1700000000000");
  assert.equal(block.expiration, "1700000090000");
  assert.ok(
    BigInt(block.expiration) - BigInt(block.timestamp) > BigInt(tron.TRON_REVIEW_TTL_MS),
    "a late confirm must still produce a transaction the node accepts"
  );
  assert.throws(() => tron.parseNowBlock({}), /blockID/);
  assert.throws(
    () => tron.parseNowBlock({ blockID: "11".repeat(32), block_header: {} }),
    /timestamp/
  );
});

/* ---------------------------------------------------- trx vs trc20 fields */

test("a trx request omits the token contract and a trc20 request carries it", () => {
  const block = {
    ref_block_bytes: "aabb",
    ref_block_hash: "0102030405060708",
    timestamp: "1700000000000",
    expiration: "1700000060000",
  };
  const trx = tron.buildTransferRequest({
    kind: "trx", from: "Tfrom", to: "Tto", amountBase: 1_500_000n,
    tokenContract: null, feeLimitSun: 0n, block,
  });
  assert.equal(trx.kind, "trx");
  assert.equal(trx.amount, "1500000");
  assert.equal(trx.fee_limit, "0");
  assert.equal(Object.prototype.hasOwnProperty.call(trx, "token_contract_address"), false);

  const trc20 = tron.buildTransferRequest({
    kind: "trc20", from: "Tfrom", to: "Tto", amountBase: 1_000_000n,
    tokenContract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", feeLimitSun: 100_000_000n, block,
  });
  assert.equal(trc20.kind, "trc20");
  assert.equal(trc20.token_contract_address, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  assert.equal(trc20.fee_limit, "100000000");
  assert.throws(
    () => tron.buildTransferRequest({
      kind: "trc20", from: "Tfrom", to: "Tto", amountBase: 1n,
      tokenContract: null, feeLimitSun: 0n, block,
    }),
    /token contract/
  );
});

test("the form picks the kind and refuses a fee limit on a plain TRX transfer", () => {
  const plain = tron.validateTronSend({ to: "Tto", token: "", feeLimit: "" });
  assert.deepEqual(plain.errors, {});
  assert.equal(plain.values.kind, "trx");
  assert.equal(plain.values.feeLimitSun, 0n);

  const token = tron.validateTronSend({
    to: "Tto", token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", feeLimit: "100",
  });
  assert.deepEqual(token.errors, {});
  assert.equal(token.values.kind, "trc20");
  assert.equal(token.values.feeLimitSun, 100_000_000n);

  const missingTo = tron.validateTronSend({ to: " ", token: "", feeLimit: "" });
  assert.match(missingTo.errors.to, /recipient/);

  const trxFee = tron.validateTronSend({ to: "Tto", token: "", feeLimit: "1" });
  assert.match(trxFee.errors.feeLimit, /TRC-20/);

  const overCap = tron.validateTronSend({
    to: "Tto", token: "TRtc20", feeLimit: "100.000001",
  });
  assert.match(overCap.errors.feeLimit, /100 TRX/);
});

/* --------------------------------------------------- confirm pin and broadcast */

function confirmReview() {
  const block = {
    blockID: "00".repeat(6) + "aabb" + "0102030405060708" + "11".repeat(16),
    blockNumber: "1",
    ref_block_bytes: "aabb",
    ref_block_hash: "0102030405060708",
    timestamp: "1700000000000",
    expiration: "1700000090000",
  };
  const request = tron.buildTransferRequest({
    kind: "trx", from: "Tfrom", to: "Tto", amountBase: 1_000_000n,
    tokenContract: null, feeLimitSun: 0n, block,
  });
  return {
    family: "tron",
    kind: "trx",
    networkSlug: "tron",
    networkName: "TRON",
    testnet: false,
    from: "Tfrom",
    to: "Tto",
    tokenContract: null,
    amountBase: 1_000_000n,
    feeLimitSun: 0n,
    block,
    request,
    tx: { txID: "aa".repeat(32), raw_data_hex: "00" },
    builtAt: 1_000,
    providerUrl: "https://api.trongrid.io",
    providerLabel: "TronGrid",
  };
}

const SIGNED_TRON = JSON.stringify({
  txID: "aa".repeat(32),
  raw_data_hex: "00",
  raw_data: {},
  signature: "bb".repeat(64) + "1c",
});

test("a review mutated after preparation is refused before signing", async () => {
  let signed = false;
  await assert.rejects(
    () => tron.confirmTronTransfer({
      review: Object.assign(confirmReview(), { amountBase: 2_000_000n }),
      fetchJson: () => Promise.resolve({ result: true }),
      mainnetArmed: true,
      now: 2_000,
      sign: () => { signed = true; return SIGNED_TRON; },
    }),
    /do not match the request/
  );
  assert.equal(signed, false, "a tampered review must not reach the signer");
});

test("signed bytes that differ from the reviewed bytes are refused before broadcast", async () => {
  let broadcast = 0;
  const mutated = JSON.stringify({
    txID: "cc".repeat(32),
    raw_data_hex: "ff",
    raw_data: {},
    signature: "bb".repeat(64) + "1c",
  });
  await assert.rejects(
    () => tron.confirmTronTransfer({
      review: confirmReview(),
      fetchJson: () => { broadcast += 1; return Promise.resolve({ result: true }); },
      mainnetArmed: true,
      now: 2_000,
      sign: () => mutated,
    }),
    /signed transaction bytes do not match the reviewed bytes/
  );
  assert.equal(broadcast, 0, "nothing may be broadcast when the bytes differ");
});

test("confirm broadcasts exactly once and surfaces a provider error verbatim", async () => {
  const calls = [];
  const ok = await tron.confirmTronTransfer({
    review: confirmReview(),
    fetchJson: (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({ result: true, txid: "aa".repeat(32) });
    },
    mainnetArmed: true,
    now: 2_000,
    sign: () => SIGNED_TRON,
  });
  assert.equal(ok.txHash, "aa".repeat(32));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.trongrid.io/wallet/broadcasttransaction");
  assert.deepEqual(calls[0].body.signature, ["bb".repeat(64) + "1c"]);

  let failedCalls = 0;
  await assert.rejects(
    () => tron.confirmTronTransfer({
      review: confirmReview(),
      fetchJson: () => { failedCalls += 1; return Promise.reject(new Error("HTTP 502")); },
      mainnetArmed: true,
      now: 2_000,
      sign: () => SIGNED_TRON,
    }),
    /Broadcasting to TronGrid failed: HTTP 502/
  );
  assert.equal(failedCalls, 1, "no retry after a provider error");

  await assert.rejects(
    () => tron.confirmTronTransfer({
      review: confirmReview(),
      fetchJson: () => Promise.resolve({
        result: false, code: "CONTRACT_VALIDATE_ERROR", message: "energy insufficient",
      }),
      mainnetArmed: true,
      now: 2_000,
      sign: () => SIGNED_TRON,
    }),
    /rejected the transaction \(CONTRACT_VALIDATE_ERROR\) energy insufficient/
  );
});

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
  console.error("\n" + failed + " of " + cases.length + " wallet tron tests failed");
  process.exit(1);
}
console.log("\n" + cases.length + " wallet tron tests passed");
