// Pins the cabinet login wiring in admin.js: the form sends the operator
// user/password, falls back to the token only when that field is filled, and
// clears the password after the attempt. The revert tier reverts admin.js and
// needs a test to go red.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./admin.js", import.meta.url), "utf8");

test("the cabinet login sends the operator credentials", () => {
  assert.match(source, /user: userInput\?\.value/);
  assert.match(source, /password: passwordInput\?\.value/);
  assert.match(source, /\{ token \}/);
  // The operator, not just the operand: flipping !== to === must break a test.
  assert.match(source, /token\.trim\(\) !== ""/);
  assert.match(source, /if \(passwordInput\) passwordInput\.value = ""/);
  assert.match(source, /That login was not accepted\./);
});
