// Pins DESIGN-SYSTEM 3.19 on the cabinet wallet: one short inline sentence per
// card, long explanations behind <details>, and the seed estimate inside the
// existing info popover. The revert tier reverts wallet.js and needs this test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./wallet.html", import.meta.url), "utf8");
const js = readFileSync(new URL("./wallet.js", import.meta.url), "utf8");
const strip = (text) => text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("the top notice keeps one short safety sentence", () => {
  const match = /<p class="notice"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  assert.ok(match, "the notice is present");
  const text = strip(match[1]);
  assert.ok(text.length <= 260, `the notice is ${text.length} characters`);
  assert.match(text, /Losing the passphrase loses the keys/i);
});

test("long explanations live behind disclosures", () => {
  const details = (html.match(/<details/g) || []).length;
  assert.ok(details >= 10, `only ${details} details blocks`);
});

test("the seed estimate moved into the info popover", () => {
  assert.match(js, /wallet-seed-info-popover/);
  assert.match(js, /aria-expanded/);
  assert.doesNotMatch(html, /id="wallet-seed-estimate"[^>]*>[^<]{200}/);
});
