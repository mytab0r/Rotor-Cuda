// Tests for the key utility tooling: the pure helpers in key-tools.js and the
// new wasm exports (public key report, point addition, keystore decryption).
//
// Usage: node apps/site/key-tools-test.mjs [apps/site/rotor_wasm.wasm]

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
require("./chains.generated.js");
require("./amount.js");
const tools = require("./key-tools.js");
const wasmPath = process.argv[2] ?? fileURLToPath(new URL("./rotor_wasm.wasm", import.meta.url));

const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), {});
const wasm = instance.exports;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

for (const name of [
  "public_key_report",
  "public_key_add",
  "public_key_subtract",
  "public_key_mul",
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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
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

// P2 - P1 = (2 - 1) * G = G. The expected point is the mul_g-derived key 1.
const KEY2_COMPRESSED = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const subA = upload(KEY2_COMPRESSED);
const subB = upload(KEY1_COMPRESSED);
assert(
  wasm.public_key_subtract(subA.pointer, subA.length, subB.pointer, subB.length) === 0,
  `public_key_subtract: ${wasmError()}`,
);
const difference = resultJson();
assert(difference.pubkey_compressed === KEY1_COMPRESSED, `P2 - P1 compressed ${difference.pubkey_compressed}`);
assert(wasm.public_key_subtract(subA.pointer, subA.length, subA.pointer, subA.length) !== 0, "P - P must be rejected");
wasm.dealloc(subA.pointer, subA.length);
wasm.dealloc(subB.pointer, subB.length);

// k * G must equal the public key derived from scalar k (mul_g path).
for (const [scalar, expected] of [
  ["00".repeat(31) + "01", KEY1_COMPRESSED],
  ["00".repeat(31) + "02", KEY2_COMPRESSED],
]) {
  const point = upload(KEY1_COMPRESSED);
  const exponent = upload(scalar);
  assert(
    wasm.public_key_mul(point.pointer, point.length, exponent.pointer, exponent.length) === 0,
    `public_key_mul: ${wasmError()}`,
  );
  const product = resultJson();
  assert(product.pubkey_compressed === expected, `k * G for k=${scalar} is ${product.pubkey_compressed}`);
  wasm.dealloc(point.pointer, point.length);
  wasm.dealloc(exponent.pointer, exponent.length);
}

const zeroPoint = upload(KEY1_COMPRESSED);
const zeroScalar = upload("00".repeat(32));
assert(
  wasm.public_key_mul(zeroPoint.pointer, zeroPoint.length, zeroScalar.pointer, zeroScalar.length) !== 0,
  "a zero scalar must be rejected",
);
wasm.dealloc(zeroPoint.pointer, zeroPoint.length);
wasm.dealloc(zeroScalar.pointer, zeroScalar.length);

// --------------------------------------------------------------- keystore

// Full keccak256(dk[16..32] || ciphertext) of the scrypt fixture below; its
// first 16 bytes are the legacy MAC. Independently reproduced by the Rust test.
const FULL_MAC = "3a5cc2cde46413afd05a8cc3b2bb836c1b9e669776d9a1be80d45cae5cfcf221";

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
    name: "scrypt-full-mac",
    kdf: 0,
    n: 1024,
    r: 8,
    p: 1,
    c: 0,
    salt: "dc4503dd74699a901de4d508c404856188e305edba9c4883eb076ff63d052e5f",
    iv: "298f88b92ccc0d3a00d9c9740083aaf3",
    ciphertext: "d0529445d0ea0ac164cd2e33b8f2fbb290d512a525124035cacf7de3e10b709e",
    mac: FULL_MAC,
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
const PBKDF2 = FIXTURES.find((fixture) => fixture.name === "pbkdf2");
const wrong = {
  salt: upload(hexToBytes(PBKDF2.salt)),
  iv: upload(hexToBytes(PBKDF2.iv)),
  ciphertext: upload(hexToBytes(PBKDF2.ciphertext)),
  mac: upload(hexToBytes(PBKDF2.mac)),
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

// A corrupt 32-byte MAC is rejected too.
const wrongFullMac = {
  salt: upload(hexToBytes(FIXTURES[0].salt)),
  iv: upload(hexToBytes(FIXTURES[0].iv)),
  ciphertext: upload(hexToBytes(FIXTURES[0].ciphertext)),
  mac: upload(hexToBytes(FULL_MAC.slice(0, -2) + "00")),
  password: upload("testpassword"),
};
try {
  const status = wasm.keystore_decrypt(
    0, 1024, 8, 1, 0, 32,
    wrongFullMac.salt.pointer, wrongFullMac.salt.length,
    wrongFullMac.iv.pointer, wrongFullMac.iv.length,
    wrongFullMac.ciphertext.pointer, wrongFullMac.ciphertext.length,
    wrongFullMac.mac.pointer, wrongFullMac.mac.length,
    wrongFullMac.password.pointer, wrongFullMac.password.length,
  );
  assert(status !== 0, "corrupt 32-byte MAC must be rejected");
  assert(wasmError().includes("MAC"), `corrupt 32-byte MAC error: ${wasmError()}`);
} finally {
  for (const buffer of Object.values(wrongFullMac)) wasm.dealloc(buffer.pointer, buffer.length);
}

// --------------------------------------------------------- keystore JSON parser

const parser = require("./keystore-parser.js");
const baseCrypto = {
  cipher: "aes-128-ctr",
  cipherparams: { iv: FIXTURES[0].iv },
  ciphertext: FIXTURES[0].ciphertext,
  kdf: "scrypt",
  kdfparams: { dklen: 32, n: 1024, r: 8, p: 1, salt: FIXTURES[0].salt },
  mac: FIXTURES[0].mac,
};
const clone = (value) => JSON.parse(JSON.stringify(value));

const legacyMac = parser.parseKeystore(JSON.stringify({ version: 3, crypto: baseCrypto }));
assert(legacyMac.mac.length === 32, `16-byte MAC parses as ${legacyMac.mac.length}`);
assert(legacyMac.kdfId === 0 && legacyMac.n === 1024, "object kdfparams still parses");

const fullMacJson = { version: 3, crypto: clone(baseCrypto) };
fullMacJson.crypto.mac = FULL_MAC;
const fullMac = parser.parseKeystore(JSON.stringify(fullMacJson));
assert(fullMac.mac.length === 64, `32-byte MAC parses as ${fullMac.mac.length}`);
assert(fullMac.mac === FULL_MAC, "full MAC is kept verbatim");

const arrayJson = { version: 3, crypto: clone(baseCrypto) };
arrayJson.crypto.kdfparams = [1024, 8, 1];
arrayJson.crypto.salt = FIXTURES[0].salt;
arrayJson.crypto.dklen = 32;
arrayJson.crypto.mac = FULL_MAC;
const arrayForm = parser.parseKeystore(JSON.stringify(arrayJson));
assert(arrayForm.kdfId === 0, "array kdfparams is scrypt");
assert(
  arrayForm.n === 1024 && arrayForm.r === 8 && arrayForm.p === 1,
  `array kdfparams [n, r, p] as ${arrayForm.n}/${arrayForm.r}/${arrayForm.p}`,
);
assert(arrayForm.salt === FIXTURES[0].salt, "array form reads the crypto salt");
assert(arrayForm.mac.length === 64, "array form keeps the 32-byte MAC");

// End to end: the parsed legacy shape decrypts the same fixture through wasm.
const parsedBuffers = {
  salt: upload(hexToBytes(arrayForm.salt)),
  iv: upload(hexToBytes(arrayForm.iv)),
  ciphertext: upload(hexToBytes(arrayForm.ciphertext)),
  mac: upload(hexToBytes(arrayForm.mac)),
  password: upload("testpassword"),
};
try {
  const status = wasm.keystore_decrypt(
    arrayForm.kdfId,
    arrayForm.n,
    arrayForm.r,
    arrayForm.p,
    arrayForm.c,
    arrayForm.dklen,
    parsedBuffers.salt.pointer,
    parsedBuffers.salt.length,
    parsedBuffers.iv.pointer,
    parsedBuffers.iv.length,
    parsedBuffers.ciphertext.pointer,
    parsedBuffers.ciphertext.length,
    parsedBuffers.mac.pointer,
    parsedBuffers.mac.length,
    parsedBuffers.password.pointer,
    parsedBuffers.password.length,
  );
  assert(status === 0, `array-form keystore decrypt: ${wasmError()}`);
  assert(
    text(wasm.result_ptr(), wasm.result_len()) === EXPECTED_KEY,
    "array-form keystore decrypts to the fixture key",
  );
  assert(typeof wasm.clear_result === "function", "wasm exposes clear_result");
  wasm.clear_result();
  assert(wasm.result_len() === 0, "clear_result empties the result buffer");
} finally {
  for (const buffer of Object.values(parsedBuffers)) wasm.dealloc(buffer.pointer, buffer.length);
}

for (const kdfparams of [[1024, 8], [1024, 8, 1, 32]]) {
  const bad = { version: 3, crypto: clone(arrayJson.crypto) };
  bad.crypto.kdfparams = kdfparams;
  let message = "";
  try {
    parser.parseKeystore(JSON.stringify(bad));
  } catch (err) {
    message = err.message;
  }
  assert(
    message.includes("[n, r, p]"),
    `array kdfparams ${JSON.stringify(kdfparams)} must be rejected clearly, got ${message}`,
  );
}

const badMacJson = { version: 3, crypto: clone(baseCrypto) };
badMacJson.crypto.mac = "ab".repeat(24);
let badMacMessage = "";
try {
  parser.parseKeystore(JSON.stringify(badMacJson));
} catch (err) {
  badMacMessage = err.message;
}
assert(
  badMacMessage.includes("32") && badMacMessage.includes("64"),
  `a 48-hex MAC must name both accepted sizes, got ${badMacMessage}`,
);

// ------------------------------------------------- key facts and counters

const sha256Double = async (bytes) => {
  const first = createHash("sha256").update(bytes).digest();
  return createHash("sha256").update(first).digest();
};

function deriveFor(hex, curve) {
  const buffer = upload(hexToBytes(hex));
  try {
    assert(wasm.derive_report(buffer.pointer, curve) === 0, `derive_report curve ${curve}: ${wasmError()}`);
    return resultJson();
  } finally {
    wasm.dealloc(buffer.pointer, buffer.length);
  }
}

const BTC58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RIPPLE58 = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

function decodeAlphabet(text, alphabet) {
  let value = 0n;
  for (const char of text) {
    const index = alphabet.indexOf(char);
    assert(index >= 0, `invalid base58 character ${char}`);
    value = value * 58n + BigInt(index);
  }
  let hex = value === 0n ? "" : value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const leading = text.length - text.replace(new RegExp(`^${alphabet[0]}+`), "").length;
  return Uint8Array.from(Buffer.from("00".repeat(leading) + hex, "hex"));
}

function factById(facts, id) {
  return facts.find((fact) => fact.id === id) || {};
}

const KEY_ONE = "00".repeat(31) + "01";
const secpReport = deriveFor(KEY_ONE, 0);
const edReport = deriveFor(KEY_ONE, 1);

// ---------------------------------------------------------------- WIF vectors
// key 1 and the well-known Bitcoin Wiki key, compressed, on each mainnet
// version byte this site links. Values were cross-checked with an independent
// Node BigInt implementation before being added here.
const WIF_VECTORS = [
  [KEY_ONE, "bitcoin", "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn"],
  [KEY_ONE, "litecoin", "T33ydQRKp4FCW5LCLLUB7deioUMoveiwekdwUwyfRDeGZm76aUjV"],
  [KEY_ONE, "dogecoin", "QNcdLVw8fHkixm6NNyN6nVwxKek4u7qrioRbQmjxac5TVoTtZuot"],
  [
    "0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d",
    "bitcoin",
    "KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617",
  ],
  [
    "0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d",
    "litecoin",
    "T3TccUZx4EXBZaHnFiP9eTr8igDEZoqSjNvbA56Z8vV74oyAcjTK",
  ],
  [
    "0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d",
    "dogecoin",
    "QP2GKa5kuU2i2G3xJMH5KL9NErbVYGxMoRiF5trrJJvHzrJ2Ebp7",
  ],
];
for (const [hex, network, wif] of WIF_VECTORS) {
  const encoded = await tools.wifEncode(hexToBytes(hex), network, sha256Double);
  assert(encoded === wif, `${network} WIF ${encoded} !== ${wif}`);
  const decoded = await tools.wifDecode(wif, sha256Double);
  assert(decoded.network === network, `${wif} network ${decoded.network}`);
  assert(decoded.compressed === true, `${wif} must be compressed`);
  assert(Buffer.from(decoded.bytes).toString("hex") === hex, `${wif} key mismatch`);
}
const uncompressed = await tools.wifDecode(
  "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf",
  sha256Double,
);
assert(uncompressed.network === "bitcoin", "uncompressed BTC WIF network");
assert(uncompressed.compressed === false, "uncompressed BTC WIF flag");
assert(Buffer.from(uncompressed.bytes).toString("hex") === KEY_ONE, "uncompressed BTC WIF key");

// The 37-byte (uncompressed) form has no 0x01 marker; LTC/DOGE versions must
// round-trip through wifEncode/wifDecode with compressed=false.
for (const [network, prefixes] of [
  ["litecoin", ["6", "T"]],
  ["dogecoin", ["6", "Q"]],
]) {
  const wif = await tools.wifEncode(hexToBytes(KEY_ONE), network, sha256Double, false);
  assert(prefixes.includes(wif[0]), `${network} uncompressed WIF ${wif} prefix`);
  const decoded = await tools.wifDecode(wif, sha256Double);
  assert(decoded.network === network, `${network} uncompressed WIF keeps its network`);
  assert(decoded.compressed === false, `${network} uncompressed WIF flag`);
  assert(Buffer.from(decoded.bytes).toString("hex") === KEY_ONE, `${network} uncompressed WIF key`);
}
let wifRejected = false;
try {
  await tools.wifDecode("T33ydQRKp4FCW5LCLLUB7deioUMoveiwekdwUwyfRDeGZm76aUjW", sha256Double);
} catch (err) {
  wifRejected = true;
}
assert(wifRejected, "a corrupted WIF checksum must be rejected");

// --------------------------------------------------- key input resolution
// Every accepted representation must map to the same 32-byte hex key, so a
// pasted value shows the same page and Keys table as the same key in hex.
const sha256Single = async (bytes) => createHash("sha256").update(bytes).digest();
const sha512Hash = async (bytes) => createHash("sha512").update(bytes).digest();
function secpPublicKey(bytes) {
  const buffer = upload(bytes);
  try {
    assert(wasm.derive_report(buffer.pointer, 0) === 0, `derive_report: ${wasmError()}`);
    return Uint8Array.from(Buffer.from(resultJson().pubkey_compressed, "hex"));
  } finally {
    wasm.dealloc(buffer.pointer, buffer.length);
  }
}
const keyHashes = {
  sha256: sha256Single,
  doubleSha256: sha256Double,
  sha512: sha512Hash,
  secpPublicKey,
};

async function resolved(text) {
  return tools.resolveKeyInput(text, keyHashes);
}

const hexResolved = await resolved(KEY_ONE.toUpperCase());
assert(hexResolved.hex === KEY_ONE && hexResolved.format === "hex", "uppercase hex resolves to lowercase");
assert((await resolved("0x" + KEY_ONE)).hex === KEY_ONE, "0x hex resolves to the plain key");
assert((await resolved("1")).hex === KEY_ONE, "decimal 1 resolves to key 1");
const wifResolved = await resolved(WIF_VECTORS[0][2]);
assert(wifResolved.hex === KEY_ONE && wifResolved.format === "wif", "WIF resolves to key 1");
assert(wifResolved.network === "bitcoin", "WIF keeps its network for the input status");

// Litecoin (version 0xb0) and Dogecoin (0x9e) WIFs start with T/6 and Q/6.
// The same key must round-trip through wifEncode and resolveKeyInput, so a
// directory WIF link and the key page accept what the other one emits.
for (const [network, prefixes] of [
  ["litecoin", ["T", "6"]],
  ["dogecoin", ["Q", "6"]],
]) {
  const wif = await tools.wifEncode(hexToBytes(KEY_ONE), network, sha256Double);
  assert(
    prefixes.includes(wif[0]),
    `${network} WIF ${wif} must start with ${prefixes.join(" or ")}`,
  );
  const roundTrip = await resolved(wif);
  assert(roundTrip.hex === KEY_ONE && roundTrip.format === "wif", `${network} WIF resolves to key 1`);
  assert(roundTrip.network === network, `${network} WIF keeps its network`);
}
const keypairInput = JSON.stringify(Array.from({ length: 32 }, (_, index) => index));
const keypairResolved = await resolved(keypairInput);
assert(keypairResolved.format === "keypair", "keypair JSON keeps its format");
assert(keypairResolved.hex === Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join(""), "keypair JSON uses the first 32 bytes");
const pSecret = await tools.xrpSecret(KEY_ONE, sha256Double);
assert(tools.looksLikeXrpSecret(pSecret), "the page's XRP secret is recognised by shape");
assert((await resolved(pSecret)).hex === KEY_ONE, "p-prefixed XRP secret resolves to key 1");
const familySeed = "snoPBrXtMeMyMHUVTgbuqAfg1SUTb";
assert(tools.looksLikeXrpSecret(familySeed), "an s-prefixed XRP family seed is recognised by shape");
assert(
  (await resolved(familySeed)).hex === "1acaaedece405b2a958212629e16f2eb46b153eee94cdd350fdeff52795525b7",
  "XRP family seed resolves to the documented key",
);
assert(
  (await resolved("hello")).hex === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  "brainwallet text resolves to SHA-256 of the trimmed text",
);
const brokenSecret = pSecret.slice(0, -1) + (pSecret.endsWith("K") ? "L" : "K");
assert(
  !tools.looksLikeXrpSecret(brokenSecret) ||
    (await resolved(brokenSecret)).format === "brainwallet",
  "a checksum-invalid XRP-shaped string falls back to the brainwallet",
);

// ------------------------------------------------------ search routing
// The global search modal maps text to a destination without deriving. These
// vectors pin the donor order: WIF, XRP secret, keypair, 64-hex, mnemonic,
// then brainwallet.
const twelveWords = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const route = (value, mode) => tools.routeKeyInput(value, mode);

const hexRoute = route(KEY_ONE);
assert(hexRoute.kind === "hex" && hexRoute.href === "/key/" + KEY_ONE, "64-hex routes to /key/<hex>");
assert(route(KEY_ONE.toUpperCase()).href === "/key/" + KEY_ONE, "auto hex is lowercased");
assert(route("0x" + KEY_ONE).href === "/key/" + KEY_ONE, "0x hex routes to the plain hex key");
assert(route("abc", "hex").href === "/key/" + "abc".padStart(64, "0"), "forced HEX pads short input");
assert(route("1").kind === "brainwallet", "decimal 1 is a brainwallet in auto mode");
assert(route("1", "hex").href === "/key/" + KEY_ONE, "forced HEX treats 1 as key 1");

assert(route(WIF_VECTORS[0][2]).kind === "wif", "WIF routes to /key/<wif>");
assert(route(WIF_VECTORS[0][2]).href === "/key/" + WIF_VECTORS[0][2], "WIF link keeps the value");
for (const [network, prefixes] of [
  ["litecoin", ["T", "6"]],
  ["dogecoin", ["Q", "6"]],
]) {
  const wif = await tools.wifEncode(hexToBytes(KEY_ONE), network, sha256Double);
  assert(prefixes.includes(wif[0]), `${network} WIF ${wif} has the donor prefix`);
  const wifRoute = route(wif);
  assert(wifRoute.kind === "wif", `${network} WIF routes to /key/<wif>`);
  assert(wifRoute.href === "/key/" + wif, `${network} WIF link keeps the value`);
}
assert(route(pSecret).kind === "xrp", "p-prefixed XRP secret routes to /key/<secret>");
assert(route(pSecret).href === "/key/" + pSecret, "XRP secret link keeps the value");
assert(route(familySeed).kind === "xrp", "s-prefixed XRP family seed routes to /key/<secret>");

const jsonKeypairRoute = route(keypairInput);
assert(jsonKeypairRoute.kind === "keypair", "JSON keypair routes to /key/<keypair>");
assert(jsonKeypairRoute.curve === "ed25519", "keypair is an ed25519 input");
assert(
  jsonKeypairRoute.href === "/key/[" + Array.from({ length: 32 }, (_, index) => index).join(",") + "]",
  `JSON keypair is compacted for the link, got ${jsonKeypairRoute.href}`,
);

const base58Bytes = Uint8Array.from({ length: 64 }, (_, index) => index);
const base58Pair = tools.base58Encode(base58Bytes);
const base58Route = route(base58Pair);
assert(base58Route.kind === "keypair", "base58 keypair routes to /key/<keypair>");
assert(base58Route.href === "/key/" + base58Pair, "base58 keypair link keeps the value");
const base58Resolved = await resolved(base58Pair);
assert(base58Resolved.format === "keypair", "base58 keypair resolves for derivation");
assert(
  base58Resolved.hex === Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join(""),
  "base58 keypair uses the first 32 bytes as the ed25519 seed",
);

const mnemonicRoute = route(twelveWords);
assert(mnemonicRoute.kind === "mnemonic", "mnemonic routes to the converter");
assert(mnemonicRoute.href === "/mnemonic-converter", "mnemonic link is /mnemonic-converter");

const brainwalletRoute = route("hello world");
assert(brainwalletRoute.kind === "brainwallet", "other text is a brainwallet");
assert(brainwalletRoute.href === "/brainwallet", "brainwallet link is /brainwallet");
assert(route("hello world", "brainwallet").href === "/brainwallet", "forced brainwallet stays a brainwallet");
assert(route(KEY_ONE, "brainwallet").kind === "brainwallet", "forced brainwallet overrides key-like text");

for (const [value, mode, pattern] of [
  ["xyz", "hex", /HEX/],
  ["not-a-wif", "wif", /WIF/],
  ["hello", "keypair", /Keypair/],
  ["hello", "xrp", /XRP/],
  ["hello", "mnemonic", /Mnemonic/],
]) {
  let message = "";
  try {
    route(value, mode);
  } catch (err) {
    message = err.message;
  }
  assert(pattern.test(message), `forced ${mode} rejects ${value}: ${message}`);
}
assert(route("") === null, "empty input has no route");
assert(route("813abc", "auto").kind === "brainwallet", "short hex is a brainwallet in auto mode");

const secpFacts = await tools.buildKeyFacts(secpReport, sha256Double);
assert(factById(secpFacts, "hex").value === KEY_ONE, "secp HEX fact is the report key");
assert(factById(secpFacts, "hex").href === "/key/hex", "HEX links to the hex calculator");
assert(factById(secpFacts, "decimal").value === "1", "secp DECIMAL fact is 1");
assert(factById(secpFacts, "wif").value === secpReport.wif_compressed, "compressed WIF fact");
assert(factById(secpFacts, "wif").href === "/key/wif", "WIF links to the WIF calculator");
assert(factById(secpFacts, "wif_u").value === secpReport.wif_uncompressed, "uncompressed WIF fact");
assert(factById(secpFacts, "pubkey").value === secpReport.pubkey_compressed, "PUBKEY fact");
assert(!factById(secpFacts, "keypair").value && factById(secpFacts, "keypair").unavailable.includes("ed25519"),
  "KEYPAIR is explicitly unavailable on secp256k1");
assert(factById(secpFacts, "page").value === "/private-keys/bitcoin", "key 1 page is directory page 1");

const xrp = factById(secpFacts, "xrp");
assert(typeof xrp.value === "string" && xrp.value.startsWith("p"), `XRP secret starts with p, got ${xrp.value}`);
assert(/^[rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz]+$/.test(xrp.value),
  "XRP secret uses the Ripple alphabet");
const xrpBytes = decodeAlphabet(xrp.value, RIPPLE58);
assert(xrpBytes.length === 37, `XRP secret payload is 37 bytes, got ${xrpBytes.length}`);
assert(xrpBytes[0] === 0x23, "XRP secret carries the private-key type byte 0x23");
assert(Buffer.from(xrpBytes.slice(1, 33)).equals(Buffer.from(hexToBytes(KEY_ONE))), "XRP secret embeds the key");
const xrpChecksum = await sha256Double(Uint8Array.from([0x23, ...hexToBytes(KEY_ONE)]));
assert(Buffer.from(xrpBytes.slice(33)).equals(Buffer.from(xrpChecksum.slice(0, 4))),
  "XRP secret checksum is the first four double-SHA256 bytes");

const edFacts = await tools.buildKeyFacts(edReport, sha256Double);
assert(!factById(edFacts, "wif").value && factById(edFacts, "wif").unavailable.includes("secp256k1"),
  "WIF is explicitly unavailable on ed25519");
assert(!factById(edFacts, "wif_u").value && factById(edFacts, "wif_u").unavailable.includes("secp256k1"),
  "WIF (U) is explicitly unavailable on ed25519");
assert(!factById(edFacts, "xrp").value && factById(edFacts, "xrp").unavailable.includes("secp256k1"),
  "XRP secret is explicitly unavailable on ed25519");
assert(factById(edFacts, "pubkey").value === edReport.ed_pubkey, "ed25519 PUBKEY fact");
assert(factById(edFacts, "page").value === "/private-keys/solana", "ed25519 page is the Solana directory");
const keypairBytes = decodeAlphabet(factById(edFacts, "keypair").value, BTC58);
assert(keypairBytes.length === 64, `Solana keypair is 64 bytes, got ${keypairBytes.length}`);
assert(Buffer.from(keypairBytes.slice(0, 32)).equals(Buffer.from(hexToBytes(KEY_ONE))),
  "Solana keypair starts with the seed");
assert(Buffer.from(keypairBytes.slice(32)).equals(Buffer.from(hexToBytes(edReport.ed_pubkey))),
  "Solana keypair ends with the ed25519 public key");

const key60 = "00".repeat(31) + "3c";
const key61 = "00".repeat(31) + "3d";
assert(tools.privateKeyPage(key60, "secp256k1").href === "/private-keys/bitcoin", "key 60 is page 1");
assert(tools.privateKeyPage(key61, "secp256k1").href === "/private-keys/bitcoin/2", "key 61 is page 2");
assert(tools.privateKeyPage("00".repeat(32), "ed25519") === null, "key 0 has no directory page");

// ------------------------------------------------- grouping, labels, counters

// Donor type labels: the table shows P2SH, not "Nested SegWit"; Zcash uses
// the t1 (c)/(u) short names; TRON/Solana share Base58; XRP is r….
const TYPE_CASES = [
  ["btc_p2pkh", "Legacy"],
  ["btc_p2pkh_uncompressed", "Legacy (u)"],
  ["btc_p2sh_p2wpkh", "P2SH"],
  ["btc_p2wpkh", "SegWit"],
  ["btc_p2tr", "Taproot"],
  ["ltc_p2pkh", "Legacy"],
  ["ltc_p2wpkh", "SegWit"],
  ["ltc_p2sh_p2wpkh", "P2SH"],
  ["ltc_p2tr", "Taproot"],
  ["bch_cashaddr", "CashAddr"],
  ["bch_legacy", "Legacy"],
  ["doge_p2pkh", "Legacy"],
  ["doge_p2pkh_uncompressed", "Legacy (u)"],
  ["zcash_p2pkh", "t1 (c)"],
  ["zcash_p2pkh_uncompressed", "t1 (u)"],
  ["ton", "V4R2"],
  ["sui", "0x"],
  ["tron", "Base58"],
  ["solana", "Base58"],
  ["xrp_classic", "r…"],
  ["evm", "EVM"],
];
for (const [id, label] of TYPE_CASES) {
  assert(tools.addressTypeLabel(id) === label, `${id} type ${tools.addressTypeLabel(id)} !== ${label}`);
}
assert(tools.addressTypeLabel("evm_bnb") === "", "EVM sub-rows carry no type label");
assert(tools.addressTypeLabel("ltc_p2tr") === "Taproot", "a future Litecoin taproot row uses the donor label");

// Display grouping: every BTC row shares one Chain cell; EVM sub-rows and the
// generic 0x parent each keep their own; unknown families do not collapse.
assert(tools.rowGroup("btc_p2pkh") === "btc" && tools.rowGroup("btc_p2tr") === "btc", "BTC rows group");
assert(tools.rowGroup("ltc_p2wpkh") === "ltc" && tools.rowGroup("zcash_p2pkh") === "zcash", "family grouping");
assert(tools.rowGroup("evm") === "evm" && tools.rowGroup("evm_bnb") === "evm_bnb", "EVM rows keep separate groups");
assert(tools.rowGroup("evm_parent") === "evm_parent", "the shared parent is its own group");
assert(tools.rowFamily("evm_bnb") === "evm" && tools.rowFamily("evm_parent") === "evm", "EVM family for ordering");

// Key rows print the canonical native unit: the four L2s settle in ETH, not
// in a network short name, and the decimals come from data/chains.json.
for (const id of ["evm", "evm_arbitrum", "evm_optimism", "evm_base", "evm_zksync"]) {
  assert(tools.chainMeta(id).ticker === "ETH", `${id} key row prints ETH`);
  assert(tools.chainMeta(id).decimals === 18, `${id} key row uses 18 decimals`);
}
assert(tools.chainMeta("evm_bnb").ticker === "BNB", "BNB key row prints BNB");
assert(tools.chainMeta("evm_polygon").ticker === "POL", "Polygon key row prints POL");
assert(tools.chainMeta("tron").ticker === "TRX" && tools.chainMeta("tron").decimals === 6, "TRON unit");
assert(tools.chainMeta("ton_w5").icon === "chain-ton", "the W5 row keeps the TON icon");
assert(tools.chainUnit("bitcoin").symbol === "BTC" && tools.chainUnit("bitcoin").decimals === 8, "BTC unit");
assert(tools.chainSlug("evm_arbitrum") === "arbitrum" && tools.chainSlug("btc_p2tr") === "bitcoin", "row id -> slug");

// Donor order: BTC, EVM, TRX, SOL, TON, SUI, XRP, LTC, BCH, DOGE, ZEC.
const ORDER_IDS = ["zcash_p2pkh", "btc_p2wpkh", "doge_p2pkh", "evm", "tron", "ltc_p2pkh", "sui", "xrp_classic", "solana", "bch_legacy", "ton", "btc_p2pkh"];
const ordered = tools.orderAddressRows(ORDER_IDS.map((id) => ({ id }))).map((row) => row.id);
assert(
  ordered.join(",") === "btc_p2wpkh,btc_p2pkh,evm,tron,solana,ton,sui,xrp_classic,ltc_p2pkh,bch_legacy,doge_p2pkh,zcash_p2pkh",
  `address order ${ordered.join(",")}`,
);

// Rowspan runs count visible rows only; filtering two BTC rows out of five
// gives a span of 3, and a chain cell is shown only on the run's first row.
const SPAN_ROWS = [
  { group: "btc", visible: true },
  { group: "btc", visible: false },
  { group: "btc", visible: true },
  { group: "btc", visible: true },
  { group: "btc", visible: false },
  { group: "evm_parent", visible: true },
  { group: "evm", visible: true },
  { group: "evm_bnb", visible: false },
  { group: "tron", visible: true },
];
const spans = tools.groupAddressRows(SPAN_ROWS).map((entry) => entry.span);
assert(spans.join(",") === "3,0,0,0,0,1,1,0,1", `rowspans ${spans.join(",")}`);
const allVisible = tools.groupAddressRows([
  { group: "btc", visible: true },
  { group: "btc", visible: true },
  { group: "btc", visible: true },
  { group: "btc", visible: true },
  { group: "btc", visible: true },
]);
assert(allVisible[0].span === 5 && allVisible.slice(1).every((entry) => entry.span === 0), "BTC span is 5");

// Counters: Has balance counts chain groups (not addresses); Active also
// counts a zero-balance row with an activity signal; Checked counts a chain
// group once every visible row is done. Rows without a provider are done
// immediately, so a key page can reach 18/18; the denominator is 18.
const counters = tools.balanceCounters([
  { chain: "btc", state: "ok", amount: 5n, active: true, checkable: true, visible: true },
  { chain: "btc", state: "ok", amount: 0n, active: false, checkable: true, visible: true },
  { chain: "evm", state: "ok", amount: "5", active: true, checkable: true, visible: true },
  { chain: "evm_bnb", state: "ok", amount: 0n, active: false, checkable: true, visible: true },
  { chain: "tron", state: "err", amount: undefined, checkable: true, visible: true },
  { chain: "xrp", state: "off", amount: undefined, checkable: false, visible: true },
  { chain: "btc", state: "ok", amount: 9n, checkable: true, visible: false },
], 18);
assert(counters.withBalance === 2, `two funded chain groups, got ${counters.withBalance}`);
assert(counters.activeChains === 2, `two active chain groups, got ${counters.activeChains}`);
assert(counters.checked === 5 && counters.total === 18, `5/18 settled chain groups, got ${counters.checked}/${counters.total}`);

// Every chain group done: checkable rows at ok/err and provider-less rows
// count as done, which is the 18/18 donor state.
const allDone = [];
for (let index = 0; index < 18; index += 1) {
  allDone.push({ chain: `chain_${index}`, state: index % 2 ? "err" : "ok", checkable: true, visible: true });
}
assert(tools.balanceCounters(allDone, 18).checked === 18, "eighteen settled groups reach 18/18");
const allNoProvider = [];
for (let index = 0; index < 18; index += 1) {
  allNoProvider.push({ chain: `chain_${index}`, state: "off", checkable: false, visible: true });
}
assert(
  tools.balanceCounters(allNoProvider, 18).checked === 18,
  "provider-less rows count as done immediately"
);
const partiallyDone = tools.balanceCounters([
  { chain: "ltc", state: "off", checkable: false, visible: true },
  { chain: "ltc", state: "off", checkable: false, visible: true },
  { chain: "solana", state: "ok", checkable: true, visible: true },
  { chain: "sui", state: "loading", checkable: true, visible: true },
], 18);
assert(partiallyDone.checked === 2, `two of three groups done, got ${partiallyDone.checked}`);

const activeEmpty = tools.balanceCounters([
  { chain: "tron", state: "ok", amount: 0n, active: true, checkable: true, visible: true },
]);
assert(activeEmpty.activeChains === 1 && activeEmpty.withBalance === 0, "activity without balance counts as active only");

const unchecked = tools.balanceCounters([
  { chain: "btc", state: "ok", amount: 0n, checkable: true, visible: true },
  { chain: "btc", state: "loading", amount: undefined, checkable: true, visible: true },
]);
assert(unchecked.checked === 0, "a loading row keeps its chain group unchecked");
assert(unchecked.total === 18, "the Checked denominator is the fixed 18 chain groups");

// Balance line: decimals and symbol come from the summary. The row text and
// the title are built by the same function, so a TRX balance cannot use 18
// decimals while its title uses 6.
assertEqual(
  tools.formatAtomic({ amount: 10343145665n, decimals: 6, symbol: "TRX" }),
  "10343.145665 TRX",
  "TRX uses 6 decimals from the summary"
);
assertEqual(
  tools.formatAtomic({ amount: 10343145665n, decimals: 18, symbol: "TRX" }),
  "0.000000010343145665 TRX",
  "the same atomic amount at 18 decimals is the regression value"
);
assertEqual(
  tools.balanceLine(
    { amount: 10343145665n, decimals: 6, symbol: "TRX", txs: 1122 },
    { lastTxAge: "2h ago" }
  ),
  "10343.145665 TRX · 1122 tx · last 2h ago",
  "TRX line carries the tx count and last-tx age"
);
assertEqual(
  tools.balanceLine({ amount: 1234567890n, decimals: 9, symbol: "SOL" }),
  "1.23456789 SOL",
  "SOL uses 9 decimals"
);
assertEqual(
  tools.balanceLine({ amount: 1234567n, decimals: 6, symbol: "XRP", txs: 4 }),
  "1.234567 XRP · 4 tx",
  "XRP uses 6 decimals and keeps the tx count"
);
assertEqual(
  tools.balanceLine({ amount: 1000000000000000000n, decimals: 18, symbol: "ETH", nonce: 3 }),
  "1 ETH · nonce 3",
  "EVM lines use 18 decimals and the nonce"
);
assertEqual(
  tools.balanceLine({ amount: 100000000000n, decimals: 9, symbol: "TON" }),
  "100 TON",
  "TON uses 9 decimals"
);
assertEqual(
  tools.balanceLine({ amount: 0n, decimals: 6, symbol: "TRX", txs: 1122 }, { lastTxAge: "2h ago" }),
  "0 TRX · 1122 tx · last 2h ago",
  "a zero TRX balance still carries the activity"
);
assertEqual(
  tools.balanceLine({ amount: 0n, decimals: 6, symbol: "TRX", note: "account not activated" }),
  "0 TRX · account not activated",
  "a provider note is part of the same line"
);

// ------------------------------------------------------ both-curve row merge
// The donor derives every 32-byte value on both curves, so the key page table
// always carries the secp256k1 rows (plus the JS CashAddr/uncompressed rows)
// and the ed25519-only rows SOL, SUI and both TON wallets: exactly 30 rows
// after the EVM parent is expanded into its eight networks.
const codecs = require("./address-codecs.js");
const tonV4R2 = {
  id: "ton",
  label: "TON wallet v4R2",
  address: "EQD4rL6q6f4vP7d8c8n7t6n5f4d3s2a1q0p9o8i7u6y5t4r3e2w1q",
  steps: {},
  curve: "ed25519",
};
const codecRows = Object.values(codecs.derive(secpReport)).filter(Boolean);
assert(codecRows.length === 3, `three JS-encoded secp rows, got ${codecRows.length}`);
const mergedRows = tools.mergeCurveAddresses(secpReport, edReport, {
  secp: codecRows,
  ed25519: [tonV4R2],
});
const EVM_NETWORKS = [
  "evm", "evm_bnb", "evm_arbitrum", "evm_optimism",
  "evm_base", "evm_polygon", "evm_avalanche", "evm_zksync",
].map((id) => ({ id, label: id }));
const displayRows = tools.orderAddressRows(
  tools.expandEvmAddresses(mergedRows, EVM_NETWORKS, "EVM (shared 0x address)"),
);
const displayIds = displayRows.map((row) => row.id);
const EXPECTED_IDS = [
  "btc_p2pkh", "btc_p2pkh_uncompressed", "btc_p2sh_p2wpkh", "btc_p2wpkh", "btc_p2tr",
  "evm_parent", "evm", "evm_bnb", "evm_arbitrum", "evm_optimism",
  "evm_base", "evm_polygon", "evm_avalanche", "evm_zksync",
  "tron", "solana", "ton", "ton_w5", "sui", "xrp_classic",
  "ltc_p2pkh", "ltc_p2sh_p2wpkh", "ltc_p2wpkh", "ltc_p2tr",
  "bch_legacy", "bch_cashaddr", "doge_p2pkh", "doge_p2pkh_uncompressed",
  "zcash_p2pkh", "zcash_p2pkh_uncompressed",
];
assert(displayIds.length === 30, `donor table has 30 rows, got ${displayIds.length}`);
assert(
  displayIds.join(",") === EXPECTED_IDS.join(","),
  `merged row order ${displayIds.join(",")}`,
);
assert(new Set(displayIds).size === displayIds.length, "merged row ids are unique");
assert(
  displayRows.find((row) => row.id === "btc_p2pkh").curve === "secp256k1",
  "BTC row is tagged secp256k1",
);
for (const id of ["solana", "sui", "ton", "ton_w5"]) {
  assert(displayRows.find((row) => row.id === id).curve === "ed25519", `${id} is tagged ed25519`);
}
// One chain group per donor chain: 11 families + eight EVM networks, with the
// 0x parent and the TON V4R2/W5 pair not double-counted.
const chainGroups = new Set(displayRows.map((row) => tools.counterChainKey(row.id)).filter(Boolean));
assert(chainGroups.size === 18, `18 chain groups, got ${chainGroups.size}`);
assert(tools.rowGroup("ton") === "ton" && tools.rowGroup("ton_w5") === "ton", "TON rows share a chain cell");

// An out-of-range secp256k1 value has no secp report; the ed25519 rows and
// their curves still render and are the only rows.
const edOnlyRows = tools.mergeCurveAddresses(null, edReport, { ed25519: [tonV4R2] });
assert(edOnlyRows.length === 4, `out-of-range value renders 4 ed25519 rows, got ${edOnlyRows.length}`);
assert(edOnlyRows.every((row) => row.curve === "ed25519"), "out-of-range rows are all ed25519");

// ------------------------------------------------------------- USD prices
// Chain -> ticker. EVM L2s settle in ETH; BNB/Polygon/Avalanche keep their own
// coin, and the donor's supported set maps one ticker per symbol.
assert(tools.tickerFor("bitcoin") === "BTC" && tools.tickerFor("btc") === "BTC", "BTC ticker");
assert(
  ["eth", "ethereum", "arbitrum", "optimism", "base", "zksync"].every((chain) => tools.tickerFor(chain) === "ETH"),
  "EVM L2s price in ETH",
);
assert(tools.tickerFor("bnb") === "BNB", "BNB ticker");
assert(tools.tickerFor("polygon") === "POL", "Polygon ticker");
assert(tools.tickerFor("avalanche") === "AVAX", "Avalanche ticker");
assert(tools.tickerFor("TRX") === "TRX" && tools.tickerFor("tron") === "TRX", "TRON ticker");
assert(tools.tickerFor("unknown-chain") === "", "unknown chains have no ticker");
assert(
  tools.tickerList().join(",") ===
    "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,TRXUSDT,LTCUSDT,DOGEUSDT,BCHUSDT,XRPUSDT,ZECUSDT,POLUSDT,AVAXUSDT,TONUSDT,SUIUSDT",
  `ticker list ${tools.tickerList().join(",")}`,
);
assert(
  tools.priceRequestUrl().startsWith("https://api.binance.com/api/v3/ticker/price?symbols="),
  "price request targets the public Binance ticker",
);
const parsedPrices = tools.parsePriceResponse([
  { symbol: "BTCUSDT", price: "60000.50" },
  { symbol: "POLUSDT", price: "0.50" },
  { symbol: "NOPEUSDT", price: "1" },
  { symbol: "ETHUSDT", price: "0" },
]);
assert(parsedPrices.BTC === "60000.50" && parsedPrices.POL === "0.50", "supported prices kept");
assert(!("NOPE" in parsedPrices) && !("ETH" in parsedPrices), "unsupported and non-positive prices dropped");

// Atomic -> cents with BigInt at 6, 8 and 18 decimals. No float path.
assert(tools.atomicToCents(100000000n, 8, tools.priceScaled("60000")) === 6000000n, "1 BTC at 60k");
assert(
  tools.atomicToCents(1500000000000000000n, 18, tools.priceScaled("3000")) === 450000n,
  "1.5 ETH at 3k",
);
assert(tools.atomicToCents(2000000n, 6, tools.priceScaled("0.25")) === 50n, "2 TRX at 0.25");
assert(tools.atomicToCents(1n, 8, tools.priceScaled("1")) === 0n, "sub-cent amounts round to zero cents");
assert(tools.atomicToCents(1n, 8, tools.priceScaled("0")) === null, "a zero price is not usable");

// Missing price excludes the row; it must never be counted as zero. Included
// stays 2 and the total is the two priced rows only.
const fiat = tools.fiatTotals(
  [
    { chain: "btc", symbol: "BTC", amount: "150000000", decimals: 8 },
    { chain: "tron", symbol: "TRX", amount: "2000000", decimals: 6 },
    { chain: "solana", symbol: "SOL", amount: "123", decimals: 9 },
    { chain: "eth", symbol: "ETH", amount: null, decimals: 18 },
  ],
  { BTC: "60000", TRX: "0.25" },
);
assert(fiat.included === 2, `two priced rows, got ${fiat.included}`);
assert(fiat.noPrice === 1 && fiat.noBalance === 1, "missing price and missing balance are counted separately");
assert(fiat.cents === 9000050n, `priced total is 9000050 cents, got ${fiat.cents}`);
assert(tools.formatUsd(fiat.cents) === "$90,000.50", `formatted ${tools.formatUsd(fiat.cents)}`);
assert(tools.formatUsd(123456789n) === "$1,234,567.89", "thousands separators");
assert(tools.formatUsd(0n) === "$0.00", "zero dollars");

// Cache: fresh inside six hours, stale at the boundary, missing without prices.
const TTL = 6 * 60 * 60 * 1000;
const NOW = 1700000000000;
assert(tools.priceCacheState(null, NOW, TTL) === "missing", "no cache is missing");
assert(
  tools.priceCacheState({ prices: {}, fetchedAt: NOW - 1 }, NOW, TTL) === "missing",
  "an entry without prices is missing",
);
assert(
  tools.priceCacheState({ prices: { BTC: "1" }, fetchedAt: NOW - 1000 }, NOW, TTL) === "fresh",
  "a recent entry is fresh",
);
assert(
  tools.priceCacheState({ prices: { BTC: "1" }, fetchedAt: NOW - TTL + 1 }, NOW, TTL) === "fresh",
  "the last fresh millisecond",
);
assert(
  tools.priceCacheState({ prices: { BTC: "1" }, fetchedAt: NOW - TTL }, NOW, TTL) === "stale",
  "the TTL boundary is stale",
);
assert(
  tools.priceCacheState({ prices: { BTC: "1" }, fetchedAt: NOW + 5000 }, NOW, TTL) === "fresh",
  "clock skew stays fresh",
);
assert(
  tools.formatPriceTime(Date.UTC(2026, 10, 21, 14, 3)) === "2026-11-21 14:03 UTC",
  "price timestamp is UTC",
);

// ZEC: SoChain v3 returns decimal coin strings, not satoshis. The parser must
// convert without floats and reject anything that is not unsigned decimal.
// The route-level detector for the wired row is `key-zec-provider` in
// scripts/ui-audit.mjs; these assertions pin the amount conversion.
const zecZero = tools.parseSochainBalance({
  status: "success",
  data: { confirmed: "0.00000000", unconfirmed: "0.00000000" },
});
assert(zecZero && zecZero.confirmed === 0n && zecZero.unconfirmed === 0n, "zero ZEC balance is 0 sat");
const zecOne = tools.parseSochainBalance({
  status: "success",
  data: { confirmed: "1.23456789", unconfirmed: "0.00000000" },
});
assert(zecOne && zecOne.confirmed === 123456789n, `1.23456789 ZEC is 123456789 sat, got ${zecOne && zecOne.confirmed}`);
assert(
  tools.parseSochainBalance({ status: "success", data: { confirmed: "lots", unconfirmed: "0" } }) === null,
  "non-numeric ZEC amount is rejected",
);
assert(tools.parseSochainBalance({ status: "fail", data: {} }) === null, "failed ZEC response is rejected");

// Every chain row keeps an explorer link, including each shared-EVM network.
for (const id of ["evm", "evm_bnb", "evm_arbitrum", "evm_optimism", "evm_base", "evm_polygon", "evm_avalanche", "evm_zksync"]) {
  const url = tools.explorerFor(id);
  assert(typeof url === "string" && url.startsWith("https://") && url.length > "https://".length, `EVM explorer for ${id}, got ${url}`);
}
for (const id of ["btc_legacy", "zcash_p2pkh", "tron"]) {
  const url = tools.explorerFor(id);
  assert(typeof url === "string" && url.startsWith("https://"), `explorer for ${id}, got ${url}`);
}

console.log(
  "key-tools ok: integer, fragments, pubkey report/add/subtract/multiply, scrypt+pbkdf2 keystore (16/32-byte MAC), " +
    "JSON parser (64-hex MAC, array kdfparams), key facts (HEX/Decimal/WIF/WIF-u/Keypair/XRP/PubKey/Page), " +
    "row order/grouping/type labels, both-curve 30-row merge, chain-group counters, USD ticker math/cache, " +
    "ZEC SoChain amounts, explorer URLs",
);
