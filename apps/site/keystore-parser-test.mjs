// Tests for apps/site/keystore-parser.js: the pure V3 keystore validator and
// the shipped example vector. Node built-ins only.
//
// Usage: node apps/site/keystore-parser-test.mjs

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parseKeystore, KEYSTORE_EXAMPLES } = require("./keystore-parser.js");

const EXAMPLE = KEYSTORE_EXAMPLES[0];
const VECTOR = JSON.parse(EXAMPLE.json);
const WASM_PATH = process.argv[2] ?? fileURLToPath(new URL("./rotor_wasm.wasm", import.meta.url));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function legacyArrayKeystore() {
  return {
    version: 3,
    crypto: {
      cipher: "aes-128-ctr",
      cipherparams: { iv: "00".repeat(16) },
      ciphertext: "11".repeat(32),
      kdf: "scrypt",
      kdfparams: [1024, 8, 1],
      salt: "22".repeat(32),
      dklen: 32,
      mac: "33".repeat(32),
    },
  };
}

test("parses the shipped PBKDF2 V3 example", () => {
  const request = parseKeystore(EXAMPLE.json);
  assert.equal(request.kdfName, "pbkdf2");
  assert.equal(request.kdfId, 1);
  assert.equal(request.c, 262144);
  assert.equal(request.dklen, 32);
  assert.equal(request.n, 0);
  assert.equal(request.r, 0);
  assert.equal(request.p, 0);
  assert.equal(request.salt, VECTOR.crypto.kdfparams.salt);
  assert.equal(request.iv, VECTOR.crypto.cipherparams.iv);
  assert.equal(request.ciphertext, VECTOR.crypto.ciphertext);
  assert.equal(request.mac, VECTOR.crypto.mac);
  assert.equal(request.declaredAddress, EXAMPLE.address.replace(/^0x/, ""));
  assert.equal(request.version, 3);
  assert.equal(request.id, VECTOR.id);
  assert.equal(request.cipher, "aes-128-ctr");
});

test("rejects a version other than 3", () => {
  const bad = clone(VECTOR);
  bad.version = 2;
  assert.throws(() => parseKeystore(JSON.stringify(bad)), /Unsupported keystore version "2"/);
});

test("rejects an unsupported cipher", () => {
  const bad = clone(VECTOR);
  bad.crypto.cipher = "aes-256-cbc";
  assert.throws(() => parseKeystore(JSON.stringify(bad)), /Unsupported cipher "aes-256-cbc"/);
});

test("rejects an unsupported KDF", () => {
  const bad = clone(VECTOR);
  bad.crypto.kdf = "argon2";
  bad.crypto.kdfparams = { dklen: 32, salt: "ab".repeat(32) };
  assert.throws(() => parseKeystore(JSON.stringify(bad)), /Unsupported KDF "argon2"/);
});

test("rejects bad hex in a required field", () => {
  const bad = clone(VECTOR);
  bad.crypto.ciphertext = "abcd";
  assert.throws(() => parseKeystore(JSON.stringify(bad)), /field "ciphertext"/);
});

test("accepts the legacy positional kdfparams array", () => {
  const request = parseKeystore(JSON.stringify(legacyArrayKeystore()));
  assert.equal(request.kdfName, "scrypt");
  assert.equal(request.kdfId, 0);
  assert.equal(request.n, 1024);
  assert.equal(request.r, 8);
  assert.equal(request.p, 1);
  assert.equal(request.dklen, 32);
  assert.equal(request.salt, "22".repeat(32));
});

test("rejects a malformed legacy kdfparams array", () => {
  const bad = legacyArrayKeystore();
  bad.crypto.kdfparams = [1024, 8];
  assert.throws(() => parseKeystore(JSON.stringify(bad)), /must be \[n, r, p\]/);
});

test("every shipped example parses into a valid request", () => {
  for (const example of KEYSTORE_EXAMPLES) {
    const request = parseKeystore(example.json);
    assert.equal(request.version, 3);
    assert.equal(request.declaredAddress, example.address.replace(/^0x/, ""));
    assert.equal(request.kdfId, 1);
    assert.equal(example.password, "testpassword");
    assert.ok(request.password === undefined, `${example.id} must not expose a password`);
  }
  assert.ok(EXAMPLE.label.toLowerCase().includes("test"));
  assert.ok(/public test key|test vector/i.test(EXAMPLE.label));
});

test("the shipped example decrypts to its declared address", {
  skip: existsSync(WASM_PATH) ? false : `wasm not found at ${WASM_PATH}`,
}, async () => {
  const { instance } = await WebAssembly.instantiate(await readFile(WASM_PATH), {});
  const wasm = instance.exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");
  const text = (pointer, length) =>
    decoder.decode(new Uint8Array(wasm.memory.buffer, pointer, length));
  const upload = (data) => {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    const pointer = wasm.alloc(bytes.length) >>> 0;
    new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
    return { pointer, length: bytes.length };
  };
  const hex = (value) => Uint8Array.from(Buffer.from(value, "hex"));

  const request = parseKeystore(EXAMPLE.json);
  const buffers = {
    salt: upload(hex(request.salt)),
    iv: upload(hex(request.iv)),
    ciphertext: upload(hex(request.ciphertext)),
    mac: upload(hex(request.mac)),
    password: upload(EXAMPLE.password),
  };
  const keyUpload = { pointer: 0, length: 0 };
  try {
    const status = wasm.keystore_decrypt(
      request.kdfId, request.n, request.r, request.p, request.c, request.dklen,
      buffers.salt.pointer, buffers.salt.length,
      buffers.iv.pointer, buffers.iv.length,
      buffers.ciphertext.pointer, buffers.ciphertext.length,
      buffers.mac.pointer, buffers.mac.length,
      buffers.password.pointer, buffers.password.length,
    ) >>> 0;
    assert.equal(status, 0, text(wasm.error_ptr(), wasm.error_len()));

    const key = hex(text(wasm.result_ptr(), wasm.result_len()));
    keyUpload.pointer = wasm.alloc(key.length) >>> 0;
    keyUpload.length = key.length;
    new Uint8Array(wasm.memory.buffer, keyUpload.pointer, key.length).set(key);
    assert.equal(wasm.derive_report(keyUpload.pointer, 0) >>> 0, 0,
      text(wasm.error_ptr(), wasm.error_len()));

    const report = JSON.parse(text(wasm.result_ptr(), wasm.result_len()));
    const evm = report.addresses.find((entry) => entry.id === "evm").address;
    assert.equal(evm.toLowerCase(), EXAMPLE.address.toLowerCase());
  } finally {
    for (const buffer of Object.values(buffers)) wasm.dealloc(buffer.pointer, buffer.length);
    if (keyUpload.pointer) wasm.dealloc(keyUpload.pointer, keyUpload.length);
  }
});
