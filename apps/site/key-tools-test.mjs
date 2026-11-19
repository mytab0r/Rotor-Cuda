// Tests for the key utility tooling: the pure helpers in key-tools.js and the
// new wasm exports (public key report, point addition, keystore decryption).
//
// Usage: node apps/site/key-tools-test.mjs [apps/site/rotor_wasm.wasm]

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tools = require("./key-tools.js");
const wasmPath = process.argv[2] ?? fileURLToPath(new URL("./rotor_wasm.wasm", import.meta.url));

const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), {});
const wasm = instance.exports;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

for (const name of [
  "public_key_report",
  "public_key_add",
  "keystore_decrypt",
  "derive_report",
  "result_ptr",
  "result_len",
  "error_ptr",
  "error_len",
]) {
  if (typeof wasm[name] !== "function") throw new Error(`wasm is missing export ${name}`);
}

function upload(data) {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const pointer = wasm.alloc(bytes.length) >>> 0;
  if (!pointer) throw new Error("alloc returned 0");
  new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
  return { pointer, length: bytes.length };
}

function text(pointer, length) {
  return decoder.decode(new Uint8Array(wasm.memory.buffer, pointer, length));
}

function resultJson() {
  return JSON.parse(text(wasm.result_ptr(), wasm.result_len()));
}

function wasmError() {
  return text(wasm.error_ptr(), wasm.error_len());
}

function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------- integer helpers

const integerCases = [
  ["0x1", "1", "0x1"],
  ["255", "255", "0xff"],
  ["0b11111111", "255", "0xff"],
  ["0xFF", "255", "0xff"],
  ["0x" + "f".repeat(64), (2n ** 256n - 1n).toString(10), "0x" + "f".repeat(64)],
];
for (const [input, decimal, hex] of integerCases) {
  const formatted = tools.formatInteger(tools.parseInteger(input));
  assert(formatted.decimal === decimal, `${input}: decimal ${formatted.decimal}`);
  assert(formatted.hex === hex, `${input}: hex ${formatted.hex}`);
}
for (const bad of ["", "0xzz", "-1", "1e5", "0b102", "0x" + "f".repeat(65)]) {
  let threw = false;
  try {
    tools.parseInteger(bad);
  } catch (err) {
    threw = true;
  }
  assert(threw, `parseInteger accepted ${JSON.stringify(bad)}`);
}
const padded = tools.formatInteger(tools.parseInteger("1"));
assert(padded.hexPadded.length === 64, "padded hex must be 32 bytes");
assert(padded.binaryPadded.length === 256, "padded binary must be 256 bits");
assert(padded.bytes === 1, "key 1 is one byte");

// ------------------------------------------------------------ fragment assembly

const assembled = tools.assembleKey(
  [
    "# halves",
    "0:hex:4c0883a69102937d6231471b5dbb6204",
    "16:hex:fe5129617082792ae468d01a3f362318",
  ].join("\n"),
);
assert(assembled.complete, "fragment halves must complete");
assert(
  assembled.hex === "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
  `assembled hex ${assembled.hex}`,
);

const partial = tools.assembleKey("0:hex:deadbeef\n");
assert(!partial.complete, "partial fragments must not complete");
assert(partial.missing.length === 28, `missing count ${partial.missing.length}`);
assert(partial.missing[0] === 4 && partial.missing[27] === 31, "missing range");

const mixed = tools.assembleKey(
  "0:bin:0000000100000010\n2:dec:255\n3:ascii:A\n4:hex:" + "0".repeat(56) + "\n",
);
assert(mixed.complete, "mixed fragment formats must complete");
assert(mixed.hex === "0102ff41" + "0".repeat(56), `mixed hex ${mixed.hex}`);

for (const bad of ["0:hex:abc", "31:hex:ffff", "0:hex:00\n0:hex:00", "garbage", "0:nope:00"]) {
  let threw = false;
  try {
    tools.assembleKey(bad);
  } catch (err) {
    threw = true;
  }
  assert(threw, `assembleKey accepted ${JSON.stringify(bad)}`);
}

// --------------------------------------------------------------- wasm exports

const KEY1_COMPRESSED = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const pubUpload = upload(KEY1_COMPRESSED);
assert(wasm.public_key_report(pubUpload.pointer, pubUpload.length) === 0, `public_key_report: ${wasmError()}`);
const pubReport = resultJson();
wasm.dealloc(pubUpload.pointer, pubUpload.length);
const pubAddresses = Object.fromEntries(pubReport.addresses.map((entry) => [entry.id, entry.address]));
assert(pubReport.pubkey_uncompressed.length === 130, "uncompressed form");
assert(pubAddresses.btc_p2pkh === "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", "key-1 P2PKH");
assert(pubAddresses.btc_p2wpkh === "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "key-1 P2WPKH");
assert(pubAddresses.evm === "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf", "key-1 EVM");
assert(pubAddresses.tron === "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC", "key-1 TRON");

const a = upload(KEY1_COMPRESSED);
const b = upload(KEY1_COMPRESSED);
assert(wasm.public_key_add(a.pointer, a.length, b.pointer, b.length) === 0, `public_key_add: ${wasmError()}`);
const sum = resultJson();
wasm.dealloc(a.pointer, a.length);
wasm.dealloc(b.pointer, b.length);
assert(
  sum.pubkey_compressed === "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
  `G + G compressed ${sum.pubkey_compressed}`,
);
assert(
  sum.pubkey_uncompressed ===
    "04c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee51ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a",
  "G + G uncompressed",
);

const negG = upload("0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
const p = upload(KEY1_COMPRESSED);
assert(wasm.public_key_add(p.pointer, p.length, negG.pointer, negG.length) !== 0, "P + (-P) must be rejected");
wasm.dealloc(negG.pointer, negG.length);
wasm.dealloc(p.pointer, p.length);

// --------------------------------------------------------------- keystore

const FIXTURES = [
  {
    name: "scrypt",
    kdf: 0,
    n: 1024,
    r: 8,
    p: 1,
    c: 0,
    salt: "dc4503dd74699a901de4d508c404856188e305edba9c4883eb076ff63d052e5f",
    iv: "298f88b92ccc0d3a00d9c9740083aaf3",
    ciphertext: "d0529445d0ea0ac164cd2e33b8f2fbb290d512a525124035cacf7de3e10b709e",
    mac: "3a5cc2cde46413afd05a8cc3b2bb836c",
  },
  {
    name: "pbkdf2",
    kdf: 1,
    n: 0,
    r: 0,
    p: 0,
    c: 1024,
    salt: "f8bb8267db01439b94e5cb7f32b9c745adb219c65531c0e59e9a5d326ca423f8",
    iv: "aa1a4975ed2552d141c2b0efb697227e",
    ciphertext: "f4cff4877250f18f9f538d9c466e49dbc0eab4a46f86fc10075296e60ffa4f5f",
    mac: "e52c429438f1fcfe33d429825550bd69",
  },
];
const EXPECTED_KEY = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

for (const fixture of FIXTURES) {
  const buffers = {
    salt: upload(hexToBytes(fixture.salt)),
    iv: upload(hexToBytes(fixture.iv)),
    ciphertext: upload(hexToBytes(fixture.ciphertext)),
    mac: upload(hexToBytes(fixture.mac)),
    password: upload("testpassword"),
  };
  let status;
  try {
    status = wasm.keystore_decrypt(
      fixture.kdf,
      fixture.n,
      fixture.r,
      fixture.p,
      fixture.c,
      32,
      buffers.salt.pointer,
      buffers.salt.length,
      buffers.iv.pointer,
      buffers.iv.length,
      buffers.ciphertext.pointer,
      buffers.ciphertext.length,
      buffers.mac.pointer,
      buffers.mac.length,
      buffers.password.pointer,
      buffers.password.length,
    );
    assert(status === 0, `${fixture.name} keystore: ${wasmError()}`);
    const keyHex = text(wasm.result_ptr(), wasm.result_len());
    assert(keyHex === EXPECTED_KEY, `${fixture.name} key ${keyHex}`);

    const keyBytes = hexToBytes(keyHex);
    const keyUpload = upload(keyBytes);
    assert(wasm.derive_report(keyUpload.pointer, 0) === 0, `derive after ${fixture.name}`);
    const report = resultJson();
    assert(
      report.addresses.find((entry) => entry.id === "evm").address.toLowerCase() ===
        "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23",
      `${fixture.name} derived EVM address`,
    );
  } finally {
    for (const buffer of Object.values(buffers)) wasm.dealloc(buffer.pointer, buffer.length);
  }
}

// A wrong password is rejected and leaves the error buffer readable.
const wrong = {
  salt: upload(hexToBytes(FIXTURES[1].salt)),
  iv: upload(hexToBytes(FIXTURES[1].iv)),
  ciphertext: upload(hexToBytes(FIXTURES[1].ciphertext)),
  mac: upload(hexToBytes(FIXTURES[1].mac)),
  password: upload("wrong-password"),
};
try {
  const status = wasm.keystore_decrypt(
    1, 0, 0, 0, 1024, 32,
    wrong.salt.pointer, wrong.salt.length,
    wrong.iv.pointer, wrong.iv.length,
    wrong.ciphertext.pointer, wrong.ciphertext.length,
    wrong.mac.pointer, wrong.mac.length,
    wrong.password.pointer, wrong.password.length,
  );
  assert(status !== 0, "wrong password must be rejected");
  assert(wasmError().includes("MAC"), `wrong password error: ${wasmError()}`);
} finally {
  for (const buffer of Object.values(wrong)) wasm.dealloc(buffer.pointer, buffer.length);
}

console.log("key-tools ok: integer, fragments, pubkey report/add, scrypt+pbkdf2 keystore");
