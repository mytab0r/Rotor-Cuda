// Tests for apps/site/search.js: detection modes, public-row shaping for the
// global search modal and the CSV export.
//
// Usage: node apps/site/search-test.mjs [path/to/rotor_wasm.wasm]
//
// The real wasm artifact derives the rows; no network, no DOM and no
// dependency outside Node's standard library. The CSV assertions pin that
// private-key fields from the wasm report never reach exported rows.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import search from "./search.js";

const WASM_PATH = process.argv[2] ?? "apps/site/rotor_wasm.wasm";

const KEY1_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const KEY1_BTC = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const KEY1_EVM = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const KEY1_WIF = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
const BRAINWALLET_SHA256 =
  "c4bbcb1fbec99d65bf59d85c8cb62ee2db963f0fe106f483d9afa73bd4e39a8a";

const wasmBytes = readFileSync(WASM_PATH);
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const wasm = instance.exports;

/* ------------------------------------------------------------- detection */

const hex = await search.detect("0x" + KEY1_HEX, "hex");
assert.equal(hex.kind, "hex");
assert.equal(hex.hex, KEY1_HEX);
assert.equal((await search.detect(KEY1_HEX, "auto")).hex, KEY1_HEX);

const shortHex = await search.detect("abc", "hex");
assert.equal(shortHex.hex, "abc".padStart(64, "0"));

await assert.rejects(search.detect("f".repeat(65), "hex"), /exactly 64 characters/);
await assert.rejects(search.detect("f".repeat(65), "auto"), /exactly 64 characters/);
await assert.rejects(search.detect("xyz", "hex"), /may only contain/);

const wif = await search.detect(KEY1_WIF, "wif");
assert.equal(wif.kind, "wif");
assert.equal(wif.hex, KEY1_HEX);
assert.equal((await search.detect(KEY1_WIF, "auto")).hex, KEY1_HEX);
await assert.rejects(search.detect("not-a-wif", "wif"), /Not a WIF/);

const twelveWords = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const mnemonic = await search.detect(twelveWords, "mnemonic");
assert.equal(mnemonic.kind, "mnemonic");
assert.equal(mnemonic.phrase, twelveWords);

const phrase = "correct horse battery staple";
const brainwallet = await search.detect(phrase, "auto");
assert.equal(brainwallet.kind, "brainwallet");
assert.equal(brainwallet.hex, BRAINWALLET_SHA256);
assert.equal((await search.detect(phrase, "brainwallet")).hex, BRAINWALLET_SHA256);
/* The same 12 lower-case words can be a phrase or a brainwallet. The explicit
 * selector has to win over auto-detection. */
const abandoned = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
assert.equal((await search.detect(abandoned, "auto")).kind, "mnemonic");
assert.equal((await search.detect(abandoned, "brainwallet")).kind, "brainwallet");
await assert.rejects(search.detect("not a mnemonic", "mnemonic"), /12, 15, 18, 21 or 24/);

await assert.rejects(
  search.detect("s" + "a".repeat(24), "xrp-secret"),
  /XRP family seeds/,
);
await assert.rejects(
  search.detect("not-a-secret", "xrp-secret"),
  /Not an XRP family secret/,
);

const seedJson = JSON.stringify(Array(32).fill(0));
const keypair = await search.detect(seedJson, "keypair");
assert.equal(keypair.kind, "keypair");
assert.equal(keypair.curve, "ed25519");
assert.equal(keypair.chain, "solana");
assert.equal(keypair.hex, "0".repeat(64));
assert.equal((await search.detect(seedJson, "auto")).kind, "keypair");
await assert.rejects(search.detect("[1,2]", "keypair"), /32 \(seed\) or 64/);
await assert.rejects(search.detect("[", "keypair"), /JSON is not valid/);

/* ------------------------------------------------------- result shaping */

const report = search.deriveReport(wasm, search.hexToBytes(KEY1_HEX), 0);
assert.equal(report.curve, "secp256k1");

const all = search.shapeReport(report, { chain: "", count: 10 });
assert.deepEqual(all.map((row) => row.chain), [
  "bitcoin",
  "ethereum",
  "tron",
  "xrp",
  "litecoin",
  "bitcoin-cash",
  "dogecoin",
  "zcash",
]);
assert.equal(all[0].address, KEY1_BTC);
assert.equal(all[0].type, "Legacy");
assert.equal(all[0].explorer, "https://mempool.space/address/" + KEY1_BTC);
assert.equal(all[1].address, KEY1_EVM);

assert.equal(search.shapeReport(report, { chain: "", count: 1 }).length, 1);
assert.equal(search.shapeReport(report, { chain: "", count: 3 }).length, 3);

const bitcoin = search.shapeReport(report, { chain: "bitcoin", count: 5 });
assert.equal(bitcoin.length, 5);
assert.deepEqual(bitcoin.map((row) => row.type), [
  "Legacy",
  "Legacy (uncompressed)",
  "P2SH-P2WPKH",
  "Native segwit",
  "Taproot",
]);
assert.equal(search.shapeReport(report, { chain: "bitcoin", count: 1 }).length, 1);

const bnb = search.shapeReport(report, { chain: "bnb", count: 5 });
assert.equal(bnb.length, 1);
assert.equal(bnb[0].chainLabel, "BNB");
assert.equal(bnb[0].address, KEY1_EVM);
assert.equal(bnb[0].explorer, "https://bscscan.com/address/" + KEY1_EVM);

/* The secp256k1 core reports an empty Solana row; it must not become a link. */
assert.equal(search.shapeReport(report, { chain: "solana", count: 5 }).length, 0);
assert.equal(search.shapeReport(report, { chain: "ethereum", count: 5 }).length, 1);
assert.deepEqual(search.shapeReport(null, { chain: "", count: 5 }), []);

const ed = search.deriveReport(wasm, search.hexToBytes(KEY1_HEX), 1);
assert.equal(ed.curve, "ed25519");
assert.deepEqual(search.shapeReport(ed, { chain: "", count: 10 }).map((row) => row.chain), [
  "solana",
  "sui",
]);
const ton = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
search.appendTonRow(ed, ton);
search.appendTonRow(ed, ton);
const tonRows = search.shapeReport(ed, { chain: "ton", count: 5 });
assert.equal(tonRows.length, 1);
assert.equal(tonRows[0].chainLabel, "TON");
assert.equal(tonRows[0].address, ton);
assert.equal(tonRows[0].explorer, "https://tonviewer.com/" + encodeURIComponent(ton));

/* ------------------------------------------------------------------- CSV */

const csv = search.toCsv(all);
const lines = csv.trim().split("\n");
assert.equal(lines[0], "chain,address,type,explorer");
assert.equal(lines.length, all.length + 1);
assert.equal(lines[1], `Bitcoin,${KEY1_BTC},Legacy,https://mempool.space/address/${KEY1_BTC}`);
assert.ok(!csv.includes(report.priv_hex), "CSV must not contain the private key");
assert.ok(!csv.includes(report.priv_bin), "CSV must not contain the binary key");
assert.ok(!csv.includes(report.wif_compressed), "CSV must not contain the WIF");
assert.ok(!csv.includes(report.wif_uncompressed), "CSV must not contain the raw WIF");
assert.equal(search.toCsv([]), "chain,address,type,explorer\n");

assert.equal(search.csvEscape('a,b'), '"a,b"');
assert.equal(search.csvEscape('a"b'), '"a""b"');
assert.equal(search.csvEscape("a\nb"), '"a\nb"');
assert.equal(search.csvEscape("plain"), "plain");

assert.equal(search.chainLabel("bitcoin"), "Bitcoin");
assert.equal(search.familyOf("btc_p2wpkh"), "btc");
assert.equal(search.familyOf("evm"), "evm");
assert.equal(search.shapeReport(report, { chain: "", count: 2 }).length, 5);
assert.equal(search.CHAINS.length, 18);
assert.deepEqual(search.COUNTS, [1, 3, 5, 10]);

console.log("search-test: ok");
