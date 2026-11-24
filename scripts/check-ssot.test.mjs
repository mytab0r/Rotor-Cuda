// Source pin for the authored vendor-lock entries. The universal revert tier
// needs a command that goes red when the check-ssot hunk is reverted; the
// behavioural proof is the SSOT gate run in the PR, not this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./check-ssot.mjs", import.meta.url), "utf8");

test("a web/public file is either a locked copy or an explicit authored entry", () => {
  assert.match(source, /json\.authored/);
  assert.match(source, /authored\.has\(file\)/);
  assert.match(source, /is also a copy target/);
});

test("an authored entry must explain itself and live under web/public", () => {
  assert.match(source, /must explain why the file is authored here/);
  assert.match(source, /must live under \$\{WEB_PUBLIC_DIR\}/);
});
