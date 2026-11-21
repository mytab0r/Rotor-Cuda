#!/usr/bin/env node
// Contract tests for scripts/build-tokens.mjs.
// Run with: node --test scripts/build-tokens.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "./build-tokens.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILES = [
  "apps/site/site.css",
  "design/tokens/tokens.json",
  "design/tokens/tokens.contract.json",
];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rotor-build-tokens-"));
  for (const relative of FILES) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, relative), target);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function write(root, relative, content) {
  fs.writeFileSync(path.join(root, relative), content);
}

function tokensOf(root) {
  return JSON.parse(read(root, "design/tokens/tokens.json"));
}

function contractOf(root) {
  return JSON.parse(read(root, "design/tokens/tokens.contract.json"));
}

function saveTokens(root, tokens) {
  write(root, "design/tokens/tokens.json", `${JSON.stringify(tokens, null, 2)}\n`);
}

function saveContract(root, contract) {
  write(root, "design/tokens/tokens.contract.json", `${JSON.stringify(contract, null, 2)}\n`);
}

test("generation is idempotent and keeps aliases", (t) => {
  const root = fixture(t);
  const first = run({ root });
  assert.equal(first.ok, true);
  const css = read(root, "apps/site/site.css");
  const ts = read(root, "design/generated/tokens.ts");

  const second = run({ root });
  assert.equal(second.ok, true);
  assert.deepEqual(second.written, []);
  assert.equal(read(root, "apps/site/site.css"), css);
  assert.equal(read(root, "design/generated/tokens.ts"), ts);

  assert.match(css, /--surface-0: var\(--bg\);/);
  assert.match(css, /--radius-control: var\(--radius-m\);/);
  assert.doesNotMatch(css, /--surface-0: #07090e;/);
  assert.match(ts, /"--surface-0": "var\(--surface-0\)",/);
  assert.equal((css.match(/\/\* tokens:start \*\//g) || []).length, 2);
  assert.equal((css.match(/\/\* tokens:end \*\//g) || []).length, 2);
});

test("--check fails when tokens.json changes without regeneration", (t) => {
  const root = fixture(t);
  run({ root });
  const tokens = tokensOf(root);
  tokens.primitive.legacy.bg.$value = "#000000";
  saveTokens(root, tokens);

  const result = run({ root, check: true });
  assert.equal(result.ok, false);
  assert.match(result.messages.join("\n"), /apps\/site\/site\.css is stale/);
  assert.match(result.messages.join("\n"), /tokens:check FAILED/);
});

test("--check fails when the committed CSS region is edited by hand", (t) => {
  const root = fixture(t);
  run({ root });
  const css = read(root, "apps/site/site.css");
  write(root, "apps/site/site.css", css.replace("--bg: #07090e;", "--bg: #07090f;"));

  const result = run({ root, check: true });
  assert.equal(result.ok, false);
  assert.match(result.messages.join("\n"), /expected:.*--bg: #07090e;/);
  assert.match(result.messages.join("\n"), /actual:.*--bg: #07090f;/);
});

test("a token declared in JSON lands in both generated outputs", (t) => {
  const root = fixture(t);
  const tokens = tokensOf(root);
  tokens.primitive.legacy.probe = { $value: "#123456", $type: "color" };
  saveTokens(root, tokens);
  const contract = contractOf(root);
  contract.names.push("--probe");
  contract.names.sort();
  saveContract(root, contract);

  const result = run({ root });
  assert.equal(result.ok, true);
  const css = read(root, "apps/site/site.css");
  assert.match(css, /--probe: #123456;/);
  assert.match(read(root, "design/generated/tokens.ts"), /"--probe": "var\(--probe\)",/);
});

test("a contract name missing from tokens.json is reported", (t) => {
  const root = fixture(t);
  const tokens = tokensOf(root);
  delete tokens.primitive.space["space-1"];
  saveTokens(root, tokens);

  assert.throws(
    () => run({ root }),
    /contract name --space-1 is missing from tokens\.json/,
  );
});

test("LF checkouts regenerate cleanly", (t) => {
  const root = fixture(t);
  const css = read(root, "apps/site/site.css").replace(/\r\n/g, "\n");
  write(root, "apps/site/site.css", css);
  assert.equal(run({ root }).ok, true);
  assert.equal(read(root, "apps/site/site.css").includes("\r\n"), false);
  assert.equal(read(root, "design/generated/tokens.ts").includes("\r\n"), false);
  assert.equal(run({ root, check: true }).ok, true);
});

test("CRLF checkouts regenerate cleanly", (t) => {
  const root = fixture(t);
  const css = read(root, "apps/site/site.css").replace(/\r?\n/g, "\r\n");
  write(root, "apps/site/site.css", css);
  assert.equal(run({ root }).ok, true);
  assert.match(read(root, "apps/site/site.css"), /\r\n/);
  assert.match(read(root, "design/generated/tokens.ts"), /\r\n/);
  assert.equal(run({ root, check: true }).ok, true);
});

test("a light override without a dark token is rejected", (t) => {
  const root = fixture(t);
  const tokens = tokensOf(root);
  delete tokens.primitive.legacy["accent-2"];
  saveTokens(root, tokens);

  assert.throws(
    () => run({ root }),
    /light override --accent-2 has no dark-theme token/,
  );
});
