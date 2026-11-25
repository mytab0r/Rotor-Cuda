#!/usr/bin/env node
/* /docs is a reading surface: one compact "On this page" card and one card per
 * section, never the old single card holding every section. This pins the
 * served legacy page and its Astro counterpart:
 *   - at least eight section cards, each with one H2 and a kebab-case id;
 *   - a TOC with exactly one link per section, every href resolving to a card;
 *   - no element that wraps several H2s in one `.card.docs` block;
 *   - the Astro page carries the same section ids in the same order.
 *
 * Usage: node apps/site/docs-sections-test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const legacy = read("./docs.html");
const astro = read("../../web/src/pages/docs/index.astro");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}\n  ${error && error.stack ? error.stack : error}`);
  }
}

const SECTION = /<section\b([^>]*\bclass\s*=\s*["'][^"']*\bcard\b[^"']*["'][^>]*)>([\s\S]*?)<\/section>/gi;
const attrId = (attrs) => (attrs.match(/\bid\s*=\s*["']([^"']+)["']/i) || [])[1] || null;
const headingText = (body) => {
  const match = body.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  return match ? match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : null;
};

function sectionsOf(html) {
  return [...html.matchAll(SECTION)].map((match) => ({
    id: attrId(match[1]),
    body: match[2],
    heading: headingText(match[2]),
  }));
}

function tocOf(html) {
  const nav = html.match(/<nav\b[^>]*\bdata-docs-toc\b[^>]*>([\s\S]*?)<\/nav>/i);
  assert.ok(nav, "docs.html must keep the data-docs-toc nav");
  return [...nav[1].matchAll(/href\s*=\s*["']#([^"']+)["']/gi)].map((match) => match[1]);
}

test("the legacy page renders one card per section, never one giant card", () => {
  const sections = sectionsOf(legacy);
  assert.ok(sections.length >= 8, `expected at least eight section cards, found ${sections.length}`);
  for (const section of sections) {
    assert.ok(section.id, "every section card carries an id");
    assert.match(section.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${section.id} is kebab-case`);
    assert.equal(
      (section.body.match(/<h2\b/gi) || []).length,
      1,
      `#${section.id} holds exactly one H2, not the whole page`,
    );
  }
});

test("the TOC has one link per section and every href resolves", () => {
  const sections = sectionsOf(legacy);
  const ids = sections.map((section) => section.id);
  const toc = tocOf(legacy);
  assert.equal(new Set(ids).size, ids.length, "section ids are unique");
  assert.equal(toc.length, sections.length, "one TOC link per section card");
  assert.deepEqual(toc, ids, "the TOC follows the section order");
  for (const anchor of toc) {
    assert.ok(ids.includes(anchor), `TOC href #${anchor} resolves to a section card`);
  }
  for (const section of sections) {
    assert.ok(
      toc.includes(section.id),
      `section #${section.id} is in the TOC`,
    );
  }
});

test("the TOC labels match the section headings", () => {
  const labels = new Map();
  for (const section of sectionsOf(legacy)) labels.set(section.id, section.heading);
  const toc = legacy.match(/<nav\b[^>]*\bdata-docs-toc\b[^>]*>([\s\S]*?)<\/nav>/i);
  for (const [, href, text] of toc[1].matchAll(/href\s*=\s*["']#([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    assert.equal(text.replace(/<[^>]+>/g, "").trim(), labels.get(href), `label for #${href}`);
  }
});

test("the internal site-map audit section is not exposed on /docs", () => {
  assert.ok(!legacy.includes("site-map-and-donor-parity"), "the site-map section is gone");
  assert.ok(!/donor parity/i.test(legacy), "the internal parity copy is gone");
  assert.ok(!astro.includes("site-map-and-donor-parity"), "the Astro page drops the section too");
});

test("the Astro page renders the same section cards", () => {
  const legacySections = sectionsOf(legacy);
  const astroSections = sectionsOf(astro);
  assert.deepEqual(
    astroSections.map((section) => section.id),
    legacySections.map((section) => section.id),
    "same section ids in the same order",
  );
  assert.deepEqual(
    astroSections.map((section) => section.heading),
    legacySections.map((section) => section.heading),
    "same section headings in the same order",
  );
  assert.ok(!astro.includes('<article class="card docs-prose">'), "no single article card remains");
  assert.match(astro, /<nav class="card docs-toc"[^>]*data-docs-toc/, "the TOC is a card");
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall docs section tests passed");
