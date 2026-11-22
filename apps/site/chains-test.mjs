// Canonical chain identity test: data/chains.json (generated into
// chains.generated.js and the marked site.css region) is the single source of
// truth for symbol, color and display order.
//
// Usage: node apps/site/chains-test.mjs
//
// The real generated artifacts are read; no network, no DOM and no dependency
// outside Node's standard library. The browser-computed color check lives in
// scripts/ui-audit.mjs (`chain-tab-color`).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import "./chains.generated.js";

const chains = globalThis.RotorChains;
assert.ok(chains && chains.bySlug, "chains.generated.js must define RotorChains");

const CANONICAL_ORDER = [
  "bitcoin", "ethereum", "bnb", "arbitrum", "optimism", "base", "polygon",
  "avalanche", "zksync", "solana", "tron", "xrp", "litecoin", "bitcoin-cash",
  "dogecoin", "zcash", "sui", "ton",
];

assert.deepEqual(chains.order, CANONICAL_ORDER, "production order");
assert.equal(new Set(chains.order).size, chains.order.length, "order is unique");

for (const [index, slug] of CANONICAL_ORDER.entries()) {
  const chain = chains.bySlug[slug];
  assert.ok(chain, `${slug} is present`);
  assert.equal(chain.slug, slug, `${slug} slug`);
  assert.equal(chain.order, index + 1, `${slug} order`);
  assert.match(chain.color, /^#[0-9a-f]{6}$/, `${slug} color`);
  assert.match(chain.symbol, /^[A-Za-z]+$/, `${slug} symbol`);
  assert.ok(chain.decimals >= 0 && chain.decimals <= 30, `${slug} decimals`);
  assert.equal(chain.icon, `chain-${slug}`, `${slug} icon`);
}

// The symbol decision: the four L2s settle in ETH, the other EVM networks keep
// their own native ticker.
for (const slug of ["ethereum", "arbitrum", "optimism", "base", "zksync"]) {
  assert.equal(chains.bySlug[slug].symbol, "ETH", `${slug} symbol`);
}
assert.equal(chains.bySlug.bnb.symbol, "BNB");
assert.equal(chains.bySlug.polygon.symbol, "POL");
assert.equal(chains.bySlug.avalanche.symbol, "AVAX");

const css = readFileSync(new URL("./site.css", import.meta.url), "utf8");
const start = css.indexOf("/* chains:start */");
const end = css.indexOf("/* chains:end */");
assert.ok(start !== -1 && end > start, "site.css must carry the generated chains region");

const region = css.slice(start, end);
const variables = new Map();
for (const match of region.matchAll(/--chain-([a-z0-9-]+):\s*(#[0-9a-f]{6});/g)) {
  variables.set(match[1], match[2]);
}
for (const slug of CANONICAL_ORDER.slice(0, 8)) {
  assert.equal(
    variables.get(slug),
    chains.bySlug[slug].color,
    `site.css --chain-${slug} must equal the canonical color`,
  );
}

// Family classes resolve through the representative chain, not a literal.
const familyClasses = {
  "btc": "bitcoin",
  "evm": "ethereum",
  "tron": "tron",
  "solana": "solana",
  "ltc": "litecoin",
  "doge": "dogecoin",
  "bch": "bitcoin-cash",
  "xrp": "xrp",
};
for (const [family, slug] of Object.entries(familyClasses)) {
  assert.ok(
    region.includes(`.chain-${family} { --chain-color: var(--chain-${slug}); }`),
    `.chain-${family} must map to --chain-${slug}`,
  );
  assert.ok(
    region.includes(`.key-dot-${family} { background: var(--chain-${slug}); }`),
    `.key-dot-${family} must map to --chain-${slug}`,
  );
}

// No canonical color may be repeated outside the generated region.
const outside = css.slice(0, start) + css.slice(end);
const colors = new Set(CANONICAL_ORDER.map((slug) => chains.bySlug[slug].color));
for (const color of colors) {
  assert.ok(!outside.includes(color), `site.css repeats ${color} outside the generated region`);
}

console.log("chains: canonical order, symbols, colors and CSS variables OK");
