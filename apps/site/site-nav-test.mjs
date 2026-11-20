#!/usr/bin/env node
/* Tests for the pure narrow-header nav helpers. No browser, no network. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

const source = readFileSync(fileURLToPath(new URL("./site.js", import.meta.url)), "utf8");

/* site.js returns early when there is no document; the exports must already
 * exist at that point. */
globalThis.window = globalThis;
runInThisContext(source, { filename: "site.js" });

const nav = globalThis.RotorSiteNav;
assert.ok(nav, "site.js must expose RotorSiteNav before the DOM guard");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}\n  ${err && err.stack ? err.stack : err}`);
  }
}

function links(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `link-${index}` }));
}

const ids = (list) => list.map((link) => link.id);

test("seven primary links split into four inline and three in the tail", () => {
  assert.equal(nav.INLINE_COUNT, 4);
  const parts = nav.splitLinks(links(7), nav.INLINE_COUNT);
  assert.deepEqual(ids(parts.inline), ["link-0", "link-1", "link-2", "link-3"]);
  assert.deepEqual(ids(parts.tail), ["link-4", "link-5", "link-6"]);
});

test("a short nav keeps every link inline and leaves an empty tail", () => {
  const parts = nav.splitLinks(links(3), 4);
  assert.deepEqual(ids(parts.inline), ["link-0", "link-1", "link-2"]);
  assert.deepEqual(parts.tail, []);
});

test("a keep count beyond the link count is clamped", () => {
  const parts = nav.splitLinks(links(2), 9);
  assert.deepEqual(ids(parts.inline), ["link-0", "link-1"]);
  assert.deepEqual(parts.tail, []);
});

test("an active tail link is detected", () => {
  const parts = nav.splitLinks(links(7), nav.INLINE_COUNT);
  assert.equal(nav.activeInTail(parts.tail, (link) => link.id === "link-5"), true);
  assert.equal(nav.activeInTail(parts.tail, (link) => link.id === "link-3"), false);
  assert.equal(nav.activeInTail([], () => true), false);
});

test("restoring and re-splitting is idempotent and duplicates nothing", () => {
  const original = links(7);
  const first = nav.splitLinks(original, nav.INLINE_COUNT);
  const restored = first.inline.concat(first.tail);
  assert.deepEqual(ids(restored), ids(original));

  const second = nav.splitLinks(restored, nav.INLINE_COUNT);
  assert.deepEqual(ids(second.inline), ids(first.inline));
  assert.deepEqual(ids(second.tail), ids(first.tail));
  assert.deepEqual(ids(second.inline.concat(second.tail)), ids(original));
});

if (failed) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log("all site-nav tests passed");
