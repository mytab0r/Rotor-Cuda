// Pins the two contracts behind ROT-472. The universal revert tier needs a
// command that goes red when the audit hunk is reverted; the behavioural proof
// is the served-page mutation run in the PR, not this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./ui-audit.mjs", import.meta.url), "utf8");
const start = source.indexOf("async function auditPage(args)");
const end = source.indexOf("async function auditWalletSeed(cdp)", start);
assert.ok(start > 0 && end > start, "auditPage is present");
const auditPage = source.slice(start, end);

test("the resting audit waits for fonts and one frame before measuring", () => {
  assert.match(auditPage, /document\.fonts\.ready/);
  assert.match(auditPage, /requestAnimationFrame\(\(\) => resolve\(\)\)/);
});

test("a table cell is clipped by text rects, not by hit-area scroll overflow", () => {
  assert.match(auditPage, /textOutside\(cell, cell\.getBoundingClientRect\(\)\)/);
  assert.doesNotMatch(auditPage, /cell\.scrollHeight > cell\.clientHeight \+ 1/);
});

/* The three key-page gates behind the Astro migration. The universal revert
 * tier needs these to go red when the audit hunks are reverted. */
test("the key-page fold budget fails above 700 at 1280 and 800 at 375", () => {
  assert.match(auditPage, /key-page-fold/);
  assert.match(auditPage, /viewportWidth >= 1024 \? 700 : viewportWidth <= 479 \? 800 : null/);
  assert.match(auditPage, /metrics\.keyPage\.tableStartY > foldLimit/);
});

test("a server-rendered key page is probed for zero first-paint provider requests", () => {
  assert.match(source, /PROVIDER_HOSTS/);
  assert.match(source, /firstPaintProviderRequests/);
  assert.match(source, /key-page-first-paint-requests/);
  assert.match(source, /document\.getElementById\('key-balance-check'\)/);
});

test("the format-scope probe is coordinator-only and keeps the coordinator report", () => {
  assert.match(source, /const astroShell = await evaluate/);
  assert.match(source, /if \(!astroShell\) \{/);
  assert.match(source, /if \(originalFirst\) \{\r?\n\s*setter\.call\(input, original\)/);
});


test("key summary rows stack at <=560px and stay two columns above it", () => {
  assert.match(auditPage, /"key-summary-stack"/);
  assert.match(
    auditPage,
    /\(route === "\/key" \|\| route\.startsWith\("\/key\/"\)\) && !document\.querySelector\("main\.key-page-v2"\)/,
  );
  assert.match(auditPage, /Math\.abs\(ddBox\.left - dtBox\.left\) <= 2 && ddBox\.top >= dtBox\.bottom - 2/);
  assert.match(auditPage, /ddBox\.left > dtBox\.left \+ 40 && ddBox\.top < dtBox\.bottom - 2 && dtBox\.top < ddBox\.bottom - 2/);
  assert.match(auditPage, /viewportWidth <= 560 \? !stacked : !beside/);
  assert.match(auditPage, /if \(!rows\.length && priv && priv\.value\.trim\(\)\) \{/);
});
