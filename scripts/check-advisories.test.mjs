#!/usr/bin/env node
// Tests for the security advisory SSOT and its gate. No browser, no network.
//
// Usage: node --test scripts/check-advisories.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkAdvisories } from "./check-advisories.mjs";
import {
  DATA_PATH,
  PAGE_PATH,
  coordinatorRoutes,
  loadChains,
  readJson,
  renderSecurityPage,
  validateSecurityAdvisories,
} from "./lib/security-advisories.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const real = readJson(repoRoot, DATA_PATH);
const routes = coordinatorRoutes(repoRoot);
const chainSlugs = loadChains(repoRoot);

function validate(mutate) {
  const copy = JSON.parse(JSON.stringify(real));
  mutate(copy);
  return validateSecurityAdvisories(copy, { repoRoot, routes, chainSlugs, today: "2026-11-22" });
}

test("the committed advisory data passes validation", () => {
  const result = validateSecurityAdvisories(real, { repoRoot, routes, chainSlugs, today: "2026-11-22" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("severity is a closed set", () => {
  const result = validate((data) => { data.advisories[0].severity = "urgent"; });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /severity/);
});

test("an advisory cannot reference a checker that is not in the registry", () => {
  const result = validate((data) => { data.advisories[0].checker = "missing-checker"; });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /unknown checker/);
});

test("a checker route must exist in the coordinator", () => {
  const result = validate((data) => { data.checkers[0].route = "/todayi-removed#check"; });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /not a route/);
});

test("every source must be https and at least one is primary", () => {
  const insecure = validate((data) => { data.advisories[0].sources[0].url = "http://milksad.info/"; });
  assert.equal(insecure.ok, false);
  assert.match(insecure.errors.join("\n"), /https/);
  const noPrimary = validate((data) => { data.advisories[0].sources.forEach((s) => { s.primary = false; }); });
  assert.equal(noPrimary.ok, false);
  assert.match(noPrimary.errors.join("\n"), /primary/);
});

test("every advisory and threat carries actions", () => {
  const result = validate((data) => { data.advisories[1].actions = []; data.threats[0].actions = []; });
  assert.equal(result.ok, false);
  assert.equal((result.errors.join("\n").match(/actions/g) || []).length, 2);
});

test("a reviewed entry records who checked it and when", () => {
  const result = validate((data) => {
    data.advisories[0].review = { status: "reviewed", reviewed_at: "2026-11-22" };
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /reviewed_by/);
});

test("a draft must not claim a reviewed date", () => {
  const result = validate((data) => {
    data.advisories[0].review = { status: "draft", reviewed_by: "someone", reviewed_at: "2026-11-22" };
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /draft/);
});

test("affected chains must be canonical chain slugs", () => {
  const result = validate((data) => { data.advisories[0].affected.chains = ["mooncoin"]; });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /unknown chain/);
});

test("a threat class cannot carry a CVE or a checker", () => {
  const result = validate((data) => {
    data.threats[0].cve = ["CVE-0000-0000"];
    data.threats[0].checker = null;
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /cve is not allowed/);
  assert.match(result.errors.join("\n"), /checker is not allowed/);
});

test("protection claims are rejected", () => {
  const result = validate((data) => { data.advisories[0].summary += " We protect you."; });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /banned protection claim/);
});

test("the renderer escapes every data string", () => {
  const copy = JSON.parse(JSON.stringify(real));
  copy.advisories[0].summary = "<script>alert(1)</script>";
  copy.advisories[0].actions = ["<img src=x onerror=alert(2)>"];
  const page = renderSecurityPage(copy);
  assert.equal(page.includes("<script>alert(1)</script>"), false);
  assert.equal(page.includes("<img src=x onerror=alert(2)>"), false);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page, /&lt;img src=x onerror=alert\(2\)&gt;/);
});

test("the route is served, the generated page is fresh and carries the SEO shape", () => {
  const { ok, errors } = checkAdvisories(repoRoot);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);

  assert.equal(routes.has("/security"), true);
  assert.equal(routes.has("/security-advisories.json"), true);
  const page = fs.readFileSync(path.join(repoRoot, PAGE_PATH), "utf8");
  assert.equal(page.match(/<main/g).length, 1);
  assert.equal(page.match(/<h1/g).length, 1);
  // The coordinator injects the one shared marketing footer at serve time.
  assert.equal(page.match(/<footer/g), null);
  assert.match(page, /<link rel="canonical" href="https:\/\/rotor\.pxbt\.app\/security">/);
  assert.equal(/noindex/i.test(page), false);
  assert.match(page, /application\/ld\+json/);
});
