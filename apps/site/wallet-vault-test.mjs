// Tests for the cabinet wallet vault codec (apps/site/wallet-vault.js).
//
// Usage: node apps/site/wallet-vault-test.mjs
//
// Uses Node's WebCrypto; no dependencies, no DOM, no network. The codec's
// 600,000-iteration PBKDF2 is exercised for real, so the suite takes a few
// seconds by design.

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const vault = require("./wallet-vault.js");

const PASSPHRASE = "correct horse battery staple";
const WIF_SECRET = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
const HEX_SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const ENTRIES = [
  {
    id: "entry-1",
    chain: "bitcoin",
    label: "cold storage",
    secret_type: "wif",
    secret: WIF_SECRET
  },
  {
    id: "entry-2",
    chain: "ethereum",
    label: "hot wallet",
    secret_type: "hex",
    secret: HEX_SECRET
  }
];

const cryptoObj = webcrypto;

function decodeBase64(text) {
  return new Uint8Array(Buffer.from(text, "base64"));
}

function encodeBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

async function makeRecord(entries = ENTRIES, passphrase = PASSPHRASE) {
  return vault.createVaultRecord(entries, passphrase, { crypto: cryptoObj });
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("round trip restores exactly the stored entries", async () => {
  const record = await makeRecord();
  assert.equal(record.version, 1);
  assert.equal(record.kdf.name, "PBKDF2-SHA256");
  assert.equal(record.kdf.iterations, 600000);
  assert.equal(record.cipher.name, "AES-GCM");
  assert.equal(decodeBase64(record.kdf.salt).length, 16);
  assert.equal(decodeBase64(record.cipher.iv).length, 12);
  assert.ok(record.ciphertext.length > 0);
  assert.match(record.updated_at, /^\d{4}-\d{2}-\d{2}T/);

  const opened = await vault.decryptVaultRecord(record, PASSPHRASE, { crypto: cryptoObj });
  assert.deepEqual(opened.entries, ENTRIES);
});

test("a wrong passphrase is rejected without yielding entries", async () => {
  const record = await makeRecord();
  await assert.rejects(
    () => vault.decryptVaultRecord(record, "wrong passphrase", { crypto: cryptoObj }),
    /wrong passphrase or damaged data/
  );
});

test("tampered ciphertext is rejected", async () => {
  const record = await makeRecord();
  const bytes = decodeBase64(record.ciphertext);
  bytes[bytes.length - 1] ^= 0x01;
  const tampered = { ...record, ciphertext: encodeBase64(bytes) };
  await assert.rejects(
    () => vault.decryptVaultRecord(tampered, PASSPHRASE, { crypto: cryptoObj }),
    /wrong passphrase or damaged data/
  );
});

test("the stored record and ciphertext contain no plaintext secret", async () => {
  const record = await makeRecord();
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes(WIF_SECRET), "WIF leaked into the record");
  assert.ok(!serialized.includes(HEX_SECRET), "hex key leaked into the record");
  assert.ok(!serialized.includes(PASSPHRASE), "passphrase leaked into the record");

  const ciphertext = Buffer.from(decodeBase64(record.ciphertext)).toString("latin1");
  assert.ok(!ciphertext.includes(WIF_SECRET), "WIF leaked into the ciphertext");
  assert.ok(!ciphertext.includes(HEX_SECRET), "hex key leaked into the ciphertext");
});

test("every save uses a fresh salt and IV and new ciphertext", async () => {
  const first = await makeRecord();
  const second = await makeRecord();
  assert.notEqual(first.kdf.salt, second.kdf.salt);
  assert.notEqual(first.cipher.iv, second.cipher.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("export/import moves only the encrypted blob", async () => {
  const record = await makeRecord();
  const blob = vault.exportVaultBlob(record);
  assert.equal(typeof blob, "string");
  assert.ok(!blob.includes(WIF_SECRET));
  const imported = vault.importVaultBlob(blob);
  assert.deepEqual(imported, record);
  const opened = await vault.decryptVaultRecord(imported, PASSPHRASE, { crypto: cryptoObj });
  assert.deepEqual(opened.entries, ENTRIES);
});

test("import rejects plaintext JSON and malformed blobs", () => {
  const plaintext = JSON.stringify({ entries: ENTRIES });
  assert.throws(() => vault.importVaultBlob(plaintext), /not an encrypted vault blob/);
  assert.throws(() => vault.importVaultBlob("not base64"), /not an encrypted vault blob/);
  assert.throws(() => vault.importVaultBlob(""), /empty/);
});

test("records with weak KDF parameters are rejected", async () => {
  const record = await makeRecord();
  const weak = { ...record, kdf: { ...record.kdf, iterations: 1000 } };
  assert.throws(() => vault.validateRecord(weak), /below the required 600000/);
  assert.throws(
    () => vault.importVaultBlob(encodeBase64(Buffer.from(JSON.stringify(weak)))),
    /below the required 600000/
  );
  await assert.rejects(
    () => vault.createVaultRecord(ENTRIES, PASSPHRASE, { crypto: cryptoObj, iterations: 1000 }),
    /below the required 600000/
  );
});

test("records with wrong salt or IV sizes are rejected", async () => {
  const record = await makeRecord();
  assert.throws(
    () => vault.validateRecord({ ...record, kdf: { ...record.kdf, salt: encodeBase64(new Uint8Array(8)) } }),
    /salt must be 16 bytes/
  );
  assert.throws(
    () => vault.validateRecord({ ...record, cipher: { ...record.cipher, iv: encodeBase64(new Uint8Array(8)) } }),
    /IV must be 12 bytes/
  );
});

test("entry validation rejects unknown fields and secret types", async () => {
  await assert.rejects(
    () => vault.createVaultRecord([{ ...ENTRIES[0], secret_type: "seed" }], PASSPHRASE, { crypto: cryptoObj }),
    /unsupported secret_type/
  );
  const record = await makeRecord([
    { ...ENTRIES[0], extra: "ignored" }
  ]);
  const opened = await vault.decryptVaultRecord(record, PASSPHRASE, { crypto: cryptoObj });
  assert.deepEqual(Object.keys(opened.entries[0]).sort(), [
    "chain", "id", "label", "secret", "secret_type"
  ]);
});

let failed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}
if (failed) {
  console.error(`\n${failed} of ${cases.length} wallet vault tests failed`);
  process.exit(1);
}
console.log(`\n${cases.length} wallet vault tests passed`);
