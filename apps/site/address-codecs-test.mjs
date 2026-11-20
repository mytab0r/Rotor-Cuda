// Tests for apps/site/address-codecs.js: the Bitcoin Cash CashAddr and
// Base58Check encoders used by the /key page. Zero npm dependencies; Node
// built-ins only.
//
// Usage: node apps/site/address-codecs-test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const types = require("./address-codecs.js");

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

let checks = 0;
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
  checks += 1;
}

function sha256d(bytes) {
  return createHash("sha256")
    .update(createHash("sha256").update(bytes).digest())
    .digest();
}

function decodeBase58(text) {
  let value = 0n;
  for (const char of text) {
    const index = BASE58.indexOf(char);
    assert.ok(index >= 0, `invalid base58 character ${char}`);
    value = value * 58n + BigInt(index);
  }
  let hex = value === 0n ? "" : value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let leading = 0;
  while (leading < text.length && text[leading] === "1") leading += 1;
  return Buffer.from("00".repeat(leading) + hex, "hex");
}

function decodeBase58Check(text) {
  const data = decodeBase58(text);
  const body = data.subarray(0, data.length - 4);
  assert.deepEqual(data.subarray(data.length - 4), sha256d(body).subarray(0, 4), `${text} checksum`);
  return body;
}

// Key 1 public key hash160 values. The compressed value is also used by
// key-tools-test.mjs; the uncompressed value is the well-known key-1 P2PKH
// address 1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm.
const COMPRESSED = "751e76e8199196d454941c45d1b3a323f1433bd6";
const UNCOMPRESSED = "91b24bf9f5288532960ac687abb035127b1d28a5";

/* ------------------------------------------------------- CashAddr vectors */
/* Authoritative source, fetched 2026-11-20:
 * https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md
 * ("Larger Test Vectors", payload size 20, type 0, prefix bitcoincash). */

check("CashAddr spec vector (20-byte payload, type 0)", () => {
  assert.equal(
    types.cashaddr("f5bf48b397dae70be82b3cca4793f8eb2b6cdac9", 0),
    "bitcoincash:qr6m7j9njldwwzlg9v7v53unlr4jkmx6eylep8ekg2",
  );
});

check("CashAddr translation of legacy P2PKH 1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu", () => {
  const legacy = decodeBase58Check("1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu");
  assert.equal(legacy[0], 0x00);
  assert.equal(
    types.cashaddr(legacy.subarray(1), 0),
    "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
  );
});

check("CashAddr translation of legacy P2SH 3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC", () => {
  const legacy = decodeBase58Check("3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC");
  assert.equal(legacy[0], 0x05);
  assert.equal(
    types.cashaddr(legacy.subarray(1), 1),
    "bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq",
  );
});

check("CashAddr of the key-1 compressed hash160", () => {
  assert.equal(
    types.cashaddr(COMPRESSED, 0),
    "bitcoincash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cy4spdc2h",
  );
});

/* ---------------------------------------------------- Base58Check vectors */

check("Base58Check Bitcoin version 0x00 on the compressed hash160", () => {
  // Pinned independently by key-tools-test.mjs (key-1 P2PKH).
  assert.equal(types.base58check([0x00], COMPRESSED), "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH");
});

check("Base58Check Bitcoin version 0x00 on the uncompressed hash160", () => {
  assert.equal(types.base58check([0x00], UNCOMPRESSED), "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm");
});

check("Dogecoin version byte is 0x1e on the uncompressed hash160", () => {
  const address = types.base58check([0x1e], UNCOMPRESSED);
  assert.equal(address, "DJRU7MLhcPwCTNRZ4e8gJzDebtG1H5M7pc");
  const body = decodeBase58Check(address);
  assert.equal(body[0], 0x1e);
  assert.deepEqual(body.subarray(1), Buffer.from(UNCOMPRESSED, "hex"));
});

check("Zcash version bytes are 0x1c 0xb8 on the uncompressed hash160", () => {
  const address = types.base58check([0x1c, 0xb8], UNCOMPRESSED);
  assert.equal(address, "t1X9yaRpCHJpWX1HrGUxEu39xyQinmo3Ana");
  const body = decodeBase58Check(address);
  assert.deepEqual(body.subarray(0, 2), Buffer.from([0x1c, 0xb8]));
  assert.deepEqual(body.subarray(2), Buffer.from(UNCOMPRESSED, "hex"));
});

check("compressed and uncompressed hashes produce different Dogecoin/Zcash addresses", () => {
  const dogeCompressed = types.base58check([0x1e], COMPRESSED);
  const dogeUncompressed = types.base58check([0x1e], UNCOMPRESSED);
  assert.equal(dogeCompressed, "DFpN6QqFfUm3gKNaxN6tNcab1FArL9cZLE");
  assert.notEqual(dogeCompressed, dogeUncompressed);
  assert.notEqual(
    types.base58check([0x1c, 0xb8], COMPRESSED),
    types.base58check([0x1c, 0xb8], UNCOMPRESSED),
  );
});

/* ------------------------------------------------------------- rejection */

check("CashAddr rejects non-20-byte hashes", () => {
  assert.throws(() => types.cashaddr(new Uint8Array(19), 0));
  assert.throws(() => types.cashaddr(new Uint8Array(21), 0));
  assert.throws(() => types.cashaddr("00".repeat(19), 0));
  assert.throws(() => types.cashaddr("00".repeat(21), 0));
  assert.throws(() => types.cashaddr("abc", 0));
  assert.throws(() => types.cashaddr("zz".repeat(20), 0));
});

check("CashAddr rejects types outside 0-15", () => {
  for (const type of [-1, 16, 1.5, "0", null, undefined]) {
    assert.throws(() => types.cashaddr(COMPRESSED, type), `type ${String(type)}`);
  }
});

check("Base58Check rejects bad prefix and payload sizes", () => {
  assert.throws(() => types.base58check([], COMPRESSED));
  assert.throws(() => types.base58check([0x1e, 0xb8, 0x00], COMPRESSED));
  assert.throws(() => types.base58check([0x1e], new Uint8Array(19)));
  assert.throws(() => types.base58check([0x1e], new Uint8Array(21)));
  assert.throws(() => types.base58check([0x1e], [1, 2, 3]));
  assert.throws(() => types.base58check([0x1e], Array(20).fill(256)));
  assert.throws(() => types.base58check([0x1e], "00".repeat(19)));
});

/* ---------------------------------------------------------------- derive */

const SYNTHETIC = {
  curve: "secp256k1",
  addresses: [
    {
      id: "bch_legacy",
      label: "Bitcoin Cash legacy",
      address: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
      steps: { pubkey: "0279be667e", hash160: COMPRESSED },
    },
    {
      id: "btc_p2pkh_uncompressed",
      label: "Bitcoin legacy (uncompressed)",
      address: "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm",
      steps: { pubkey: "0479be667e", hash160: UNCOMPRESSED },
    },
    {
      id: "doge_p2pkh",
      label: "Dogecoin legacy",
      address: "DFpN6QqFfUm3gKNaxN6tNcab1FArL9cZLE",
      steps: { pubkey: "0279be667e", hash160: COMPRESSED },
    },
  ],
};

check("derive returns all three rows from the report hash160 values", () => {
  const rows = types.derive(SYNTHETIC);
  assert.equal(rows.bch_cashaddr.address, "bitcoincash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cy4spdc2h");
  assert.equal(rows.bch_cashaddr.steps.hash160, COMPRESSED);
  assert.equal(rows.bch_cashaddr.steps.pubkey, "0279be667e");
  assert.equal(rows.doge_p2pkh_uncompressed.address, "DJRU7MLhcPwCTNRZ4e8gJzDebtG1H5M7pc");
  assert.equal(rows.doge_p2pkh_uncompressed.steps.hash160, UNCOMPRESSED);
  assert.equal(rows.zcash_p2pkh_uncompressed.address, "t1X9yaRpCHJpWX1HrGUxEu39xyQinmo3Ana");
  assert.equal(rows.zcash_p2pkh_uncompressed.steps.hash160, UNCOMPRESSED);
});

check("derive uses the uncompressed row for DOGE/ZEC, not the compressed DOGE row", () => {
  const rows = types.derive(SYNTHETIC);
  assert.notEqual(rows.doge_p2pkh_uncompressed.address, SYNTHETIC.addresses[2].address);
  assert.equal(rows.doge_p2pkh_uncompressed.steps.pubkey, "0479be667e");
});

check("derive does not mutate the report", () => {
  const before = SYNTHETIC.addresses.length;
  types.derive(SYNTHETIC);
  assert.equal(SYNTHETIC.addresses.length, before);
});

check("derive returns nulls for ed25519 and for missing inputs", () => {
  for (const report of [
    { curve: "ed25519", addresses: [] },
    { curve: "secp256k1", addresses: [] },
    null,
    undefined,
  ]) {
    const rows = types.derive(report);
    assert.equal(rows.bch_cashaddr, null);
    assert.equal(rows.doge_p2pkh_uncompressed, null);
    assert.equal(rows.zcash_p2pkh_uncompressed, null);
  }
});

check("derive returns null when a hash160 step is malformed", () => {
  const rows = types.derive({
    curve: "secp256k1",
    addresses: [
      { id: "bch_legacy", steps: { hash160: "00".repeat(19) } },
      { id: "btc_p2pkh_uncompressed", steps: { hash160: "not-hex" } },
    ],
  });
  assert.equal(rows.bch_cashaddr, null);
  assert.equal(rows.doge_p2pkh_uncompressed, null);
  assert.equal(rows.zcash_p2pkh_uncompressed, null);
});

/* --------------------------------------------- real WASM report contract */

// The rows are only useful if they match the report the WASM core actually
// returns. Derive key 1 through the committed artifact and pin the result.
const wasmPath = process.argv[2] ?? fileURLToPath(new URL("./rotor_wasm.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), {});
const wasm = instance.exports;
const decoder = new TextDecoder("utf-8");
const key = new Uint8Array(32);
key[31] = 1;
const pointer = wasm.alloc(key.length) >>> 0;
new Uint8Array(wasm.memory.buffer, pointer, key.length).set(key);
let report;
try {
  assert.equal(wasm.derive_report(pointer, 0), 0, "derive_report key 1");
  report = JSON.parse(
    decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.result_ptr(), wasm.result_len())),
  );
} finally {
  wasm.dealloc(pointer, key.length);
}

check("derive consumes the live WASM report shape for key 1", () => {
  assert.equal(report.curve, "secp256k1");
  const rows = types.derive(report);
  assert.equal(rows.bch_cashaddr.address, "bitcoincash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cy4spdc2h");
  assert.equal(rows.bch_cashaddr.steps.hash160, COMPRESSED);
  assert.equal(rows.doge_p2pkh_uncompressed.address, "DJRU7MLhcPwCTNRZ4e8gJzDebtG1H5M7pc");
  assert.equal(rows.zcash_p2pkh_uncompressed.address, "t1X9yaRpCHJpWX1HrGUxEu39xyQinmo3Ana");
});

console.log(`address-codecs ok: ${checks} checks (CashAddr spec vectors, Base58Check 0x1e/0x1cb8, derive)`);
