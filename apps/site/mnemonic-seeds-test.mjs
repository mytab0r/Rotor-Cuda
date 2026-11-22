// Tests for the mnemonic seeds directory rows: the private key value chosen
// from the derivation report, its WIF link, and the icon copy wiring. The
// directory script exports these helpers before its chain guard, so they load
// under Node without a DOM.
//
// Usage: node apps/site/mnemonic-seeds-test.mjs

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
require("./chains.generated.js");
require("./amount.js");
require("./balance-cache.js");
require("./balance-providers.js");
const providers = globalThis.RotorBalanceProviders;
const scriptPath = fileURLToPath(new URL("./mnemonic-seeds.js", import.meta.url));
const browsePath = fileURLToPath(new URL("./browse.js", import.meta.url));

globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };

const clipboardWrites = [];
const fakeClipboard = {
  writeText(text) {
    clipboardWrites.push(text);
    return Promise.resolve();
  }
};
if (globalThis.navigator && globalThis.navigator.clipboard) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: fakeClipboard
  });
} else {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: fakeClipboard }
  });
}

require("./mnemonic-seeds.js");
const api = globalThis.RotorMnemonicSeeds;

const WIF = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
const HEX = "0000000000000000000000000000000000000000000000000000000000000001";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

function fakeButton(label) {
  return {
    attributes: { "aria-label": label },
    classes: [],
    classList: {
      add(name) { this.owner.classes.push(name); },
      remove(name) {
        this.owner.classes = this.owner.classes.filter((item) => item !== name);
      }
    },
    getAttribute(name) { return this.attributes[name]; },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

function button(label) {
  const value = fakeButton(label);
  value.classList.owner = value;
  return value;
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("bitcoin rows show the derived hex key", () => {
  const report = { priv_hex: HEX, wif_compressed: WIF };
  assertEqual(api.privateKeyFor("bitcoin", report), HEX, "BTC key must be the hex");
});

test("non-bitcoin rows show the derived hex", () => {
  assertEqual(
    api.privateKeyFor("ethereum", { priv_hex: HEX, wif_compressed: WIF }),
    HEX,
    "EVM key must be hex"
  );
  assertEqual(api.privateKeyFor("solana", { priv_hex: HEX }), HEX, "ed25519 key must be hex");
});

test("a missing report yields no key", () => {
  assertEqual(api.privateKeyFor("bitcoin", null), "", "no report, no key");
  assertEqual(api.privateKeyFor("bitcoin", {}), "", "empty report, no key");
});

test("every non-empty key links to the key calculator", () => {
  assertEqual(
    api.privateKeyHref("bitcoin", HEX),
    "/key/" + encodeURIComponent(HEX),
    "hex must link to /key/<hex>"
  );
  assertEqual(api.privateKeyHref("bitcoin", ""), "", "empty key has no link");
  assertEqual(
    api.privateKeyHref("ethereum", HEX),
    "/key/" + encodeURIComponent(HEX),
    "EVM hex links too"
  );
});

test("directory query omits defaults and prefers presets over paths", () => {
  assertEqual(api.directoryQuery({ bits: 128, type: "legacy", defaultType: "legacy" }), "", "defaults omitted");
  assertEqual(api.directoryQuery({ bits: 192 }), "?bits=192", "non-default word count");
  assertEqual(
    api.directoryQuery({ bits: 128, type: "segwit", defaultType: "legacy" }),
    "?type=segwit",
    "non-default address type"
  );
  assertEqual(
    api.directoryQuery({ bits: 256, type: "taproot", defaultType: "legacy", preset: "bip86", path: "m/86'" }),
    "?bits=256&type=taproot&preset=bip86",
    "preset wins over a custom path"
  );
  assertEqual(
    api.directoryQuery({ path: "m/44'/0'/0'/0/1" }),
    "?path=m%2F44%27%2F0%27%2F0%27%2F0%2F1",
    "custom path is encoded"
  );
});

test("bitcoin legacy rows keep compressed and uncompressed addresses", () => {
  const map = {
    btc_p2pkh: "1Compressed",
    btc_p2pkh_uncompressed: "1Uncompressed",
    btc_p2wpkh: "bc1qexample"
  };
  assertEqual(
    JSON.stringify(api.addressEntriesFor("bitcoin", "legacy", map, "btc_p2pkh")),
    JSON.stringify([
      { prefix: "c", address: "1Compressed" },
      { prefix: "u", address: "1Uncompressed" }
    ]),
    "legacy keeps both forms"
  );
  assertEqual(
    JSON.stringify(api.addressEntriesFor("bitcoin", "segwit", map, "btc_p2wpkh")),
    JSON.stringify([{ prefix: "", address: "bc1qexample" }]),
    "segwit has one address"
  );
  assertEqual(
    JSON.stringify(api.addressEntriesFor("bitcoin", "legacy", {}, "btc_p2pkh")),
    "[]",
    "no map entries"
  );
});

test("compact phrase keeps the first two and last word", () => {
  assertEqual(
    api.compactPhrase("abandon ability able about above absent absorb abstract absurd abuse access accident"),
    "abandon ability … accident",
    "12-word phrase is masked in the middle"
  );
  assertEqual(
    api.compactPhrase(
      "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title"
    ),
    "legal winner … title",
    "24-word phrase is masked in the middle"
  );
});

test("compact phrase normalizes whitespace", () => {
  assertEqual(api.compactPhrase("  abandon   ability\nabout  zoo "), "abandon ability … zoo", "extra whitespace is ignored");
});

test("short phrases are not masked", () => {
  assertEqual(api.compactPhrase("abandon ability zoo"), "abandon ability zoo", "no middle word to hide");
  assertEqual(api.compactPhrase("abandon"), "abandon", "one word stays whole");
  assertEqual(api.compactPhrase(""), "", "empty phrase stays empty");
  assertEqual(api.compactPhrase(undefined), "", "missing phrase stays empty");
});

test("tiny received amounts use atomic units", () => {
  assertEqual(api.receivedText(1, 8, "BTC", "bitcoin"), "1 sat", "BTC-family tiny received renders in sat");
  assertEqual(api.receivedText(5000, 8, "LTC", "litecoin"), "5000 sat", "Litecoin tiny received renders in sat");
  assertEqual(api.receivedText(1, 8, "ZEC", "zcash"), "1 zat", "Zcash tiny received renders in zat");
  assertEqual(api.receivedText(50000000, 8, "BTC", "bitcoin"), "0.5 BTC", "ordinary received keeps the coin unit");
  assertEqual(api.receivedText(10000, 8, "BTC", "bitcoin"), "0.0001 BTC", "amount at the cut keeps the coin unit");
  assertEqual(api.receivedText(0, 8, "BTC", "bitcoin"), "0", "zero received stays zero");
});

test("mnemonic-solana-balances: providerMetaFor maps only supported chains", () => {
  const solana = api.providerMetaFor("solana");
  assertEqual(solana.provider, "solana", "solana uses the Solana provider");
  assertEqual(solana.chain, "solana", "cache chain is solana");
  assertEqual(solana.decimals, 9, "lamports render with 9 decimals");
  assertEqual(solana.symbol, "SOL", "rows show the SOL symbol");
  assertEqual(
    JSON.stringify(api.providerMetaFor("zcash")),
    JSON.stringify({ provider: "sochain", chain: "zcash", decimals: 8, symbol: "ZEC" }),
    "zcash reads SoChain"
  );
  assertEqual(
    JSON.stringify(api.providerMetaFor("bitcoin")),
    JSON.stringify({ provider: "blockchain.info", chain: "bitcoin", decimals: 8, symbol: "BTC" }),
    "bitcoin meta is unchanged"
  );
});

test("mnemonic-solana-balances: one getMultipleAccounts body lists both addresses", () => {
  const body = api.solanaBatchBody(["AddrOne", "AddrTwo"]);
  assertEqual(body.jsonrpc, "2.0", "JSON-RPC envelope");
  assertEqual(body.method, "getMultipleAccounts", "one batched method");
  assertEqual(body.id, 1, "single request id");
  assertEqual(
    JSON.stringify(body.params[0]),
    JSON.stringify(["AddrOne", "AddrTwo"]),
    "both addresses in one params list"
  );
  assertEqual(body.params[1].encoding, "base64", "base64 account encoding");
  assertEqual(body.params[1].commitment, "confirmed", "confirmed commitment");
});

test("mnemonic-tron-xrp-sui-balances: providerMetaFor maps TRON, XRP and SUI", () => {
  assertEqual(
    JSON.stringify(api.providerMetaFor("bitcoin-cash")),
    JSON.stringify({ provider: "haskoin-bch", chain: "bitcoin-cash", decimals: 8, symbol: "BCH" }),
    "BCH uses the batched Haskoin provider"
  );
  assertEqual(
    JSON.stringify(api.providerMetaFor("tron")),
    JSON.stringify({ provider: "tronscan", chain: "tron", decimals: 6, symbol: "TRX" }),
    "TRON uses Tronscan"
  );
  assertEqual(
    JSON.stringify(api.providerMetaFor("xrp")),
    JSON.stringify({ provider: "xrpscan", chain: "xrp", decimals: 6, symbol: "XRP" }),
    "XRP uses XRP Scan"
  );
  assertEqual(
    JSON.stringify(api.providerMetaFor("sui")),
    JSON.stringify({ provider: "sui", chain: "sui", decimals: 9, symbol: "SUI" }),
    "SUI uses the Sui GraphQL provider"
  );
  assertEqual(
    JSON.stringify(api.providerMetaFor("litecoin")),
    JSON.stringify({ provider: "sochain", chain: "litecoin", decimals: 8, symbol: "LTC" }),
    "LTC reads SoChain per address"
  );
  assertEqual(
    JSON.stringify(api.providerMetaFor("dogecoin")),
    JSON.stringify({ provider: "sochain", chain: "dogecoin", decimals: 8, symbol: "DOGE" }),
    "DOGE reads SoChain per address"
  );
  assertEqual(
    JSON.stringify(api.providerMetaFor("zcash")),
    JSON.stringify({ provider: "sochain", chain: "zcash", decimals: 8, symbol: "ZEC" }),
    "ZEC reads SoChain per address"
  );
  assertEqual(
    JSON.stringify(api.providerMetaFor("ton")),
    JSON.stringify({ provider: "tonapi", chain: "ton", decimals: 9, symbol: "TON" }),
    "TON uses the batched TonAPI directory provider"
  );
});

test("mnemonic-utxo-balances: SoChain serves LTC, DOGE and ZEC per address", async () => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: "success",
        data: { confirmed: "1.23456789", unconfirmed: "0.00000001" }
      })
    };
  };
  try {
    const ltc = await providers.fetchProvider(api.providerMetaFor("litecoin"), ["ltcAddr"]);
    assertEqual(ltc.values.ltcAddr.balance, "123456790", "LTC decimal strings sum to satoshis");
    assertEqual(ltc.errors.ltcAddr, undefined, "a good response has no error");
    assertEqual(requests.length, 1, "one request per address");
    assert(requests[0].includes("/balance/LTC/ltcAddr"), `LTC ticker in URL, got ${requests[0]}`);

    const doge = await providers.fetchProvider(api.providerMetaFor("dogecoin"), ["dogeAddr"]);
    assertEqual(doge.values.dogeAddr.balance, "123456790", "DOGE uses the same parser");
    assert(requests[1].includes("/balance/DOGE/dogeAddr"), `DOGE ticker in URL, got ${requests[1]}`);

    const zec = await providers.fetchProvider(api.providerMetaFor("zcash"), ["zecAddr"]);
    assertEqual(zec.values.zecAddr.balance, "123456790", "ZEC uses the same parser");
    assert(requests[2].includes("/balance/ZEC/zecAddr"), `ZEC ticker in URL, got ${requests[2]}`);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("mnemonic-sochain-quota-storm: the first 429 stops the rest of the page", async () => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { ok: false, status: 429, json: async () => ({}) };
  };
  try {
    /* ZEC has no fallback, so this is the SoChain-only path the guard was
     * built for; Litecoin and Dogecoin are covered by the fallback tests. */
    const addresses = Array.from({ length: 60 }, (_, index) => `zec${index}`);
    const result = await providers.fetchProvider(api.providerMetaFor("zcash"), addresses);
    assertEqual(Object.keys(result.values).length, 0, "a 429 never yields a balance");
    assertEqual(Object.keys(result.errors).length, 60, "every row keeps the retry state");
    assert(
      requests.length <= providers.BALANCE_LIMIT * 2,
      `the exhausted quota stops the fan-out, got ${requests.length} requests for 60 rows`
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("mnemonic-ltc-sochain-fallback: a 429 serves all 60 LTC rows from litecoinspace", async () => {
  const sochainRequests = [];
  const fallbackRequests = [];
  const fallbackBase = globalThis.RotorProviders.find("litecoin", "litecoinspace").url;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.startsWith(fallbackBase + "/address/")) {
      fallbackRequests.push(text);
      const address = decodeURIComponent(text.slice((fallbackBase + "/address/").length));
      const index = Number(address.replace("ltc", ""));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          address,
          chain_stats: {
            funded_txo_sum: 100000000 + index,
            spent_txo_sum: 10000000,
            tx_count: index
          }
        })
      };
    }
    sochainRequests.push(text);
    return { ok: false, status: 429, json: async () => ({}) };
  };
  try {
    const addresses = Array.from({ length: 60 }, (_, index) => `ltc${index}`);
    const result = await providers.fetchProvider(api.providerMetaFor("litecoin"), addresses);
    assertEqual(Object.keys(result.values).length, 60, "all 60 rows resolve from the fallback");
    assertEqual(Object.keys(result.errors).length, 0, "no row keeps the retry state");
    addresses.forEach((address, index) => {
      assertEqual(
        result.values[address].balance,
        String(90000000 + index),
        "confirmed balance is funded - spent in satoshis"
      );
    });
    assert(
      sochainRequests.length <= providers.BALANCE_LIMIT * 2,
      `the exhausted quota stops the SoChain fan-out, got ${sochainRequests.length} requests`
    );
    assertEqual(fallbackRequests.length, 60, "one litecoinspace request per address");
    const expected = addresses.map(
      (address) => fallbackBase + "/address/" + encodeURIComponent(address)
    );
    assert(
      expected.every((url) => fallbackRequests.includes(url)),
      "every litecoinspace URL is the SSOT provider URL plus the address"
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("mnemonic-doge-blockcypher-batch: a SoChain 429 falls back to one BlockCypher request for all 60 rows", async () => {
  const sochainRequests = [];
  const blockcypherRequests = [];
  const blockcypherBase = globalThis.RotorProviders.find("dogecoin", "blockcypher").url;
  const litecoinSpaceBase = globalThis.RotorProviders.find("litecoin", "litecoinspace").url;
  const addresses = Array.from({ length: 60 }, (_, index) => `Ddoge${index}`);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.startsWith(blockcypherBase + "/addrs/")) {
      blockcypherRequests.push(text);
      return {
        ok: true,
        status: 200,
        json: async () => addresses.map((address, index) => ({
          address,
          balance: String(1000 + index),
          total_received: String(5000 + index),
          n_tx: index
        }))
      };
    }
    sochainRequests.push(text);
    return { ok: false, status: 429, json: async () => ({}) };
  };
  try {
    const result = await providers.fetchProvider(api.providerMetaFor("dogecoin"), addresses);
    assertEqual(Object.keys(result.values).length, 60, "all 60 rows resolve from the fallback");
    assertEqual(Object.keys(result.errors).length, 0, "no row keeps the retry state");
    addresses.forEach((address, index) => {
      assertEqual(result.values[address].balance, String(1000 + index), "balance maps by request order");
      assertEqual(result.values[address].received, String(5000 + index), "received maps by request order");
      assertEqual(result.values[address].tx, index, "tx maps by request order");
    });
    assert(
      sochainRequests.length <= providers.BALANCE_LIMIT * 2,
      `the exhausted quota stops the SoChain fan-out, got ${sochainRequests.length} requests`
    );
    assertEqual(blockcypherRequests.length, 1, "one BlockCypher request for the whole page");
    assertEqual(
      blockcypherRequests[0],
      blockcypherBase + "/addrs/" + addresses.map(encodeURIComponent).join(";") + "/balance",
      "the SSOT BlockCypher batch URL lists every address once in input order"
    );
    assert(
      sochainRequests.every((url) => !url.startsWith(litecoinSpaceBase)),
      "DOGE never calls litecoinspace"
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("mnemonic-doge-blockcypher-batch: a short batch is an error for every affected row, never zero", async () => {
  const blockcypherBase = globalThis.RotorProviders.find("dogecoin", "blockcypher").url;
  const addresses = ["DdogeA", "DdogeB", "DdogeC"];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith(blockcypherBase + "/addrs/")) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ address: addresses[0], balance: "7", total_received: "9", n_tx: 1 }]
      };
    }
    return { ok: false, status: 429, json: async () => ({}) };
  };
  try {
    const result = await providers.fetchProvider(api.providerMetaFor("dogecoin"), addresses);
    assertEqual(Object.keys(result.values).length, 0, "a short body never yields a value");
    addresses.forEach((address) => {
      assertEqual(typeof result.errors[address], "string", "every affected row keeps the retry state");
    });
    assertEqual(result.errors[addresses[0]], "unexpected response", "the honest parser error is surfaced");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("mnemonic-doge-blockcypher-batch: one address is read from the single-object form", async () => {
  const blockcypherBase = globalThis.RotorProviders.find("dogecoin", "blockcypher").url;
  const address = "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L";
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.startsWith(blockcypherBase + "/addrs/")) {
      requests.push(text);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          address,
          balance: "6223536467666",
          total_received: "4385334473843834264",
          n_tx: 1487
        })
      };
    }
    return { ok: false, status: 429, json: async () => ({}) };
  };
  try {
    const result = await providers.fetchProvider(api.providerMetaFor("dogecoin"), [address]);
    assertEqual(requests.length, 1, "one fallback request");
    assertEqual(
      requests[0],
      blockcypherBase + "/addrs/" + encodeURIComponent(address) + "/balance",
      "the SSOT single-address batch URL"
    );
    assertEqual(result.values[address].balance, "6223536467666", "the object form is parsed");
    assertEqual(result.values[address].received, "4385334473843834264", "total_received is kept");
    assertEqual(result.values[address].tx, 1487, "n_tx is kept");
    assertEqual(Object.keys(result.errors).length, 0, "no error when the provider answers");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("mnemonic-doge-blockcypher-batch: the private-key directory keeps DOGE on SoChain with a BlockCypher fallback", async () => {
  const source = await readFile(browsePath, "utf8");
  const providersSource = await readFile(
    fileURLToPath(new URL("./balance-providers.js", import.meta.url)),
    "utf8"
  );
  assert(
    source.includes("config.chain === 'dogecoin'"),
    "browse.js must still declare DOGE among the SoChain chains"
  );
  assert(
    !source.includes("provider: 'blockcypher-doge'"),
    "browse.js must not wire BlockCypher as DOGE's primary provider"
  );
  assert(
    providersSource.includes("meta.chain === 'dogecoin'") &&
      providersSource.includes("blockcypherDogeProvider(addresses)"),
    "balance-providers.js must fall back to the BlockCypher batch for DOGE"
  );
});

test("mnemonic-ltc-sochain-fallback: ZEC never calls litecoinspace", async () => {
  const requests = [];
  const fallbackBase = globalThis.RotorProviders.find("litecoin", "litecoinspace").url;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { ok: false, status: 429, json: async () => ({}) };
  };
  try {
    const result = await providers.fetchProvider(api.providerMetaFor("zcash"), ["zecAddr"]);
    assertEqual(result.values.zecAddr, undefined, "ZEC has no fallback balance");
    assertEqual(typeof result.errors.zecAddr, "string", "ZEC keeps the retry state");
    assert(
      requests.every((url) => !url.startsWith(fallbackBase)),
      "ZEC stays SoChain-only, no litecoinspace request"
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("mnemonic-utxo-balances: no page claims LTC/DOGE/ZEC unprovidable", async () => {
  const mnemonicSource = await readFile(scriptPath, "utf8");
  const browseSource = await readFile(browsePath, "utf8");
  assert(
    !mnemonicSource.includes("LTC/DOGE/ZEC stay unsupported"),
    "the old unsupported comment must be gone"
  );
  assert(
    !browseSource.includes("would exceed the keyless rate limit"),
    "the old private-key directory comment must be gone"
  );
  assert(
    mnemonicSource.includes("provider: 'sochain'") && browseSource.includes("provider: 'sochain'"),
    "both directories map the chains to SoChain"
  );
});

test("mnemonic-ton-seeds: one bulk POST maps TonAPI accounts by index", async () => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        accounts: [
          { address: "0:aaaa", balance: 100 },
          { address: "0:bbbb", balance: 0 },
          { address: "0:cccc", balance: "250" }
        ]
      })
    };
  };
  try {
    const result = await providers.fetchProvider(
      api.providerMetaFor("ton"),
      ["EQone", "EQtwo", "EQthree"]
    );
    assertEqual(requests.length, 1, "one request for the whole page");
    assertEqual(requests[0].url, "https://tonapi.io/v2/accounts/_bulk", "bulk endpoint");
    assertEqual(requests[0].options.method, "POST", "bulk uses POST");
    assertEqual(
      JSON.stringify(JSON.parse(requests[0].options.body)),
      JSON.stringify({ account_ids: ["EQone", "EQtwo", "EQthree"] }),
      "request carries the address list"
    );
    assertEqual(
      JSON.stringify(result.values),
      JSON.stringify({
        EQone: { balance: "100" },
        EQtwo: { balance: "0" },
        EQthree: { balance: "250" }
      }),
      "accounts map by request index, not by the echoed raw address"
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("mnemonic-ton-seeds: a malformed TonAPI body throws instead of zero", () => {
  function throws(fn, message) {
    let threw = false;
    try { fn(); } catch (err) { threw = true; }
    assert(threw, message);
  }
  throws(() => providers.parseTonApiAccounts(["a", "b"], { accounts: [{ balance: 1 }] }),
    "a short account list must throw");
  throws(() => providers.parseTonApiAccounts(["a"], { accounts: null }),
    "a missing accounts array must throw");
  throws(() => providers.parseTonApiAccounts(["a"], { accounts: [{}] }),
    "a missing balance must throw");
  throws(() => providers.parseTonApiAccounts(["a"], { accounts: [{ balance: "1.5" }] }),
    "a non-integer balance must throw");
});

test("mnemonic-ton-seeds: the config matches the donor path, types and presets", () => {
  const config = api.chainConfig("ton");
  assert(config, "TON must have a real config, not an unsupported state");
  assertEqual(config.unsupported, undefined, "TON must not keep an unsupported message");
  assertEqual(
    JSON.stringify(config.types.map((type) => [type.value, type.field, type.path])),
    JSON.stringify([
      ["ton", "ton", "m/44'/607'/0'"],
      ["ton_w5", "ton_w5", "m/44'/607'/0'"],
    ]),
    "the donor path serves both the v4R2 and the W5 address type"
  );
  assertEqual(
    JSON.stringify(config.presets.map((preset) => [preset.id, preset.label, preset.path])),
    JSON.stringify([
      ["master", "Master Key", "m"],
      ["tonkeeper", "Tonkeeper", "m/44'/607'/0'"],
    ]),
    "preset ids, labels and paths are identical to the donor"
  );
  assertEqual(
    JSON.stringify(api.addressEntriesFor("ton", "ton_w5", { ton: "EQv4", ton_w5: "EQw5" }, "ton_w5")),
    JSON.stringify([{ prefix: "", address: "EQw5" }]),
    "the W5 row reads the report's ton_w5 address as-is"
  );
});

test("mnemonic-ton-seeds: deriveEntry builds v4R2 through /ton.js and keeps W5 from the report", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert(
    source.includes("entry.addressMap.ton = await ton.address(report.ed_pubkey)"),
    "the v4R2 row must be built by the TON bundle, not faked"
  );
  assert(
    source.includes("script.src = window.RotorAssets && typeof window.RotorAssets.url === 'function'"),
    "the TON bundle URL must use the build-prefixed asset URL"
  );
  assert(
    source.includes("if (chain === 'ton' && !entry.addressMap.ton)"),
    "the TON augmentation must be gated to the TON page"
  );
  assert(
    !source.includes("TON mnemonic seeds need the wallet contract builder"),
    "the old unsupported message must be gone"
  );
  assertEqual(
    JSON.stringify(api.addressEntriesFor("ton", "ton", { ton: "EQv4", ton_w5: "EQw5" }, "ton")),
    JSON.stringify([{ prefix: "", address: "EQv4" }]),
    "the v4R2 rows read the bundle-built address"
  );
});

test("mnemonic-bch-balances: one Haskoin request lists each address once in order", async () => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => [
        { address: "bitcoincash:qqqaaa", confirmed: "1000", unconfirmed: "0", txs: 3 },
        { address: "bitcoincash:qqqbbb", confirmed: "2000", unconfirmed: "500", txs: 0 }
      ]
    };
  };
  try {
    const result = await providers.fetchProvider(
      api.providerMetaFor("bitcoin-cash"),
      ["legacyA", "legacyA", "legacyB"]
    );
    assertEqual(requests.length, 1, "one request for the whole page");
    assert(
      requests[0].endsWith("/address/balances?addresses=legacyA,legacyB"),
      `the query lists each address once in input order, got ${requests[0]}`
    );
    assertEqual(result.values.legacyA.balance, "1000", "row 0 maps to the first address by index");
    assertEqual(result.values.legacyB.balance, "2500", "confirmed + unconfirmed is the balance");
    assertEqual(result.values.legacyB.tx, 0, "the tx count comes from the same row");
    assertEqual(Object.keys(result.errors).length, 0, "no error when the provider answers");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("mnemonic-bch-balances: a rejected batch is an error for every address, never zero", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: "user-error" }) });
  try {
    await providers.fetchProvider(
      api.providerMetaFor("bitcoin-cash"),
      ["legacyA", "legacyB"]
    );
    throw new Error("a 400 response must reject, not return zero balances");
  } catch (error) {
    assertEqual(error.message, "HTTP 400", "the whole batch fails loud");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("mnemonic-xrp-redirect: XRP Scan is called with redirect: error", async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ account_data: { Balance: "1234567", TransactionCount: 4 } })
    };
  };
  try {
    const result = await providers.fetchProvider({ provider: "xrpscan" }, ["rTest"]);
    assertEqual(calls.length, 1, "one request per address");
    assertEqual(calls[0].init && calls[0].init.redirect, "error", "a 302 must reject instead of being followed");
    assertEqual(result.values.rTest.balance, "1234567", "a normal JSON response still yields a balance");
    assertEqual(result.values.rTest.tx, 4, "the transaction count is kept");
    assertEqual(Object.keys(result.errors).length, 0, "no error on a normal response");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("mnemonic-tron-xrp-sui-balances: the shared dispatcher covers every browse provider", async () => {
  const source = await readFile(browsePath, "utf8");
  const emitted = [...source.matchAll(/provider:\s*'([^']+)'/g)].map((match) => match[1]);
  assert(emitted.length >= 7, `browse.js must still declare its providers, found ${emitted.length}`);
  emitted.forEach((provider) => {
    assert(providers.supportsProvider(provider), `browse.js emits "${provider}" but the dispatcher lacks it`);
  });
  assert(source.includes("config.chain === 'bitcoin-cash'"), "browse.js must wire Bitcoin Cash balances");
  assert(source.includes("provider: 'haskoin-bch'"), "bch-directory-provider: browse.js must use the batched Haskoin provider for BCH");
  assertEqual(await providers.fetchProvider({ provider: "not-a-provider" }, ["a"]).then((r) => Object.keys(r.values).length), 0, "an unknown provider resolves empty");
});

test("copy wiring writes the exact value to the clipboard", async () => {
  clipboardWrites.length = 0;
  const target = button("Copy WIF private key");
  const pending = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { pending.push(fn); return 0; };
  try {
    await api.copyText(WIF, target);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assertEqual(clipboardWrites.length, 1, "one clipboard write");
  assertEqual(clipboardWrites[0], WIF, "clipboard receives the key");
  assert(target.classes.includes("is-copied"), "button shows the copied state");
  assertEqual(target.getAttribute("aria-label"), "Copied", "button announces the copy");
  pending.forEach((fn) => fn());
  assertEqual(target.getAttribute("aria-label"), "Copy WIF private key", "label restored");
});

test("mnemonic copy uses the same explicit-click handler", async () => {
  clipboardWrites.length = 0;
  const target = button("Copy mnemonic");
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { return 0; };
  try {
    await api.copyText("abandon abandon about", target);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assertEqual(clipboardWrites[0], "abandon abandon about", "clipboard receives the phrase");
});

test("the row script never stores or logs keys", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert(!/localStorage|sessionStorage/.test(source), "keys must not use web storage");
  assert(!/console\.(log|info|debug|warn|error)/.test(source), "keys must not be logged");
});

/* Balance-row instrumentation contract. A listing row that renders balances
 * must expose `data-balance-state` (and `data-balance-at` where a timestamp
 * exists) on the row element itself, or a verifier selecting
 * [data-balance-state] silently measures zero rows. */
const BALANCE_ROW_CONTRACT = [
  {
    file: "browse.js",
    fn: "renderGroup",
    state: /group\.row\.dataset\.balanceState\s*=/,
    at: /group\.row\.dataset\.balanceAt\s*=/,
  },
  {
    file: "browse.js",
    fn: "fetchAndApply",
    state: /record\.row\.dataset\.balanceState\s*=\s*['"]loading['"]/,
  },
  {
    file: "key.js",
    fn: "renderCachedRow",
    state: /row\.dataset\.balanceState\s*=\s*['"]ok['"]/,
    at: /row\.dataset\.balanceAt\s*=/,
  },
  {
    file: "key.js",
    fn: "checkRow",
    state: /row\.dataset\.balanceState\s*=\s*['"]loading['"]/,
  },
  {
    file: "mnemonic-seeds.js",
    fn: "createRow",
    state: /entry\.row\s*=\s*row/,
  },
  {
    file: "mnemonic-seeds.js",
    fn: "renderEntry",
    state: /setBalanceState\(entry,\s*entry\.balanceState/,
  },
  {
    file: "mnemonic-seeds.js",
    fn: "setBalanceState",
    state: /dataset\.balanceState\s*=/,
    at: /dataset\.balanceAt\s*=/,
  },
  {
    file: "mnemonic-seeds.js",
    fn: "fetchAndApply",
    state: /record\.entry\.row\.dataset\.balanceState\s*=\s*['"]loading['"]/,
  },
];

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = source.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

function scanBalanceRowContract(sources, contract = BALANCE_ROW_CONTRACT) {
  const problems = [];
  for (const rule of contract) {
    const body = functionBody(sources[rule.file] || "", rule.fn);
    if (!body) {
      problems.push(`${rule.file}:${rule.fn}: function not found`);
      continue;
    }
    if (!rule.state.test(body)) {
      problems.push(`${rule.file}:${rule.fn}: balance rows do not set data-balance-state`);
    }
    if (rule.at && !rule.at.test(body)) {
      problems.push(`${rule.file}:${rule.fn}: balance rows do not set data-balance-at`);
    }
  }
  return problems;
}

test("balance-state-attribute: every balance row sets data-balance-state on the row", async () => {
  const sources = {
    "browse.js": await readFile(browsePath, "utf8"),
    "key.js": await readFile(fileURLToPath(new URL("./key.js", import.meta.url)), "utf8"),
    "mnemonic-seeds.js": await readFile(scriptPath, "utf8"),
  };
  assertEqual(scanBalanceRowContract(sources).join("\n"), "", "balance rows must carry the state attribute");
});

test("balance-state-attribute: the detector catches a removed mnemonic state write", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert(source.includes("setBalanceState(entry, entry.balanceState, first)"), "fixture must contain the state write");
  const mutated = source.replace(
    "    setBalanceState(entry, entry.balanceState, first);",
    "    /* state write removed by the mutation test */"
  );
  assert(mutated !== source, "mutation must change the source");
  const problems = scanBalanceRowContract({ "mnemonic-seeds.js": mutated });
  assert(
    problems.some((problem) => problem.includes("mnemonic-seeds.js:renderEntry")),
    `mutation must fail the detector, got: ${problems.join("; ")}`
  );
});

test("balance-state-attribute: the detector catches a removed browse state write", async () => {
  const source = await readFile(browsePath, "utf8");
  const mutated = source.replace(
    "group.row.dataset.balanceState = failed ? 'err' : ok ? (fresh ? 'ok' : 'stale') : 'missing';",
    "/* state write removed by the mutation test */"
  );
  assert(mutated !== source, "mutation must change the source");
  const problems = scanBalanceRowContract({ "browse.js": mutated });
  assert(
    problems.some((problem) => problem.includes("browse.js:renderGroup")),
    `mutation must fail the detector, got: ${problems.join("; ")}`
  );
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${error && error.message ? error.message : error}`);
  }
}

if (failed) {
  console.error(`\n${failed} of ${tests.length} mnemonic seed tests failed`);
  process.exit(1);
}
console.log(`\n${tests.length} mnemonic seed tests passed`);
