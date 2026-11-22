#!/usr/bin/env node
// Single-source-of-truth gate for chain/provider data.
//
// Checks:
//   data-shape       data/chains.json and data/providers.json pass the
//                    generator's schema validation (unique slugs, required
//                    fields, https URLs, no private hosts).
//   generated-fresh  apps/site/chains.generated.js and src/generated/chains.rs
//                    match what `node scripts/gen-ssot.mjs` would write.
//   provider-literal no first-party apps/site/*.js file carries a provider or
//                    explorer hostname that already lives in the canonical
//                    data. Consumers must read the generated globals.
//
// data/ssot-allow.json records the known exceptions. The list is shrink-only:
// a new literal fails, an entry whose match no longer occurs fails as stale,
// and an expired entry fails. Vendored bundles may use `"match": "*"` to opt
// the whole file out.
//
// Zero dependencies; Windows-safe. Exit: 0 = clean, 1 = violations.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO_ROOT, run } from "./gen-ssot.mjs";

const SITE_DIR = "apps/site";
const GENERATED_JS = "chains.generated.js";
const ALLOW_PATH = "data/ssot-allow.json";
const EXEMPT_GENERATED = new Set([GENERATED_JS]);
const OWNERS = new Set([
  "site-ui",
  "coordinator",
  "wasm-core",
  "desktop-tools",
  "ops/docs",
]);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function readJson(root, relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  } catch (error) {
    fail(`cannot read ${relative}: ${error.message}`);
  }
}

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// Every hostname the canonical data owns. A literal in a site script means the
// fact is copied; the generated global is the only allowed copy.
export function canonicalHosts(data) {
  const hosts = new Set();
  const add = (value) => {
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
    } catch {
      // Validation in gen-ssot already reports malformed URLs.
    }
  };
  for (const list of data.providers.values()) {
    for (const provider of list) add(provider.url);
  }
  for (const chain of data.chains) {
    add(chain.explorer);
    if (chain.explorerTx) add(chain.explorerTx);
  }
  return [...hosts].sort();
}

function listSiteFiles(root) {
  return fs
    .readdirSync(path.join(root, SITE_DIR))
    .filter((name) => name.endsWith(".js") && !EXEMPT_GENERATED.has(name))
    .sort()
    .map((name) => `${SITE_DIR}/${name}`);
}

function lineNumbers(text, needle) {
  const lines = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    lines.push(text.slice(0, index).split("\n").length);
    index = text.indexOf(needle, index + needle.length);
  }
  return lines;
}

function loadAllowlist(root) {
  const full = path.join(root, ALLOW_PATH);
  if (!fs.existsSync(full)) return [];
  const json = readJson(root, ALLOW_PATH);
  if (!Array.isArray(json)) fail(`${ALLOW_PATH} must be an array`);
  return json;
}

function validateAllowlist(root, entries) {
  const errors = [];
  const seen = new Set();
  const today = todayUtc();
  for (const [index, entry] of entries.entries()) {
    const where = `${ALLOW_PATH}[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    for (const field of ["file", "match", "reason", "owner", "expires"]) {
      if (typeof entry[field] !== "string" || entry[field].trim().length === 0) {
        errors.push(`${where}.${field} must be a non-empty string`);
      }
    }
    if (typeof entry.file !== "string" || !entry.file.startsWith(`${SITE_DIR}/`) ||
        !entry.file.endsWith(".js") || entry.file.includes("..")) {
      errors.push(`${where}.file must be a first-party ${SITE_DIR}/*.js path`);
      continue;
    }
    const full = path.join(root, entry.file);
    if (!fs.existsSync(full)) {
      errors.push(`${where}.file does not exist: ${entry.file}`);
      continue;
    }
    if (!OWNERS.has(entry.owner)) {
      errors.push(`${where}.owner must be one of: ${[...OWNERS].join(", ")}`);
    }
    if (!isoDate(entry.expires)) {
      errors.push(`${where}.expires must be YYYY-MM-DD`);
    } else if (entry.expires < today) {
      errors.push(`${where} expired on ${entry.expires}; remove the literal or renew the entry`);
    }
    const key = `${entry.file}\0${entry.match}`;
    if (seen.has(key)) errors.push(`${where} duplicates ${entry.file} / ${entry.match}`);
    seen.add(key);
    const text = fs.readFileSync(full, "utf8");
    if (entry.match !== "*" && !text.includes(entry.match)) {
      errors.push(
        `${where} is stale: ${entry.file} no longer contains ${JSON.stringify(entry.match)}; ` +
          "remove the allowlist entry (the list is shrink-only)",
      );
    }
  }
  return errors;
}

function allowSet(entries) {
  const set = new Set();
  for (const entry of entries) {
    if (entry.file && entry.match) set.add(`${entry.file}\0${entry.match}`);
  }
  return set;
}

export function check(root = REPO_ROOT) {
  const errors = [];
  const freshness = run({ root, check: true });
  for (const message of freshness.messages) {
    if (!freshness.ok) errors.push(message);
  }
  if (!freshness.ok) return { ok: false, errors, needles: [], checked: 0, allowlisted: 0 };

  const data = freshness.data;
  const needles = canonicalHosts(data);
  const allow = loadAllowlist(root);
  errors.push(...validateAllowlist(root, allow));
  const allowEntries = allowSet(allow);
  const wholeFile = new Set(allow.filter((entry) => entry.match === "*").map((entry) => entry.file));

  const files = listSiteFiles(root);
  let checked = 0;
  let allowlisted = 0;
  for (const relative of files) {
    checked += 1;
    if (wholeFile.has(relative)) {
      allowlisted += 1;
      continue;
    }
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    for (const needle of needles) {
      const lines = lineNumbers(text, needle);
      if (lines.length === 0) continue;
      if (allowEntries.has(`${relative}\0${needle}`)) {
        allowlisted += 1;
        continue;
      }
      errors.push(
        `${relative}:${lines.join(",")} carries the canonical provider host ${JSON.stringify(needle)}; ` +
          "read window.RotorProviders / window.RotorChains instead, or add a reviewed data/ssot-allow.json entry",
      );
    }
  }

  return { ok: errors.length === 0, errors, needles, checked, allowlisted };
}

export function main() {
  try {
    const result = check();
    if (!result.ok) {
      for (const error of result.errors) console.error(`error: ${error}`);
      console.error(`ssot:check FAILED (${result.errors.length} error(s))`);
      return 1;
    }
    console.log(
      `ssot:check OK (${result.needles.length} canonical hosts, ${result.checked} site scripts, ` +
        `${result.allowlisted} allowlisted occurrence(s))`,
    );
    return 0;
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
