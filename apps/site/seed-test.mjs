// Tests for the seed studio engine: BIP39/BIP32, Electrum standard/segwit seed
// versions, and the legacy 1626-word Electrum scheme.
//
// Usage: node apps/site/seed-test.mjs [apps/site/rotor_wasm.wasm]

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
require("./chains.generated.js");
require("./amount.js");
const wasmPath = process.argv[2] ?? fileURLToPath(new URL("./rotor_wasm.wasm", import.meta.url));

globalThis.window = globalThis;
require("./seed.js");
const crypto = require("./seed-crypto.js");

// The page script early-returns when the form is absent; these tests only use
// the pure helpers it exposes before that DOM check.
globalThis.document = { getElementById: () => null };
require("./seed-page.js");
const page = globalThis.RotorSeedPage;

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

async function assertRejects(fn, pattern, message) {
  try {
    await fn();
  } catch (error) {
    const text = error && error.message ? error.message : String(error);
    assert(pattern.test(text), `${message}: unexpected error "${text}"`);
    return;
  }
  throw new Error(`${message}: expected a rejection`);
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
    "490aa18749841c21f4ece6da50898645578736ce0e38cd67568c14e3c47c9d95",
    "old address 0 private key"
  );
  assertEqual(
    addressOf(reportFor(derived.keys[0]), "btc_p2pkh_uncompressed"),
    "18v3oDeH9LCmeKrbC2nYgLP5UKva1NpMG",
    "old address 0"
  );
  assertEqual(
    addressOf(reportFor(derived.keys[1]), "btc_p2pkh_uncompressed"),
    "1BDoTF94QViEdnNuL4n6gQ8LgihBNCwXDT",
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

test("Electrum BIP39 validation accepts native standard and segwit word counts", async () => {
  const standard = await crypto.validateElectrumBip39(
    "cram swing cover prefer miss modify ritual silly deliver chunk behind inform able"
  );
  assertEqual(standard.seedType, "standard", "13-word standard seed type");
  assertEqual(standard.words.length, 13, "13-word standard length");

  const segwit = await crypto.validateElectrumBip39(
    "wild father tree among universe such mobile favorite target dynamic credit identify"
  );
  assertEqual(segwit.seedType, "segwit", "12-word segwit seed type");
  assertEqual(segwit.words.length, 12, "12-word segwit length");
});

test("Electrum BIP39 validation rejects BIP39-only, 2FA and short phrases", async () => {
  await assertRejects(
    () => crypto.validateElectrumBip39("abandon ".repeat(11) + "about"),
    /not an Electrum BIP39 seed/,
    "plain BIP39 phrase"
  );
  await assertRejects(
    () => crypto.validateElectrumBip39("science dawn member doll dutch real can brick knife deny drive list"),
    /2FA/,
    "2FA seed version"
  );
  await assertRejects(() => crypto.validateElectrumBip39(""), /at least two words/, "empty phrase");
  await assertRejects(() => crypto.validateElectrumBip39("abandon"), /at least two words/, "one word");

  assert(
    !window.RotorSeed.validate("cram swing cover prefer miss modify ritual silly deliver chunk behind inform able"),
    "a 13-word phrase must still fail BIP39 checksum validation"
  );
});

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

/* ------------------------------------------------- live counter and batches */

test("the live word counter normalizes whitespace", () => {
  assertEqual(page.countWords(""), 0, "empty phrase");
  assertEqual(page.countWords("  abandon \n ability\t"), 2, "collapsed whitespace");
  assertEqual(page.countWords("abandon ".repeat(11) + "about"), 12, "12-word phrase");
  assertEqual(page.countWords("hardly point goal hallway patience key stone difference ready caught listen fact"), 12, "Electrum old phrase");
});

test("validity hints follow the derive rules for every scheme", async () => {
  const bip39 = "abandon ".repeat(11) + "about";
  assertEqual(await page.phraseHint(bip39, "bip39"), "Valid BIP39 phrase.", "BIP39 valid");
  assertEqual(
    await page.phraseHint("abandon ".repeat(11).trim(), "bip39"),
    "BIP39 uses 12, 15, 18, 21 or 24 words.",
    "BIP39 wrong count"
  );
  assertEqual(
    await page.phraseHint("zzzz ".repeat(12).trim(), "bip39"),
    "Some words are not in the BIP39 wordlist.",
    "BIP39 unknown word"
  );
  assertEqual(
    await page.phraseHint("abandon ".repeat(12).trim(), "bip39"),
    "BIP39 checksum does not match.",
    "BIP39 checksum"
  );

  const oldPhrase = "hardly point goal hallway patience key stone difference ready caught listen fact";
  assertEqual(await page.phraseHint(oldPhrase, "electrum-old"), "Valid Electrum old phrase.", "Electrum old valid");
  assertEqual(
    await page.phraseHint("hardly point goal hallway patience key stone difference ready caught listen", "electrum-old"),
    "Electrum old phrases use 12 or 24 words.",
    "Electrum old wrong count"
  );
  assertEqual(
    await page.phraseHint("word ".repeat(12).trim(), "electrum-old"),
    "Not a valid Electrum old phrase: check the words.",
    "Electrum old unknown words"
  );

  const segwit = "wild father tree among universe such mobile favorite target dynamic credit identify";
  const standard = "cram swing cover prefer miss modify ritual silly deliver chunk behind inform able";
  assertEqual(
    await page.phraseHint(segwit, "electrum-bip39"),
    "Valid Electrum BIP39 phrase (segwit).",
    "Electrum BIP39 segwit"
  );
  assertEqual(
    await page.phraseHint(standard, "electrum-bip39"),
    "Valid Electrum BIP39 phrase (standard).",
    "Electrum BIP39 standard"
  );
  assertEqual(
    await page.phraseHint("science dawn member doll dutch real can brick knife deny drive list", "electrum-bip39"),
    "Electrum 2FA seeds are not supported here.",
    "Electrum BIP39 2FA"
  );
  assertEqual(
    await page.phraseHint(bip39, "electrum-bip39"),
    "Not an Electrum BIP39 seed-version phrase.",
    "plain BIP39 is not an Electrum seed"
  );
  assertEqual(
    await page.phraseHint("abandon", "electrum-bip39"),
    "An Electrum seed needs at least two words.",
    "Electrum BIP39 one word"
  );
});

test("the next five indices continue after the rendered count", () => {
  assertEqual(page.batchIndices(20, 5).join(","), "20,21,22,23,24", "after a 20-address batch");
  assertEqual(page.batchIndices(1, 5).join(","), "1,2,3,4,5", "after a single address");
  assertEqual(page.batchIndices(0, 5).join(","), "0,1,2,3,4", "first batch");
  assertEqual(page.batchIndices(18, 5).join(","), "18,19,20,21,22", "partial overlap is not re-derived by math");
});

test("derives 20 consecutive addresses for one BIP39 path", async () => {
  const phrase = "abandon ".repeat(11) + "about";
  const seed = await crypto.bip39Seed(phrase, "");
  const addresses = [];
  for (let index = 0; index < 20; index += 1) {
    const path = `m/44'/0'/0'/0/${index}`;
    const key = await crypto.bip32PrivateKey(seed, path, pubkeyFor);
    addresses.push(addressOf(reportFor(key), "btc_p2pkh"));
  }
  assertEqual(addresses.length, 20, "20 derived rows");
  assertEqual(addresses[0], "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA", "first vector address");
  assertEqual(new Set(addresses).size, 20, "all addresses are distinct");
  addresses.forEach((address, index) => assert(address, `address ${index} is non-empty`));
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
