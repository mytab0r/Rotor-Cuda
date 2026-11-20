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
const scriptPath = fileURLToPath(new URL("./mnemonic-seeds.js", import.meta.url));

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
  assert(target.classes.includes("copied"), "button shows the copied state");
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
