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
//                    Allowlist entries cover plain text only: a canonical host
//                    inside an http(s):// URL literal always fails.
//   provider-id      every `SSOT_PROVIDERS.find('chain', 'id')`,
//                    `.first('chain')` and static `.byChain` / `.bySlug`
//                    reference names a chain and provider id that exist in
//                    data/providers.json / data/chains.json.
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
const AMOUNT_JS = "amount.js";
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

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function occurrences(text, needle) {
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  const hits = [];
  let index = haystack.indexOf(target);
  while (index !== -1) {
    hits.push({ index, line: lineAt(text, index) });
    index = haystack.indexOf(target, index + target.length);
  }
  return hits;
}

function urlSpans(text) {
  const spans = [];
  for (const match of text.matchAll(/https?:\/\/[^\s"'`<>]+/gi)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function insideUrl(spans, index) {
  return spans.some((span) => index >= span.start && index < span.end);
}

// Amount conversion has one implementation: apps/site/amount.js. A local copy
// in a consumer is how the eleven formatters and three parsers drifted apart;
// those copies used Number and lost precision above 2^53. Detector id:
// lossy-amount-formatter.
const AMOUNT_DEFINITIONS = [
  { needle: "function formatUnits(", re: /^[ \t]*function\s+formatUnits\s*\(/gm },
  { needle: "function formatUnits6(", re: /^[ \t]*function\s+formatUnits6\s*\(/gm },
  { needle: "function parseUnits(", re: /^[ \t]*function\s+parseUnits\s*\(/gm },
  { needle: "function coin(", re: /^[ \t]*function\s+coin\s*\(/gm },
  { needle: "function formatEth(", re: /^[ \t]*function\s+formatEth\s*\(/gm },
  { needle: "Math.pow(10,", re: /\bMath\.pow\(\s*10\s*,/g },
];

const PROVIDER_CALLS = [
  {
    kind: "find",
    re: /\b(?:SSOT_PROVIDERS|RotorProviders)\.find\(\s*(['"])([a-z0-9-]+)\1\s*,\s*(['"])([a-z0-9-]+)\3\s*\)/g,
    chainGroup: 2,
    idGroup: 4,
  },
  {
    kind: "first",
    re: /\b(?:SSOT_PROVIDERS|RotorProviders)\.first\(\s*(['"])([a-z0-9-]+)\1\s*\)/g,
    chainGroup: 2,
  },
];

const PROVIDER_ACCESS = [
  {
    kind: "byChain",
    re: /\b(?:SSOT_PROVIDERS|RotorProviders)\.byChain\.([a-z0-9]+(?:-[a-z0-9]+)*)/g,
    group: 1,
  },
  {
    kind: "byChain",
    re: /\b(?:SSOT_PROVIDERS|RotorProviders)\.byChain\[\s*(['"])([a-z0-9-]+)\1\s*\]/g,
    group: 2,
  },
];

const CHAIN_ACCESS = [
  {
    kind: "bySlug",
    re: /\b(?:SSOT_CHAINS|RotorChains)\.bySlug\.([a-z0-9]+(?:-[a-z0-9]+)*)/g,
    group: 1,
  },
  {
    kind: "bySlug",
    re: /\b(?:SSOT_CHAINS|RotorChains)\.bySlug\[\s*(['"])([a-z0-9-]+)\1\s*\]/g,
    group: 2,
  },
];

// The generated globals are the runtime contract. A typo in a chain slug or a
// provider id is not caught by the literal or freshness checks, and it crashes
// the page on `find(...).url`; validate every static reference here.
export function validateReferences(root, files, data) {
  const errors = [];
  let references = 0;
  for (const relative of files) {
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    for (const call of PROVIDER_CALLS) {
      for (const match of text.matchAll(call.re)) {
        references += 1;
        const chain = match[call.chainGroup];
        const line = lineAt(text, match.index);
        const list = data.providers.get(chain);
        if (!list) {
          errors.push(
            `${relative}:${line} ${call.kind}('${chain}', ...) names a chain with no providers in data/providers.json`,
          );
          continue;
        }
        if (call.idGroup !== undefined) {
          const id = match[call.idGroup];
          if (!list.some((provider) => provider.id === id)) {
            errors.push(
              `${relative}:${line} ${call.kind}('${chain}', '${id}') names a provider id absent from data/providers.json ` +
                `for ${chain}; available: ${list.map((provider) => provider.id).join(", ")}`,
            );
          }
        }
      }
    }
    for (const access of PROVIDER_ACCESS) {
      for (const match of text.matchAll(access.re)) {
        references += 1;
        const chain = match[access.group];
        const line = lineAt(text, match.index);
        if (!data.providers.has(chain)) {
          errors.push(
            `${relative}:${line} ${access.kind}.${chain} names a chain absent from data/providers.json`,
          );
        }
      }
    }
    for (const access of CHAIN_ACCESS) {
      for (const match of text.matchAll(access.re)) {
        references += 1;
        const slug = match[access.group];
        const line = lineAt(text, match.index);
        if (!data.slugs.has(slug)) {
          errors.push(
            `${relative}:${line} ${access.kind}.${slug} names a chain absent from data/chains.json`,
          );
        }
      }
    }
  }
  return { errors, references };
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

export function validateAmountFormatters(root, files, allowEntries, wholeFile) {
  const errors = [];
  let checked = 0;
  for (const relative of files) {
    if (relative === `${SITE_DIR}/${AMOUNT_JS}` || wholeFile.has(relative)) continue;
    checked += 1;
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    for (const definition of AMOUNT_DEFINITIONS) {
      for (const match of text.matchAll(definition.re)) {
        if (allowEntries.has(`${relative}\0${definition.needle}`)) continue;
        errors.push(
          `${relative}:${lineAt(text, match.index)} defines "${definition.needle}" (lossy-amount-formatter); ` +
            "use window.RotorAmount from apps/site/amount.js, or add a reviewed data/ssot-allow.json entry",
        );
      }
    }
  }
  return { errors, checked };
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
  const references = validateReferences(root, files, data);
  errors.push(...references.errors);
  const amounts = validateAmountFormatters(root, files, allowEntries, wholeFile);
  errors.push(...amounts.errors);

  let checked = 0;
  let allowlisted = 0;
  for (const relative of files) {
    checked += 1;
    if (wholeFile.has(relative)) {
      allowlisted += 1;
      continue;
    }
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    const spans = urlSpans(text);
    for (const needle of needles) {
      const hits = occurrences(text, needle);
      if (hits.length === 0) continue;
      const allowed = allowEntries.has(`${relative}\0${needle}`);
      for (const hit of hits) {
        if (insideUrl(spans, hit.index)) {
          errors.push(
            `${relative}:${hit.line} contains the canonical provider host ${JSON.stringify(needle)} ` +
              "inside an http(s) URL literal; allowlist entries cover plain text only",
          );
        } else if (!allowed) {
          errors.push(
            `${relative}:${hit.line} carries the canonical provider host ${JSON.stringify(needle)}; ` +
              "read window.RotorProviders / window.RotorChains instead, or add a reviewed data/ssot-allow.json entry",
          );
        } else {
          allowlisted += 1;
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    needles,
    checked,
    allowlisted,
    references: references.references,
    amountFormatters: amounts.checked,
  };
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
        `${result.allowlisted} allowlisted occurrence(s), ${result.references} provider reference(s), ` +
        `${result.amountFormatters} amount-checked script(s))`,
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
