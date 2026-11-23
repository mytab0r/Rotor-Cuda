// Unit cases for the pure mutation selectors in scripts/mutate-changed.mjs.
// They do not touch a file; the CLI path is exercised by the CI job.

import test from "node:test";
import assert from "node:assert/strict";

import { mutateComparison, mutateLine, mutateReturn, testFileFor } from "./mutate-changed.mjs";

test("flips a strict equality in both directions", () => {
  assert.equal(mutateComparison("if (a === b) {"), "if (a !== b) {");
  assert.equal(mutateComparison("if (a !== b) {"), "if (a === b) {");
});

test("flips relational operators without touching arrows or shifts", () => {
  assert.equal(mutateComparison("if (a < b) {"), "if (a >= b) {");
  assert.equal(mutateComparison("if (a >= b) {"), "if (a < b) {");
  assert.equal(mutateComparison("const f = (x) => x > 0;"), "const f = (x) => x <= 0;");
  assert.equal(mutateComparison("const y = x << 2;"), null);
  assert.equal(mutateComparison("// a === b"), null);
});

test("flips a boolean or negated return and wraps any other expression", () => {
  assert.equal(mutateReturn("  return true;"), "  return false;");
  assert.equal(mutateReturn("  return false;"), "  return true;");
  assert.equal(mutateReturn("  return !ok;"), "  return ok;");
  assert.equal(mutateReturn("  return ok;"), "  return !(ok);");
  assert.equal(mutateReturn("  return;"), null);
});

test("prefers a comparison over a return on the same line", () => {
  assert.equal(mutateLine("  return a === b;"), "  return a !== b;");
});

test("maps a source file to its test file", () => {
  assert.equal(testFileFor("apps/site/amount.js"), "apps/site/amount-test.mjs");
  assert.equal(testFileFor("scripts/check-process.mjs"), "scripts/check-process.test.mjs");
  assert.equal(testFileFor("apps/site/site.css"), null);
});
