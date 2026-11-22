// Regression guard for the legacy-selector matcher: a page-scoped prefix such
// as `.puzzle-cta` must flag an override of a shared family. The baseline
// records the accepted debt with a reason; this test keeps the detection
// itself from going quiet.
//
// Run with: node --test scripts/check-token-usage.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkLegacySelectors,
  checkRawHex,
  generatedRegionSpans,
} from "./check-token-usage.mjs";
import { findGeneratedRegions } from "./generated-regions.mjs";

const file = (text) => [{ relative: "apps/site/site.css", text }];
const regions = [];

const matches = (text) => checkLegacySelectors({ cssFiles: file(text), regions }).map((v) => v.match);

test("flags a puzzle page override of the shared button family", () => {
  assert.deepEqual(matches(".puzzle-cta .btn { min-height: 46px; }"), [".puzzle-cta .btn"]);
});

test("flags a puzzle hero override of the shared button family", () => {
  assert.deepEqual(matches(".puzzle-hero .btn { padding: 10px 18px; }"), [".puzzle-hero .btn"]);
});

test("flags a key page override of the shared card family", () => {
  assert.deepEqual(matches(".key-page > .card { padding: 3px; }"), [".key-page > .card"]);
});

test("flags a seed page override of the shared chip family", () => {
  assert.deepEqual(matches(".seed-count-row .chip { font-size: 11px; }"), [".seed-count-row .chip"]);
});

test("does not flag a shared family used without a page scope", () => {
  assert.deepEqual(matches(".card { padding: var(--space-5); }"), []);
  assert.deepEqual(matches(".design-gallery .card { padding: var(--space-5); }"), []);
});

test("does not flag a page scope that targets a non-shared class", () => {
  assert.deepEqual(matches(".puzzle-cta h2 { margin: 0; }"), []);
});

test("the generated-region registry lists tokens and chains once", () => {
  const text = [
    "/* tokens:start */",
    ":root { --color: #000000; }",
    "/* tokens:end */",
    "/* chains:start */",
    ":root { --chain-x: #123456; }",
    "/* chains:end */",
  ].join("\n");
  assert.deepEqual(
    findGeneratedRegions(text).map((region) => region.name),
    ["tokens", "chains"],
  );
});

test("raw-hex skips every generated region but not the CSS around it", () => {
  const text = [
    "/* tokens:start */",
    ":root { --color: #000000; }",
    "/* tokens:end */",
    "/* chains:start */",
    ":root { --chain-x: #123456; }",
    "/* chains:end */",
    ".outside { color: #abcdef; }",
  ].join("\n");
  const violations = checkRawHex({
    cssFiles: [{ relative: "apps/site/site.css", text }],
    htmlFiles: [],
    regions: generatedRegionSpans(text),
  });
  assert.deepEqual(
    violations.map((violation) => violation.match),
    ["#abcdef"],
    "only the colour outside both generated regions is reported",
  );
});
