// Tests for the wallet seed-phrase flow helpers: BIP39 entropy/checksum rules
// and the wallet chain -> BIP44 path presets. The generator and the validator
// come from the same seed stack the page lazy-loads; this file only pins the
// pure contract, the browser flow is covered by the UI audit.
//
// Usage: node apps/site/wallet-seed-test.mjs

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

globalThis.window = globalThis;
require("./seed.js");
const seedCrypto = require("./seed-crypto.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}\n  expected: ${expected}\n  actual:   ${actual}`);
}

function assertNotEqual(actual, expected, message) {
  if (actual === expected) throw new Error(`${message}: both values are ${actual}`);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/* --------------------------------------------------------------- entropy */

test("BIP39 entropy bits follow 32 x words / 3", () => {
  for (const [count, bits] of [[12, 128], [15, 160], [18, 192], [21, 224], [24, 256]]) {
    assertEqual(seedCrypto.entropyBitsForWords(count), bits, `${count}-word entropy bits`);
    assertEqual(seedCrypto.entropyBytesForWords(count), bits / 8, `${count}-word entropy bytes`);
  }
  assertEqual(seedCrypto.entropyBitsForWords(13), 0, "13 words are not a BIP39 length");
  assertEqual(seedCrypto.entropyBitsForWords(0), 0, "zero words");
  let threw = false;
  try {
    seedCrypto.entropyBytesForWords(13);
  } catch (error) {
    threw = /12, 15, 18, 21 or 24/.test(String(error && error.message));
  }
  assert(threw, "entropyBytesForWords must refuse a non-BIP39 length");
});

/* ------------------------------------------------------------ generation */

test("generateBip39(24) yields 24 BIP39 words with a valid checksum", () => {
  const phrase = seedCrypto.generateBip39(24);
  const words = phrase.split(" ");
  assertEqual(words.length, 24, "word count");
  for (const word of words) {
    assert(window.RotorSeed.wordlist.includes(word), `"${word}" is in the BIP39 wordlist`);
  }
  assert(window.RotorSeed.validate(phrase), "generated phrase passes the BIP39 checksum");
});

test("two generations differ (fresh OS randomness, not a fixed vector)", () => {
  const first = seedCrypto.generateBip39(24);
  const second = seedCrypto.generateBip39(24);
  assertNotEqual(first, second, "24-word generations");
});

/* -------------------------------------------------------------- validation */

test("the standard test phrase validates and a one-word change does not", () => {
  const valid = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  assert(window.RotorSeed.validate(valid), "standard abandon...about phrase");
  const changed = "ability" + valid.slice("abandon".length);
  assert(!window.RotorSeed.validate(changed), "changing one word breaks the checksum");
});

/* --------------------------------------------------------- chain -> path */

const SUPPORTED = {
  bitcoin: "m/84'/0'/0'/0/0",
  "bitcoin-testnet": "m/84'/0'/0'/0/0",
  ethereum: "m/44'/60'/0'/0/0",
  bnb: "m/44'/60'/0'/0/0",
  arbitrum: "m/44'/60'/0'/0/0",
  optimism: "m/44'/60'/0'/0/0",
  base: "m/44'/60'/0'/0/0",
  polygon: "m/44'/60'/0'/0/0",
  avalanche: "m/44'/60'/0'/0/0",
  zksync: "m/44'/60'/0'/0/0",
  litecoin: "m/84'/2'/0'/0/0",
  "bitcoin-cash": "m/44'/145'/0'/0/0",
  dogecoin: "m/44'/3'/0'/0/0",
  tron: "m/44'/195'/0'/0/0",
  xrp: "m/44'/144'/0'/0/0"
};
const REFUSED = ["zcash", "solana", "sui", "ton"];

test("the chain -> path table covers every supported wallet chain", () => {
  for (const [slug, path] of Object.entries(SUPPORTED)) {
    assertEqual(seedCrypto.seedPathFor(slug), path, `${slug} path`);
  }
  const tableKeys = Object.keys(seedCrypto.SEED_PATHS).sort();
  assertEqual(tableKeys.join(","), Object.keys(SUPPORTED).sort().join(","), "exact preset key set");
});

test("zcash, solana, sui and ton are refused, and only those", () => {
  const all = Object.keys(SUPPORTED).concat(REFUSED);
  const refused = all.filter((slug) => !seedCrypto.seedPathFor(slug));
  assertEqual(refused.join(","), REFUSED.join(","), "refused chain set");
  for (const slug of REFUSED) {
    assertEqual(seedCrypto.seedPathFor(slug), "", `${slug} has no preset`);
  }
  assertEqual(seedCrypto.seedPathFor("not-a-chain"), "", "unknown slugs are refused too");
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
console.log(`\nall ${tests.length} wallet seed tests passed`);
