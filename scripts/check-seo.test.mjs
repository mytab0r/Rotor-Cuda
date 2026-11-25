// Source pin for the key-page SEO checks. The universal revert tier needs a
// command that goes red when the check-seo key hunks are reverted; the
// behavioural proof is the SEO mutation run in the PR, not this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./check-seo.mjs", import.meta.url), "utf8");

test("check-seo gates the curated key pages", () => {
  assert.match(source, /async function curatedKeys\(/);
  assert.match(source, /async function checkKeyFamily\(/);
  assert.match(source, /async function checkKeySitemap\(/);
});

test("the key pages are wired into the run, the metadata set and the report", () => {
  assert.match(source, /const keys = await curatedKeys\(\)/);
  assert.match(source, /keyFamily\.results\.map/);
  assert.match(source, /keyPages: keyFamily\.results/);
});

test("an arbitrary key is never advertised: the worker pages are noindex", () => {
  assert.match(source, /worker pages are noindex/);
  assert.match(source, /keySitemap\.keyPaths/);
});

/* A docs section card carries the id and the H2 sits inside it; the gate must
 * accept that anchor while still requiring the TOC to cover every H2. */
test("a section card id can anchor its heading in the TOC", () => {
  assert.match(source, /heading\.sectionId/);
  assert.match(source, /const anchors = \[heading\.id, heading\.sectionId\]\.filter\(Boolean\)/);
  assert.match(source, /has no id and no anchored section/);
  assert.match(source, /is missing from the TOC/);
});
