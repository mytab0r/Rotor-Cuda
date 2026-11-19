// Tests for the seed studio engine: BIP39/BIP32, Electrum standard/segwit seed
// versions, and the legacy 1626-word Electrum scheme.
//
// Usage: node apps/site/seed-test.mjs [apps/site/rotor_wasm.wasm]

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const wasmPath = process.argv[2] ?? fileURLToPath(new URL("./rotor_wasm.wasm", import.meta.url));

globalThis.window = globalThis;
require("./seed.js");
const crypto = require("./seed-crypto.js");

const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), {});
const wasm = instance.exports;
const decoder = new TextDecoder("utf-8");

function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function reportFor(keyHex) {
  const bytes = hexToBytes(keyHex);
  const pointer = wasm.alloc(bytes.length) >>> 0;
  if (!pointer) throw new Error("wasm alloc returned 0");
  try {
    new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
    const status = wasm.derive_report(pointer, 0) >>> 0;
    if (status !== 0) {
      throw new Error(decoder.decode(
        new Uint8Array(wasm.memory.buffer, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0)
      ));
    }
    return JSON.parse(decoder.decode(
      new Uint8Array(wasm.memory.buffer, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0)
    ));
  } finally {
    wasm.dealloc(pointer, bytes.length);
  }
}

function addressOf(report, id) {
  const row = (report.addresses || []).find((entry) => entry.id === id);
  return row ? row.address : "";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}\n  expected: ${expected}\n  actual:   ${actual}`);
}

async function pubkeyFor(keyHex) {
  const report = reportFor(keyHex);
  return hexToBytes(report.pubkey_compressed);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/* ------------------------------------------------------------------ sha256 */

test("sha256 matches the published NIST vectors", () => {
  assertEqual(
    bytesToHex(crypto.sha256(crypto.utf8(""))),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "empty string"
  );
  assertEqual(
    bytesToHex(crypto.sha256(crypto.utf8("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "abc"
  );
  assertEqual(
    bytesToHex(crypto.sha256d(crypto.utf8("hello"))),
    "9595c9df90075148eb06860365df33584b75bff782a510c6cd4883a419833d50",
    "sha256d"
  );
});

/* --------------------------------------------------------------- electrum */

test("Electrum old word encode/decode matches the Electrum test vector", () => {
  const seedHex = "8edad31a95e7d59f8837667510d75a4d";
  const words = "hardly point goal hallway patience key stone difference ready caught listen fact";
  assertEqual(crypto.oldEncode(seedHex), words, "mn_encode");
  assertEqual(crypto.oldDecode(words), seedHex, "mn_decode");
  assertEqual(crypto.validateOld(words).seedHex, seedHex, "validateOld");
});

test("Electrum old derivation matches the legacy stretch/sequence reference", async () => {
  const seedHex = "8edad31a95e7d59f8837667510d75a4d";
  const derived = await crypto.oldPrivateKeys(seedHex, 2, async (keyHex) => reportFor(keyHex));
  assertEqual(
    derived.keys[0],
    "b4a12467fd7e8d0e193aa27b31a0368289f0b536892ab567aeb52b59249acbe8",
    "old address 0 private key"
  );
  assertEqual(
    addressOf(reportFor(derived.keys[0]), "btc_p2pkh_uncompressed"),
    "1ArkKc14Smo7Dw7vyrZuX6DkqYvZAp8XXk",
    "old address 0"
  );
  assertEqual(
    addressOf(reportFor(derived.keys[1]), "btc_p2pkh_uncompressed"),
    "1G4erbznYaPjY92NgF17osUnDMP8jUBZQB",
    "old address 1"
  );
});

test("Electrum old generation produces canonical 12/24 word phrases", () => {
  for (const count of [12, 24]) {
    const phrase = crypto.generateOld(count);
    const info = crypto.validateOld(phrase);
    assertEqual(info.words.length, count, `${count}-word phrase length`);
    assertEqual(crypto.oldEncode(info.seedHex), info.words.join(" "), "round trip");
  }
});

test("Electrum seed versions match the Electrum test vectors", async () => {
  const segwit = "wild father tree among universe such mobile favorite target dynamic credit identify";
  const standard = "cram swing cover prefer miss modify ritual silly deliver chunk behind inform able";
  const segwit2 = "frost pig brisk excite novel report camera enlist axis nation novel desert";
  assertEqual(await crypto.electrumSeedType(segwit), "segwit", "wild father type");
  assertEqual(await crypto.electrumSeedType(standard), "standard", "cram swing type");
  assertEqual(await crypto.electrumSeedType(segwit2), "segwit", "frost pig type");
  assertEqual(await crypto.electrumSeedType("abandon ".repeat(11) + "about"), "", "plain BIP39 is not an Electrum seed");

  const master = await crypto.electrumSeed(segwit, "");
  assertEqual(
    bytesToHex(master),
    "aac2a6302e48577ab4b46f23dbae0774e2e62c796f797d0a1b5faeb528301e3064342dafb79069e7c4c6b8c38ae11d7a973bec0d4f70626f8cc5184a8d0b0756",
    "Electrum master seed"
  );
  const withPassphrase = await crypto.electrumSeed(
    segwit,
    "Did you ever hear the tragedy of Darth Plagueis the Wise?"
  );
  assertEqual(
    bytesToHex(withPassphrase),
    "4aa29f2aeb0127efb55138ab9e7be83b36750358751906f86c662b21a1ea1370f949e6d1a12fa56d3d93cadda93038c76ac8118597364e46f5156fde6183c82f",
    "Electrum master seed with passphrase"
  );
});

/* ------------------------------------------------------------------ bip39 */

test("the seed bundle exposes the BIP39 wordlist for Electrum word checks", () => {
  assert(Array.isArray(window.RotorSeed.wordlist), "RotorSeed.wordlist must be an array");
  assertEqual(window.RotorSeed.wordlist.length, 2048, "BIP39 English word count");
  assertEqual(window.RotorSeedCrypto.bip39Words().length, 2048, "bip39Words()");
});

test("BIP39 key 1 vector: abandon…about -> 1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA", async () => {
  const phrase = "abandon ".repeat(11) + "about";
  assert(window.RotorSeed.validate(phrase), "phrase must be a valid BIP39 mnemonic");
  const seed = await crypto.bip39Seed(phrase, "");
  const key = await crypto.bip32PrivateKey(seed, "m/44'/0'/0'/0/0", pubkeyFor);
  assertEqual(
    key,
    "e284129cc0922579a535bbf4d1a3b25773090d28c909bc0fed73b5e0222cc372",
    "private key"
  );
  assertEqual(
    addressOf(reportFor(key), "btc_p2pkh"),
    "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA",
    "address"
  );
});

test("BIP39 BIP32 derivation matches the bundled scure implementation", async () => {
  const phrase = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  const seed = await crypto.bip39Seed(phrase, "TREZOR");
  for (const path of ["m/44'/0'/0'/0/0", "m/49'/0'/0'/0/4", "m/84'/0'/0'/1/7", "m/86'/0'/0'/0/2"]) {
    const ours = await crypto.bip32PrivateKey(seed, path, pubkeyFor);
    const bundled = window.RotorSeed.derive(phrase, "TREZOR", path);
    assertEqual(ours, bundled, `BIP32 ${path}`);
  }
});

test("BIP39 generation honours all five word counts", () => {
  for (const count of [12, 15, 18, 21, 24]) {
    const phrase = crypto.generateBip39(count);
    assertEqual(phrase.split(" ").length, count, `${count}-word phrase`);
    assert(window.RotorSeed.validate(phrase), `${count}-word checksum`);
  }
});

test("Electrum BIP39 generation yields a standard seed-version phrase", async () => {
  const phrase = await crypto.generateElectrumBip39(12);
  assertEqual(phrase.split(" ").length, 12, "word count");
  assertEqual(await crypto.electrumSeedType(phrase), "standard", "seed version");
  assert(window.RotorSeed.validate(phrase), "BIP39 wordlist/checksum");
});

/* ---------------------------------------------------------------- runner */

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(`  ${error && error.message ? error.message : error}`);
  }
}
if (failed) {
  console.error(`\n${failed} of ${tests.length} tests failed`);
  process.exit(1);
}
console.log(`\nall ${tests.length} seed studio tests passed`);
