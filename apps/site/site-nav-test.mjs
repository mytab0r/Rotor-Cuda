#!/usr/bin/env node
/* Tests for the pure narrow-header nav helpers. No browser, no network. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("./chains.generated.js");
require("./amount.js");

const source = readFileSync(fileURLToPath(new URL("./site.js", import.meta.url)), "utf8");

/* site.js returns early when there is no document; the exports must already
 * exist at that point. */
globalThis.window = globalThis;
runInThisContext(source, { filename: "site.js" });

const nav = globalThis.RotorSiteNav;
assert.ok(nav, "site.js must expose RotorSiteNav before the DOM guard");
const crumbs = globalThis.RotorBreadcrumbs;
assert.ok(crumbs, "site.js must expose RotorBreadcrumbs before the DOM guard");

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

/* nav-keystore-highlight: /keystore-parser shares only the text prefix with
 * /key, so the Search item must match `/key` itself or a `/key/` child. The
 * tool pages highlight Tools, never Search. */
test("the section mapping keeps /keystore-parser on Tools", () => {
  assert.equal(nav.sectionForPath("/keystore-parser"), "tools");
  assert.equal(nav.sectionForPath("/keystore-parser/anything"), "tools");
  assert.equal(nav.sectionForPath("/key"), "search");
  assert.equal(nav.sectionForPath("/key/" + "0".repeat(64)), "search");
  assert.equal(nav.sectionForPath("/tools"), "tools");
  assert.equal(nav.sectionForPath("/"), "home");
  /* The wallet is a child of the cabinet area and shares its one header
   * entry, so the cabinet chip highlights there too. */
  assert.equal(nav.sectionForPath("/cabinet/wallet"), "cabinet");
  assert.equal(nav.sectionForPath("/monitor"), "cabinet");
});

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

test("zero inline moves every link into the drawer", () => {
  const parts = nav.splitLinks(links(8), 0);
  assert.deepEqual(parts.inline, []);
  assert.deepEqual(ids(parts.tail), ids(links(8)));
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

test("a breadcrumb trail puts one separator between items", () => {
  const trail = crumbs.trail([
    { label: "Home", href: "/" },
    { label: "Tools", href: "/tools" },
    { label: "Key explorer" },
  ]);
  assert.deepEqual(trail.map((entry) => entry.separator ? "/" : entry.label), [
    "Home", "/", "Tools", "/", "Key explorer",
  ]);
});

test("only the last breadcrumb is current", () => {
  const trail = crumbs.trail([
    { label: "Home", href: "/" },
    { label: "Docs" },
  ]);
  assert.equal(trail.filter((entry) => entry.current).length, 1);
  assert.equal(trail[trail.length - 1].current, true);
  assert.equal(trail[0].current, false);
});

test("empty and missing breadcrumb lists render nothing", () => {
  assert.deepEqual(crumbs.trail([]), []);
  assert.deepEqual(crumbs.trail(null), []);
});

/* Every static page carries its own copy of the header, while generated pages
 * use site_header() in src/coordinator/mod.rs. A nav edit applied to one copy
 * only silently loses the link on the other pages, so pin the full order. */
test("every static page ships the same main-nav link set", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const expected = ["home", "directory", "seeds", "puzzle", "vanity", "milk-sad", "tools", "docs"];
  let checked = 0;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".html"))) {
    const block = readFileSync(dir + name, "utf8").match(/<nav aria-label="Main">([\s\S]*?)<\/nav>/);
    if (!block) continue;
    const found = [...block[1].matchAll(/data-nav="([a-z-]+)"/g)].map((match) => match[1]);
    assert.deepEqual(found, expected, `${name} main nav links`);
    /* The Seeds item is a directory destination. Pointing it at the studio
     * (/seed) sent visitors expecting a browsable list to a converter. */
    const seeds = [...block[1].matchAll(/<a href="([^"]+)" data-nav="seeds"/g)].map((match) => match[1]);
    assert.deepEqual(seeds, ["/mnemonic-seeds"], `${name} Seeds nav destination`);
    checked += 1;
  }
  assert.ok(checked >= 20, `expected at least 20 static pages, checked ${checked}`);
});

/* The header is copied into every static page, so a route can keep a stale
 * icon after the others move. Pin the identity contract here as well as in the
 * browser audit: one sprite icon per destination and one accessible name per
 * control, or two different actions look identical at mobile widths. */
test("every static page gives each header control its own icon and name", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  let checked = 0;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".html"))) {
    const source = readFileSync(dir + name, "utf8");
    const header = source.match(/<header class="site-nav">([\s\S]*?)<\/header>/);
    if (!header) continue;
    const destinations = new Map();
    const names = new Map();
    for (const match of header[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      const attrs = match[1];
      const destination = (attrs.match(/data-nav="([a-z-]+)"/) || [])[1];
      if (!destination) continue;
      const icon = (match[2].match(/icons\.svg#([a-z-]+)/) || [])[1] || "";
      if (icon) {
        assert.ok(
          !destinations.has(icon) || destinations.get(icon) === destination,
          `${name}: ${icon} is shared by ${destinations.get(icon)} and ${destination}`,
        );
        destinations.set(icon, destination);
      }
      const label = (
        (attrs.match(/aria-label="([^"]+)"/) || [])[1] ||
        match[2].replace(/<[^>]*>/g, " ")
      ).replace(/\s+/g, " ").trim();
      if (label) {
        assert.ok(
          !names.has(label) || names.get(label) === destination,
          `${name}: accessible name "${label}" is shared by ${names.get(label)} and ${destination}`,
        );
        names.set(label, destination);
      }
    }
    checked += 1;
  }
  assert.ok(checked >= 20, `expected at least 20 static headers, checked ${checked}`);
});

/* The wallet is a child of the cabinet area: the header keeps one Cabinet
 * entry and reaches /cabinet/wallet from there. A second wallet chip consumed
 * the desktop row and made two 44px controls look identical on mobile. */
test("the static header exposes one cabinet entry and no wallet chip", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  let checked = 0;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".html"))) {
    const source = readFileSync(dir + name, "utf8");
    const header = source.match(/<header class="site-nav">([\s\S]*?)<\/header>/);
    if (!header || !header[1].includes('data-nav="home"')) continue;
    assert.ok(!header[1].includes('data-nav="wallet"'), `${name} has a separate wallet chip`);
    assert.ok(!header[1].includes('href="/cabinet/wallet"'), `${name} links the wallet from the header`);
    const cabinet = [...header[1].matchAll(/data-nav="cabinet"/g)].length;
    assert.equal(cabinet, 1, `${name} has ${cabinet} cabinet entries`);
    checked += 1;
  }
  assert.ok(checked >= 20, `expected at least 20 static headers, checked ${checked}`);
});

if (failed) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log("all site-nav tests passed");
