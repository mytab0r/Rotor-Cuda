#!/usr/bin/env node
// Token drift detectors for the Rotor design system.
//
// This is the static half of the design-system gate. Every check reads the
// committed files only; nothing here starts a browser. The rendered half stays
// in scripts/ui-audit.mjs (grammar, geometry, contrast).
//
// Checks and their contract (docs/design-system/DESIGN-SYSTEM.md §8):
//   token-contract        every tokens.json token has a generated CSS
//                         declaration, the contract and tokens.json agree, and
//                         every first-party var(--x) resolves.
//   orphan-token          a declared token with no first-party consumer is a
//                         violation unless it carries
//                         $extensions["org.rotor.css"].reserved = true.
//                         There is deliberately no timer here: the reservation
//                         is reviewed, the code only reads the flag.
//   theme-parity          every colour token declared in the generated :root
//                         region has a declaration in the generated light block.
//   radius-scale          border-radius declarations use var(--radius-*); the
//                         documented exceptions are 0, inherit and 50%.
//   raw-hex-outside-root  no #rgb/#rrggbb/#rrggbbaa colour outside the generated
//                         token regions, in first-party CSS and inline styles.
//   legacy-selector       no page-scoped override of a shared component family
//                         (the `.key-page > .card` pattern from plan.md batch 7).
//
// Pre-existing debt that needs a design decision is listed in
// design/tokens/token-usage-baseline.json with an exact file:line, the matched
// text and a reason. The baseline is shrink-only: a new violation fails, and
// an entry that no longer matches fails as stale.
//
// Zero dependencies; Windows-safe. Exit: 0 = clean, 1 = violations.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const TOKENS_PATH = "design/tokens/tokens.json";
const CONTRACT_PATH = "design/tokens/tokens.contract.json";
const BASELINE_PATH = "design/tokens/token-usage-baseline.json";
const CSS_PATH = "apps/site/site.css";
const SITE_DIR = "apps/site";
const START_MARKER = "/* tokens:start */";
const END_MARKER = "/* tokens:end */";
const CSS_COMMENT_NS = "org.rotor.css";

// Vendored bundles carry their own license files (ton.LICENSE.txt,
// wallets.LICENSE.txt) and contain third-party inline styles. They are not
// first-party site CSS, so the token rules do not apply to them.
const VENDORED_JS = new Set(["ton.js", "walletconnect.js"]);

// Documented border-radius exceptions: a reset, an inherited radius and a
// circle. They are not scale steps and cannot be expressed as --radius-*.
const RADIUS_EXCEPTIONS = new Set(["0", "inherit", "50%"]);

// Shared component families from DESIGN-SYSTEM §3. A page-scoped selector
// that reaches one of these is the legacy override the batch-7 cleanup removed.
const SHARED_FAMILIES = [
  "card",
  "data-table",
  "table-scroll",
  "icon-button",
  "field",
  "segmented",
  "chip",
  "status",
  "stat",
  "btn",
  "button",
  "badge",
  "nav",
  "breadcrumb",
  "pager",
  "empty-state",
  "error",
  "skeleton",
  "notice",
];

// Page-scope roots. A class matching one of these in an ancestor compound marks
// the rule as page-local. Kept explicit so the detector cannot silently widen.
const PAGE_ROOTS = [
  "key-page",
  "range-page",
  "monitor-page",
  "browse-page",
  "directory-page",
  "landing-page",
  "wallet-page",
  "puzzle-page",
  "send-page",
  "seed-page",
  "docs-page",
  "tools-page",
];
const PAGE_PREFIXES = [
  "key-",
  "range-",
  "monitor-",
  "browse-",
  "directory-",
  "landing-",
  "wallet-",
  "puzzle-",
  "send-",
  "seed-",
  "brainwallet-",
];

function fail(message) {
  throw new Error(message);
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function readJson(root, relative) {
  try {
    return JSON.parse(read(root, relative));
  } catch (error) {
    fail(`cannot read ${relative}: ${error.message}`);
  }
}

function list(dir, extension) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .sort();
}

function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

// Replace comment characters with spaces but keep every newline and offset, so
// line numbers and region offsets stay valid.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function isToken(value) {
  return value && typeof value === "object" && !Array.isArray(value) && "$value" in value;
}

function isGroup(value) {
  return value && typeof value === "object" && !Array.isArray(value) && !("$value" in value);
}

// Flatten primitive/semantic/component groups into { key, token, path }.
export function flattenTokens(tokens) {
  const entries = [];
  const seen = new Map();
  const walk = (group, prefix) => {
    for (const [key, value] of Object.entries(group)) {
      if (key.startsWith("$")) continue;
      const tokenPath = prefix ? `${prefix}.${key}` : key;
      if (isToken(value)) {
        if (seen.has(key)) fail(`duplicate token --${key} in ${seen.get(key)} and ${tokenPath}`);
        seen.set(key, tokenPath);
        entries.push({ key, token: value, path: tokenPath });
      } else if (isGroup(value)) {
        walk(value, tokenPath);
      } else {
        fail(`token ${tokenPath} must be a token or a group`);
      }
    }
  };
  for (const tier of ["primitive", "semantic", "component"]) {
    if (!isGroup(tokens[tier])) fail(`tokens.json is missing the ${tier} tier`);
    walk(tokens[tier], tier);
  }
  return entries;
}

export function reserved(token) {
  if (!token || typeof token !== "object") return false;
  if (token.reserved === true) return true;
  return token.$extensions?.[CSS_COMMENT_NS]?.reserved === true;
}

// Locate the two generated regions and their kinds. Offsets refer to the
// original file text (comments are not stripped for this step).
export function generatedRegions(css) {
  const regions = [];
  let cursor = 0;
  while (true) {
    const start = css.indexOf(START_MARKER, cursor);
    const end = start === -1 ? -1 : css.indexOf(END_MARKER, start + START_MARKER.length);
    if (start === -1) break;
    if (end === -1) fail(`unclosed ${START_MARKER}`);
    const bodyStart = start + START_MARKER.length;
    const region = css.slice(bodyStart, end);
    const open = region.indexOf("{");
    const selector = open === -1 ? "" : region.slice(0, open).trim();
    const kind = selector === ":root" ? "dark" : selector === 'html[data-theme="light"]' ? "light" : null;
    if (!kind) fail(`tokens region has an unknown selector: ${selector || "(empty)"}`);
    regions.push({ start, end, bodyStart, bodyEnd: end, kind });
    cursor = end + END_MARKER.length;
  }
  if (regions.length === 0) fail(`${CSS_PATH} has no generated token regions`);
  return regions;
}

function inRegion(regions, index) {
  return regions.some((region) => index >= region.start && index < region.end);
}

export function declarations(text) {
  const names = new Map();
  for (const match of text.matchAll(/(--[\w-]+)\s*:/g)) {
    if (!names.has(match[1])) names.set(match[1], match.index);
  }
  return names;
}

function localDeclarations(cssFiles, htmlFiles, jsFiles) {
  const names = new Set();
  for (const { text } of cssFiles) {
    for (const match of text.matchAll(/(--[\w-]+)\s*:/g)) names.add(match[1]);
  }
  for (const { text } of htmlFiles) {
    for (const match of text.matchAll(/style\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const value = match[1] ?? match[2] ?? "";
      for (const property of value.matchAll(/(--[\w-]+)\s*:/g)) names.add(property[1]);
    }
  }
  for (const { text } of jsFiles) {
    for (const match of text.matchAll(/setProperty\(\s*['"](--[\w-]+)['"]/g)) names.add(match[1]);
  }
  return names;
}

function addViolation(list, id, file, line, detail, match) {
  list.push({ id, file, line, detail, match });
}

// 1. token-contract ---------------------------------------------------------
export function checkTokenContract({ css, tokens, contract, regions, cssFiles, htmlFiles, jsFiles }) {
  const violations = [];
  const entries = flattenTokens(tokens);
  const jsonNames = new Set(entries.map((entry) => entry.key));
  const regionText = (kind) => {
    const region = regions.find((candidate) => candidate.kind === kind);
    if (!region) fail(`missing ${kind} tokens region`);
    return css.slice(region.bodyStart, region.bodyEnd);
  };
  const dark = declarations(regionText("dark"));
  const light = declarations(regionText("light"));

  for (const entry of entries) {
    if (!dark.has(`--${entry.key}`)) {
      addViolation(
        violations,
        "token-contract",
        TOKENS_PATH,
        1,
        `token --${entry.key} (${entry.path}) has no declaration in the generated :root region`,
        `--${entry.key}`,
      );
    }
  }
  for (const name of dark.keys()) {
    if (!jsonNames.has(name.slice(2))) {
      addViolation(
        violations,
        "token-contract",
        CSS_PATH,
        1,
        `--${name.slice(2)} is declared in the generated :root region but missing from ${TOKENS_PATH}`,
        name,
      );
    }
  }

  // Contract <-> tokens.json, including a contract name that no token backs.
  if (!Array.isArray(contract.names) || !Array.isArray(contract.lightOverrides)) {
    violations.push({ id: "token-contract", file: CONTRACT_PATH, line: 1, detail: "names/lightOverrides must be arrays", match: "names" });
  } else {
    const contractNames = new Set(contract.names);
    const contractLight = new Set(contract.lightOverrides);
    for (const name of contract.names) {
      if (!jsonNames.has(name.replace(/^--/, ""))) {
        addViolation(violations, "token-contract", CONTRACT_PATH, 1, `contract name ${name} is missing from ${TOKENS_PATH}`, name);
      }
    }
    for (const entry of entries) {
      if (!contractNames.has(`--${entry.key}`)) {
        addViolation(violations, "token-contract", TOKENS_PATH, 1, `token --${entry.key} is missing from the contract`, `--${entry.key}`);
      }
    }
    const lightGroup = new Set(
      Object.keys(tokens.light || {}).filter((key) => !key.startsWith("$")),
    );
    for (const name of light.keys()) {
      if (!lightGroup.has(name.slice(2))) {
        addViolation(
          violations,
          "token-contract",
          CSS_PATH,
          1,
          `${name} is declared in the generated light region but missing from the light group`,
          name,
        );
      }
    }
    for (const name of contract.lightOverrides) {
      if (!lightGroup.has(name.replace(/^--/, ""))) {
        addViolation(violations, "token-contract", CONTRACT_PATH, 1, `light contract name ${name} is missing from the light group`, name);
      }
    }
    for (const name of lightGroup) {
      if (!contractLight.has(`--${name}`)) {
        addViolation(violations, "token-contract", TOKENS_PATH, 1, `light override --${name} is missing from the contract`, `--${name}`);
      }
    }
  }

  // Every first-party var(--x) must resolve. Component-scoped properties
  // declared in site CSS/HTML are legitimate; an unknown name is not.
  const declared = new Set([...jsonNames].map((name) => `--${name}`));
  for (const name of dark.keys()) declared.add(name);
  for (const name of light.keys()) declared.add(name);
  for (const name of localDeclarations(cssFiles, htmlFiles, jsFiles)) declared.add(name);

  const refs = [];
  for (const { relative, text } of cssFiles) {
    const starts = lineStarts(text);
    for (const match of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
      refs.push({ file: relative, line: lineAt(starts, match.index), name: match[1] });
    }
  }
  for (const { relative, text } of htmlFiles) {
    const starts = lineStarts(text);
    for (const match of text.matchAll(/style\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const value = match[1] ?? match[2] ?? "";
      for (const reference of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        refs.push({ file: relative, line: lineAt(starts, match.index), name: reference[1] });
      }
    }
  }
  for (const { relative, text } of jsFiles) {
    const starts = lineStarts(text);
    for (const match of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
      refs.push({ file: relative, line: lineAt(starts, match.index), name: match[1] });
    }
  }
  const reported = new Set();
  for (const ref of refs) {
    if (declared.has(ref.name)) continue;
    const key = `${ref.file}:${ref.line}:${ref.name}`;
    if (reported.has(key)) continue;
    reported.add(key);
    addViolation(
      violations,
      "token-contract",
      ref.file,
      ref.line,
      `var(${ref.name}) has no declaration in tokens.json or first-party CSS/HTML`,
      ref.name,
    );
  }
  return violations;
}

function cssRegionText(css, regions, kind) {
  const region = regions.find((candidate) => candidate.kind === kind);
  if (!region) fail(`missing ${kind} tokens region`);
  return css.slice(region.bodyStart, region.bodyEnd);
}

// 2. orphan-token -----------------------------------------------------------
export function checkOrphanTokens({ tokens, cssFiles, htmlFiles, jsFiles }) {
  const entries = flattenTokens(tokens);
  const consumers = new Set();
  const collect = (text) => {
    for (const match of text.matchAll(/var\(\s*(--[\w-]+)/g)) consumers.add(match[1]);
  };
  for (const { text } of [...cssFiles, ...htmlFiles, ...jsFiles]) collect(text);

  const violations = [];
  for (const entry of entries) {
    const name = `--${entry.key}`;
    if (consumers.has(name)) continue;
    if (reserved(entry.token)) continue;
    addViolation(
      violations,
      "orphan-token",
      TOKENS_PATH,
      1,
      `${name} (${entry.path}) is declared but has no first-party consumer; add a consumer or mark it reserved`,
      name,
    );
  }
  return violations;
}

// 3. theme-parity -----------------------------------------------------------
export function checkThemeParity({ css, tokens, regions }) {
  const entries = flattenTokens(tokens);
  const light = declarations(cssRegionText(css, regions, "light"));
  const violations = [];
  for (const entry of entries) {
    if (entry.token.$type !== "color") continue;
    if (light.has(`--${entry.key}`)) continue;
    addViolation(
      violations,
      "theme-parity",
      TOKENS_PATH,
      1,
      `colour token --${entry.key} is declared in :root but has no value under html[data-theme="light"]`,
      `--${entry.key}`,
    );
  }
  return violations;
}

// 4. radius-scale -----------------------------------------------------------
export function radiusScale(tokens) {
  const scale = new Map();
  for (const entry of flattenTokens(tokens)) {
    if (!entry.key.startsWith("radius-")) continue;
    const value = entry.token.$value;
    let pixels = null;
    if (entry.token.$type === "dimension" && value && typeof value === "object" && value.unit === "px") {
      pixels = `${value.value}px`;
    } else if (typeof value === "string") {
      const match = value.match(/^(\d+(?:\.\d+)?)px$/);
      if (match) pixels = `${match[1]}px`;
    }
    if (pixels && !scale.has(pixels)) scale.set(pixels, `--${entry.key}`);
  }
  return scale;
}

export function checkRadiusScale({ tokens, cssFiles, regions }) {
  const scale = radiusScale(tokens);
  const violations = [];
  for (const { relative, text } of cssFiles) {
    const starts = lineStarts(text);
    for (const match of text.matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
      if (inRegion(regions, match.index)) continue;
      const raw = match[1].replace(/!important/gi, "").trim();
      if (raw.includes("var(")) continue;
      const parts = raw.split("/").flatMap((part) => part.trim().split(/\s+/)).filter(Boolean);
      for (const part of parts) {
        if (RADIUS_EXCEPTIONS.has(part)) continue;
        const token = scale.get(part);
        const hint = token ? `use var(${token})` : "use a --radius-* token";
        addViolation(
          violations,
          "radius-scale",
          relative,
          lineAt(starts, match.index),
          `border-radius: ${raw} uses the literal ${part}; ${hint}`,
          `border-radius: ${raw}`,
        );
      }
    }
  }
  return violations;
}

// 5. raw-hex-outside-root ---------------------------------------------------
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

function hexOccurrences(relative, segment, fullText, baseOffset) {
  const starts = lineStarts(fullText);
  const found = [];
  for (const match of segment.matchAll(HEX)) {
    const index = baseOffset + match.index;
    found.push({ file: relative, line: lineAt(starts, index), hex: match[0] });
  }
  return found;
}

export function checkRawHex({ cssFiles, htmlFiles, regions }) {
  const violations = [];
  for (const { relative, text } of cssFiles) {
    // Only declaration bodies, so `#id` selectors never match. The generated
    // :root and light regions are the documented home of raw colours.
    for (const block of text.matchAll(/\{([^{}]*)\}/g)) {
      const bodyStart = block.index + 1;
      if (inRegion(regions, block.index)) continue;
      for (const found of hexOccurrences(relative, block[1], text, bodyStart)) {
        addViolation(
          violations,
          "raw-hex-outside-root",
          relative,
          found.line,
          `raw colour ${found.hex} outside the generated token regions`,
          found.hex,
        );
      }
    }
  }
  for (const { relative, text } of htmlFiles) {
    // Inline <style> blocks are first-party CSS even when they live in HTML.
    for (const styleBlock of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      const bodyStart = styleBlock.index + styleBlock[0].indexOf(">") + 1;
      for (const block of styleBlock[1].matchAll(/\{([^{}]*)\}/g)) {
        const blockStart = bodyStart + block.index + 1;
        for (const found of hexOccurrences(relative, block[1], text, blockStart)) {
          addViolation(
            violations,
            "raw-hex-outside-root",
            relative,
            found.line,
            `raw colour ${found.hex} in an inline <style> block outside the generated token regions`,
            found.hex,
          );
        }
      }
    }
    for (const match of text.matchAll(/style\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const value = match[1] ?? match[2] ?? "";
      const valueStart = match.index + match[0].indexOf(value);
      for (const found of hexOccurrences(relative, value, text, valueStart)) {
        addViolation(
          violations,
          "raw-hex-outside-root",
          relative,
          found.line,
          `raw colour ${found.hex} in an inline style outside the generated token regions`,
          found.hex,
        );
      }
    }
  }
  return violations;
}

// 6. legacy-selector --------------------------------------------------------
function classes(compound) {
  return [...compound.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]);
}

function isPageLocal(name) {
  return PAGE_ROOTS.includes(name) || PAGE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isSharedFamily(name) {
  return SHARED_FAMILIES.some((family) => name === family || name.startsWith(`${family}-`));
}

export function checkLegacySelectors({ cssFiles, regions }) {
  const violations = [];
  for (const { relative, text } of cssFiles) {
    const starts = lineStarts(text);
    for (const rule of text.matchAll(/([^{}]+)\{/g)) {
      if (inRegion(regions, rule.index)) continue;
      const rawSelector = rule[1];
      const selector = rawSelector.trim();
      if (!selector || selector.startsWith("@") || selector.startsWith("/*")) continue;
      let offset = 0;
      for (const chunk of rawSelector.split(",")) {
        const part = chunk.trim();
        const partIndex = rule.index + offset + Math.max(chunk.indexOf(part), 0);
        offset += chunk.length + 1;
        const compounds = part.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
        if (compounds.length < 2) continue;
        // The shared family may be the subject (.card) or an ancestor of the
        // subject (.card p): both override a shared component from page scope.
        const sharedIndex = compounds.findIndex((compound) => classes(compound).some(isSharedFamily));
        if (sharedIndex < 1) continue;
        const target = classes(compounds[sharedIndex]).find(isSharedFamily);
        const scope = compounds
          .slice(0, sharedIndex)
          .flatMap(classes)
          .find(isPageLocal);
        if (!scope) continue;
        addViolation(
          violations,
          "legacy-selector",
          relative,
          lineAt(starts, partIndex),
          `${part} overrides the shared .${target} family from page scope .${scope}`,
          part,
        );
      }
    }
  }
  return violations;
}

// Baseline ------------------------------------------------------------------
// An entry records the exact file:line where the debt was accepted, but the
// match is by file + matched text, not by line, so an unrelated edit above the
// entry does not turn the gate red. A new copy of the same text in the same
// file still needs its own entry, which keeps the baseline shrink-only.
function applyBaseline(violations, entries) {
  const used = new Set();
  const remaining = [];
  for (const violation of violations) {
    const index = entries.findIndex(
      (entry, candidate) =>
        !used.has(candidate) &&
        entry.file === violation.file &&
        (entry.match === violation.match || violation.match.includes(entry.match)),
    );
    if (index === -1) remaining.push(violation);
    else used.add(index);
  }
  const stale = entries.filter((_, index) => !used.has(index));
  return { remaining, stale };
}

function loadBaseline(root) {
  const full = path.join(root, BASELINE_PATH);
  if (!fs.existsSync(full)) return { checks: {} };
  const data = readJson(root, BASELINE_PATH);
  return { checks: data.checks || {} };
}

export function collectChecks(root = REPO_ROOT) {
  const tokens = readJson(root, TOKENS_PATH);
  const contract = readJson(root, CONTRACT_PATH);
  const css = read(root, CSS_PATH);
  const regions = generatedRegions(css);
  const siteDir = path.join(root, SITE_DIR);

  const cssFiles = list(siteDir, ".css").map((name) => ({ relative: `${SITE_DIR}/${name}`, text: stripComments(read(root, `${SITE_DIR}/${name}`)) }));
  const htmlFiles = list(siteDir, ".html").map((name) => ({ relative: `${SITE_DIR}/${name}`, text: read(root, `${SITE_DIR}/${name}`) }));
  const jsFiles = list(siteDir, ".js")
    .filter((name) => !VENDORED_JS.has(name))
    .map((name) => ({ relative: `${SITE_DIR}/${name}`, text: read(root, `${SITE_DIR}/${name}`) }));

  return [
    { id: "token-contract", violations: checkTokenContract({ css, tokens, contract, regions, cssFiles, htmlFiles, jsFiles }) },
    { id: "orphan-token", violations: checkOrphanTokens({ tokens, cssFiles, htmlFiles, jsFiles }) },
    { id: "theme-parity", violations: checkThemeParity({ css, tokens, regions }) },
    { id: "radius-scale", violations: checkRadiusScale({ tokens, cssFiles, regions }) },
    { id: "raw-hex-outside-root", violations: checkRawHex({ cssFiles, htmlFiles, regions }) },
    { id: "legacy-selector", violations: checkLegacySelectors({ cssFiles, regions }) },
  ];
}

export function run({ root = REPO_ROOT } = {}) {
  const baseline = loadBaseline(root);
  const checks = collectChecks(root);

  const messages = [];
  let failed = false;
  let total = 0;
  for (const check of checks) {
    const baselined = baseline.checks[check.id] || { count: 0, entries: [] };
    const entries = Array.isArray(baselined.entries) ? baselined.entries : [];
    const countMatches = (baselined.count ?? 0) === entries.length;
    const { remaining, stale } = applyBaseline(check.violations, entries);
    total += remaining.length;
    let status = "OK";
    if (remaining.length > 0 || stale.length > 0 || !countMatches) {
      failed = true;
      status = "FAILED";
    }
    messages.push(
      `${check.id}: ${status} (${remaining.length} new, ${entries.length - stale.length} baselined, ` +
        `${check.violations.length} total${entries.length ? `, baseline ${baselined.count ?? entries.length}` : ""})`,
    );
    if (!countMatches) {
      messages.push(
        `  baseline count ${baselined.count ?? "(missing)"} does not match ${entries.length} entr(ies); update the count with the entries`,
      );
    }
    for (const violation of remaining) {
      messages.push(`  ${violation.file}:${violation.line} ${violation.detail}`);
    }
    for (const entry of stale) {
      messages.push(
        `  ${entry.file}:${entry.line} stale baseline entry (${entry.match}); the violation is gone or moved, remove the entry`,
      );
    }
    if (remaining.length === 0 && stale.length === 0 && check.id === "orphan-token") {
      messages.push("  note: the reservation flag is reviewed, not timed; there is no 30-day grace in code");
    }
  }

  if (failed) messages.push(`token-usage: FAILED (${total} new violation(s))`);
  else messages.push("token-usage: OK (all six token detectors clean)");
  return { ok: !failed, messages, total };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    console.error(`token-usage: unexpected argument(s): ${argv.join(" ")}`);
    return 1;
  }
  try {
    const result = run();
    for (const message of result.messages) console.log(message);
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`token-usage: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
