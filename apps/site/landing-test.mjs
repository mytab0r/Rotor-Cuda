// Landing directory layout test: the fifteen chain links and the six address
// database links render as compact rows/inline links, not as tall cards.
//
// Usage: node apps/site/landing-test.mjs
//
// The rendered dead-space check is `card-dead-space` in scripts/ui-audit.mjs;
// this pins the markup and the CSS contract so the card grid cannot come back.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const landing = read("./landing.html");
const astro = read("../../web/src/pages/index.astro");
const css = read("./site.css");

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

test("landing chains are one-line rows, not cards", () => {
  const block = landing.slice(
    landing.indexOf('<h2>Chains</h2>'),
    landing.indexOf("</section>", landing.indexOf('<h2>Chains</h2>')),
  );
  assert.match(block, /class="chain-grid chain-grid--rows"/, "chain directory uses the row grid");
  const rows = [...block.matchAll(/<a class="chain-row" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  assert.equal(rows.length, 15, "fifteen chain rows");
  assert.equal((block.match(/class="chain-card"/g) || []).length, 0, "no chain card remains");
  for (const [, href, body] of rows) {
    assert.match(href, /^\/private-keys\//, `${href} is a chain hub`);
    assert.match(body, /class="chain-row-icon"[\s\S]*class="icon"/, `${href} keeps its icon`);
    assert.match(body, /class="chain-row-name"/, `${href} keeps its name`);
    const meta = body.match(/class="chain-row-meta">([^<]+)</);
    assert.ok(meta, `${href} keeps its meta line`);
    assert.match(meta[1], /^[A-Z]+ · \d+ types?$/, `${href} meta stays short enough for one line`);
  }
});

test("landing address databases are one inline list, not a card grid", () => {
  const start = landing.indexOf('<h2>Address databases</h2>');
  const block = landing.slice(start, landing.indexOf("</section>", start));
  assert.match(block, /<ul class="address-db-links">/, "one inline list");
  assert.equal((block.match(/class="address-db-card"/g) || []).length, 0, "no address-db card remains");
  assert.equal((block.match(/class="address-db-grid"/g) || []).length, 0, "no address-db grid remains");
  const links = [...block.matchAll(/<a class="address-db-link" href="([^"]+)">([\s\S]*?)<\/a>/g)];
  assert.equal(links.length, 6, "six inline links");
  for (const [, href, body] of links) {
    assert.equal(href, "/wallets", "the databases live on one page");
    assert.match(body, /class="address-db-name"/, "each link keeps its name");
    assert.match(body, /class="address-db-meta"/, "each link keeps its meta");
  }
});

test("the Astro mirror carries the same two surfaces", () => {
  assert.match(astro, /class="chain-grid chain-grid--rows"/, "Astro chain directory uses the row grid");
  assert.match(astro, /class="chain-row"/, "Astro renders chain rows");
  assert.match(astro, /<ul class="address-db-links">/, "Astro renders one address list");
  assert.equal((astro.match(/class="address-db-card"/g) || []).length, 0, "Astro keeps no address cards");
});

function declarations(selector) {
  const blocks = [...css.matchAll(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g"))];
  return blocks.map((match) => match[1]);
}

test("the card no longer reserves a fixed height", () => {
  const cardRules = [...css.matchAll(/\.chain-card[^{]*\{([^}]*)\}/g)].map((match) => match[1]);
  assert.ok(cardRules.length > 0, "the shared chain card still has a rule");
  for (const rule of cardRules) {
    assert.doesNotMatch(rule, /min-height\s*:/, "no .chain-card min-height reservation");
  }
});

test("the row form keeps the 44px control floor and a compact gap", () => {
  const row = declarations(".chain-row");
  assert.equal(row.length, 1, "one .chain-row rule");
  assert.match(row[0], /min-height:\s*var\(--control-h\)/, "row keeps the control height floor");
  assert.match(row[0], /gap:\s*var\(--space-2\)/, "row keeps the small gap token");
  const icon = declarations(".chain-row-icon").join("\n");
  assert.match(icon, /width:\s*var\(--space-6\)/, "row icon slot is 24px");
});

if (failed) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log("all landing tests passed");
