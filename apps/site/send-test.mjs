// Tests for the top-level testnet send page (apps/site/send.js) and the
// cabinet kernel it reuses (apps/site/wallet-btc.js, apps/site/wallet-evm.js).
//
// Usage: node apps/site/send-test.mjs
//
// No dependencies, no DOM, no network. The tests pin:
//  - route -> chain mapping and the TESTNET-only chain guard;
//  - WIF/hex key parsing, including explicit mainnet rejection;
//  - the testnet-only HTTP endpoint allowlists;
//  - that a prepare + sign + broadcast round trip never puts the private key
//    or WIF into any outbound payload.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const send = require("./send.js");
const btc = require("./wallet-btc.js");
const evm = require("./wallet-evm.js");

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const KEY_HEX = "11".repeat(32);
const KEY_BYTES = Buffer.from(KEY_HEX, "hex");

const BTC_FROM = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const BTC_DEST = "tb1qq6hag67dl53wl99vzg42z8eyzfz2xlkvvlryfj";
const BTC_TXID_A = "ab".repeat(32);
const EVM_TO = "0x3535353535353535353535353535353535353535";
const EVM_FROM = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const EVM_CHAIN_HEX = "0xaa36a7";
const EVM_SIGNED =
  "0x02f87483aa36a780843b9aca00847735940082520894353535353535353535353535353535353535353587038d7ea4c6800080c080a0d02b933531d628f5d2251fbf58903a4d720f9bd6c7c51f7578f7cf301f761263a012a7d571860bb8d7e71bcb6c63d265bc6fc57b250b9381cbc18c1543c282b147";
const EVM_TX_HASH = "0x" + "ab".repeat(32);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

function encodeWif(version, keyBytes, compressed) {
  const body = Buffer.concat([
    Buffer.from([version]),
    Buffer.from(keyBytes),
    compressed ? Buffer.from([0x01]) : Buffer.alloc(0),
  ]);
  const checksum = sha256(sha256(body)).subarray(0, 4);
  return base58Encode(Buffer.concat([body, checksum]));
}

const TESTNET_WIF = encodeWif(0xef, KEY_BYTES, true);
const MAINNET_WIF = encodeWif(0x80, KEY_BYTES, true);
const UNCOMPRESSED_TESTNET_WIF = encodeWif(0xef, KEY_BYTES, false);
const LITECOIN_WIF = encodeWif(0xb0, KEY_BYTES, true);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("ok   " + name);
  } catch (err) {
    failed += 1;
    console.error("FAIL " + name);
    console.error("     " + (err && err.stack ? err.stack.split("\n").slice(0, 3).join("\n     ") : err));
  }
}

async function rejects(fn, needle, message) {
  let error = null;
  try {
    await fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error, message + ": expected a rejection");
  assert.ok(needle.test(error.message), message + ": message was " + JSON.stringify(error.message));
}

const tests = [];
function add(name, fn) { tests.push([name, fn]); }

/* ------------------------------------------------------------ routing */

add("chainFromPath maps the three routes and defaults to Bitcoin", () => {
  assert.equal(send.chainFromPath("/send"), send.BTC_CHAIN);
  assert.equal(send.chainFromPath("/send/"), send.BTC_CHAIN);
  assert.equal(send.chainFromPath("/send/bitcoin"), send.BTC_CHAIN);
  assert.equal(send.chainFromPath("/send/bitcoin/"), send.BTC_CHAIN);
  assert.equal(send.chainFromPath("/send/ethereum"), send.EVM_CHAIN);
  assert.equal(send.chainFromPath("/send/ethereum/"), send.EVM_CHAIN);
  assert.equal(send.chainFromPath("/send/unknown"), send.BTC_CHAIN);
});

add("assertTestnetChain accepts only the two testnets", () => {
  assert.equal(send.assertTestnetChain(send.BTC_CHAIN), send.BTC_CHAIN);
  assert.equal(send.assertTestnetChain(send.EVM_CHAIN), send.EVM_CHAIN);
});

add("assertTestnetChain rejects Bitcoin and Ethereum mainnet by name", async () => {
  await rejects(() => send.assertTestnetChain("bitcoin"), /mainnet/i, "bitcoin");
  await rejects(() => send.assertTestnetChain("ethereum"), /mainnet/i, "ethereum");
  await rejects(() => send.assertTestnetChain("bnb"), /only sends on/, "bnb");
});

/* ------------------------------------------------------------- key input */

add("parseSecret accepts a compressed Bitcoin testnet WIF", async () => {
  const parsed = await send.parseSecret(TESTNET_WIF, send.BTC_CHAIN);
  assert.equal(parsed.chain, send.BTC_CHAIN);
  assert.equal(parsed.keyHex, KEY_HEX);
  assert.equal(Buffer.from(parsed.keyBytes).toString("hex"), KEY_HEX);
});

add("parseSecret accepts a 64-hex Bitcoin key for testnet", async () => {
  const parsed = await send.parseSecret("0x" + KEY_HEX, send.BTC_CHAIN);
  assert.equal(parsed.chain, send.BTC_CHAIN);
  assert.equal(parsed.keyHex, KEY_HEX);
});

add("parseSecret rejects a Bitcoin mainnet WIF explicitly", async () => {
  await rejects(
    () => send.parseSecret(MAINNET_WIF, send.BTC_CHAIN),
    /mainnet/i,
    "mainnet WIF",
  );
});

add("parseSecret rejects an uncompressed testnet WIF", async () => {
  await rejects(
    () => send.parseSecret(UNCOMPRESSED_TESTNET_WIF, send.BTC_CHAIN),
    /compressed/i,
    "uncompressed WIF",
  );
});

add("parseSecret rejects non-testnet WIF versions", async () => {
  await rejects(
    () => send.parseSecret(LITECOIN_WIF, send.BTC_CHAIN),
    /testnet WIF/i,
    "litecoin WIF",
  );
});

add("parseSecret accepts a 0x EVM key only on the Sepolia chain", async () => {
  const parsed = await send.parseSecret("0x" + KEY_HEX, send.EVM_CHAIN);
  assert.equal(parsed.chain, send.EVM_CHAIN);
  assert.equal(parsed.keyHex, KEY_HEX);
  await rejects(
    () => send.parseSecret(String(KEY_HEX).slice(2), send.EVM_CHAIN),
    /32-byte private key/i,
    "short EVM key",
  );
  await rejects(
    () => send.parseSecret(TESTNET_WIF, send.EVM_CHAIN),
    /32-byte private key/i,
    "WIF on the EVM chain",
  );
});

add("keyLooksComplete only accepts complete secrets", () => {
  assert.equal(send.keyLooksComplete(TESTNET_WIF, send.BTC_CHAIN), true);
  assert.equal(send.keyLooksComplete("0x" + KEY_HEX, send.BTC_CHAIN), true);
  assert.equal(send.keyLooksComplete("0x" + KEY_HEX, send.EVM_CHAIN), true);
  assert.equal(send.keyLooksComplete(KEY_HEX.slice(0, 60), send.EVM_CHAIN), false);
  assert.equal(send.keyLooksComplete("not-a-key", send.BTC_CHAIN), false);
});

/* ---------------------------------------------------------- endpoint gates */

add("Bitcoin API gate allows only mempool.space testnet", () => {
  assert.equal(
    send.assertBtcApiUrl(btc.API_BASE + "/address/" + BTC_FROM + "/utxo"),
    btc.API_BASE + "/address/" + BTC_FROM + "/utxo",
  );
  assert.throws(() => send.assertBtcApiUrl("https://mempool.space/api/address/x/utxo"), /non-testnet/);
  assert.throws(() => send.assertBtcApiUrl("https://mempool.space/testnet/api.evil.example/address"), /non-testnet/);
  assert.throws(() => send.assertBtcApiUrl("http://mempool.space/testnet/api/address"), /non-testnet/);
  assert.throws(() => send.assertBtcBroadcastUrl("https://mempool.space/api/tx"), /non-testnet/);
  assert.equal(send.assertBtcBroadcastUrl(btc.API_BASE + "/tx"), btc.API_BASE + "/tx");
});

add("EVM RPC gate allows only the Sepolia provider allowlist", () => {
  const providers = evm.PROVIDERS.map((provider) => provider.url);
  for (const url of providers) assert.equal(send.assertEvmRpcUrl(url, providers), url);
  assert.throws(() => send.assertEvmRpcUrl("https://ethereum-rpc.publicnode.com", providers), /Sepolia allowlist/);
  assert.throws(() => send.assertEvmRpcUrl("https://eth.drpc.org", providers), /Sepolia allowlist/);
  assert.throws(() => send.assertEvmRpcUrl(undefined, providers), /Sepolia allowlist/);
});

add("containsSecret detects a key inside captured payloads", () => {
  assert.equal(send.containsSecret({ hello: "world" }, KEY_HEX), false);
  assert.equal(send.containsSecret({ note: KEY_HEX.toUpperCase() }, KEY_HEX), true);
  assert.equal(send.containsSecret("raw-" + KEY_HEX + "-tail", KEY_HEX), true);
});

/* ------------------------------------ Bitcoin kernel round trip, no key leak */

add("Bitcoin prepare/sign/broadcast never sends the key or WIF", async () => {
  const calls = [];
  const getJson = (url) => {
    calls.push({ kind: "get", url });
    assert.equal(send.assertBtcApiUrl(url), url);
    if (url.endsWith("/utxo")) {
      return [{
        txid: BTC_TXID_A,
        vout: 0,
        value: 200000,
        status: { confirmed: true },
      }];
    }
    throw new Error("unexpected GET " + url);
  };
  const unsigned = (fields) => {
    calls.push({ kind: "unsigned", fields });
    return "00";
  };

  const review = await btc.prepareTransaction({
    form: { to: BTC_DEST, amount: "0.0001", feeRate: "2" },
    from: BTC_FROM,
    chain: send.BTC_CHAIN,
    getJson,
    unsigned,
  });
  assert.equal(review.network, "testnet");
  assert.equal(review.chain, send.BTC_CHAIN);
  assert.ok(review.feeSats > 0n);

  const signed = "ab".repeat(10);
  const result = await btc.confirmTransaction({
    review,
    sign: () => signed,
    broadcast: (url, hex) => {
      calls.push({ kind: "broadcast", url, body: hex });
      assert.equal(send.assertBtcBroadcastUrl(url), url);
      return "cd".repeat(32);
    },
  });
  assert.equal(result.signedHex, signed);
  assert.equal(result.txid, "cd".repeat(32));
  assert.equal(result.explorerUrl, btc.EXPLORER_TX + "cd".repeat(32));

  for (const call of calls) {
    assert.equal(send.containsSecret(call, KEY_HEX), false, "key leaked into " + call.kind);
    assert.equal(send.containsSecret(call, TESTNET_WIF), false, "WIF leaked into " + call.kind);
  }
  assert.ok(calls.some((call) => call.kind === "broadcast"));
  assert.ok(calls.filter((call) => call.kind !== "unsigned").every((call) => /mempool\.space\/testnet\/api/.test(call.url)));
});

/* --------------------------------------- Ethereum kernel round trip, no leak */

add("Ethereum Sepolia prepare/confirm never sends the key", async () => {
  const answers = {
    eth_chainId: EVM_CHAIN_HEX,
    eth_getTransactionCount: "0x0",
    eth_getBalance: "0xde0b6b3a7640000",
    eth_estimateGas: "0x5208",
    eth_feeHistory: { baseFeePerGas: ["0x3b9aca00", "0x77359400"] },
    eth_maxPriorityFeePerGas: "0x3b9aca00",
    eth_sendRawTransaction: EVM_TX_HASH,
  };
  const calls = [];
  const fetchJson = (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ url, method: request.method, body: options.body });
    assert.equal(send.assertEvmRpcUrl(url, evm.PROVIDERS.map((provider) => provider.url)), url);
    return Promise.resolve({ jsonrpc: "2.0", id: 1, result: answers[request.method] });
  };

  const review = await evm.prepareTransaction({
    form: { to: EVM_TO, value: "0.001" },
    from: EVM_FROM,
    fetchJson,
    unsigned: () => "0x02f8",
  });
  assert.equal(review.chainId, send.SEPOLIA_CHAIN_ID);
  assert.equal(review.providerUrl, evm.PROVIDERS[0].url);

  const result = await evm.confirmTransaction({
    review,
    fetchJson,
    sign: () => EVM_SIGNED,
  });
  assert.equal(result.txHash, EVM_TX_HASH);
  assert.equal(result.signedHex, EVM_SIGNED);

  for (const call of calls) {
    assert.equal(send.containsSecret(call, KEY_HEX), false, "key leaked into " + call.method);
  }
  assert.ok(calls.some((call) => call.method === "eth_sendRawTransaction"));
  assert.ok(calls.every((call) => evm.PROVIDERS.some((provider) => provider.url === call.url)));
});

for (const [name, fn] of tests) await test(name, fn);
console.log("");
console.log(passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
