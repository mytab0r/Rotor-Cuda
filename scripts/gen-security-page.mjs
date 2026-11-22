#!/usr/bin/env node
// Render apps/site/security.html from data/security-advisories.json.
//
// The page is committed so the coordinator can embed it with include_str and
// crawlers see the content without running JavaScript. `--check` compares the
// committed file with the renderer output; scripts/check-advisories.mjs also
// enforces freshness in CI.
//
// Zero dependencies; Windows-safe. Exit: 0 = written/current, 1 = stale check.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_PATH,
  PAGE_PATH,
  detectEol,
  normalizeEol,
  readJson,
  renderSecurityPage,
  withEol,
} from "./lib/security-advisories.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const checkOnly = process.argv.includes("--check");

const data = readJson(repoRoot, DATA_PATH);
const target = path.join(repoRoot, PAGE_PATH);
let current = "";
try {
  current = fs.readFileSync(target, "utf8");
} catch {
  current = "";
}
const html = withEol(renderSecurityPage(data), detectEol(current));

if (checkOnly) {
  if (normalizeEol(current) !== normalizeEol(html)) {
    console.error(`${PAGE_PATH}: stale; run node scripts/gen-security-page.mjs`);
    process.exit(1);
  }
  console.log(`${PAGE_PATH}: current`);
} else {
  fs.writeFileSync(target, html, "utf8");
  console.log(`${PAGE_PATH}: written`);
}
