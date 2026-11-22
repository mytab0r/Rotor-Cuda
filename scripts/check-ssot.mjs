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
//                    data/providers.json / data/chains.json. `RotorChains.order`
//                    membership checks are validated the same way.
//   vendor-lock      every data/vendor.lock.json entry matches its source and
//                    target byte for byte, and every file under web/public is
//                    locked or listed as an intentional non-copy.
//   detector-registry every id emitted by scripts/ui-audit.mjs appears in
//                    data/detectors.json, every defect-ledger detector names an
//                    implemented registry entry, and the generated markdown
//                    tables (scripts/gen-detector-docs.mjs) are current.
//   chain-color      no first-party apps/site/*.js or *.css file carries a
//                    canonical chain color outside the generated globals and
//                    the marked `chains:start` CSS region.
//   chain-order      no first-party apps/site/*.js file declares its own
//                    chain-order array starting with 'bitcoin'. Consumers must
//                    read `window.RotorChains.order`; reviewed exceptions carry
//                    an allowlist entry.
//
// data/ssot-allow.json records the known exceptions. The list is shrink-only:
// a new literal fails, an entry whose match no longer occurs fails as stale,
// and an expired entry fails. Vendored bundles may use `"match": "*"` to opt
// the whole file out.
//
// Zero dependencies; Windows-safe. Exit: 0 = clean, 1 = violations.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO_ROOT, run } from "./gen-ssot.mjs";
import { validateAuditCoverage, validateDefectCoverage, validateRegistry } from "./lib/detectors.mjs";
import { checkDetectorDocs } from "./gen-detector-docs.mjs";
import { findGeneratedRegions } from "./generated-regions.mjs";

const SITE_DIR = "apps/site";
const GENERATED_JS = "chains.generated.js";
const AMOUNT_JS = "amount.js";
const ALLOW_PATH = "data/ssot-allow.json";
const VENDOR_LOCK_PATH = "data/vendor.lock.json";
const WEB_PUBLIC_DIR = "web/public";
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

function listCssFiles(root) {
  return fs
    .readdirSync(path.join(root, SITE_DIR))
    .filter((name) => name.endsWith(".css"))
    .sort()
    .map((name) => `${SITE_DIR}/${name}`);
}

// Generated regions are the documented home of generated values. Strip every
// region registered in scripts/generated-regions.mjs before a scanner looks for
// copied facts; tokens and chains are the current registrations.
function outsideGeneratedRegion(relative, text) {
  if (relative !== "apps/site/site.css") return text;
  let out = text;
  const regions = findGeneratedRegions(text, { file: relative });
  for (const region of regions.reverse()) {
    out = out.slice(0, region.start) + out.slice(region.end + region.endMarker.length);
  }
  return out;
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
// lossy-amount-formatter. It catches declarations, function expressions and
// `var x =` aliases, Number amount math and BigInt power-of-ten scaling.
const AMOUNT_DEFINITIONS = [
  {
    name: "a local amount function",
    re: /\bfunction\s+(?:formatUnits|formatUnits6|parseUnits|coin|formatEth)\s*\(/g,
  },
  {
    name: "a local amount function alias",
    re: /\b(?:const|let|var)\s+(?:formatUnits|formatUnits6|parseUnits|coin|formatEth)\s*=/g,
  },
  {
    name: "Number amount math",
    re: /\bMath\.pow\(\s*10\s*,/g,
  },
  {
    name: "BigInt decimal scaling",
    re: /\b10n\s*\*\*\s*(?:BigInt\(|\d+n?)/g,
  },
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
  {
    kind: "order",
    re: /\b(?:SSOT_CHAINS|RotorChains)\.order\.(?:indexOf|includes|lastIndexOf)\(\s*(['"])([a-z0-9-]+)\1\s*\)/g,
    group: 2,
  },
];

// The generated globals are the runtime contract. A typo in a chain slug or a
// provider id is not caught by the literal or freshness checks, and it crashes
// the page on `find(...).url`; validate every static reference here.
export function validateReferences(root, files, data) {
  const errors = [];
  const mainnet = new Set(
    data.chains.filter((chain) => !chain.testnet).map((chain) => chain.slug),
  );
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
        const known = access.kind === "order" ? mainnet.has(slug) : data.slugs.has(slug);
        if (!known) {
          errors.push(
            `${relative}:${line} ${access.kind} reference names ${slug}, absent from ` +
              (access.kind === "order" ? "the canonical production order" : "data/chains.json"),
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

function lineTextAt(text, index) {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

// Allowlist entries cover the exact reviewed line: a fee-cap constant or a
// fiat conversion is not an amount formatter, and the entry still carries
// reason/owner/expires through validateAllowlist above.
function allowlistedAmount(allow, relative, text, match) {
  if (!Array.isArray(allow)) return false;
  const line = lineTextAt(text, match.index);
  return allow.some(
    (entry) =>
      entry &&
      entry.file === relative &&
      entry.match !== "*" &&
      typeof entry.match === "string" &&
      line.includes(entry.match),
  );
}

export function validateAmountFormatters(root, files, allow, wholeFile) {
  const errors = [];
  let checked = 0;
  for (const relative of files) {
    if (relative === `${SITE_DIR}/${AMOUNT_JS}` || wholeFile.has(relative)) continue;
    checked += 1;
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    for (const definition of AMOUNT_DEFINITIONS) {
      for (const match of text.matchAll(definition.re)) {
        if (allowlistedAmount(allow, relative, text, match)) continue;
        errors.push(
          `${relative}:${lineAt(text, match.index)} defines ${definition.name} (lossy-amount-formatter); ` +
            "use window.RotorAmount from apps/site/amount.js, or add a reviewed data/ssot-allow.json entry",
        );
      }
    }
  }
  return { errors, checked };
}

function sha256File(full) {
  return createHash("sha256").update(fs.readFileSync(full)).digest("hex");
}

function walkFiles(root, relative) {
  const files = [];
  const visit = (dirRelative) => {
    const full = path.join(root, dirRelative);
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const child = `${dirRelative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  if (fs.existsSync(path.join(root, relative))) visit(relative);
  return files.sort();
}

function relativePathErrors(root, relative, prefix) {
  const errors = [];
  if (typeof relative !== "string" || relative.trim() === "") {
    errors.push(`vendor-lock-digest: ${prefix} must be a non-empty path`);
    return errors;
  }
  if (path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").includes("..")) {
    errors.push(`vendor-lock-digest: ${prefix} must be a relative POSIX path: ${relative}`);
  }
  if (!fs.existsSync(path.join(root, relative))) {
    errors.push(`vendor-lock-digest: ${prefix} does not exist: ${relative}`);
  }
  return errors;
}

// web/public/ holds byte copies of apps/site assets for the Astro pilot. The
// lock is the machine source: a digest mismatch, a missing file or a new file
// under web/public without an entry fails here.
export function validateVendorLock(root = REPO_ROOT) {
  let json;
  try {
    json = readJson(root, VENDOR_LOCK_PATH);
  } catch (error) {
    return { errors: [`vendor-lock-digest: ${error.message}`], entries: 0, nonCopies: 0 };
  }
  const errors = [];
  if (!isObject(json) || json.version !== 1 || !Array.isArray(json.entries) || !Array.isArray(json.nonCopies)) {
    return {
      errors: [`vendor-lock-digest: ${VENDOR_LOCK_PATH} must be { version: 1, entries: [], nonCopies: [] }`],
      entries: 0,
      nonCopies: 0,
    };
  }

  const targets = new Set();
  for (const [index, entry] of json.entries.entries()) {
    const where = `${VENDOR_LOCK_PATH}.entries[${index}]`;
    if (!isObject(entry)) {
      errors.push(`vendor-lock-digest: ${where} must be an object`);
      continue;
    }
    for (const field of ["source", "target", "sha256"]) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        errors.push(`vendor-lock-digest: ${where}.${field} must be a non-empty string`);
      }
    }
    if (typeof entry.source === "string" && !entry.source.startsWith(`${SITE_DIR}/`)) {
      errors.push(`vendor-lock-digest: ${where}.source must live under ${SITE_DIR}/: ${entry.source}`);
    }
    if (typeof entry.target === "string" && !entry.target.startsWith(`${WEB_PUBLIC_DIR}/`)) {
      errors.push(`vendor-lock-digest: ${where}.target must live under ${WEB_PUBLIC_DIR}/: ${entry.target}`);
    }
    const before = errors.length;
    errors.push(...relativePathErrors(root, entry.source, `${where}.source`));
    errors.push(...relativePathErrors(root, entry.target, `${where}.target`));
    if (entry.target) {
      if (targets.has(entry.target)) errors.push(`vendor-lock-digest: ${where}.target repeats ${entry.target}`);
      targets.add(entry.target);
    }
    if (errors.length !== before) continue;
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
      errors.push(`vendor-lock-digest: ${where}.sha256 must be 64 lowercase hex characters`);
      continue;
    }
    const sourceDigest = sha256File(path.join(root, entry.source));
    const targetDigest = sha256File(path.join(root, entry.target));
    if (entry.sha256 !== sourceDigest) {
      errors.push(
        `vendor-lock-digest: ${where}.sha256 does not match ${entry.source}: ` +
          `locked ${entry.sha256}, actual ${sourceDigest}`,
      );
    }
    if (targetDigest !== sourceDigest) {
      errors.push(
        `vendor-lock-digest: ${entry.target} drifted from ${entry.source}: ` +
          `copy ${targetDigest}, source ${sourceDigest}; copy apps/site again`,
      );
    }
  }

  for (const file of walkFiles(root, WEB_PUBLIC_DIR)) {
    if (!targets.has(file)) {
      errors.push(
        `vendor-lock-digest: ${file} is not in ${VENDOR_LOCK_PATH}; add the source/digest pair or remove the copy`,
      );
    }
  }

  const seenNonCopies = new Set();
  for (const [index, entry] of json.nonCopies.entries()) {
    const where = `${VENDOR_LOCK_PATH}.nonCopies[${index}]`;
    if (!isObject(entry)) {
      errors.push(`vendor-lock-digest: ${where} must be an object`);
      continue;
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      errors.push(`vendor-lock-digest: ${where}.reason must explain why the file is not copied`);
    }
    if (typeof entry.source !== "string" || !entry.source.startsWith(`${SITE_DIR}/`)) {
      errors.push(`vendor-lock-digest: ${where}.source must live under ${SITE_DIR}/`);
      continue;
    }
    if (seenNonCopies.has(entry.source)) errors.push(`vendor-lock-digest: ${where}.source repeats ${entry.source}`);
    seenNonCopies.add(entry.source);
    errors.push(...relativePathErrors(root, entry.source, `${where}.source`));
  }

  return { errors, entries: json.entries.length, nonCopies: json.nonCopies.length };
}

// One detector registry: data/detectors.json. The audit must be covered, a
// defect-ledger detector must resolve to an implemented entry, and the three
// generated markdown tables must match the registry.
export function validateDetectors(root = REPO_ROOT) {
  const registry = validateRegistry(root);
  const errors = [...registry.errors];
  if (registry.ok) {
    errors.push(...validateAuditCoverage(root, registry));
    errors.push(...validateDefectCoverage(root, registry));
    errors.push(...checkDetectorDocs(root).errors);
  }
  return { errors, entries: registry.entries.length };
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
  const amounts = validateAmountFormatters(root, files, allow, wholeFile);
  errors.push(...amounts.errors);

  const vendor = validateVendorLock(root);
  errors.push(...vendor.errors);
  const detectors = validateDetectors(root);
  errors.push(...detectors.errors);

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

  // Canonical chain colors must live only in the generated outputs. A color in
  // a first-party CSS rule or JS table is a copied fact.
  const colors = new Set(data.chains.map((chain) => chain.color.toLowerCase()));
  const cssFiles = listCssFiles(root);
  let colorOccurrences = 0;
  for (const relative of [...files, ...cssFiles]) {
    const text = outsideGeneratedRegion(
      relative,
      fs.readFileSync(path.join(root, relative), "utf8"),
    );
    const lines = text.split("\n");
    for (const color of colors) {
      for (const hit of occurrences(text, color)) {
        colorOccurrences += 1;
        const lineText = (lines[hit.line - 1] ?? "").trim();
        if (!allowEntries.has(`${relative}\0${lineText}`)) {
          errors.push(
            `${relative}:${hit.line} repeats the canonical chain color ${color}; ` +
              "read var(--chain-<slug>) / window.RotorChains.bySlug[slug].color instead",
          );
        }
      }
    }
  }

  // A local chain-order array drifts from data/chains.json. The canonical
  // order is window.RotorChains.order (and chain::all() in Rust).
  const orderArray = /\bvar\s+[A-Za-z_$][\w$]*\s*=\s*\[\s*(['"])bitcoin\1/g;
  let orderArrays = 0;
  for (const relative of files) {
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    const lines = text.split("\n");
    for (const match of text.matchAll(orderArray)) {
      orderArrays += 1;
      const line = lineAt(text, match.index);
      const lineText = (lines[line - 1] ?? "").trim();
      if (!allowEntries.has(`${relative}\0${lineText}`)) {
        errors.push(
          `${relative}:${line} declares a local chain-order array; ` +
            "read window.RotorChains.order instead, or add a reviewed data/ssot-allow.json entry",
        );
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
    colorOccurrences,
    orderArrays,
    amountFormatters: amounts.checked,
    vendorEntries: vendor.entries,
    vendorNonCopies: vendor.nonCopies,
    detectors: detectors.entries,
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
        `${result.allowlisted} allowlisted occurrence(s), ${result.references} provider/chain reference(s), ` +
        `${result.amountFormatters} amount-checked script(s), ${result.vendorEntries} vendor lock entries ` +
        `(${result.vendorNonCopies} intentional non-copies), ${result.detectors} detectors, ` +
        `${result.colorOccurrences} chain color literal(s) outside the generated output, ` +
        `${result.orderArrays} local order array(s))`,
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
