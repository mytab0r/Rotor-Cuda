#!/usr/bin/env node
/* Tests for the self-contained QR encoder. No browser, no network. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

const source = readFileSync(fileURLToPath(new URL("./qr.js", import.meta.url)), "utf8");

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };
runInThisContext(source, { filename: "qr.js" });

const qr = globalThis.RotorQR;
assert.ok(qr && typeof qr.encode === "function", "qr.js must expose RotorQR.encode before any DOM access");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}\n  ${err && err.stack ? err.stack : err}`);
  }
}

function matrixText(modules) {
  return modules.map((row) => row.join("")).join("");
}

function matrixHash(modules) {
  return createHash("sha256").update(matrixText(modules), "utf8").digest("hex");
}

/* Golden matrices pinned from independent byte-mode references.
   The goQR.me API named by the change always emits mask 2 (verified across
   many inputs) and switches uppercase or digit-heavy payloads to
   alphanumeric/numeric segments, so its SVG is not an oracle for mask
   selection. Where the optimal mask is 2 its matrix matches this encoder
   exactly (WIF and bech32 below), which proves the byte stream, the
   Reed-Solomon blocks and the placement against the API. The pinned hashes
   are therefore from qrcodegen (Nayuki), a spec-quality byte-mode
   implementation: the encoder reproduces every matrix below cell for cell for
   versions 1-6, including mask choice. python-qrcode and segno (both forced
   to byte mode) were used as additional cross-checks. */
const GOLDEN = [
  {
    name: "HELLO WORLD",
    data: "HELLO WORLD",
    version: 1,
    size: 21,
    hash: "f516d851861750f4deffb7514598d7058ab57a40b130409930189536174c89aa",
  },
  {
    name: "ETH address",
    data: "0x52908400098527886E0F7030069857D2E4169EE7",
    version: 3,
    size: 29,
    hash: "5835e74775d465c996747b6db1c27ee21ebbfaf3b1afd9cd999cbbe157ffca8d",
  },
  {
    name: "WIF",
    data: "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ",
    version: 4,
    size: 33,
    hash: "b50296ce5d239fa6a50530839ebf837c322654636136fcc6ee4bd8fa0f07fa8d",
  },
  {
    name: "bech32",
    data: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    version: 3,
    size: 29,
    hash: "11d3989a41b272442fa4b927c27a394928bd880ed63765009e65424561e829d8",
  },
  {
    name: "bech32 62",
    data: "bc1qqzry9x8gf2tvdw0s3jn54khce6mua7lqzry9x8gf2tvdw0s3jn54khce6m",
    version: 4,
    size: 33,
    hash: "fae2b54b0dbb540d15e64a3f1373612ce320d227c0de4568c1f46c99392f72ef",
  },
  {
    name: "106-byte v6",
    data: "c".repeat(106),
    version: 6,
    size: 41,
    hash: "3c6a661acfae31165c920090db47b0b4b2cf6aa21d602f404885939c6094176f",
  },
];

for (const item of GOLDEN) {
  test(`golden matrix: ${item.name}`, () => {
    const out = qr.encode(item.data);
    assert.equal(out.version, item.version);
    assert.equal(out.size, item.size);
    assert.equal(out.modules.length, item.size);
    assert.equal(matrixHash(out.modules), item.hash);
  });
}

test("byte capacity picks the smallest version 1..6", () => {
  const cases = [
    [1, 1], [14, 1],
    [15, 2], [26, 2],
    [27, 3], [42, 3],
    [43, 4], [62, 4],
    [63, 5], [84, 5],
    [85, 6], [106, 6],
  ];
  for (const [bytes, version] of cases) {
    const out = qr.encode("a".repeat(bytes));
    assert.equal(out.version, version, `${bytes} bytes must use version ${version}`);
    assert.equal(out.size, 4 * version + 17);
  }
});

test("a 62-byte input is version 4", () => {
  const out = qr.encode("x".repeat(62));
  assert.equal(out.version, 4);
  assert.equal(out.size, 33);
});

test("modules are square rows of 0/1", () => {
  const out = qr.encode("structure");
  assert.ok(Array.isArray(out.modules));
  for (const row of out.modules) {
    assert.equal(row.length, out.size);
    for (const cell of row) assert.ok(cell === 0 || cell === 1);
  }
});

function checkFinder(modules, top, left) {
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      const edge = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      assert.equal(
        modules[top + r][left + c],
        edge || core ? 1 : 0,
        `finder cell ${top + r},${left + c}`,
      );
    }
  }
}

test("three finder patterns sit in the corners", () => {
  const out = qr.encode("finder patterns");
  checkFinder(out.modules, 0, 0);
  checkFinder(out.modules, 0, out.size - 7);
  checkFinder(out.modules, out.size - 7, 0);
});

test("timing patterns alternate across row 6 and column 6", () => {
  const out = qr.encode("timing patterns");
  const last = out.size - 9;
  for (let i = 8; i <= last; i += 1) {
    const dark = i % 2 === 0 ? 1 : 0;
    assert.equal(out.modules[6][i], dark, `row 6, column ${i}`);
    assert.equal(out.modules[i][6], dark, `row ${i}, column 6`);
  }
});

test("dark module is set for versions 1..6", () => {
  for (const bytes of [1, 15, 27, 43, 63, 85]) {
    const out = qr.encode("d".repeat(bytes));
    assert.equal(out.modules[4 * out.version + 9][8], 1, `version ${out.version}`);
  }
});

test("multi-byte UTF-8 uses the byte length for the version", () => {
  /* 13 x "é" is 13 characters but 26 UTF-8 bytes: version 2, not version 1. */
  const twoByte = qr.encode("é".repeat(13));
  assert.equal(twoByte.version, 2);
  assert.equal(qr.encode("é".repeat(14)).version, 3);
  /* 20 x "€" is 60 UTF-8 bytes: version 4. */
  assert.equal(qr.encode("€".repeat(20)).version, 4);
  /* 53 x "é" is exactly 106 bytes: version 6; 54 is 108 bytes and must throw. */
  assert.equal(qr.encode("é".repeat(53)).version, 6);
  assert.throws(() => qr.encode("é".repeat(54)), /106/);
});

test("empty input throws", () => {
  assert.throws(() => qr.encode(""), /empty/i);
});

test("input above 106 bytes throws", () => {
  assert.throws(() => qr.encode("a".repeat(107)), /106/);
});

if (failed) {
  console.error(`${failed} qr test(s) failed`);
  process.exit(1);
}
console.log("qr: all tests passed");
