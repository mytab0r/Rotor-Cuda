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
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import "./chains.generated.js";
import engine from "./brainwallet-engine.js";

const require = createRequire(import.meta.url);
const keyTools = require("./key-tools.js");

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

// 2b. The engine wraps the same wasm report and picks one row per chain.
const engineReport = engine.deriveReport(wasm, key, 0);
assert.equal(engine.addressOf(engineReport, "bitcoin"), "1C7zdTfnkzmr13HfA2vNm5SJYRK6nEKyq8");
assert.equal(engine.addressOf(engineReport, "ethereum"), "0xDCCD62d450c645f6437680b8A4DaA098396DcE0e");
assert.equal(engine.addressOf(engineReport, "bitcoin", "taproot"), address(report, "btc_p2tr"));
assert.equal(engine.addressOf(engineReport, "ton"), "");

// 3. Deterministic two-word corpus and BigInt page math.
assert.equal(engine.WORDS.length, 138, "138-word list");
assert.equal(new Set(engine.WORDS).size, 138, "words are unique");
assert.equal(engine.corpusSize(), 18890n, "18,890 phrases");
assert.equal(engine.rowsPerPage(), 60n, "60 rows per page");
assert.equal(engine.totalPages(), 315n, "315 pages");
assert.equal(engine.corpusPhrase(0), "amber amber");
assert.equal(engine.corpusPhrase(1), "amber anchor");
assert.equal(engine.corpusPhrase(18889), "velvet sage");
assert.throws(() => engine.corpusPhrase(18890), /outside/);
const corpus = new Set();
for (let index = 0; index < 18890; index += 1) corpus.add(engine.corpusPhrase(index));
assert.equal(corpus.size, 18890, "corpus phrases are unique");
assert.ok([...corpus].every((phrase) => phrase.split(" ").length === 2), "two words per phrase");

const firstPage = engine.pageRows(1);
assert.equal(firstPage.length, 60);
assert.equal(firstPage[0].index, 0);
assert.equal(firstPage[0].phrase, "amber amber");
assert.equal(firstPage[59].index, 59);
const lastPage = engine.pageRows(315);
assert.equal(lastPage.length, 50, "page 315 is the 50-row tail");
assert.equal(lastPage[0].index, 18840);
assert.equal(lastPage[49].index, 18889);
assert.equal(lastPage[49].phrase, "velvet sage");
assert.equal(engine.pageRows(0).length, 60, "page 0 clamps to 1");
assert.equal(engine.pageRows(316).length, 50, "page 316 clamps to 315");
assert.equal(engine.clampPage("0"), 1n);
assert.equal(engine.clampPage("9999"), 315n);
assert.equal(engine.pagePath("bitcoin", 1), "/brainwallet/bitcoin");
assert.equal(engine.pagePath("bitcoin", 315), "/brainwallet/bitcoin/315");

// 3b. Corpus address vector: corpus[0] = "amber amber".
const corpusKey = await engine.phraseKey(engine.corpusPhrase(0), webcrypto.subtle);
assert.equal(engine.bytesToHex(corpusKey), "ac230dc638a16f96dd3492a00840e3e923b39731c115b0dc2c79344ea015636a");
const corpusReport = engine.deriveReport(wasm, corpusKey, 0);
assert.equal(
  engine.addressOf(corpusReport, "bitcoin"),
  "1FUiEHnftmmkGrZQPzMXP977N1PhTYBMcM",
  "bitcoin legacy address of corpus[0]",
);
assert.equal(
  engine.addressOf(corpusReport, "bitcoin", "segwit"),
  "bc1qnm8k3p23gscfdy79wc90wmv5d9krvcyrknyrdx",
);
assert.equal(
  engine.addressOf(corpusReport, "bitcoin", "script"),
  "3QWK7M7mwvPA8cQvaAmiMcUJDKVHqiu2DN",
);
assert.equal(
  engine.addressOf(corpusReport, "bitcoin", "taproot"),
  "bc1pfx64wlfyvadm3yfdsta8pd0wjmax6c65890tzzyal47uefqynmfqg598x6",
);
assert.equal(
  engine.addressOf(corpusReport, "ethereum"),
  "0x53652e65B2727D7dcf6A6157F6b095C9CC84d8d1",
);
assert.equal(engine.addressOf(corpusReport, "litecoin"), "LZhfVW6VyS1oXfFZa8LpfAAsaDkyaBiofr");
assert.equal(engine.addressOf(corpusReport, "dogecoin"), "DKcomYjKCBg2ork18aM5vuGiF97znooGAH");
assert.equal(
  engine.explorerFor("bitcoin", "1FUiEHnftmmkGrZQPzMXP977N1PhTYBMcM"),
  "https://mempool.space/address/1FUiEHnftmmkGrZQPzMXP977N1PhTYBMcM",
);

// 3c. Generator variants: offset 0 is the phrase key, offset 1 is key + 1.
assert.equal(engine.addToKey(engine.bytesToHex(corpusKey), 0, 0), engine.bytesToHex(corpusKey));
assert.equal(
  engine.addToKey(engine.bytesToHex(corpusKey), 1, 0),
  "ac230dc638a16f96dd3492a00840e3e923b39731c115b0dc2c79344ea015636b",
);
const secondReport = engine.deriveReport(
  wasm,
  Uint8Array.from(Buffer.from(engine.addToKey(engine.bytesToHex(corpusKey), 1, 0), "hex")),
  0,
);
assert.equal(engine.addressOf(secondReport, "bitcoin"), "1HtSU5UQoHAHnq942p5PbVpUtAn4Knq4mW");
assert.equal(engine.CHAIN_LIST.length, 18, "18 chain tabs");
assert.equal(engine.chainSlugs().includes("bitcoin-cash"), true);
assert.equal(engine.chainConfig("bitcoin").curve, 0);
assert.equal(engine.chainConfig("solana").curve, 1);
assert.equal(engine.chainConfig("ton").ton, true);
assert.equal(engine.toCsv(["a", "b"], [["x,y", 'q"z']]), 'a,b\r\n"x,y","q""z"\r\n');

// 3c. Key-cell links follow the donor. BTC and BCH use the report's 0x80 WIFs;
// LTC (0xb0) and DOGE (0x9e) are re-encoded, so their links start with T/6 and
// Q/6; ETH and TON pass no WIFs, so they keep only the hex link.
const keyHex = engineReport.priv_hex;
const sha256Double = async (bytes) => {
  const first = createHash("sha256").update(bytes).digest();
  return createHash("sha256").update(first).digest();
};
const keyBytes = Uint8Array.from(Buffer.from(keyHex, "hex"));
const btcWifs = {
  compressed: engineReport.wif_compressed,
  uncompressed: engineReport.wif_uncompressed,
};
const btcLinks = engine.keyLinksFor(keyHex, btcWifs);
assert.deepEqual(
  btcLinks,
  [
    { label: keyHex, href: "/key/" + keyHex },
    { label: "WIF(c)", href: "/key/" + btcWifs.compressed },
    { label: "WIF(u)", href: "/key/" + btcWifs.uncompressed },
  ],
  "BTC key cell links hex + both WIFs",
);
assert.deepEqual(engine.keyLinksFor(keyHex, btcWifs), btcLinks, "BCH shares the 0x80 WIFs");
for (const [network, prefixes] of [
  ["litecoin", ["T", "6"]],
  ["dogecoin", ["Q", "6"]],
]) {
  const compressed = await keyTools.wifEncode(keyBytes, network, sha256Double, true);
  const uncompressed = await keyTools.wifEncode(keyBytes, network, sha256Double, false);
  assert.ok(prefixes.includes(compressed[0]), `${network} WIF(c) prefix`);
  assert.ok(uncompressed[0] === "6" || prefixes.includes(uncompressed[0]), `${network} WIF(u) prefix`);
  assert.deepEqual(
    engine.keyLinksFor(keyHex, { compressed, uncompressed }),
    [
      { label: keyHex, href: "/key/" + keyHex },
      { label: "WIF(c)", href: "/key/" + compressed },
      { label: "WIF(u)", href: "/key/" + uncompressed },
    ],
    `${network} key cell links hex + both network WIFs`,
  );
}
assert.deepEqual(
  engine.keyLinksFor(keyHex, null),
  [{ label: keyHex, href: "/key/" + keyHex }],
  "ETH/TON keep only the hex link",
);
assert.deepEqual(engine.keyLinksFor("", btcWifs), [], "no key means no links");
assert.equal(engine.chainConfig("bitcoin").wif, true, "BTC exposes WIF links");
assert.equal(engine.chainConfig("ethereum").wif, undefined, "ETH exposes no WIF links");

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
