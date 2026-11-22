#!/usr/bin/env node
// Render the detector tables in the human docs from data/detectors.json.
//
// Generated blocks live between HTML comment markers:
//   <!-- BEGIN GENERATED detectors:skill -->
//   <!-- END GENERATED detectors:skill -->
//
// `--check` fails when a committed block is stale. scripts/check-ssot.mjs calls
// the same check, so a registry edit without regenerated docs fails CI.
//
// Zero dependencies; Windows-safe. Exit: 0 = current, 1 = stale or invalid.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib/area-map.mjs";
import { loadRegistry, tableScopes, validateRegistry } from "./lib/detectors.mjs";

export const TARGETS = [
  { file: ".claude/skills/ui-self-review/SKILL.md", table: "skill" },
  { file: "docs/design-system/DESIGN-SYSTEM.md", table: "design-system" },
  { file: "docs/design-system/plan.md", table: "plan" },
];

const HEADER = ["| ID | Rule | Batch | Status |", "|---|---|---|---|"];

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function renderBlock(table, entries, eol = "\n") {
  const rows = entries
    .filter((entry) => tableScopes(entry).includes(table))
    .map((entry) => `| \`${entry.id}\` | ${entry.rule} | ${entry.batch} | ${entry.status} |`);
  return [
    `<!-- BEGIN GENERATED detectors:${table} -->`,
    ...HEADER,
    ...rows,
    `<!-- END GENERATED detectors:${table} -->`,
  ].join(eol);
}

function blockPattern(table) {
  return new RegExp(
    `<!-- BEGIN GENERATED detectors:${table} -->[\\s\\S]*?<!-- END GENERATED detectors:${table} -->`,
  );
}

export function expectedDocs(root = REPO_ROOT) {
  const registry = loadRegistry(root);
  return TARGETS.map(({ file, table }) => {
    const full = path.join(root, file);
    const text = fs.readFileSync(full, "utf8");
    const eol = detectEol(text);
    const pattern = blockPattern(table);
    const matches = text.match(pattern);
    if (!matches) {
      return { file, table, text, expected: null, error: `missing generated block for ${table} in ${file}` };
    }
    const expected = text.replace(pattern, renderBlock(table, registry.detectors, eol));
    return { file, table, text, expected, error: null };
  });
}

function firstDiff(actual, expected) {
  const a = actual.split("\n");
  const b = expected.split("\n");
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if ((a[index] ?? "").replace(/\r$/, "") === (b[index] ?? "").replace(/\r$/, "")) continue;
    return {
      line: index + 1,
      actual: (a[index] ?? "").replace(/\r$/, "").slice(0, 160),
      expected: (b[index] ?? "").replace(/\r$/, "").slice(0, 160),
    };
  }
  return null;
}

export function checkDetectorDocs(root = REPO_ROOT) {
  const validation = validateRegistry(root);
  if (!validation.ok) return { ok: false, errors: validation.errors, stale: [] };
  const errors = [];
  const stale = [];
  for (const { file, table, expected, error } of expectedDocs(root)) {
    if (error) {
      errors.push(`[detector-docs-fresh] ${error}`);
      continue;
    }
    const actual = fs.readFileSync(path.join(root, file), "utf8");
    if (actual === expected) continue;
    const diff = firstDiff(actual, expected);
    stale.push({ file, table, diff });
    errors.push(
      `[detector-docs-fresh] ${file} detector table ${table} is stale` +
        (diff ? `: first difference at line ${diff.line}` : "") +
        "; run node scripts/gen-detector-docs.mjs",
    );
  }
  return { ok: errors.length === 0, errors, stale };
}

export function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    console.error(`error: unknown argument(s): ${unknown.join(", ")}`);
    console.error("usage: node scripts/gen-detector-docs.mjs [--check]");
    return 2;
  }
  try {
    if (argv.includes("--check")) {
      const result = checkDetectorDocs();
      if (!result.ok) {
        for (const error of result.errors) console.error(`error: ${error}`);
        console.error(`detector-docs:check FAILED (${result.errors.length} error(s))`);
        return 1;
      }
      console.log(`detector-docs:check OK (${TARGETS.length} generated tables current)`);
      return 0;
    }
    const validation = validateRegistry();
    if (!validation.ok) {
      for (const error of validation.errors) console.error(`error: ${error}`);
      console.error("detector-docs: registry is invalid; nothing written");
      return 1;
    }
    const written = [];
    for (const { file, expected, error } of expectedDocs()) {
      if (error) {
        console.error(`error: [detector-docs-fresh] ${error}`);
        return 1;
      }
      const actual = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      if (actual === expected) continue;
      fs.writeFileSync(path.join(REPO_ROOT, file), expected);
      written.push(file);
    }
    console.log(
      written.length > 0
        ? `detector-docs: wrote ${written.join(", ")}`
        : "detector-docs: already current",
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
