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
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("./chains.generated.js");
require("./amount.js");
const send = require("./send.js");
const btc = require("./wallet-btc.js");
const evm = require("./wallet-evm.js");
/* The browser loads wallet-evm.js as a classic script, so send.js sees it as
 * a global. Mirror that load order here so the shared address validator is
 * the one under test, not send.js's emergency fallback. */
globalThis.RotorEvmSend = evm;
const tron = require("./tron-tx.js");

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

/* Pinned ERC-20 transfer vector: 1.000000 at 6 decimals -> raw 0xf4240,
 * selector 0xa9059cbb, recipient and amount left-padded to 32-byte words. */
const USDT_CONTRACT = "0x" + "11".repeat(20);
const USDT_RECIPIENT = "0x" + "35".repeat(20);
const USDT_DATA =
  "0xa9059cbb" +
  "000000000000000000000000" + "35".repeat(20) +
  "00000000000000000000000000000000000000000000000000000000000f4240";

/* TRON test vectors: two valid base58check mainnet-shape addresses (the Nile
 * testnet reuses the same 0x41 address prefix). */
const TRON_FROM = "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC";
const TRON_TO = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_TXID = "ef".repeat(32);
const TRON_RAW_DATA_HEX = "0a02abab2208" + "cd".repeat(8) + "4080b0e7a7f62e";
const TRON_SIGNATURE = "a1".repeat(65);
const TRON_BLOCK = {
  blockID: "ab".repeat(32),
  blockNumber: "70000000",
  ref_block_bytes: "abab",
  ref_block_hash: "cd".repeat(8),
  timestamp: "1700000000000",
  expiration: "1700000060000",
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function messageOf(fn) {
  try {
    fn();
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
  return null;
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
const UNCOMPRESSED_MAINNET_WIF = encodeWif(0x80, KEY_BYTES, false);
const LITECOIN_WIF = encodeWif(0xb0, KEY_BYTES, true);

/* Published WIF vectors for private key 1, plus the addresses the WASM core
 * must derive from them. The same 32 bytes must produce the same EVM/TRON
 * address whether they arrived as hex or as any of the four WIF shapes. */
const KEY1_HEX = "0".repeat(63) + "1";
const KEY1_BYTES = Buffer.from(KEY1_HEX, "hex");
const KEY1_MAINNET_WIF = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
const KEY1_MAINNET_WIF_UNCOMPRESSED = "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf";
const KEY1_TESTNET_WIF = "cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA";
const KEY1_TESTNET_WIF_UNCOMPRESSED = "91avARGdfge8E4tZfYLoxeJ5sGBdNJQH4kvjJoQFacbgwmaKkrx";
const KEY1_EVM_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const KEY1_TRON_ADDRESS = "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC";

const WASM_PATH = new URL("./rotor_wasm.wasm", import.meta.url);
let wasmPromise = null;
function loadWasm() {
  if (!wasmPromise) {
    wasmPromise = WebAssembly.instantiate(readFileSync(WASM_PATH), {})
      .then((module) => module.instance.exports);
  }
  return wasmPromise;
}

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

add("chainFromPath maps all six routes and defaults to Bitcoin", () => {
  assert.equal(send.chainFromPath("/send"), send.BTC_CHAIN);
  assert.equal(send.chainFromPath("/send/"), send.BTC_CHAIN);
  assert.equal(send.chainFromPath("/send/bitcoin"), send.BTC_CHAIN);
  assert.equal(send.chainFromPath("/send/bitcoin/"), send.BTC_CHAIN);
  assert.equal(send.chainFromPath("/send/ethereum"), send.EVM_CHAIN);
  assert.equal(send.chainFromPath("/send/ethereum/"), send.EVM_CHAIN);
  assert.equal(send.chainFromPath("/send/bnb"), send.BNB_CHAIN);
  assert.equal(send.chainFromPath("/send/bnb/"), send.BNB_CHAIN);
  assert.equal(send.chainFromPath("/send/usdt"), send.USDT_CHAIN);
  assert.equal(send.chainFromPath("/send/usdt/"), send.USDT_CHAIN);
  assert.equal(send.chainFromPath("/send/tron"), send.TRON_CHAIN);
  assert.equal(send.chainFromPath("/send/tron/"), send.TRON_CHAIN);
  assert.equal(send.chainFromPath("/send/unknown"), send.BTC_CHAIN);
});

add("assertTestnetChain accepts only the five testnets", () => {
  assert.equal(send.assertTestnetChain(send.BTC_CHAIN), send.BTC_CHAIN);
  assert.equal(send.assertTestnetChain(send.EVM_CHAIN), send.EVM_CHAIN);
  assert.equal(send.assertTestnetChain(send.BNB_CHAIN), send.BNB_CHAIN);
  assert.equal(send.assertTestnetChain(send.USDT_CHAIN), send.USDT_CHAIN);
  assert.equal(send.assertTestnetChain(send.TRON_CHAIN), send.TRON_CHAIN);
});

add("assertTestnetChain rejects every mainnet slug by name", async () => {
  await rejects(() => send.assertTestnetChain("bitcoin"), /mainnet/i, "bitcoin");
  await rejects(() => send.assertTestnetChain("ethereum"), /mainnet/i, "ethereum");
  await rejects(() => send.assertTestnetChain("bnb"), /mainnet/i, "bnb");
  await rejects(() => send.assertTestnetChain("usdt"), /mainnet/i, "usdt");
  await rejects(() => send.assertTestnetChain("tron"), /mainnet/i, "tron");
  assert.equal(send.isEvmChain(send.BNB_CHAIN), true);
  assert.equal(send.isEvmChain(send.USDT_CHAIN), true);
  assert.equal(send.isEvmChain(send.BTC_CHAIN), false);
  assert.equal(send.isEvmChain(send.TRON_CHAIN), false);
  assert.equal(send.isTronChain(send.TRON_CHAIN), true);
  assert.equal(send.isTronChain(send.EVM_CHAIN), false);
  assert.equal(send.isTokenChain(send.USDT_CHAIN), true);
  assert.equal(send.isTokenChain(send.EVM_CHAIN), false);
});

add("EVM chain-id guard rejects BNB mainnet 56 and unknown ids", () => {
  for (const id of send.ALLOWED_EVM_CHAIN_IDS) {
    assert.equal(send.assertAllowedChainId(id), id);
  }
  assert.throws(() => send.assertAllowedChainId(56), /not an allowed testnet chain/);
  assert.throws(() => send.assertAllowedChainId(1), /not an allowed testnet chain/);
  assert.equal(send.assertAllowedChainId(97, send.BNB_CHAIN), 97);
  assert.equal(send.assertAllowedChainId(11155111, send.EVM_CHAIN), 11155111);
  assert.throws(
    () => send.assertAllowedChainId(56, send.BNB_CHAIN),
    /BNB Smart Chain testnet \(chain id 97\) is required/,
  );
  assert.throws(
    () => send.assertAllowedChainId(97, send.EVM_CHAIN),
    /Ethereum Sepolia \(chain id 11155111\) is required/,
  );
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

add("parseSecret accepts a 0x EVM key or a Bitcoin WIF on every EVM route", async () => {
  const parsed = await send.parseSecret("0x" + KEY_HEX, send.EVM_CHAIN);
  assert.equal(parsed.chain, send.EVM_CHAIN);
  assert.equal(parsed.keyHex, KEY_HEX);
  for (const chain of [send.EVM_CHAIN, send.BNB_CHAIN, send.USDT_CHAIN]) {
    for (const wif of [MAINNET_WIF, UNCOMPRESSED_MAINNET_WIF, TESTNET_WIF, UNCOMPRESSED_TESTNET_WIF]) {
      const fromWif = await send.parseSecret(wif, chain);
      assert.equal(fromWif.chain, chain);
      assert.equal(fromWif.keyHex, KEY_HEX);
      assert.equal(Buffer.from(fromWif.keyBytes).toString("hex"), KEY_HEX);
    }
  }
  await rejects(
    () => send.parseSecret(String(KEY_HEX).slice(2), send.EVM_CHAIN),
    /32-byte private key/i,
    "short EVM key",
  );
  await rejects(
    () => send.parseSecret(LITECOIN_WIF, send.EVM_CHAIN),
    /mainnet \(0x80\) or testnet \(0xef\)/,
    "a foreign-coin WIF",
  );
});

add("WIF decode vectors: mainnet/testnet, compressed/uncompressed, checksum", async () => {
  const vectors = [
    [KEY1_MAINNET_WIF, true],
    [KEY1_MAINNET_WIF_UNCOMPRESSED, false],
    [KEY1_TESTNET_WIF, true],
    [KEY1_TESTNET_WIF_UNCOMPRESSED, false],
  ];
  for (const [wif, compressed] of vectors) {
    const decoded = await send.decodeWif(wif);
    assert.equal(decoded.compressed, compressed, wif);
    assert.equal(Buffer.from(decoded.key).toString("hex"), KEY1_HEX, wif);
  }
  // The same four vectors decode through parseSecret on EVM/TRON.
  for (const chain of [send.EVM_CHAIN, send.TRON_CHAIN]) {
    for (const [wif] of vectors) {
      const parsed = await send.parseSecret(wif, chain);
      assert.equal(parsed.keyHex, KEY1_HEX, wif + " on " + chain);
    }
  }
  // A corrupted checksum is rejected before any key is returned.
  const badChecksum = KEY1_MAINNET_WIF.slice(0, -1) +
    (KEY1_MAINNET_WIF.endsWith("1") ? "2" : "1");
  await rejects(() => send.decodeWif(badChecksum), /checksum/i, "bad WIF checksum");
  await rejects(
    () => send.parseSecret(badChecksum, send.EVM_CHAIN),
    /checksum/i,
    "bad WIF checksum on EVM",
  );
});

add("EVM and TRON derive the same address from hex, mainnet WIF and testnet WIF", async () => {
  const wasm = await loadWasm();
  const evmHex = await send.parseSecret("0x" + KEY1_HEX, send.EVM_CHAIN);
  const evmMainnet = await send.parseSecret(KEY1_MAINNET_WIF, send.EVM_CHAIN);
  const evmTestnet = await send.parseSecret(KEY1_TESTNET_WIF, send.EVM_CHAIN);
  assert.deepEqual(evmHex.keyBytes, evmMainnet.keyBytes);
  assert.deepEqual(evmHex.keyBytes, evmTestnet.keyBytes);
  assert.equal(send.deriveAddress(wasm, evmHex.keyBytes, send.EVM_CHAIN), KEY1_EVM_ADDRESS);
  assert.equal(send.deriveAddress(wasm, evmMainnet.keyBytes, send.EVM_CHAIN), KEY1_EVM_ADDRESS);
  assert.equal(send.deriveAddress(wasm, evmTestnet.keyBytes, send.EVM_CHAIN), KEY1_EVM_ADDRESS);

  const tronHex = await send.parseSecret(KEY1_HEX, send.TRON_CHAIN);
  const tronMainnet = await send.parseSecret(KEY1_MAINNET_WIF, send.TRON_CHAIN);
  const tronTestnet = await send.parseSecret(KEY1_TESTNET_WIF_UNCOMPRESSED, send.TRON_CHAIN);
  assert.deepEqual(tronHex.keyBytes, tronMainnet.keyBytes);
  assert.deepEqual(tronHex.keyBytes, tronTestnet.keyBytes);
  assert.equal(send.deriveAddress(wasm, tronHex.keyBytes, send.TRON_CHAIN), KEY1_TRON_ADDRESS);
  assert.equal(send.deriveAddress(wasm, tronMainnet.keyBytes, send.TRON_CHAIN), KEY1_TRON_ADDRESS);
  assert.equal(send.deriveAddress(wasm, tronTestnet.keyBytes, send.TRON_CHAIN), KEY1_TRON_ADDRESS);
});

add("the Bitcoin route keeps its testnet-only WIF rule", async () => {
  const parsed = await send.parseSecret(KEY1_TESTNET_WIF, send.BTC_CHAIN);
  assert.equal(parsed.keyHex, KEY1_HEX);
  await rejects(
    () => send.parseSecret(KEY1_MAINNET_WIF, send.BTC_CHAIN),
    /mainnet/i,
    "mainnet compressed WIF",
  );
  await rejects(
    () => send.parseSecret(KEY1_MAINNET_WIF_UNCOMPRESSED, send.BTC_CHAIN),
    /mainnet/i,
    "mainnet uncompressed WIF",
  );
  await rejects(
    () => send.parseSecret(KEY1_TESTNET_WIF_UNCOMPRESSED, send.BTC_CHAIN),
    /compressed/i,
    "testnet uncompressed WIF",
  );
});

add("keyLooksComplete only accepts complete secrets", () => {
  assert.equal(send.keyLooksComplete(TESTNET_WIF, send.BTC_CHAIN), true);
  assert.equal(send.keyLooksComplete("0x" + KEY_HEX, send.BTC_CHAIN), true);
  assert.equal(send.keyLooksComplete("0x" + KEY_HEX, send.EVM_CHAIN), true);
  assert.equal(send.keyLooksComplete(KEY_HEX, send.TRON_CHAIN), true);
  assert.equal(send.keyLooksComplete("0x" + KEY_HEX, send.TRON_CHAIN), true);
  assert.equal(send.keyLooksComplete(TESTNET_WIF, send.TRON_CHAIN), true);
  assert.equal(send.keyLooksComplete(MAINNET_WIF, send.EVM_CHAIN), true);
  assert.equal(send.keyLooksComplete(TESTNET_WIF, send.BNB_CHAIN), true);
  assert.equal(send.keyLooksComplete(TESTNET_WIF, send.USDT_CHAIN), true);
  assert.equal(send.keyLooksComplete(KEY_HEX.slice(0, 60), send.EVM_CHAIN), false);
  assert.equal(send.keyLooksComplete("not-a-key", send.BTC_CHAIN), false);
});

add("parseSecret accepts a TRON hex or WIF key", async () => {
  const bare = await send.parseSecret(KEY_HEX, send.TRON_CHAIN);
  assert.equal(bare.chain, send.TRON_CHAIN);
  assert.equal(bare.keyHex, KEY_HEX);
  assert.equal(Buffer.from(bare.keyBytes).toString("hex"), KEY_HEX);

  const prefixed = await send.parseSecret("0x" + KEY_HEX.toUpperCase(), send.TRON_CHAIN);
  assert.equal(prefixed.keyHex, KEY_HEX);

  const fromWif = await send.parseSecret(TESTNET_WIF, send.TRON_CHAIN);
  assert.equal(fromWif.chain, send.TRON_CHAIN);
  assert.equal(fromWif.keyHex, KEY_HEX);
  assert.equal(Buffer.from(fromWif.keyBytes).toString("hex"), KEY_HEX);

  await rejects(
    () => send.parseSecret(LITECOIN_WIF, send.TRON_CHAIN),
    /mainnet \(0x80\) or testnet \(0xef\)/,
    "a foreign-coin WIF",
  );
  await rejects(
    () => send.parseSecret(KEY_HEX.slice(0, 60), send.TRON_CHAIN),
    /64 hex characters/i,
    "short TRON key",
  );
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

add("EVM RPC gate allows only each chain's testnet allowlist", () => {
  const sepolia = evm.PROVIDERS.map((provider) => provider.url);
  const sepoliaAllowed = send.providersForChain(send.EVM_CHAIN, sepolia);
  for (const url of sepoliaAllowed) {
    assert.equal(send.assertEvmRpcUrl(url, sepoliaAllowed), url);
  }
  const bnb = send.providersForChain(send.BNB_CHAIN, sepolia);
  assert.deepEqual(bnb, send.BNB_TESTNET_PROVIDERS);
  for (const url of bnb) {
    assert.equal(send.assertEvmRpcUrl(url, bnb), url);
    assert.match(url, /testnet|prebsc/i);
  }
  assert.throws(
    () => send.assertEvmRpcUrl("https://bsc-dataseed.binance.org", bnb),
    /testnet allowlist/,
  );
  assert.throws(
    () => send.assertEvmRpcUrl("https://ethereum-rpc.publicnode.com", sepoliaAllowed),
    /testnet allowlist/,
  );
  assert.throws(
    () => send.assertEvmRpcUrl("https://eth.drpc.org", sepoliaAllowed),
    /testnet allowlist/,
  );
  assert.throws(() => send.assertEvmRpcUrl(undefined, sepoliaAllowed), /testnet allowlist/);
  // A Sepolia provider is not a valid BNB endpoint, and vice versa.
  assert.throws(() => send.assertEvmRpcUrl(sepoliaAllowed[0], bnb), /testnet allowlist/);
  assert.throws(() => send.assertEvmRpcUrl(bnb[0], sepoliaAllowed), /testnet allowlist/);
});

add("ERC-20 transfer pins the canonical USDT calldata vector", () => {
  const transfer = send.buildErc20Transfer({
    contract: USDT_CONTRACT,
    recipient: USDT_RECIPIENT,
    decimals: "6",
    amount: "1.000000",
  });
  assert.equal(transfer.contract, USDT_CONTRACT);
  assert.equal(transfer.recipient, USDT_RECIPIENT);
  assert.equal(transfer.decimals, 6);
  assert.equal(transfer.rawAmount, 1000000n);
  assert.equal(transfer.data, USDT_DATA);
  assert.equal(transfer.data.length, 2 + 8 + 64 + 64);

  // Decimals default to 6 when the field is empty.
  const defaulted = send.buildErc20Transfer({
    contract: USDT_CONTRACT,
    recipient: USDT_RECIPIENT,
    amount: "1",
  });
  assert.equal(defaulted.decimals, 6);
  assert.equal(defaulted.data, USDT_DATA);
});

add("ERC-20 builder rejects absent/fabricated contracts and bad fields", () => {
  assert.throws(
    () => send.buildErc20Transfer({ recipient: USDT_RECIPIENT, amount: "1" }),
    /Token contract/,
  );
  assert.throws(
    () => send.buildErc20Transfer({ contract: "", recipient: USDT_RECIPIENT, amount: "1" }),
    /Token contract/,
  );
  assert.throws(
    () => send.buildErc20Transfer({ contract: "0x1234", recipient: USDT_RECIPIENT, amount: "1" }),
    /Token contract/,
  );
  assert.throws(
    () => send.buildErc20Transfer({
      contract: "0x" + "zz".repeat(20),
      recipient: USDT_RECIPIENT,
      amount: "1",
    }),
    /Token contract/,
  );
  assert.throws(
    () => send.buildErc20Transfer({ contract: USDT_CONTRACT, recipient: "nope", amount: "1" }),
    /Recipient/,
  );
  assert.throws(
    () => send.buildErc20Transfer({
      contract: USDT_CONTRACT,
      recipient: "0x7E5F4552091A69125D5DFCB7B8C2659029395BDF",
      amount: "1",
    }),
    /Recipient: The address fails the EIP-55 checksum/,
    "an all-uppercase recipient is not silently lowercased",
  );
  assert.throws(
    () => send.buildErc20Transfer({
      contract: USDT_CONTRACT,
      recipient: USDT_RECIPIENT,
      decimals: "37",
      amount: "1",
    }),
    /0 and 36/,
  );
  assert.throws(
    () => send.buildErc20Transfer({
      contract: USDT_CONTRACT,
      recipient: USDT_RECIPIENT,
      decimals: "-1",
      amount: "1",
    }),
    /Decimals/,
  );
  assert.throws(
    () => send.buildErc20Transfer({
      contract: USDT_CONTRACT,
      recipient: USDT_RECIPIENT,
      decimals: "1.5",
      amount: "1",
    }),
    /Decimals/,
  );
  assert.throws(
    () => send.buildErc20Transfer({
      contract: USDT_CONTRACT,
      recipient: USDT_RECIPIENT,
      decimals: "6",
      amount: "1.1234567",
    }),
    /6 decimal places/,
  );
  // The generic parser keeps its own wording; the send page translates it back
  // to the token-specific, actionable strings.
  assert.equal(
    messageOf(() => send.buildErc20Transfer({
      contract: USDT_CONTRACT,
      recipient: USDT_RECIPIENT,
      decimals: "6",
      amount: "",
    })),
    "Enter a token amount.",
    "an empty token amount names the field",
  );
  assert.equal(
    messageOf(() => send.buildErc20Transfer({
      contract: USDT_CONTRACT,
      recipient: USDT_RECIPIENT,
      decimals: "6",
      amount: "1e3",
    })),
    "Use a plain decimal token amount like 1.5 (no exponent, sign or comma).",
    "a malformed token amount keeps the token-specific guidance",
  );
  assert.equal(
    messageOf(() => send.buildErc20Transfer({
      contract: USDT_CONTRACT,
      recipient: USDT_RECIPIENT,
      decimals: "6",
      amount: "1.1234567",
    })),
    "At most 6 decimal places for this token.",
    "too many token decimals keeps the token-specific cutoff",
  );
  // Raw amount above 2^256-1 cannot fit one calldata word.
  assert.throws(
    () => send.buildErc20Transfer({
      contract: USDT_CONTRACT,
      recipient: USDT_RECIPIENT,
      decimals: "0",
      amount: "9".repeat(80),
    }),
    /too large/,
  );
  assert.throws(
    () => send.buildErc20Transfer({ contract: USDT_CONTRACT, recipient: USDT_RECIPIENT, amount: "0" }),
    /greater than zero/,
  );
});

add("TRX -> sun conversion is exact and rejects bad amounts", () => {
  assert.equal(send.tronAmountSun("1", tron), 1000000n);
  assert.equal(send.tronAmountSun("1.5", tron), 1500000n);
  assert.equal(send.tronAmountSun("0.000001", tron), 1n);
  assert.equal(send.tronAmountSun("123456.789", tron), 123456789000n);
  assert.throws(() => send.tronAmountSun("1.1234567", tron), /at most 6 decimals/);
  assert.throws(() => send.tronAmountSun("0", tron), /greater than zero/);
  assert.throws(() => send.tronAmountSun("0.0", tron), /greater than zero/);
  assert.throws(() => send.tronAmountSun("-1", tron), /plain positive decimal/);
  assert.throws(() => send.tronAmountSun("1e3", tron), /plain positive decimal/);
  assert.throws(() => send.tronAmountSun("", tron), /plain positive decimal/);
  assert.throws(() => send.tronAmountSun("1", null), /TRON helper did not load/);
});

add("TRON prepare builds the review from an injected Nile block and core", async () => {
  const captured = [];
  const review = await send.prepareTronTransfer({
    tron,
    from: TRON_FROM,
    to: TRON_TO,
    amount: "1.5",
    latestBlock: () => TRON_BLOCK,
    unsigned: (request) => {
      captured.push(request);
      return {
        txID: TRON_TXID,
        raw_data_hex: TRON_RAW_DATA_HEX,
        raw_data: { contract: [] },
      };
    },
  });

  assert.equal(review.chain, send.TRON_CHAIN);
  assert.equal(review.from, TRON_FROM);
  assert.equal(review.to, TRON_TO);
  assert.equal(review.amountSun, 1500000n);
  assert.equal(review.amountTron, "1.5");
  assert.equal(review.tx.txID, TRON_TXID);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], {
    owner_address: TRON_FROM,
    to_address: TRON_TO,
    amount: "1500000",
    ref_block_bytes: "abab",
    ref_block_hash: "cd".repeat(8),
    expiration: "1700000060000",
    timestamp: "1700000000000",
    fee_limit: "0",
  });
  assert.equal(send.containsSecret(captured[0], KEY_HEX), false);

  // The recipient and amount are validated before any block/core call.
  let called = false;
  await rejects(
    () => send.prepareTronTransfer({
      tron,
      from: TRON_FROM,
      to: "not-a-tron-address",
      amount: "1",
      latestBlock: () => { called = true; return TRON_BLOCK; },
      unsigned: () => { called = true; return {}; },
    }),
    /To is not a valid base58 address/,
    "bad recipient",
  );
  assert.equal(called, false);

  await rejects(
    () => send.prepareTronTransfer({
      tron,
      from: TRON_FROM,
      to: TRON_TO,
      amount: "0",
      latestBlock: () => { called = true; return TRON_BLOCK; },
      unsigned: () => { called = true; return {}; },
    }),
    /greater than zero/,
    "zero amount",
  );
  assert.equal(called, false);
});

add("TRON sign + broadcast never puts the key in a request and posts only to Nile", async () => {
  const review = await send.prepareTronTransfer({
    tron,
    from: TRON_FROM,
    to: TRON_TO,
    amount: "1",
    latestBlock: () => TRON_BLOCK,
    unsigned: () => ({ txID: TRON_TXID, raw_data_hex: TRON_RAW_DATA_HEX, raw_data: {} }),
  });

  let signingRequest = null;
  const tronKey = await send.parseSecret(MAINNET_WIF, send.TRON_CHAIN);
  assert.equal(tronKey.keyHex, KEY_HEX);
  const signed = await send.signTronTransfer({
    tron,
    review,
    keyHex: tronKey.keyHex,
    sign: (request) => {
      signingRequest = { ...request };
      return {
        txID: TRON_TXID,
        raw_data_hex: TRON_RAW_DATA_HEX,
        raw_data: {},
        signature: TRON_SIGNATURE,
      };
    },
  });
  assert.equal(signingRequest.private_key, "0x" + KEY_HEX);
  assert.equal(signed.signature, TRON_SIGNATURE);

  const calls = [];
  const fetchJson = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ result: true });
  };
  const result = await tron.broadcast(signed, { fetchJson });
  assert.equal(result.txID, TRON_TXID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, tron.ENDPOINTS.broadcast);
  assert.ok(calls[0].url.startsWith("https://api.nileex.io/"));
  for (const call of calls) {
    assert.equal(send.containsSecret(call, KEY_HEX), false, "key leaked into the broadcast");
  }
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.signature[0], TRON_SIGNATURE);
  assert.equal(body.raw_data_hex, TRON_RAW_DATA_HEX);

  // A malformed key or review fails before the core is called.
  let signedCalled = false;
  await rejects(
    () => send.signTronTransfer({
      tron,
      review,
      keyHex: "not-a-key",
      sign: () => { signedCalled = true; return {}; },
    }),
    /32-byte hex key/,
    "bad key",
  );
  assert.equal(signedCalled, false);
  await rejects(
    () => send.signTronTransfer({ tron, review: null, keyHex: KEY_HEX }),
    /No TRON review/,
    "missing review",
  );
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
    unsigned: () => "0x02f8",
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

/* -------------------------------- BNB testnet and ERC-20 prepare wiring */

add("BNB testnet review uses chain id 97 and rejects a mainnet provider", async () => {
  const bnbProviders = send.providersForChain(send.BNB_CHAIN, []);
  const answers = {
    eth_chainId: "0x61",
    eth_getTransactionCount: "0x0",
    eth_getBalance: "0xde0b6b3a7640000",
    eth_estimateGas: "0x5208",
    eth_feeHistory: { baseFeePerGas: ["0x3b9aca00"] },
    eth_maxPriorityFeePerGas: "0x3b9aca00",
  };
  const fetchJson = (url, options) => {
    const req = JSON.parse(options.body);
    assert.ok(bnbProviders.includes(url), "BNB reads must use the BSC-testnet allowlist");
    return Promise.resolve({ jsonrpc: "2.0", id: 1, result: answers[req.method] });
  };
  const review = await evm.prepareTransaction({
    form: { to: EVM_TO, value: "0.001", gasLimit: "21000" },
    from: EVM_FROM,
    fetchJson,
    unsigned: () => "0x02f8",
    providers: bnbProviders,
    expectedChainId: send.BNB_CHAIN_ID,
    chainName: "BNB Smart Chain testnet",
    nativeSymbol: "tBNB",
    networkName: "BNB testnet",
  });
  assert.equal(review.chainId, send.BNB_CHAIN_ID);
  assert.equal(review.chainName, "BNB Smart Chain testnet");

  // A provider answering BNB mainnet (0x38 = 56) must fail before unsigned.
  const mainnetFetch = (url, options) => {
    const req = JSON.parse(options.body);
    return Promise.resolve({
      jsonrpc: "2.0",
      id: 1,
      result: req.method === "eth_chainId" ? "0x38" : "0x0",
    });
  };
  let unsignedCalled = false;
  await rejects(
    () => evm.prepareTransaction({
      form: { to: EVM_TO, value: "0.001", gasLimit: "21000" },
      from: EVM_FROM,
      fetchJson: mainnetFetch,
      unsigned: () => { unsignedCalled = true; return "0x02f8"; },
      providers: bnbProviders,
      expectedChainId: send.BNB_CHAIN_ID,
    }),
    /Chain id mismatch/i,
    "bnb mainnet provider",
  );
  assert.equal(unsignedCalled, false);
});

add("ERC-20 transfer prepares a Sepolia review with value 0 and the built calldata", async () => {
  const sepoliaProviders = send.providersForChain(
    send.USDT_CHAIN,
    evm.PROVIDERS.map((provider) => provider.url),
  );
  const answers = {
    eth_chainId: "0xaa36a7",
    eth_getTransactionCount: "0x0",
    eth_getBalance: "0xde0b6b3a7640000",
    eth_estimateGas: "0xea60",
    eth_feeHistory: { baseFeePerGas: ["0x3b9aca00"] },
    eth_maxPriorityFeePerGas: "0x3b9aca00",
  };
  const fetchJson = (url, options) => {
    const req = JSON.parse(options.body);
    assert.equal(send.assertEvmRpcUrl(url, sepoliaProviders), url);
    return Promise.resolve({ jsonrpc: "2.0", id: 1, result: answers[req.method] });
  };
  const transfer = send.buildErc20Transfer({
    contract: USDT_CONTRACT,
    recipient: USDT_RECIPIENT,
    decimals: "6",
    amount: "1",
  });
  const review = await evm.prepareTransaction({
    form: {
      to: transfer.contract,
      value: "0",
      data: transfer.data,
      gasLimit: send.USDT_DEFAULT_GAS,
    },
    from: EVM_FROM,
    fetchJson,
    unsigned: (fields) => {
      assert.equal(fields.data, transfer.data);
      assert.equal(fields.value, "0");
      assert.equal(fields.gas_limit, send.USDT_DEFAULT_GAS);
      return "0x02f8";
    },
    providers: sepoliaProviders,
    expectedChainId: send.SEPOLIA_CHAIN_ID,
    chainName: "Ethereum Sepolia (ERC-20)",
  });
  assert.equal(review.chainId, send.SEPOLIA_CHAIN_ID);
  assert.equal(review.dataHex, transfer.data);
  assert.equal(review.valueWei, 0n);
  assert.equal(review.gasLimit, 60000n);
});

for (const [name, fn] of tests) await test(name, fn);
console.log("");
console.log(passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
