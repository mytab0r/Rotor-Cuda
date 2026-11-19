// Tests for the key utility tooling: the pure helpers in key-tools.js and the
// new wasm exports (public key report, point addition, keystore decryption).
//
// Usage: node apps/site/key-tools-test.mjs [apps/site/rotor_wasm.wasm]

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

const counters = tools.balanceCounters([
  { address: "A", state: "ok", amount: 5n, chain: "btc", checkable: true, visible: true },
  { address: "A", state: "ok", amount: "5", chain: "evm", checkable: true, visible: true },
  { address: "B", state: "ok", amount: 0n, chain: "evm", checkable: true, visible: true },
  { address: "C", state: "err", amount: undefined, chain: "tron", checkable: true, visible: true },
  { address: "D", state: "", amount: undefined, chain: "btc", checkable: true, visible: false },
  { address: "E", state: "off", amount: undefined, chain: "xrp", checkable: false, visible: true },
]);
assert(counters.withBalance === 1, `one unique funded address, got ${counters.withBalance}`);
assert(counters.activeChains === 2, `two funded chains, got ${counters.activeChains}`);
assert(counters.checked === 4 && counters.total === 4, `4/4 visible provider rows, got ${counters.checked}/${counters.total}`);

console.log(
  "key-tools ok: integer, fragments, pubkey report/add, scrypt+pbkdf2 keystore (16/32-byte MAC), " +
    "JSON parser (64-hex MAC, array kdfparams), key facts (HEX/DEC/WIF/WIF-u/keypair/XRP/PAGE), counters",
);
