// Vendor-lock identity must not depend on the checkout's line endings.
//
// A Windows working tree writes CRLF (core.autocrlf=true) while Linux CI reads
// the committed LF blob. Hashing raw bytes made the same committed file hash
// differently on each platform, so the lock flipped between green and red. The
// digest is defined over LF-normalized content for every entry.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeEolBytes, regenerateVendorLock, sha256Vendored } from "./gen-ssot.mjs";
import { validateVendorLock } from "./check-ssot.mjs";

function rawDigest(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rotor-vendor-lock-"));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeLock(root, entries) {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "vendor.lock.json"),
    `${JSON.stringify({ version: 1, entries, nonCopies: [] }, null, 2)}\n`,
  );
}

test("EOL normalization gives one digest for LF and CRLF", () => withTempRoot((root) => {
  const lf = path.join(root, "lf.js");
  const crlf = path.join(root, "crlf.js");
  fs.writeFileSync(lf, "const a = 1;\nconst b = 2;\n");
  fs.writeFileSync(crlf, "const a = 1;\r\nconst b = 2;\r\n");
  assert.notEqual(rawDigest(lf), rawDigest(crlf), "raw digests differ across line endings");
  assert.equal(sha256Vendored(lf), sha256Vendored(crlf), "normalized digests match");
  assert.equal(normalizeEolBytes(Buffer.from("a\r\nb\r\n")).toString(), "a\nb\n");
}));

test("validateVendorLock accepts a CRLF source and an LF copy", () => withTempRoot((root) => {
  fs.mkdirSync(path.join(root, "apps", "site"), { recursive: true });
  fs.mkdirSync(path.join(root, "web", "public"), { recursive: true });
  const source = path.join(root, "apps", "site", "a.js");
  const target = path.join(root, "web", "public", "a.js");
  fs.writeFileSync(source, "const a = 1;\r\n");
  fs.writeFileSync(target, "const a = 1;\n");
  writeLock(root, [
    { source: "apps/site/a.js", target: "web/public/a.js", sha256: sha256Vendored(source) },
  ]);
  assert.deepEqual(validateVendorLock(root).errors, []);

  fs.appendFileSync(target, "drift\n");
  const errors = validateVendorLock(root).errors;
  assert.equal(errors.length, 1);
  assert.match(errors[0], /vendor-lock-digest/);
}));

test("regenerateVendorLock refreshes copies and normalized digests", () => withTempRoot((root) => {
  fs.mkdirSync(path.join(root, "apps", "site"), { recursive: true });
  fs.mkdirSync(path.join(root, "web", "public"), { recursive: true });
  const source = path.join(root, "apps", "site", "a.js");
  const target = path.join(root, "web", "public", "a.js");
  fs.writeFileSync(source, "const a = 1;\r\n");
  fs.writeFileSync(target, "stale\n");
  writeLock(root, [{ source: "apps/site/a.js", target: "web/public/a.js", sha256: "0".repeat(64) }]);

  const result = regenerateVendorLock(root);
  assert.equal(result.updated.length, 1);
  const lock = JSON.parse(fs.readFileSync(path.join(root, "data", "vendor.lock.json"), "utf8"));
  assert.equal(lock.entries[0].sha256, sha256Vendored(source));
  assert.ok(fs.readFileSync(target).equals(fs.readFileSync(source)), "the copy is byte-for-byte");
  assert.deepEqual(validateVendorLock(root).errors, []);
}));
