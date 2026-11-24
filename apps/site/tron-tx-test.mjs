// Tests for the TRON Nile testnet transfer core (apps/site/tron-tx.js) and the
// new WASM exports (crates/rotor-wasm/src/tron.rs).
//
// Usage: node apps/site/tron-tx-test.mjs [path/to/rotor_wasm.wasm]
//
// No dependencies, no DOM, no network. The pinned vector matches the Rust
// unit test and was independently reproduced with a hand-written Python
// protobuf encoder. The tests pin:
//  - base58check address validation (0x41 prefix, checksum, 21 bytes);
//  - exact sun <-> TRX conversion;
//  - request normalization and amount/fee/timestamp bounds;
//  - the protobuf raw_data_hex / txID / deterministic signature round trip;
//  - the testnet-only URL allowlist (Nile only, no other host or path);
//  - the ref_block_bytes/ref_block_hash derivation from blockID;
//  - that the private key never appears in the signed object or the
//    broadcast body.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
require("./chains.generated.js");
require("./amount.js");
const tron = require("./tron-tx.js");

const WASM_PATH =
  process.argv[2] ??
  fileURLToPath(new URL("./rotor_wasm.wasm", import.meta.url));

const KEY1 =
  "0000000000000000000000000000000000000000000000000000000000000001";
const OWNER = "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC";
const DEST = "TDvSsdrNM5eeXNL3czpa6AxLDHZA9nwe9K";
const RAW_DATA_HEX =
  "0a0212ab2208001122334455667740e0a499ffbc315a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a15417e5f4552091a69125d5dfcb7b8c2659029395bdf1215412b5ad5c4795c026514f8317c7a215e218dccd6cf18c0843d7080d095ffbc31900100";
const TX_ID =
  "ceff5238d3200e6ea4a23f8de6608e61aa6bb757a505e93f4fed422631a32c4e";
const SIGNATURE =
  "d990cf8db49841329b06d1c2c50e43d9481a7f762df4f603d321b8578454c0e62fe71d4d72db7bc8f95ac9d60cf5da983ba64ea13d6325e36fc99d9e46bb8a631c";

function transfer(overrides) {
  return Object.assign(
    {
      owner_address: OWNER,
      to_address: DEST,
      amount: "1000000",
      ref_block_bytes: "12ab",
      ref_block_hash: "0011223344556677",
      expiration: "1700000060000",
      timestamp: "1700000000000",
    },
    overrides ?? {},
  );
}

const wasmBytes = await readFile(WASM_PATH);
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const wasm = instance.exports;
for (const name of ["tron_unsigned_tx", "tron_sign_tx", "alloc", "dealloc"]) {
  assert.equal(typeof wasm[name], "function", `wasm export ${name}`);
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
    console.error(
      "     " +
        (err && err.stack
          ? err.stack.split("\n").slice(0, 3).join("\n     ")
          : err),
    );
  }
}

function rejects(fn, needle, message) {
  let error = null;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error, message + ": expected a rejection");
  assert.ok(
    needle.test(error.message),
    message + ": message was " + JSON.stringify(error.message),
  );
}

async function rejectsAsync(fn, needle, message) {
  let error = null;
  try {
    await fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error, message + ": expected a rejection");
  assert.ok(
    needle.test(error.message),
    message + ": message was " + JSON.stringify(error.message),
  );
}

const tests = [];
function add(name, fn) {
  tests.push([name, fn]);
}

/* --------------------------------------------------------------- hashing */

add("sha256 matches Node crypto", () => {
  for (const input of ["", "abc", "TRON Nile testnet", "x".repeat(1000)]) {
    const bytes = new TextEncoder().encode(input);
    assert.equal(
      Buffer.from(tron.sha256(bytes)).toString("hex"),
      createHash("sha256").update(bytes).digest("hex"),
      JSON.stringify(input.slice(0, 20)),
    );
  }
});

/* -------------------------------------------------------------- addresses */

add("decodeAddress accepts the key-1 and key-2 TRON addresses", () => {
  const owner = tron.decodeAddress(OWNER, "owner_address");
  assert.equal(owner.payloadHex, "41" + "7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  assert.equal(owner.accountHex, "7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  const dest = tron.decodeAddress(" " + DEST + " ");
  assert.equal(dest.address, DEST);
  assert.equal(dest.accountHex, "2b5ad5c4795c026514f8317c7a215e218dccd6cf");
});

add("decodeAddress rejects EVM, Bitcoin and malformed addresses", () => {
  rejects(
    () => tron.decodeAddress("0x2b5ad5c4795c026514f8317c7a215e218dccd6cf"),
    /hex address/,
    "EVM address",
  );
  rejects(
    () => tron.decodeAddress("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"),
    /not a TRON address|prefix/,
    "Bitcoin mainnet address",
  );
  rejects(
    () => tron.decodeAddress(OWNER.slice(0, -1) + "J"),
    /checksum/,
    "bad checksum",
  );
  rejects(() => tron.decodeAddress("not an address"), /base58/);
  rejects(() => tron.decodeAddress(""), /must be/);
});

add("a valid base58check payload with the wrong prefix is rejected", () => {
  // A Bitcoin mainnet P2PKH address is 21 bytes with a 0x00 prefix.
  rejects(
    () => tron.assertAddress("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", "to_address"),
    /prefix|TRON/,
  );
});

/* ---------------------------------------------------------------- amounts */

add("sun and TRX convert exactly", () => {
  assert.equal(tron.sunToTron("1000000"), "1");
  assert.equal(tron.sunToTron(1n), "0.000001");
  assert.equal(tron.sunToTron("1500000"), "1.5");
  assert.equal(tron.sunToTron("1"), "0.000001");
  assert.equal(tron.sunToTron("0"), "0");
  assert.equal(tron.tronToSun("1"), 1000000n);
  assert.equal(tron.tronToSun("1.5"), 1500000n);
  assert.equal(tron.tronToSun("0.000001"), 1n);
  assert.equal(tron.sunToTron(tron.tronToSun("123.456789")), "123.456789");
  rejects(() => tron.tronToSun("1.0000001"), /6 decimals/);
  rejects(() => tron.tronToSun("-1"), /plain positive/);
  rejects(() => tron.tronToSun("1e6"), /plain positive/);
  rejects(() => tron.sunToTron(-1n), /negative/);
});

/* ---------------------------------------------------------- normalization */

add("normalizeRequest accepts the documented schema", () => {
  const fields = tron.normalizeRequest(transfer(), false);
  assert.deepEqual(Object.keys(fields).sort(), [
    "amount",
    "expiration",
    "fee_limit",
    "kind",
    "owner_address",
    "ref_block_bytes",
    "ref_block_hash",
    "timestamp",
    "to_address",
  ]);
  assert.equal(fields.kind, "trx");
  assert.equal(fields.fee_limit, "0");
  assert.equal(fields.amount, "1000000");
});

add("normalizeRequest enforces amount, fee and timestamp bounds", () => {
  rejects(() => tron.normalizeRequest(transfer({ amount: "0" }), false), /greater than zero/);
  rejects(
    () => tron.normalizeRequest(transfer({ amount: "9223372036854775808" }), false),
    /int64/,
  );
  rejects(
    () => tron.normalizeRequest(transfer({ fee_limit: "100000001" }), false),
    /100 TRX/,
  );
  rejects(
    () => tron.normalizeRequest(transfer({ expiration: "0" }), false),
    /greater than zero/,
  );
  rejects(
    () => tron.normalizeRequest(transfer({ timestamp: "9007199254740993" }), false),
    /JSON-safe/,
  );
  assert.equal(
    tron.normalizeRequest(transfer({ fee_limit: "100000000" }), false).fee_limit,
    "100000000",
  );
});

add("normalizeRequest rejects unknown fields and keys in unsigned requests", () => {
  rejects(
    () => tron.normalizeRequest(transfer({ extra: "x" }), false),
    /unknown request field/,
  );
  rejects(
    () => tron.normalizeRequest(transfer({ private_key: "0x" + KEY1 }), false),
    /unsigned review request/,
  );
  rejects(
    () => tron.normalizeRequest(transfer({ ref_block_bytes: "12abcd" }), false),
    /4 hex/,
  );
  rejects(
    () => tron.normalizeRequest(transfer({ ref_block_hash: "0011" }), false),
    /16 hex/,
  );
  rejects(
    () => tron.normalizeRequest(transfer({ private_key: "0x1234" }), true),
    /32-byte hex/,
  );
});

/* ----------------------------------------------------- wasm round trip */

add("unsignedTransfer builds the pinned protobuf vector", () => {
  const review = tron.unsignedTransfer(wasm, transfer());
  assert.equal(review.txID, TX_ID);
  assert.equal(review.raw_data_hex, RAW_DATA_HEX);
  assert.equal(review.signature, undefined);
  assert.equal(review.raw_data.ref_block_bytes, "12ab");
  assert.equal(review.raw_data.ref_block_hash, "0011223344556677");
  assert.equal(review.raw_data.fee_limit, 0);
  const contract = review.raw_data.contract[0];
  assert.equal(contract.type, "TransferContract");
  assert.equal(
    contract.parameter.type_url,
    "type.googleapis.com/protocol.TransferContract",
  );
  assert.deepEqual(contract.parameter.value, {
    owner_address: "41" + "7e5f4552091a69125d5dfcb7b8c2659029395bdf",
    to_address: "41" + "2b5ad5c4795c026514f8317c7a215e218dccd6cf",
    amount: 1000000,
  });
});

add("signTransfer returns the pinned deterministic signature", () => {
  const signed = tron.signTransfer(wasm, transfer({ private_key: "0x" + KEY1 }));
  assert.equal(signed.txID, TX_ID);
  assert.equal(signed.raw_data_hex, RAW_DATA_HEX);
  assert.equal(signed.signature, SIGNATURE);
  assert.equal(signed.signature.slice(-2), "1c", "v = 27 + recovery_id 1");

  const again = tron.signTransfer(wasm, transfer({ private_key: "0x" + KEY1 }));
  assert.deepEqual(again, signed);

  const serialized = JSON.stringify(signed);
  assert.equal(serialized.toLowerCase().includes(KEY1), false, "private key leaked");
  assert.equal(Object.keys(signed).includes("private_key"), false);
});

add("wasm rejects an invalid key and bad bounds with a readable error", () => {
  rejects(
    () => tron.signTransfer(wasm, transfer({ private_key: "0x" + "00".repeat(32) })),
    /local core rejected.*private key/i,
    "zero key",
  );
  rejects(
    () => tron.signTransfer(wasm, transfer({ amount: "0", private_key: "0x" + KEY1 })),
    /greater than zero/,
    "zero amount",
  );
});

/* --------------------------------------------------------- http gates */

add("assertNileUrl accepts only the exact Nile endpoints", () => {
  for (const path of ["/wallet/getnowblock", "/wallet/broadcasttransaction"]) {
    assert.equal(
      tron.assertNileUrl(tron.NILE_BASE + path, path),
      tron.NILE_BASE + path,
    );
  }
});

add("assertNileUrl rejects mainnet and other hosts and paths", () => {
  const path = "/wallet/broadcasttransaction";
  for (const host of ["api.trongrid.io", "api.tronstack.io", "api.tronex.io"]) {
    rejects(
      () => tron.assertNileUrl("https://" + host + path, path),
      /testnet only.*host/,
      host,
    );
  }
  rejects(
    () => tron.assertNileUrl("http://api.nileex.io" + path, path),
    /https is required/,
  );
  rejects(
    () => tron.assertNileUrl("https://api.nileex.io/wallet/createtransaction", path),
    /refusing path/,
  );
  rejects(
    () => tron.assertNileUrl("https://api.nileex.io" + path + "?visible=false", path),
    /query strings/,
  );
  rejects(() => tron.assertNileUrl("not a url", path), /malformed/);
  rejects(() => tron.assertNileUrl(undefined, path), /URL is required/);
});

add("latestBlock derives the TAPOS fields from blockID", async () => {
  const calls = [];
  const blockID = "000000000000" + "aabb" + "0102030405060708" + "11".repeat(16);
  const fetchJson = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({
      blockID: blockID.toUpperCase(),
      block_header: {
        raw_data: { number: 123456, timestamp: 1700000000000 },
      },
      transactions: [],
    });
  };
  const block = await tron.latestBlock({ fetchJson });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.nileex.io/wallet/getnowblock");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(block.blockID, blockID);
  assert.equal(block.ref_block_bytes, "aabb");
  assert.equal(block.ref_block_hash, "0102030405060708");
  assert.equal(block.timestamp, "1700000000000");
  assert.equal(block.expiration, "1700000060000");
  assert.equal(block.blockNumber, "123456");
});

add("latestBlock rejects a malformed block response without retrying elsewhere", async () => {
  await rejectsAsync(
    () => tron.latestBlock({ fetchJson: () => Promise.resolve({}) }),
    /blockID/,
  );
  await rejectsAsync(
    () =>
      tron.latestBlock({
        fetchJson: () =>
          Promise.resolve({ blockID: "11".repeat(32), block_header: {} }),
      }),
    /timestamp/,
  );
});

add("broadcast POSTs only the signed fields to Nile", async () => {
  const signed = tron.signTransfer(wasm, transfer({ private_key: "0x" + KEY1 }));
  const calls = [];
  const fetchJson = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ result: true, txid: TX_ID });
  };
  const result = await tron.broadcast(
    Object.assign({ private_key: "0x" + KEY1, extra: "nope" }, signed),
    { fetchJson },
  );
  assert.equal(result.result, true);
  assert.equal(result.txID, TX_ID);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.nileex.io/wallet/broadcasttransaction",
  );
  assert.equal(calls[0].options.method, "POST");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.txID, TX_ID);
  assert.equal(body.raw_data_hex, RAW_DATA_HEX);
  assert.deepEqual(body.signature, [SIGNATURE]);
  assert.equal(body.private_key, undefined);
  assert.equal(body.extra, undefined);
  assert.equal(calls[0].options.body.toLowerCase().includes(KEY1), false);
});

add("broadcast rejects an incomplete signed object and a Nile refusal", async () => {
  const signed = tron.signTransfer(wasm, transfer({ private_key: "0x" + KEY1 }));

  await rejectsAsync(
    () => tron.broadcast({ ...signed, signature: undefined }, { fetchJson: () => Promise.resolve({ result: true }) }),
    /signature/,
  );
  await rejectsAsync(
    () =>
      tron.broadcast(signed, {
        fetchJson: () => Promise.resolve({ result: false, code: "CONTRACT_VALIDATE_ERROR" }),
      }),
    /Nile rejected.*CONTRACT_VALIDATE_ERROR/,
  );
});

/* ---------------------------------------------------------------- runner */

for (const [name, fn] of tests) await test(name, fn);
console.log("");
console.log(passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
