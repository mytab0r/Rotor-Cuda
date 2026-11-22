#!/usr/bin/env node
// Generate the single-source-of-truth chain/provider layer.
//
// Source of truth:
//   - data/chains.json     chain identity (slug, name, symbol, color, decimals,
//                          order, family, explorer)
//   - data/providers.json  per-chain ordered public RPC/API endpoints + groups
//
// Outputs:
//   - apps/site/chains.generated.js  ES5 globals for the build-less site
//   - src/generated/chains.rs        Rust constants for the coordinator/CLI
//   - apps/site/site.css             the marked `chains:start` region only
//
// `--check` regenerates all three in memory and exits 1 with a line diff
// summary when a committed output is stale.
//
// `--vendor-lock` regenerates the outputs, then copies every pair in
// data/vendor.lock.json from apps/site to web/public and rewrites the SHA-256
// digests. Run it after every merge (or any apps/site edit) so the lock cannot
// stay stale; `scripts/check-ssot.mjs` still verifies the result.
//
// Node built-ins only; no dependencies, Windows-safe.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CHAINS_REGION } from "./generated-regions.mjs";

export const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const CHAINS_PATH = "data/chains.json";
const PROVIDERS_PATH = "data/providers.json";
const VENDOR_LOCK_PATH = "data/vendor.lock.json";
const JS_PATH = "apps/site/chains.generated.js";
const RS_PATH = "src/generated/chains.rs";
const CSS_PATH = "apps/site/site.css";
const CSS_START = CHAINS_REGION.start;
const CSS_END = CHAINS_REGION.end;
const COLOR_RE = /^#[0-9a-f]{6}$/;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FAMILIES = new Set([
  "btc",
  "evm",
  "solana",
  "tron",
  "ton",
  "sui",
  "xrp",
  "ltc",
  "bch",
  "doge",
  "zcash",
]);

function fail(message) {
  throw new Error(message);
}

function readJson(root, relative) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, relative), "utf8");
  } catch (error) {
    fail(`cannot read ${relative}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`cannot parse ${relative}: ${error.message}`);
  }
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertHttpsUrl(where, value) {
  if (!isNonEmptyString(value)) fail(`${where} must be a non-empty URL`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${where} is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:") fail(`${where} must use https: ${value}`);
  if (url.username || url.password || value.includes("@")) {
    fail(`${where} must not carry credentials: ${value}`);
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    fail(`${where} must not point at a private host: ${value}`);
  }
  return url;
}

function assertTemplate(where, value, placeholder) {
  assertHttpsUrl(where, value);
  if (!value.endsWith(`{${placeholder}}`)) {
    fail(`${where} must end with {${placeholder}}: ${value}`);
  }
}

function unique(values, where) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`${where} repeats ${value}`);
    seen.add(value);
  }
}

export function loadData(root = REPO_ROOT) {
  const chainsJson = readJson(root, CHAINS_PATH);
  const providersJson = readJson(root, PROVIDERS_PATH);

  if (!isObject(chainsJson) || chainsJson.version !== 1 || !Array.isArray(chainsJson.chains)) {
    fail(`${CHAINS_PATH} must be { version: 1, chains: [...] }`);
  }
  if (!isObject(providersJson) || providersJson.version !== 1 ||
      !isObject(providersJson.groups) || !isObject(providersJson.chains)) {
    fail(`${PROVIDERS_PATH} must be { version: 1, groups: {}, chains: {} }`);
  }

  const chains = [];
  const slugs = new Set();
  const orders = new Set();
  for (const [index, chain] of chainsJson.chains.entries()) {
    const where = `${CHAINS_PATH}.chains[${index}]`;
    if (!isObject(chain)) fail(`${where} must be an object`);
    if (!isNonEmptyString(chain.slug) || !SLUG_RE.test(chain.slug)) {
      fail(`${where}.slug must match ${SLUG_RE}`);
    }
    if (slugs.has(chain.slug)) fail(`${CHAINS_PATH} repeats chain slug ${chain.slug}`);
    slugs.add(chain.slug);
    for (const field of ["name", "symbol", "family"]) {
      if (!isNonEmptyString(chain[field])) fail(`${where}.${field} must be a non-empty string`);
    }
    if (!FAMILIES.has(chain.family)) fail(`${where}.family is unknown: ${chain.family}`);
    if (typeof chain.color !== "string" || !COLOR_RE.test(chain.color)) {
      fail(`${where}.color must be a lowercase #rrggbb literal`);
    }
    if (!Number.isInteger(chain.decimals) || chain.decimals < 0 || chain.decimals > 30) {
      fail(`${where}.decimals must be an integer between 0 and 30`);
    }
    if (!Number.isInteger(chain.order) || chain.order < 1) {
      fail(`${where}.order must be a positive integer`);
    }
    if (orders.has(chain.order)) fail(`${CHAINS_PATH} repeats chain order ${chain.order}`);
    orders.add(chain.order);
    if (chain.testnet !== undefined && typeof chain.testnet !== "boolean") {
      fail(`${where}.testnet must be a boolean`);
    }
    assertTemplate(`${where}.explorer`, chain.explorer, "address");
    if (chain.explorerTx !== undefined) assertTemplate(`${where}.explorerTx`, chain.explorerTx, "tx");
    chains.push({
      slug: chain.slug,
      name: chain.name,
      symbol: chain.symbol,
      color: chain.color,
      decimals: chain.decimals,
      order: chain.order,
      family: chain.family,
      testnet: chain.testnet === true,
      explorer: chain.explorer,
      explorerTx: chain.explorerTx ?? null,
    });
  }
  chains.sort((left, right) => left.order - right.order);

  const providers = new Map();
  for (const [slug, list] of Object.entries(providersJson.chains)) {
    if (!slugs.has(slug)) fail(`${PROVIDERS_PATH}.chains.${slug} is not a chain in ${CHAINS_PATH}`);
    if (!Array.isArray(list) || list.length === 0) {
      fail(`${PROVIDERS_PATH}.chains.${slug} must be a non-empty array`);
    }
    const ids = [];
    const entries = [];
    for (const [index, provider] of list.entries()) {
      const where = `${PROVIDERS_PATH}.chains.${slug}[${index}]`;
      if (!isObject(provider)) fail(`${where} must be an object`);
      for (const field of ["id", "url", "label"]) {
        if (!isNonEmptyString(provider[field])) fail(`${where}.${field} must be a non-empty string`);
      }
      if (!SLUG_RE.test(provider.id)) fail(`${where}.id must match ${SLUG_RE}`);
      assertHttpsUrl(`${where}.url`, provider.url);
      if (provider.testnet !== undefined && typeof provider.testnet !== "boolean") {
        fail(`${where}.testnet must be a boolean`);
      }
      ids.push(provider.id);
      entries.push({
        id: provider.id,
        url: provider.url,
        label: provider.label,
        testnet: provider.testnet === true,
      });
    }
    unique(ids, `${PROVIDERS_PATH}.chains.${slug}`);
    providers.set(slug, entries);
  }

  const groups = new Map();
  for (const [name, list] of Object.entries(providersJson.groups)) {
    if (!SLUG_RE.test(name)) fail(`${PROVIDERS_PATH}.groups.${name} must match ${SLUG_RE}`);
    if (!Array.isArray(list) || list.length === 0) {
      fail(`${PROVIDERS_PATH}.groups.${name} must be a non-empty array`);
    }
    for (const slug of list) {
      if (!slugs.has(slug)) fail(`${PROVIDERS_PATH}.groups.${name} names unknown chain ${slug}`);
    }
    unique(list, `${PROVIDERS_PATH}.groups.${name}`);
    groups.set(name, list.slice());
  }

  validateTestnets(chains, providers);
  return { chains, providers, groups, slugs };
}

// The TRON flow admits no chain-id check, and Sepolia/BNB testnet/Bitcoin
// testnet have the same risk: a provider URL edit must not silently point a
// testnet page at a mainnet endpoint. Testnet chains and every one of their
// provider entries carry `testnet: true`; the URL must also carry a testnet
// host or path token. The one shared host (`mempool.space`) is accepted only
// because its path starts with `/testnet/`.
const TESTNET_TOKENS = ["nile", "sepolia", "prebsc", "testnet"];

function testnetEndpoint(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const path = `${url.pathname}${url.search}`.toLowerCase();
  return TESTNET_TOKENS.some((token) => host.includes(token) || path.includes(token));
}

function validateTestnets(chains, providers) {
  const mainnetUrls = new Set();
  const mainnetHosts = new Set();
  for (const chain of chains) {
    if (chain.testnet) continue;
    for (const provider of providers.get(chain.slug) || []) {
      mainnetUrls.add(provider.url);
      mainnetHosts.add(new URL(provider.url).hostname.toLowerCase());
    }
  }

  for (const chain of chains) {
    const list = providers.get(chain.slug) || [];
    for (const [index, provider] of list.entries()) {
      const where = `${PROVIDERS_PATH}.chains.${chain.slug}[${index}]`;
      const url = new URL(provider.url);
      const host = url.hostname.toLowerCase();
      const path = `${url.pathname}${url.search}`.toLowerCase();
      if (chain.testnet) {
        if (!provider.testnet) {
          fail(`${where}.testnet must be true because ${chain.slug} is marked testnet`);
        }
        if (!testnetEndpoint(provider.url)) {
          fail(
            `${where} has no testnet marker in host or path (${TESTNET_TOKENS.join(", ")}): ${provider.url}`,
          );
        }
        if (mainnetUrls.has(provider.url)) {
          fail(`${where} reuses a mainnet provider URL: ${provider.url}`);
        }
        if (mainnetHosts.has(host) && !TESTNET_TOKENS.some((token) => path.includes(token))) {
          fail(
            `${where} shares mainnet host ${host} without a testnet path marker: ${provider.url}`,
          );
        }
      } else {
        if (provider.testnet) {
          fail(`${where}.testnet is true on mainnet chain ${chain.slug}`);
        }
        if (testnetEndpoint(provider.url)) {
          fail(`${where} points a mainnet chain at a testnet endpoint: ${provider.url}`);
        }
      }
    }
  }
}

// Preserve the checkout's line endings: Git may hand us CRLF on Windows and LF
// on CI. Every generated line uses the same terminator.
function detectEol(text, fallback = "\n") {
  return text.includes("\r\n") ? "\r\n" : fallback;
}

function withEol(text, eol) {
  return text.replaceAll("\n", eol);
}

function prefixOf(template) {
  const index = template.indexOf("{");
  return index === -1 ? template : template.slice(0, index);
}

function renderJs(data, eol = "\n") {
  // `data.chains` is already sorted by the canonical `order`; production
  // chains (the 18 site hubs) come before the testnets and drive every
  // consumer-facing list.
  const orders = data.chains
    .filter((chain) => !chain.testnet)
    .map((chain) => chain.slug);
  const bySlug = {};
  for (const chain of data.chains) {
    bySlug[chain.slug] = {
      slug: chain.slug,
      name: chain.name,
      symbol: chain.symbol,
      color: chain.color,
      decimals: chain.decimals,
      order: chain.order,
      family: chain.family,
      testnet: chain.testnet,
      icon: `chain-${chain.slug}`,
      explorer: chain.explorer,
      explorerPrefix: prefixOf(chain.explorer),
      explorerTx: chain.explorerTx,
      explorerTxPrefix: chain.explorerTx ? prefixOf(chain.explorerTx) : null,
    };
  }
  const byChain = {};
  for (const [slug, list] of data.providers) {
    byChain[slug] = list.map((provider) => ({
      id: provider.id,
      url: provider.url,
      label: provider.label,
    }));
  }
  const groups = {};
  for (const [name, list] of data.groups) groups[name] = list;

  const lines = [
    "/* DO NOT EDIT - generated by scripts/gen-ssot.mjs.",
    " * Source of truth: data/chains.json and data/providers.json.",
    " * Run `node scripts/gen-ssot.mjs` after editing either file;",
    " * `node scripts/gen-ssot.mjs --check` fails when this file is stale. */",
    "(function (root) {",
    "  'use strict';",
    `  var CHAIN_ORDER = ${JSON.stringify(orders)};`,
    `  var CHAIN_BY_SLUG = ${JSON.stringify(bySlug, null, 2).replaceAll("\n", "\n  ")};`,
    `  var PROVIDER_GROUPS = ${JSON.stringify(groups, null, 2).replaceAll("\n", "\n  ")};`,
    `  var PROVIDER_BY_CHAIN = ${JSON.stringify(byChain, null, 2).replaceAll("\n", "\n  ")};`,
    "",
    "  function first(slug) {",
    "    var list = PROVIDER_BY_CHAIN[slug];",
    "    return list && list.length ? list[0] : null;",
    "  }",
    "",
    "  function find(slug, id) {",
    "    var list = PROVIDER_BY_CHAIN[slug] || [];",
    "    for (var index = 0; index < list.length; index += 1) {",
    "      if (list[index].id === id) return list[index];",
    "    }",
    "    return null;",
    "  }",
    "",
    "  root.RotorChains = {",
    "    version: 1,",
    "    order: CHAIN_ORDER,",
    "    bySlug: CHAIN_BY_SLUG",
    "  };",
    "  root.RotorProviders = {",
    "    version: 1,",
    "    groups: PROVIDER_GROUPS,",
    "    byChain: PROVIDER_BY_CHAIN,",
    "    first: first,",
    "    find: find",
    "  };",
    "})(typeof globalThis !== 'undefined' ? globalThis : this);",
    "",
  ];
  return withEol(lines.join("\n"), eol);
}

function rustString(value) {
  return JSON.stringify(value);
}

function renderRs(data, eol = "\n") {
  const lines = [
    "// DO NOT EDIT - generated by scripts/gen-ssot.mjs.",
    "// Source of truth: data/chains.json and data/providers.json.",
    "// Run `node scripts/gen-ssot.mjs` after editing either file;",
    "// `node scripts/gen-ssot.mjs --check` fails when this file is stale.",
    "",
    "#[rustfmt::skip]",
    "pub static CHAINS: &[&str] = &[",
  ];
  for (const chain of data.chains) lines.push(`    ${rustString(chain.slug)},`);
  lines.push("];", "");

  lines.push("#[rustfmt::skip]", "pub static CHAINS_MAINNET: &[&str] = &[");
  for (const chain of data.chains) {
    if (chain.testnet) continue;
    lines.push(`    ${rustString(chain.slug)},`);
  }
  lines.push("];", "");

  const tables = [
    ["CHAIN_NAMES", (chain) => [chain.slug, chain.name]],
    ["CHAIN_SYMBOLS", (chain) => [chain.slug, chain.symbol]],
    ["CHAIN_COLORS", (chain) => [chain.slug, chain.color]],
    ["CHAIN_ICONS", (chain) => [chain.slug, `chain-${chain.slug}`]],
    ["CHAIN_FAMILIES", (chain) => [chain.slug, chain.family]],
    ["CHAIN_EXPLORERS", (chain) => [chain.slug, chain.explorer]],
  ];
  for (const [name, map] of tables) {
    lines.push("#[rustfmt::skip]", `pub static ${name}: &[(&str, &str)] = &[`);
    for (const chain of data.chains) {
      const [slug, value] = map(chain);
      lines.push(`    (${rustString(slug)}, ${rustString(value)}),`);
    }
    lines.push("];", "");
  }

  lines.push(
    "#[rustfmt::skip]",
    "pub static CHAIN_DECIMALS: &[(&str, u8)] = &[",
  );
  for (const chain of data.chains) {
    lines.push(`    (${rustString(chain.slug)}, ${chain.decimals}),`);
  }
  lines.push("];", "");

  lines.push(
    "#[rustfmt::skip]",
    "pub static CHAIN_ORDERS: &[(&str, u16)] = &[",
  );
  for (const chain of data.chains) {
    lines.push(`    (${rustString(chain.slug)}, ${chain.order}),`);
  }
  lines.push("];", "");

  lines.push(
    "#[rustfmt::skip]",
    "pub static CHAIN_EXPLORER_TX: &[(&str, &str)] = &[",
  );
  for (const chain of data.chains) {
    if (!chain.explorerTx) continue;
    lines.push(`    (${rustString(chain.slug)}, ${rustString(chain.explorerTx)}),`);
  }
  lines.push("];", "");

  lines.push(
    "#[rustfmt::skip]",
    "pub static PROVIDER_GROUPS: &[(&str, &[&str])] = &[",
  );
  for (const [name, list] of data.groups) {
    lines.push(`    (${rustString(name)}, &[${list.map(rustString).join(", ")}]),`);
  }
  lines.push("];", "");

  lines.push(
    "use super::ProviderEntry;",
    "",
    "#[rustfmt::skip]",
    "pub static PROVIDERS: &[(&str, &[ProviderEntry])] = &[",
  );
  for (const [slug, list] of data.providers) {
    lines.push("    (");
    lines.push(`        ${rustString(slug)},`);
    lines.push("        &[");
    for (const provider of list) {
      lines.push(
        `            (${rustString(provider.id)}, ${rustString(provider.url)}, ${rustString(provider.label)}),`,
      );
    }
    lines.push("        ],");
    lines.push("    ),");
  }
  lines.push("];", "");

  return withEol(lines.join("\n"), eol);
}

// Families whose color classes exist in first-party CSS. The representative
// chain is the first production chain of that family in canonical order.
const CARD_FAMILIES = ["btc", "evm", "tron", "solana", "ltc", "doge", "bch", "xrp"];
const KEY_DOT_FAMILIES = [
  "btc",
  "evm",
  "tron",
  "solana",
  "ltc",
  "doge",
  "bch",
  "xrp",
  "zcash",
  "sui",
  "ton",
];
const MONITOR_FAMILIES = ["evm", "btc", "tron", "solana"];

function familyRepresentatives(data) {
  const byFamily = new Map();
  for (const chain of data.chains) {
    if (chain.testnet) continue;
    if (!byFamily.has(chain.family)) byFamily.set(chain.family, chain.slug);
  }
  for (const family of new Set([...CARD_FAMILIES, ...KEY_DOT_FAMILIES, ...MONITOR_FAMILIES])) {
    if (!byFamily.has(family)) fail(`no production chain carries family ${family}`);
  }
  return byFamily;
}

function renderCssRegion(data, eol = "\n") {
  const families = familyRepresentatives(data);
  const lines = [
    CSS_START,
    "/* DO NOT EDIT - generated by scripts/gen-ssot.mjs from data/chains.json.",
    " * All chain colors live here; first-party CSS and JS read these values. */",
    ":root {",
  ];
  for (const chain of data.chains) {
    lines.push(`  --chain-${chain.slug}: ${chain.color};`);
  }
  lines.push("}");
  for (const family of CARD_FAMILIES) {
    lines.push(`.chain-${family} { --chain-color: var(--chain-${families.get(family)}); }`);
  }
  for (const family of KEY_DOT_FAMILIES) {
    lines.push(`.key-dot-${family} { background: var(--chain-${families.get(family)}); }`);
  }
  for (const family of MONITOR_FAMILIES) {
    const value = `var(--chain-${families.get(family)})`;
    lines.push(`.monitor-chain-${family} { border-color: ${value}; color: ${value}; }`);
  }
  lines.push(CSS_END);
  return withEol(lines.join("\n"), eol);
}

function renderCss(data, actual, eol = "\n") {
  const start = actual.indexOf(CSS_START);
  const end = actual.indexOf(CSS_END);
  if (start === -1 || end === -1 || end < start) {
    fail(`${CSS_PATH} must contain ${CSS_START} and ${CSS_END} markers`);
  }
  return (
    actual.slice(0, start) +
    renderCssRegion(data, eol) +
    actual.slice(end + CSS_END.length)
  );
}

function diffSummary(actual, expected) {
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  const length = Math.max(actualLines.length, expectedLines.length);
  let first = -1;
  let changed = 0;
  for (let index = 0; index < length; index += 1) {
    if (actualLines[index] === expectedLines[index]) continue;
    changed += 1;
    if (first === -1) first = index;
  }
  if (first === -1) return null;
  return {
    changed,
    first: first + 1,
    actual: (actualLines[first] ?? "").replace(/\r$/, "").slice(0, 180),
    expected: (expectedLines[first] ?? "").replace(/\r$/, "").slice(0, 180),
  };
}

function readIfExists(root, relative) {
  const full = path.join(root, relative);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}

function writeIfChanged(root, relative, content) {
  const full = path.join(root, relative);
  if (fs.existsSync(full) && fs.readFileSync(full, "utf8") === content) return false;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return true;
}

function sha256File(full) {
  return createHash("sha256").update(fs.readFileSync(full)).digest("hex");
}

// A merge that touches apps/site changes every copy in web/public and makes
// the lock digests stale. `--vendor-lock` copies each locked source to its
// target and rewrites the digests, so refreshing after a merge is one command
// instead of hand-editing hashes. Generated outputs are refreshed first.
export function regenerateVendorLock(root = REPO_ROOT) {
  const lock = readJson(root, VENDOR_LOCK_PATH);
  if (!lock || lock.version !== 1 || !Array.isArray(lock.entries)) {
    fail(`${VENDOR_LOCK_PATH} must be { version: 1, entries: [...] }`);
  }
  const copied = [];
  const updated = [];
  for (const [index, entry] of lock.entries.entries()) {
    const where = `${VENDOR_LOCK_PATH}.entries[${index}]`;
    if (!entry || typeof entry.source !== "string" || typeof entry.target !== "string") {
      fail(`${where} needs string source and target`);
    }
    for (const field of ["source", "target"]) {
      const relative = entry[field];
      if (path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").includes("..")) {
        fail(`${where}.${field} must be a relative POSIX path: ${relative}`);
      }
    }
    const source = path.join(root, entry.source);
    const target = path.join(root, entry.target);
    if (!fs.existsSync(source)) fail(`${where}.source does not exist: ${entry.source}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    const digest = sha256File(source);
    if (entry.sha256 !== digest) {
      entry.sha256 = digest;
      updated.push(entry.target);
    }
    copied.push(entry.target);
  }
  for (const [index, entry] of (lock.nonCopies || []).entries()) {
    if (!entry || typeof entry.source !== "string") {
      fail(`${VENDOR_LOCK_PATH}.nonCopies[${index}].source must be a string`);
    }
    if (!fs.existsSync(path.join(root, entry.source))) {
      fail(`${VENDOR_LOCK_PATH}.nonCopies[${index}].source does not exist: ${entry.source}`);
    }
  }
  const full = path.join(root, VENDOR_LOCK_PATH);
  const actual = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
  const content = withEol(`${JSON.stringify(lock, null, 2)}\n`, detectEol(actual));
  writeIfChanged(root, VENDOR_LOCK_PATH, content);
  return { copied, updated, entries: lock.entries.length };
}

export function run({ root = REPO_ROOT, check = false } = {}) {
  const data = loadData(root);
  const jsActual = readIfExists(root, JS_PATH);
  const rsActual = readIfExists(root, RS_PATH);
  const cssActual = readIfExists(root, CSS_PATH);
  const expectedJs = renderJs(data, detectEol(jsActual));
  const expectedRs = renderRs(data, detectEol(rsActual));
  const expectedCss = renderCss(data, cssActual, detectEol(cssActual));

  const messages = [];
  const stale = [];
  for (const [relative, actual, expected] of [
    [JS_PATH, jsActual, expectedJs],
    [RS_PATH, rsActual, expectedRs],
    [CSS_PATH, cssActual, expectedCss],
  ]) {
    const diff = diffSummary(actual, expected);
    if (diff) stale.push({ relative, diff });
  }

  if (check) {
    if (stale.length > 0) {
      for (const { relative, diff } of stale) {
        messages.push(
          `${relative} is stale: ${diff.changed} line(s) differ, first at line ${diff.first}\n` +
            `  expected: ${diff.expected}\n  actual:   ${diff.actual}`,
        );
      }
      messages.push(`ssot:check FAILED (${stale.length} output(s) stale); run: node scripts/gen-ssot.mjs`);
      return { ok: false, stale, messages, data };
    }
    messages.push(
      `ssot:check OK (${data.chains.length} chains, ${data.providers.size} provider tables, ` +
        `${data.groups.size} groups; ${JS_PATH}, ${RS_PATH} and the ${CSS_PATH} region current)`,
    );
    return { ok: true, stale, messages, data };
  }

  const written = [];
  if (writeIfChanged(root, JS_PATH, expectedJs)) written.push(JS_PATH);
  if (writeIfChanged(root, RS_PATH, expectedRs)) written.push(RS_PATH);
  if (writeIfChanged(root, CSS_PATH, expectedCss)) written.push(CSS_PATH);
  messages.push(
    written.length > 0
      ? `ssot: wrote ${written.join(", ")}`
      : `ssot: already current (${data.chains.length} chains, ${data.providers.size} provider tables)`,
  );
  return { ok: true, stale, messages, written, data };
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const vendorLock = argv.includes("--vendor-lock");
  const unknown = argv.filter((arg) => arg !== "--check" && arg !== "--vendor-lock");
  if (unknown.length > 0 || (check && vendorLock)) {
    if (unknown.length > 0) console.error(`error: unknown argument(s): ${unknown.join(", ")}`);
    else console.error("error: --check and --vendor-lock are mutually exclusive");
    console.error("usage: node scripts/gen-ssot.mjs [--check | --vendor-lock]");
    return 2;
  }
  try {
    if (vendorLock) {
      const generated = run({});
      for (const message of generated.messages) console.log(message);
      const result = regenerateVendorLock();
      console.log(
        `vendor-lock: copied ${result.copied.length} file(s), ` +
          `updated ${result.updated.length} digest(s) of ${result.entries}`,
      );
      return 0;
    }
    const result = run({ check });
    for (const message of result.messages) console.log(message);
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
