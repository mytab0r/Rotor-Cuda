#!/usr/bin/env node
// Generate the design-token layer from design/tokens/tokens.json.
//
// Source of truth: design/tokens/tokens.json (W3C DTCG).
// Outputs:
//   - apps/site/site.css, inside every /* tokens:start */ ... /* tokens:end */
//     pair (one :root block, one html[data-theme="light"] block);
//   - design/generated/tokens.ts, a typed map of CSS variable references.
//
// `--check` regenerates both in memory and exits 1 with a line diff summary
// when a committed output is stale.
//
// Node 20 built-ins only; no dependencies, Windows-safe.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const TOKENS_PATH = "design/tokens/tokens.json";
const CONTRACT_PATH = "design/tokens/tokens.contract.json";
const CSS_PATH = "apps/site/site.css";
const TS_PATH = "design/generated/tokens.ts";
const START_MARKER = "/* tokens:start */";
const END_MARKER = "/* tokens:end */";
const CSS_COMMENT_NS = "org.rotor.css";

const DARK_SELECTOR = ":root";
const LIGHT_SELECTOR = 'html[data-theme="light"]';

const TYPES = new Set([
  "color",
  "dimension",
  "duration",
  "fontFamily",
  "fontWeight",
  "number",
  "cubicBezier",
  "string",
]);

function fail(message) {
  throw new Error(message);
}

function readJson(root, relative) {
  const full = path.join(root, relative);
  let text;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch (error) {
    fail(`cannot read ${relative}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`cannot parse ${relative}: ${error.message}`);
  }
}

function isToken(value) {
  return value && typeof value === "object" && !Array.isArray(value) && "$value" in value;
}

function isGroup(value) {
  return value && typeof value === "object" && !Array.isArray(value) && !("$value" in value);
}

function cssName(key) {
  return `--${key}`;
}

// Keep the checkout's line endings: Git may hand us CRLF on Windows and LF on
// CI. The generated body must not mix the two inside a marked region.
function detectEol(text, fallback = "\n") {
  return text.includes("\r\n") ? "\r\n" : fallback;
}

function withEol(text, eol) {
  return text.replaceAll("\n", eol);
}

function cssComment(group) {
  return group?.$extensions?.[CSS_COMMENT_NS]?.comment || "";
}

// Flatten a token group into { path, key, token } entries in declaration
// order. Groups may nest; keys may not repeat because the CSS name is the key.
function flatten(group, prefix, entries) {
  for (const [key, value] of Object.entries(group)) {
    if (key.startsWith("$")) continue;
    if (isToken(value)) {
      entries.push({ path: `${prefix}.${key}`, key, token: value });
    } else if (isGroup(value)) {
      flatten(value, `${prefix}.${key}`, entries);
    } else {
      fail(`token ${prefix}.${key} must be an object with $value or a group`);
    }
  }
}

function collect(tokens) {
  const darkEntries = [];
  const darkGroups = [];
  const seenKeys = new Map();
  const paths = new Map();

  const addGroup = (group, name, comment) => {
    const entries = [];
    flatten(group, name, entries);
    if (entries.length > 0) darkGroups.push({ name, comment, entries });
    for (const entry of entries) {
      if (seenKeys.has(entry.key)) {
        fail(`duplicate CSS custom property --${entry.key} in ${seenKeys.get(entry.key)} and ${entry.path}`);
      }
      seenKeys.set(entry.key, entry.path);
      paths.set(entry.path, entry.key);
      darkEntries.push(entry);
    }
  };

  for (const tier of ["primitive", "semantic", "component"]) {
    const group = tokens[tier];
    if (!group) fail(`tokens.json is missing the ${tier} tier`);
    if (!isGroup(group)) fail(`tokens.json ${tier} must be a group`);
    if (tier === "primitive") {
      for (const [name, child] of Object.entries(group)) {
        if (name.startsWith("$")) continue;
        if (!isGroup(child)) fail(`primitive.${name} must be a group`);
        addGroup(child, `primitive.${name}`, cssComment(child));
      }
    } else {
      addGroup(group, tier, cssComment(group));
    }
  }

  const lightGroup = tokens.light;
  if (!lightGroup || !isGroup(lightGroup)) fail("tokens.json must have a light group");
  const lightEntries = [];
  for (const [key, token] of Object.entries(lightGroup)) {
    if (key.startsWith("$")) continue;
    if (!isToken(token)) fail(`light.${key} must be a token`);
    if (!seenKeys.has(key)) fail(`light override --${key} has no dark-theme token`);
    lightEntries.push({ path: `light.${key}`, key, token });
  }

  return { darkEntries, darkGroups, lightEntries, paths, seenKeys };
}

function formatNumber(value) {
  // Preserve the repository's cubic-bezier spelling: .2, .7, 1.
  return String(value).replace(/^0\./, ".").replace(/^-0\./, "-.");
}

function renderValue(token, entry, paths) {
  const value = token.$value;
  const type = token.$type;
  if (typeof type !== "string" || !TYPES.has(type)) {
    fail(`${entry.path}: $type must be one of ${[...TYPES].join(", ")}`);
  }
  if (typeof value === "string") {
    const alias = value.match(/^\{([^}]+)\}$/);
    if (alias) {
      const target = alias[1];
      const key = paths.get(target);
      if (!key) fail(`${entry.path}: alias {${target}} does not resolve to a token`);
      return `var(--${key})`;
    }
    return value;
  }
  if (type === "dimension" || type === "duration") {
    if (!value || typeof value !== "object" || typeof value.value !== "number" || typeof value.unit !== "string") {
      fail(`${entry.path}: ${type} must be { "value": number, "unit": string }`);
    }
    return `${value.value}${value.unit}`;
  }
  if (type === "fontWeight" || type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(`${entry.path}: ${type} must be a number`);
    }
    return String(value);
  }
  if (type === "cubicBezier") {
    if (!Array.isArray(value) || value.length !== 4 || value.some((part) => typeof part !== "number")) {
      fail(`${entry.path}: cubicBezier must be an array of four numbers`);
    }
    return `cubic-bezier(${value.map(formatNumber).join(", ")})`;
  }
  fail(`${entry.path}: ${type} must be a string value`);
}

function declarationLines(entries, paths) {
  return entries.map((entry) => `  ${cssName(entry.key)}: ${renderValue(entry.token, entry, paths)};`);
}

function commentLines(text) {
  const lines = String(text).split("\n");
  if (lines.length === 1) return [`  /* ${lines[0]} */`];
  return [
    `  /* ${lines[0]}`,
    ...lines.slice(1, -1).map((line) => `   * ${line}`),
    `   * ${lines[lines.length - 1]} */`,
  ];
}

function renderDarkBody(tokens, paths) {
  const blocks = [];
  for (const group of tokens.darkGroups) {
    const lines = [];
    const comment = group.comment;
    if (comment) lines.push(...commentLines(comment));
    lines.push(...declarationLines(group.entries, paths));
    if (lines.length > 0) blocks.push(lines);
  }
  return blocks.map((lines) => lines.join("\n")).join("\n\n");
}

function nonTokenDeclarations(body) {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--") && !line.startsWith("/*") && !line.startsWith("*") && line !== "*/")
    .map((line) => `  ${line}`);
}

function renderLightBody(tokens, body, paths) {
  const lines = nonTokenDeclarations(body);
  lines.push(...declarationLines(tokens.lightEntries, paths));
  return lines.join("\n");
}

function regionKind(region, index) {
  const open = region.indexOf("{");
  if (open === -1) fail(`tokens region ${index + 1} has no opening brace`);
  const selector = region.slice(0, open).trim();
  if (selector === DARK_SELECTOR) return "dark";
  if (selector === LIGHT_SELECTOR) return "light";
  fail(`tokens region ${index + 1} has an unknown selector: ${selector}`);
}

function regenerateRegion(region, index, tokens, paths, eol) {
  const open = region.indexOf("{");
  const close = region.lastIndexOf("}");
  if (open === -1 || close <= open) fail(`tokens region ${index + 1} is not a CSS block`);
  const kind = regionKind(region, index);
  const body = region.slice(open + 1, close);
  const generated = kind === "dark" ? renderDarkBody(tokens, paths) : renderLightBody(tokens, body, paths);
  return `${region.slice(0, open + 1)}${eol}${withEol(generated, eol)}${eol}${region.slice(close)}`;
}

function splitRegions(css) {
  const regions = [];
  let cursor = 0;
  while (true) {
    const start = css.indexOf(START_MARKER, cursor);
    const end = start === -1 ? -1 : css.indexOf(END_MARKER, start + START_MARKER.length);
    if (start === -1) break;
    if (end === -1) fail(`unclosed ${START_MARKER} at offset ${start}`);
    regions.push({
      start,
      end,
      text: css.slice(start + START_MARKER.length, end),
    });
    cursor = end + END_MARKER.length;
  }
  if (regions.length === 0) {
    fail(`${CSS_PATH} has no ${START_MARKER} ... ${END_MARKER} region`);
  }
  const kinds = new Set();
  for (const [index, region] of regions.entries()) {
    const kind = regionKind(region.text, index);
    if (kinds.has(kind)) fail(`duplicate ${kind} tokens region`);
    kinds.add(kind);
  }
  for (const kind of ["dark", "light"]) {
    if (!kinds.has(kind)) fail(`${CSS_PATH} is missing the ${kind} tokens region`);
  }
  return regions;
}

function renderCss(css, tokens, paths) {
  const regions = splitRegions(css);
  const eol = detectEol(css);
  let result = "";
  let cursor = 0;
  for (const [index, region] of regions.entries()) {
    result += css.slice(cursor, region.start);
    result += `${START_MARKER}${regenerateRegion(region.text, index, tokens, paths, eol)}${END_MARKER}`;
    cursor = region.end + END_MARKER.length;
  }
  result += css.slice(cursor);
  return result;
}

function renderTs(tokens, eol = "\n") {
  const lines = [
    "// Generated by scripts/build-tokens.mjs from design/tokens/tokens.json.",
    "// Do not edit. Values are CSS variable references so the theme switch in",
    "// apps/site/site.css keeps the light overrides working.",
    "export const tokens = {",
  ];
  for (const entry of tokens.darkEntries) {
    const name = cssName(entry.key);
    lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(`var(${name})`)},`);
  }
  lines.push("} as const;", "", "export type TokenName = keyof typeof tokens;", "");
  return withEol(lines.join("\n"), eol);
}

function validateContract(tokens, contract) {
  const jsonNames = new Set(tokens.darkEntries.map((entry) => cssName(entry.key)));
  const jsonLight = new Set(tokens.lightEntries.map((entry) => cssName(entry.key)));
  if (!Array.isArray(contract.names) || contract.names.some((name) => typeof name !== "string")) {
    fail(`${CONTRACT_PATH}: names must be an array of strings`);
  }
  if (!Array.isArray(contract.lightOverrides) || contract.lightOverrides.some((name) => typeof name !== "string")) {
    fail(`${CONTRACT_PATH}: lightOverrides must be an array of strings`);
  }
  const contractNames = new Set(contract.names);
  const contractLight = new Set(contract.lightOverrides);
  const errors = [];
  for (const name of contract.names) {
    if (!jsonNames.has(name)) errors.push(`contract name ${name} is missing from tokens.json`);
  }
  for (const name of jsonNames) {
    if (!contractNames.has(name)) errors.push(`token ${name} is missing from the contract`);
  }
  for (const name of contract.lightOverrides) {
    if (!jsonLight.has(name)) errors.push(`contract light override ${name} is missing from the light group`);
  }
  for (const name of jsonLight) {
    if (!contractLight.has(name)) errors.push(`light override ${name} is missing from the contract`);
  }
  if (errors.length > 0) fail(`${CONTRACT_PATH} and ${TOKENS_PATH} disagree:\n  ${errors.join("\n  ")}`);
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
    actual: (actualLines[first] ?? "").replace(/\r$/, "").slice(0, 160),
    expected: (expectedLines[first] ?? "").replace(/\r$/, "").slice(0, 160),
  };
}

function writeIfChanged(root, relative, content) {
  const full = path.join(root, relative);
  if (fs.existsSync(full) && fs.readFileSync(full, "utf8") === content) return false;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return true;
}

export function run({ root = REPO_ROOT, check = false } = {}) {
  const tokensJson = readJson(root, TOKENS_PATH);
  const contract = readJson(root, CONTRACT_PATH);
  const tokens = collect(tokensJson);
  validateContract(tokens, contract);

  const cssFull = path.join(root, CSS_PATH);
  const css = fs.readFileSync(cssFull, "utf8");
  const expectedCss = renderCss(css, tokens, tokens.paths);
  const tsFull = path.join(root, TS_PATH);
  const ts = fs.existsSync(tsFull) ? fs.readFileSync(tsFull, "utf8") : "";
  const expectedTs = renderTs(tokens, detectEol(ts, detectEol(css)));

  const messages = [];
  const stale = [];
  for (const [relative, actual, expected] of [
    [CSS_PATH, css, expectedCss],
    [TS_PATH, ts, expectedTs],
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
      messages.push(`tokens:check FAILED (${stale.length} output(s) stale); run: node scripts/build-tokens.mjs`);
      return { ok: false, stale, messages };
    }
    messages.push(
      `tokens:check OK (${tokens.darkEntries.length} tokens, ${tokens.lightEntries.length} light overrides, ` +
        `${tokens.darkGroups.length} CSS groups, ${TS_PATH} current)`,
    );
    return { ok: true, stale, messages };
  }

  const written = [];
  if (writeIfChanged(root, CSS_PATH, expectedCss)) written.push(CSS_PATH);
  if (writeIfChanged(root, TS_PATH, expectedTs)) written.push(TS_PATH);
  messages.push(
    written.length > 0
      ? `tokens: wrote ${written.join(", ")} (${tokens.darkEntries.length} tokens, ${tokens.lightEntries.length} light overrides)`
      : `tokens: already current (${tokens.darkEntries.length} tokens, ${tokens.lightEntries.length} light overrides)`,
  );
  return { ok: true, stale, messages, written };
}

export function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    console.error(`tokens: unknown argument(s): ${unknown.join(" ")}`);
    return 1;
  }
  try {
    const result = run({ check: argv.includes("--check") });
    for (const message of result.messages) console.log(message);
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`tokens: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
