// Brainwallet page engine test.
//
// Usage: node apps/site/brainwallet-test.mjs [path/to/rotor_wasm.wasm]
//
// Checks the known SHA-256 brainwallet vector ("correct horse battery staple"),
// the address-row selection and explorer links used by the pages, and the
// explicit out-of-range errors. Only Node's standard library is used.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

import engine from "./brainwallet-engine.js";

const WASM_PATH = process.argv[2] ?? "apps/site/rotor_wasm.wasm";
const PHRASE = "correct horse battery staple";
const PHRASE_SHA256 =
  "c4bbcb1fbec99d65bf59d85c8cb62ee2db963f0fe106f483d9afa73bd4e39a8a";
const CURVE_ORDER =
  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";

const wasmBytes = readFileSync(WASM_PATH);
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const wasm = instance.exports;
const decoder = new TextDecoder("utf-8");

function readString(ptr, len) {
  if (!ptr || !len) return "";
  return decoder.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
}

function derive(keyBytes, curve = 0) {
  const ptr = wasm.alloc(keyBytes.length) >>> 0;
  assert.ok(ptr, "wasm alloc");
  try {
    new Uint8Array(wasm.memory.buffer, ptr, keyBytes.length).set(keyBytes);
    const status = wasm.derive_report(ptr, curve) >>> 0;
    if (status !== 0) {
      return {
        status,
        error: readString(wasm.error_ptr() >>> 0, wasm.error_len() >>> 0),
      };
    }
    const text = readString(wasm.result_ptr() >>> 0, wasm.result_len() >>> 0);
    return { status, report: JSON.parse(text) };
  } finally {
    wasm.dealloc(ptr, keyBytes.length);
  }
}

function address(report, id) {
  const entry = report.addresses.find((item) => item.id === id);
  assert.ok(entry, `address ${id}`);
  return entry.address;
}

// 1. Known SHA-256 vector and the derived key.
const nodeDigest = createHash("sha256").update(PHRASE, "utf8").digest("hex");
assert.equal(nodeDigest, PHRASE_SHA256, "node SHA-256 vector");
const key = await engine.phraseKey(PHRASE, webcrypto.subtle);
assert.equal(engine.bytesToHex(key), PHRASE_SHA256, "engine SHA-256 of phrase");
const padded = await engine.phraseKey(`  ${PHRASE}  `, webcrypto.subtle);
assert.equal(engine.bytesToHex(padded), PHRASE_SHA256, "phrase is trimmed like search.js");

// 2. The wasm derive_report is the same address engine as /key.
const { status, report, error } = derive(key, 0);
assert.equal(status, 0, error);
assert.equal(report.priv_hex, PHRASE_SHA256);
assert.equal(report.wif_compressed, "L3p8oAcQTtuokSCRHQ7i4MhjWc9zornvpJLfmg62sYpLRJF9woSu");
assert.equal(report.wif_uncompressed, "5KJvsngHeMpm884wtkJNzQGaCErckhHJBGFsvd3VyK5qMZXj3hS");
assert.equal(address(report, "btc_p2pkh"), "1C7zdTfnkzmr13HfA2vNm5SJYRK6nEKyq8");
// Published brainwallet vector: the uncompressed legacy address of this key.
assert.equal(
  address(report, "btc_p2pkh_uncompressed"),
  "1JwSSubhmg6iPtRjtyqhUYYH7bZg3Lfy1T",
  "published correct-horse-battery-staple address",
);
assert.equal(address(report, "btc_p2wpkh"), "bc1q08alc0e5ua69scxhvyma568nvguqccrv4cc9n4");
assert.equal(
  address(report, "btc_p2tr"),
  "bc1p3833qjvky7c2w3r7earqqwc377qeztadmfwjpwyy5srsch868lgs2v8tnw",
);
assert.equal(address(report, "evm"), "0xDCCD62d450c645f6437680b8A4DaA098396DcE0e");

// 3. Row selection and explorer links per page focus.
const bitcoinRows = engine.addressRows(report, "bitcoin");
assert.deepEqual(
  bitcoinRows.map((row) => row.id),
  ["btc_p2pkh", "btc_p2wpkh", "btc_p2tr"],
);
assert.equal(
  bitcoinRows[0].explorer,
  "https://mempool.space/address/1C7zdTfnkzmr13HfA2vNm5SJYRK6nEKyq8",
);

const ethereumRows = engine.addressRows(report, "ethereum");
assert.equal(ethereumRows.length, 1);
assert.equal(ethereumRows[0].id, "evm");
assert.equal(
  ethereumRows[0].explorer,
  "https://etherscan.io/address/0xDCCD62d450c645f6437680b8A4DaA098396DcE0e",
);

const allRows = engine.addressRows(report, "all");
assert.deepEqual(
  allRows.map((row) => row.id),
  ["btc_p2pkh", "btc_p2wpkh", "btc_p2tr", "evm"],
);

// 4. Key fields: WIF belongs to the Bitcoin pages, not the Ethereum one.
const bitcoinFields = engine.keyFields(report, "bitcoin");
assert.deepEqual(
  bitcoinFields.map((field) => field[0]),
  ["Private key (hex)", "WIF (compressed)", "WIF (uncompressed)"],
);
assert.equal(bitcoinFields[0][1], PHRASE_SHA256);
const ethereumFields = engine.keyFields(report, "ethereum");
assert.deepEqual(ethereumFields.map((field) => field[0]), ["Private key (hex)"]);

// 5. Random phrase generation is local, deterministic under a fake RNG and
//    never derives anything by itself.
let fakeDraws = 0;
const fakeCrypto = {
  getRandomValues(buffer) {
    fakeDraws += 1;
    buffer[0] = 0;
    return buffer;
  },
};
const generated = engine.randomPhrase(fakeCrypto);
assert.equal(generated.split(" ").length, 5);
assert.equal(fakeDraws, 5);
assert.throws(() => engine.randomPhrase(null), /random source/);

// 6. Out-of-range keys keep the core's explicit messages.
const zero = new Uint8Array(32);
const zeroResult = derive(zero, 0);
assert.notEqual(zeroResult.status, 0);
assert.match(zeroResult.error, /range 1\.\.n-1/);

const order = Uint8Array.from(Buffer.from(CURVE_ORDER, "hex"));
const orderResult = derive(order, 0);
assert.notEqual(orderResult.status, 0);
assert.match(orderResult.error, /not below the curve order/);

console.log("brainwallet engine: known SHA-256 vector, rows, explorers and range errors OK");
