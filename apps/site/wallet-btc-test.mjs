// Tests for the cabinet wallet Bitcoin testnet send flow
// (apps/site/wallet-btc.js).
//
// Usage: node apps/site/wallet-btc-test.mjs
//
// No dependencies, no DOM, no network: mempool.space is a mock, and the
// signer/broadcaster are injected callbacks. The tests pin exact satoshi
// arithmetic, bech32 validation, fee/vsize estimation, deterministic coin
// selection, the dust rule, request building and the prepare/confirm
// transition. The real BIP143 vectors live in crates/rotor-wasm (btc.rs,
// smoke.mjs) and are exercised through the wasm artifact by the site tests.

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const btc = require("./wallet-btc.js");

const FROM = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const DEST = "tb1qq6hag67dl53wl99vzg42z8eyzfz2xlkvvlryfj";
const TXID_A = "ab".repeat(32);
const TXID_B = "cd".repeat(32);
const TXID_C = "ef".repeat(32);
const API = btc.API_BASE;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        () => {
          passed += 1;
          console.log("ok   " + name);
        },
        (err) => {
          failed += 1;
          console.error("FAIL " + name);
          console.error("     " + (err && err.stack ? err.stack : err));
        }
      );
    }
    passed += 1;
    console.log("ok   " + name);
  } catch (err) {
    failed += 1;
    console.error("FAIL " + name);
    console.error("     " + (err && err.stack ? err.stack : err));
  }
  return Promise.resolve();
}

function utxo(txid, vout, value, confirmed = true) {
  return { txid, vout, value, status: { confirmed } };
}

async function run() {
  await test("BTC is parsed to satoshis exactly, without float rounding", () => {
    assert.equal(btc.parseBtcToSats("0"), 0n);
    assert.equal(btc.parseBtcToSats("1"), 100000000n);
    assert.equal(btc.parseBtcToSats("0.00000001"), 1n);
    assert.equal(btc.parseBtcToSats(" 0.1 "), 10000000n);
    assert.equal(btc.parseBtcToSats("0.00050000"), 50000n);
    assert.equal(btc.parseBtcToSats("12.34567890"), 1234567890n);
    assert.equal(btc.formatBtc(1n), "0.00000001");
    assert.equal(btc.formatBtc(50000n), "0.0005");
    assert.equal(btc.formatBtc(100000000n), "1");
    for (const bad of ["", "0.000000001", "1e-8", "-1", "1,5", ".5", "1."]) {
      assert.throws(() => btc.parseBtcToSats(bad), Error, JSON.stringify(bad));
    }
  });

  await test("the fee rate is parsed as exact hundredths of sat/vB", () => {
    assert.equal(btc.parseFeeRate("1"), 100n);
    assert.equal(btc.parseFeeRate("2.5"), 250n);
    assert.equal(btc.parseFeeRate("0.01"), 1n);
    assert.equal(btc.formatFeeRate(100n), "1");
    assert.equal(btc.formatFeeRate(250n), "2.5");
    for (const bad of ["", "0", "0.00", "-1", "1.001", "1e1", "two"]) {
      assert.throws(() => btc.parseFeeRate(bad), Error, JSON.stringify(bad));
    }
  });

  await test("P2WPKH vsize and fee estimates are deterministic", () => {
    assert.equal(btc.estimateVsize(1, 1), 110);
    assert.equal(btc.estimateVsize(1, 2), 141);
    assert.equal(btc.estimateVsize(2, 1), 178);
    assert.equal(btc.estimateVsize(2, 2), 209);
    assert.equal(btc.estimateVsize(3, 2), 277);
    assert.throws(() => btc.estimateVsize(0, 1), /input count/);
    assert.equal(btc.feeForVsize(141, 100n), 141n);
    assert.equal(btc.feeForVsize(141, 250n), 353n); // ceil(352.5)
    assert.equal(btc.feeForVsize(141, 1n), 2n); // ceil(1.41)
  });

  await test("bech32 validation accepts only testnet v0 P2WPKH", () => {
    const decoded = btc.decodeP2wpkh(FROM.toUpperCase());
    assert.equal(decoded.address, FROM);
    assert.equal(decoded.hrp, "tb");
    assert.equal(decoded.program.length, 20);

    assert.throws(
      () => btc.decodeP2wpkh("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"),
      /Bitcoin testnet tb1/
    );
    assert.throws(
      () => btc.decodeP2wpkh("tb1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5ssk79hv2"),
      /witness v0/
    );
    assert.throws(() => btc.decodeP2wpkh("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsq"), /checksum/);
    assert.throws(() => btc.decodeP2wpkh("tb1qW508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"), /mix/);
    assert.throws(() => btc.decodeP2wpkh("mrCDrCybB6J1vRfbwM5hemdJz73FwDBC8r"), Error);
  });

  await test("largest-first selection is deterministic and keeps change above dust", () => {
    const selected = btc.selectCoins(
      [utxo(TXID_A, 0, 30000), utxo(TXID_B, 1, 70000), utxo(TXID_C, 2, 50000)],
      60000n,
      100n
    );
    assert.deepEqual(selected.selected.map((u) => u.txid), [TXID_B]);
    assert.equal(selected.fee, 141n);
    assert.equal(selected.change, 9859n);
    assert.equal(selected.vsize, 141);
    assert.equal(selected.dustToFee, 0n);

    const tie = btc.selectCoins(
      [utxo(TXID_C, 0, 50000), utxo(TXID_A, 2, 50000), utxo(TXID_A, 1, 50000)],
      40000n,
      100n
    );
    assert.deepEqual(tie.selected.map((u) => `${u.txid}:${u.vout}`), [`${TXID_A}:1`]);
  });

  await test("dust change is dropped and added to the fee", () => {
    const selection = btc.selectCoins([utxo(TXID_A, 0, 50000)], 49700n, 100n);
    assert.equal(selection.change, 0n);
    assert.equal(selection.fee, 300n);
    assert.equal(selection.dustToFee, 159n);
    assert.equal(selection.vsize, 110);
  });

  await test("exact and insufficient amounts are handled without rounding", () => {
    const exact = btc.selectCoins([utxo(TXID_A, 0, 50141)], 50000n, 100n);
    assert.equal(exact.change, 0n);
    assert.equal(exact.fee, 141n);
    assert.equal(exact.dustToFee, 0n);
    assert.throws(
      () => btc.selectCoins([utxo(TXID_A, 0, 1000)], 5000n, 100n),
      /insufficient funds/
    );
  });

  await test("UTXO parsing validates the provider response", async () => {
    const url = `${API}/address/${FROM}/utxo`;
    const parsed = await btc.fetchUtxos(async (requested) => {
      assert.equal(requested, url);
      return [
        { txid: TXID_A.toUpperCase(), vout: 0, value: 1500, status: { confirmed: false } },
        { txid: TXID_B, vout: 3, value: "2500", status: { confirmed: true } }
      ];
    }, FROM);
    assert.equal(parsed[0].txid, TXID_A);
    assert.equal(parsed[0].value, 1500n);
    assert.equal(parsed[0].confirmed, false);
    assert.equal(parsed[1].value, 2500n);

    await assert.rejects(
      btc.fetchUtxos(async () => [{ txid: "zz", vout: 0, value: 1 }], FROM),
      /invalid txid/
    );
    await assert.rejects(
      btc.fetchUtxos(async () => [
        { txid: TXID_A, vout: 0, value: 1 },
        { txid: TXID_A, vout: 0, value: 2 }
      ], FROM),
      /duplicate outpoint/
    );
    await assert.rejects(
      btc.fetchUtxos(async () => [{ txid: TXID_A, vout: 0, value: 0 }], FROM),
      /invalid value/
    );
  });

  await test("the recommended fee rate falls back and rejects garbage", async () => {
    const preferred = await btc.recommendedFeeRate(async () => ({
      fastestFee: 4,
      halfHourFee: 3
    }));
    assert.equal(preferred.hundredths, 300n);
    assert.match(preferred.source, /halfHourFee 3/);
    const fallback = await btc.recommendedFeeRate(async () => ({ fastestFee: 4 }));
    assert.equal(fallback.hundredths, 400n);
    assert.match(fallback.source, /fastestFee 4/);
    await assert.rejects(btc.recommendedFeeRate(async () => ({})), /no usable rate/);
    await assert.rejects(
      btc.recommendedFeeRate(async () => ({ halfHourFee: 1.5 })),
      /invalid halfHourFee/
    );
  });

  await test("form validation reports field-specific errors", () => {
    const invalid = btc.validateForm({
      to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      amount: "0.000000001",
      feeRate: "1.001"
    });
    assert.deepEqual(Object.keys(invalid.errors).sort(), ["amount", "feeRate", "to"]);
    assert.match(invalid.errors.to, /Bitcoin testnet tb1/);
    assert.match(invalid.errors.amount, /8 decimal places/);
    assert.match(invalid.errors.feeRate, /two decimal places/);

    const ok = btc.validateForm({ to: DEST, amount: "0.0005", feeRate: "" });
    assert.deepEqual(ok.errors, {});
    assert.equal(ok.values.to, DEST);
    assert.equal(ok.values.amountSats, 50000n);
    assert.equal(ok.values.feeRateHundredths, null);
  });

  await test("mainnet and non-testnet chains are refused before any network read", async () => {
    let fetched = false;
    const getJson = async () => {
      fetched = true;
      return [];
    };
    await assert.rejects(
      btc.prepareTransaction({
        form: { to: DEST, amount: "0.0001", feeRate: "" },
        from: FROM,
        chain: "bitcoin",
        getJson,
        unsigned: () => "00"
      }),
      /mainnet sending is disabled/
    );
    assert.equal(fetched, false);
    assert.throws(() => btc.assertChain("ethereum"), /only Bitcoin testnet/);
    assert.doesNotThrow(() => btc.assertChain("bitcoin-testnet"));
  });

  await test("prepare builds the exact request and a complete review", async () => {
    const requests = [];
    const unsignedRequests = [];
    const getJson = async (url) => {
      requests.push(url);
      if (url === `${API}/address/${FROM}/utxo`) return [utxo(TXID_A, 1, 100000)];
      if (url === `${API}/v1/fees/recommended`) return { halfHourFee: 2 };
      throw new Error("unexpected URL " + url);
    };
    const review = await btc.prepareTransaction({
      form: { to: DEST, amount: "0.0005", feeRate: "" },
      from: FROM,
      chain: btc.CHAIN_SLUG,
      getJson,
      unsigned: (request) => {
        unsignedRequests.push(request);
        assert.equal(Object.prototype.hasOwnProperty.call(request, "private_key"), false);
        return "0200";
      }
    });

    assert.deepEqual(requests, [
      `${API}/address/${FROM}/utxo`,
      `${API}/v1/fees/recommended`
    ]);
    assert.equal(unsignedRequests.length, 1);
    assert.deepEqual(unsignedRequests[0], {
      network: "testnet",
      inputs: [{ txid: TXID_A, vout: 1, value: "100000", sequence: "4294967295" }],
      outputs: [
        { address: DEST, value: "50000" },
        { address: FROM, value: "49718" }
      ]
    });
    assert.equal(review.amountSats, 50000n);
    assert.equal(review.feeSats, 282n);
    assert.equal(review.changeSats, 49718n);
    assert.equal(review.feeRateHundredths, 200n);
    assert.match(review.feeRateSource, /halfHourFee/);
    assert.equal(review.totalInputSats, 100000n);
    assert.equal(review.totalSpentSats, 50282n);
    assert.equal(review.vsize, 141);
    assert.equal(review.unsignedHex, "0200");
    assert.deepEqual(review.warnings, []);
    assert.equal(review.inputs.length, 1);
    assert.equal(review.outputs.length, 2);
  });

  await test("a manual fee rate skips the estimator; unconfirmed inputs warn", async () => {
    const urls = [];
    const review = await btc.prepareTransaction({
      form: { to: DEST, amount: "0.0005", feeRate: "1.5" },
      from: FROM,
      chain: btc.CHAIN_SLUG,
      getJson: async (url) => {
        urls.push(url);
        return [utxo(TXID_A, 0, 100000, false)];
      },
      unsigned: () => "00"
    });
    assert.deepEqual(urls, [`${API}/address/${FROM}/utxo`]);
    assert.equal(review.feeRateHundredths, 150n);
    assert.equal(review.feeSats, 212n); // ceil(141 * 1.5)
    assert.equal(review.feeRateSource, "manual");
    assert.match(review.warnings[0], /unconfirmed/);
  });

  await test("dust change is reported in the review and added to the fee", async () => {
    const review = await btc.prepareTransaction({
      form: { to: DEST, amount: "0.000497", feeRate: "1" },
      from: FROM,
      chain: btc.CHAIN_SLUG,
      getJson: async () => [utxo(TXID_A, 0, 50000)],
      unsigned: () => "00"
    });
    assert.equal(review.changeSats, 0n);
    assert.equal(review.outputs.length, 1);
    assert.equal(review.feeSats, 300n);
    assert.equal(review.dustToFeeSats, 159n);
    assert.ok(review.warnings.some((line) => /dust limit/.test(line)));
  });

  await test("confirm signs exactly the reviewed request, then broadcasts it", async () => {
    let signedRequest = null;
    let broadcastArgs = null;
    const order = [];
    const review = {
      network: "testnet",
      unsignedHex: "0200",
      request: {
        network: "testnet",
        inputs: [{ txid: TXID_A, vout: 0, value: "100000", sequence: "4294967295" }],
        outputs: [
          { address: DEST, value: "50000" },
          { address: FROM, value: "49718" }
        ]
      }
    };
    const result = await btc.confirmTransaction({
      review,
      sign: async (request) => {
        signedRequest = request;
        order.push("sign");
        return "0200000001";
      },
      onSigned: async (hex) => {
        order.push("signed:" + hex);
      },
      broadcast: async (url, hex) => {
        order.push("broadcast");
        broadcastArgs = { url, hex };
        return "  " + TXID_C.toUpperCase() + "  ";
      }
    });
    assert.deepEqual(signedRequest, review.request);
    assert.deepEqual(order, ["sign", "signed:0200000001", "broadcast"]);
    assert.deepEqual(broadcastArgs, { url: `${API}/tx`, hex: "0200000001" });
    assert.equal(result.txid, TXID_C);
    assert.equal(result.signedHex, "0200000001");
    assert.equal(result.explorerUrl, `${btc.EXPLORER_TX}${TXID_C}`);
  });

  await test("confirm refuses a mainnet review and a malformed txid", async () => {
    const base = {
      network: "mainnet",
      unsignedHex: "0200",
      request: {
        network: "testnet",
        inputs: [{ txid: TXID_A, vout: 0, value: "1", sequence: "4294967295" }],
        outputs: [{ address: DEST, value: "1" }]
      }
    };
    await assert.rejects(
      btc.confirmTransaction({
        review: base,
        sign: () => "00",
        broadcast: async () => TXID_C
      }),
      /Only Bitcoin testnet/
    );
    await assert.rejects(
      btc.confirmTransaction({
        review: { ...base, network: "testnet" },
        sign: () => "00",
        broadcast: async () => "not-a-txid"
      }),
      /unexpected transaction id/
    );
    await assert.rejects(
      btc.confirmTransaction({
        review: { ...base, network: "testnet" },
        sign: () => "00",
        broadcast: async () => {
          throw new Error("HTTP 400 bad tx");
        }
      }),
      /mempool\.space testnet failed: HTTP 400 bad tx/
    );
  });

  await test("prepare surfaces insufficient funds and empty addresses", async () => {
    await assert.rejects(
      btc.prepareTransaction({
        form: { to: DEST, amount: "0.01", feeRate: "1" },
        from: FROM,
        chain: btc.CHAIN_SLUG,
        getJson: async () => [utxo(TXID_A, 0, 1000)],
        unsigned: () => "00"
      }),
      /insufficient funds/
    );
    await assert.rejects(
      btc.prepareTransaction({
        form: { to: DEST, amount: "0.0001", feeRate: "1" },
        from: FROM,
        chain: btc.CHAIN_SLUG,
        getJson: async () => [],
        unsigned: () => "00"
      }),
      /No unspent outputs/
    );
  });

  if (failed) {
    console.error(`\n${failed} failed, ${passed} passed`);
    process.exitCode = 1;
  } else {
    console.log(`\nall ${passed} tests passed`);
  }
}

run();
