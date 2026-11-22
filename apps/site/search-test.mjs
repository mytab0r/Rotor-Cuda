// Tests for apps/site/search.js: detection modes, public-row shaping for the
// global search modal and the CSV export.
//
// Usage: node apps/site/search-test.mjs [path/to/rotor_wasm.wasm]
//
// The real wasm artifact derives the rows; no network, no DOM and no
// dependency outside Node's standard library. The CSV assertions pin that
// private-key fields from the wasm report never reach exported rows.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import "./chains.generated.js";
import search from "./search.js";

const require = createRequire(import.meta.url);
const tools = require("./key-tools.js");

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

/* Litecoin (0xb0) and Dogecoin (0x9e) WIFs start with T/6 and Q/6. The search
 * decodes them to the same 32-byte key as the Bitcoin WIF above. */
const doubleSha256 = async (bytes) => {
  const first = createHash("sha256").update(bytes).digest();
  return createHash("sha256").update(first).digest();
};
const keyOneBytes = Uint8Array.from(Buffer.from(KEY1_HEX, "hex"));
for (const [network, prefixes] of [
  ["litecoin", ["T", "6"]],
  ["dogecoin", ["Q", "6"]],
]) {
  const altWif = await tools.wifEncode(keyOneBytes, network, doubleSha256);
  assert.ok(prefixes.includes(altWif[0]), `${network} WIF ${altWif} must start with ${prefixes.join(" or ")}`);
  const detected = await search.detect(altWif, "auto");
  assert.equal(detected.kind, "wif", `${network} WIF is detected in auto mode`);
  assert.equal(detected.hex, KEY1_HEX, `${network} WIF decodes to the same key`);
  assert.equal((await search.detect(altWif, "wif")).hex, KEY1_HEX, `${network} WIF decodes in WIF mode`);
}

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

/* search-xrp-secret-routing: the directory search must detect an XRP secret
 * and hand it to /key/<secret>, never hash the secret text as a brainwallet.
 * Synthetic secret-shaped strings only, never a real seed. The 32-53 char
 * lengths are the range the old short regex sent to the brainwallet branch. */
const xrpSecrets = [
  "s" + "a".repeat(28),   // 29 chars, s-prefixed family seed
  "s" + "a".repeat(39),   // 40 chars, previously past the old {20,30} ceiling
  "p" + "a".repeat(52),   // 53 chars, p-prefixed bare private key
];
for (const secret of xrpSecrets) {
  const auto = await search.detect(secret, "auto");
  assert.equal(auto.kind, "xrp-secret", `${secret[0]}-prefixed ${secret.length}-char secret detects as XRP, not brainwallet`);
  assert.equal(auto.value, secret);
  assert.equal((await search.detect(secret, "xrp-secret")).kind, "xrp-secret");
}
await assert.rejects(search.resolve(xrpSecrets[0]), /XRP secrets route to \/key\/<secret>/);
await assert.rejects(search.detect("not-a-secret", "xrp-secret"), /Not an XRP secret/);

/* search-short-hex-padding: only exactly 64 hex characters (after an optional
 * 0x) are a key. A shorter hex string is brainwallet text, matching the key
 * page and the donor table; the forced HEX chip still pads short input. */
const shortHexBrainwallet = await search.detect("deadbeef", "auto");
assert.equal(shortHexBrainwallet.kind, "brainwallet", "8 hex chars are text, not a padded key");
assert.equal(
  shortHexBrainwallet.hex,
  createHash("sha256").update("deadbeef").digest("hex"),
  "the brainwallet branch hashes the short hex text",
);
assert.equal((await search.detect("0", "auto")).kind, "brainwallet", "a lone digit is text");
assert.equal((await search.detect("f".repeat(63), "auto")).kind, "brainwallet", "63 hex chars are text");
assert.equal((await search.detect("0xdeadbeef", "auto")).kind, "brainwallet", "short 0x hex is text");
assert.equal((await search.detect(KEY1_HEX, "auto")).hex, KEY1_HEX, "64 hex is a key");
assert.equal((await search.detect("0x" + KEY1_HEX, "auto")).hex, KEY1_HEX, "0x + 64 hex is a key");
assert.equal((await search.detect("deadbeef", "hex")).hex, "deadbeef".padStart(64, "0"), "the forced HEX chip pads short input");

/* search-key-href: the shared routing helper every search form uses. */
assert.equal(await search.keyHref(KEY1_HEX), "/key/" + KEY1_HEX, "a 64-hex key opens /key/<hex>");
assert.equal(
  await search.keyHref(xrpSecrets[0]),
  "/key/" + encodeURIComponent(xrpSecrets[0]),
  "an XRP secret opens /key/<secret>",
);
assert.equal(await search.keyHref(twelveWords), "/mnemonic-converter", "a mnemonic opens the converter");
await assert.rejects(search.keyHref("", "auto"), /Paste a key/);

/* A mnemonic also hands its phrase to the converter; a key must not write. */
const stored = [];
const priorSessionStorage = globalThis.sessionStorage;
globalThis.sessionStorage = { setItem: (key, value) => stored.push([key, value]) };
try {
  await search.keyHref(twelveWords);
  assert.deepEqual(stored, [["rotor-seed-phrase", twelveWords]], "the mnemonic phrase reaches session storage");
  stored.length = 0;
  await search.keyHref(KEY1_HEX);
  assert.deepEqual(stored, [], "a hex key leaves session storage untouched");
} finally {
  if (priorSessionStorage === undefined) delete globalThis.sessionStorage;
  else globalThis.sessionStorage = priorSessionStorage;
}

/* The landing address guard consults the exported XRP shape so a base58
 * secret is routed instead of being shown the address hint. */
assert.equal(typeof search.looksLikeXrpSecret, "function", "looksLikeXrpSecret is exported");
assert.equal(search.looksLikeXrpSecret("snoPBrXtMeMyMHUVTgbuqAfg1SUTb"), true, "an s-secret is recognized");
assert.equal(search.looksLikeXrpSecret(xrpSecrets[2]), true, "a p-secret is recognized");
assert.equal(search.looksLikeXrpSecret("1BoatSLRHtKNngkdXEeobR76b53LETtpyT"), false, "a BTC address is not an XRP secret");

/* ------------------------------------------------------ input counter */

assert.deepEqual(search.countLabel(""), { value: 0, unit: "chars" });
assert.deepEqual(search.countLabel("   "), { value: 0, unit: "chars" });
assert.deepEqual(search.countLabel("KwDiBf89Qg"), { value: 10, unit: "chars" });
assert.deepEqual(search.countLabel("  KwDiBf89Qg  "), { value: 10, unit: "chars" });
assert.deepEqual(search.countLabel("hello,world"), { value: 11, unit: "chars" });
assert.deepEqual(search.countLabel("abc def"), { value: 2, unit: "words" });
assert.deepEqual(search.countLabel("  a  b   c "), { value: 3, unit: "words" });

assert.equal(search.mnemonicSubtype("segwit"), "Electrum SegWit");
assert.equal(search.mnemonicSubtype("standard"), "Electrum Legacy");
assert.equal(search.mnemonicSubtype(""), "Mnemonic");
assert.equal(search.mnemonicSubtype(undefined), "Mnemonic");
assert.equal(search.mnemonicSubtype("2fa"), "Mnemonic");
assert.equal(search.mnemonicSubtype("anything"), "Mnemonic");

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

/* ------------------------------------------------------- result cards */

const cards = search.buildCards(report, ed, []);
assert.equal(cards.length, 18, `18 chains get a card, got ${cards.length}`);
assert.equal(cards[0].slug, "bitcoin");
assert.equal(cards[0].rows.length, 5, "Bitcoin card carries every wasm address type");
assert.equal(cards[0].rows[0].type, "Legacy");
assert.equal(cards[0].rows[0].address, KEY1_BTC);
assert.equal(cards[0].rows[0].explorer, "https://mempool.space/address/" + KEY1_BTC);
assert.equal(cards[0].rows[4].type, "Taproot");

const ethereumCard = cards.find((card) => card.slug === "ethereum");
assert.equal(ethereumCard.rows.length, 1, "an EVM chain card has the shared 0x row");
assert.equal(ethereumCard.rows[0].address, KEY1_EVM);
assert.equal(ethereumCard.rows[0].explorer, "https://etherscan.io/address/" + KEY1_EVM);
assert.equal(cards.find((card) => card.slug === "bnb").rows[0].explorer, "https://bscscan.com/address/" + KEY1_EVM);

const tonCard = cards.find((card) => card.slug === "ton");
assert.equal(tonCard.rows.length, 2, "the ed25519 report contributes V4R2 and W5");
assert.ok(
  tonCard.rows.some((row) => row.id === "ton_w5" && row.type === "W5"),
  "the TON card includes the W5 row",
);

assert.equal(cards.find((card) => card.slug === "solana").rows[0].type, "Solana");
assert.equal(cards.find((card) => card.slug === "sui").rows[0].type, "Sui");
assert.equal(cards.find((card) => card.slug === "xrp").rows[0].type, "Classic");
assert.deepEqual(search.buildCards(null, null, []), [], "no reports, no cards");

const codecRow = {
  id: "bch_cashaddr",
  address: "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
};
const withCodecs = search.buildCards(report, ed, [codecRow]);
const bchCard = withCodecs.find((card) => card.slug === "bitcoin-cash");
assert.equal(bchCard.rows.length, 2, "JS codec extras join the BCH card");
assert.deepEqual(bchCard.rows.map((row) => row.type), ["Legacy", "CashAddr"]);

/* The card exports hold public rows only, never a private key. */
const balanceTexts = { bitcoin: "0 BTC", ethereum: "—" };
const tsv = search.cardsToTsv(cards, balanceTexts);
const tsvLines = tsv.trim().split("\n");
assert.equal(tsvLines[0], "chain\tindex\ttype\taddress\texplorer\tbalance");
assert.equal(
  tsvLines[1],
  `Bitcoin\t#0\tLegacy\t${KEY1_BTC}\thttps://mempool.space/address/${KEY1_BTC}\t0 BTC`,
);
assert.ok(!tsv.includes(report.priv_hex), "TSV must not contain the private key");
assert.ok(!tsv.includes(report.wif_compressed), "TSV must not contain the WIF");
assert.equal(search.cardsToTsv([], {}), "chain\tindex\ttype\taddress\texplorer\tbalance\n");

const cardCsv = search.cardsToCsv(cards, balanceTexts);
const cardCsvLines = cardCsv.trim().split("\n");
assert.equal(cardCsvLines[0], "chain,index,type,address,explorer,balance");
assert.equal(
  cardCsvLines[1],
  `Bitcoin,#0,Legacy,${KEY1_BTC},https://mempool.space/address/${KEY1_BTC},0 BTC`,
);
assert.equal(cardCsvLines[2].split(",")[5], "0 BTC", "the chain balance is repeated on each row");
assert.equal(cardCsvLines[9].split(",")[5], "—", "an unknown balance stays a dash");
assert.ok(!cardCsv.includes(report.priv_hex), "CSV must not contain the private key");
assert.equal(search.cardsToCsv([], {}), "chain,index,type,address,explorer,balance\n");

const activeCards = [
  { slug: "a", rows: [{ active: true }] },
  { slug: "b", rows: [{ active: false }, { active: true }] },
  { slug: "c", rows: [{ active: false }] },
];
assert.deepEqual(search.summaryCounts(activeCards), { chains: 2, addresses: 2 });
assert.deepEqual(search.summaryCounts([]), { chains: 0, addresses: 0 });

/* ------------------------------- directory row shaping (browse.js) */

const priorWindow = globalThis.window;
const priorDocument = globalThis.document;
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
try {
  require("./balance-providers.js");
  require("./browse.js");
} finally {
  globalThis.window = priorWindow;
  globalThis.document = priorDocument;
}
const balanceProviders = globalThis.RotorBalanceProviders;
assert.ok(balanceProviders, "shared balance providers must load for the Node test");
const browse = globalThis.RotorBrowse;
assert.ok(browse, "browse row helpers must be exported for the Node test");

const legacyMap = {
  btc_p2pkh: "1Compressed",
  btc_p2pkh_uncompressed: "1Uncompressed",
  btc_p2wpkh: "bc1qexample"
};
assert.deepEqual(
  browse.addressEntriesFor("bitcoin", "legacy", legacyMap, "btc_p2pkh"),
  [
    { prefix: "c", address: "1Compressed" },
    { prefix: "u", address: "1Uncompressed" }
  ],
  "legacy rows keep both compressed and uncompressed addresses"
);
assert.deepEqual(
  browse.addressEntriesFor("bitcoin", "segwit", legacyMap, "btc_p2wpkh"),
  [{ prefix: "", address: "bc1qexample" }],
  "segwit rows have a single address"
);
assert.deepEqual(
  browse.addressEntriesFor("bitcoin", "legacy", {}, "btc_p2pkh"),
  [],
  "a missing derivation yields no address line"
);
assert.deepEqual(browse.addressEntriesFor("ethereum", "legacy", null, "evm"), [], "no map, no rows");
assert.deepEqual(
  browse.addressCellModel(browse.addressEntriesFor("bitcoin", "legacy", legacyMap, "btc_p2pkh")),
  {
    primary: { prefix: "c", address: "1Compressed" },
    extra: [{ prefix: "u", address: "1Uncompressed" }]
  },
  "the row shows one address and keeps the uncompressed form in the disclosure"
);
assert.deepEqual(
  browse.addressCellModel(browse.addressEntriesFor("bitcoin", "segwit", legacyMap, "btc_p2wpkh")),
  { primary: { prefix: "", address: "bc1qexample" }, extra: [] },
  "a single address needs no disclosure"
);
assert.deepEqual(browse.addressCellModel([]), { primary: null, extra: [] });

assert.deepEqual(browse.metricFlags({ tx: 0, received: "0" }), { hasTx: false, hasRecv: false });
assert.deepEqual(browse.metricFlags({ tx: 2, received: "5" }), { hasTx: true, hasRecv: true });
assert.deepEqual(browse.metricFlags(null), { hasTx: false, hasRecv: false });

/* The batch endpoint returns the same TRON payload as the single-address
 * route, so both paths must feed the cache and balance cell the same shape. */
assert.deepEqual(
  balanceProviders.tronValue({ chain: "tron", balance_sun: "123", tx_count: 4, last_tx_at: 1700000000000 }),
  { balance: "123", tx: 4, lastTxAt: 1700000000000 },
  "batch payload maps to the per-address value shape"
);
assert.deepEqual(
  balanceProviders.tronValue({ chain: "tron", balance_sun: null }),
  { balance: null, tx: undefined, lastTxAt: undefined },
  "a provider overflow keeps a null balance"
);
assert.equal(balanceProviders.tronValue({ balance_sun: "1" }), null, "a non-TRON payload is rejected");

/* ?key= resolves to the page containing the key (60 keys per page).
 * Short values use the hex route, so "3c" is 60 and "3d" is 61. */
assert.equal(browse.pageForHexKey("1", "100"), 1n, "key 1 is on page 1");
assert.equal(browse.pageForHexKey("0x1", "100"), 1n, "0x prefix is accepted");
assert.equal(browse.pageForHexKey("0X1", "100"), 1n, "0X prefix is accepted");
assert.equal(browse.pageForHexKey("3c", "100"), 1n, "page 1 ends at key 0x3c (60)");
assert.equal(browse.pageForHexKey("3d", "100"), 2n, "key 0x3d (61) opens page 2");
assert.equal(
  browse.pageForHexKey("0xdeadbeef", "62265476"),
  62265476n,
  "0xdeadbeef lands on the donor page 62,265,476"
);
assert.equal(browse.pageForHexKey("ffffffff", "100"), 100n, "pages are clamped to the last page");
assert.equal(browse.pageForHexKey("0", "100"), null, "zero is not a key");
assert.equal(browse.pageForHexKey("0x0", "100"), null, "0x0 is not a key");
assert.equal(browse.pageForHexKey("zzz", "100"), null, "non-hex text is not a key");
assert.equal(browse.pageForHexKey("f".repeat(65), "100"), null, "more than 64 hex digits is not a key");
assert.equal(browse.pageForHexKey("1", "0"), null, "a page range without pages is rejected");

console.log("search-test: ok");
