/* Landing directory layout contract for the Astro pilot.
 *
 * The landing renders the fifteen chain links and six address-database links
 * as compact rows/inline links, not as card grids. The coordinator landing is
 * pinned by `apps/site/landing-test.mjs`; this test pins the Astro mirror so a
 * revert to the old `.chain-card` / `.address-db-card` markup turns red.
 *
 * It reads the committed `src/pages/index.astro` source. The compiled test
 * lives in `.test-build/tests/`, so `../../src/pages/index.astro` resolves to
 * `web/src/pages/index.astro`. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SOURCE = fileURLToPath(
  new URL('../../src/pages/index.astro', import.meta.url),
);
const astro = readFileSync(SOURCE, 'utf8');

function section(startMarker: string): string {
  const start = astro.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = astro.indexOf('</section>', start);
  assert.notEqual(end, -1, `${startMarker} section does not close`);
  return astro.slice(start, end);
}

test('the chains directory renders rows, not cards', () => {
  const block = section('<h2 id="landing-chains">');
  assert.match(block, /class="chain-grid chain-grid--rows"/, 'chain grid uses the row modifier');
  assert.match(block, /class="chain-row"/, 'chain links use the row form');
  assert.doesNotMatch(block, /class="chain-card"/, 'no chain card remains');
  assert.doesNotMatch(block, /class="chain-icon-wrap"/, 'no card icon wrapper remains');
  assert.match(block, /class="chain-row-icon"/, 'the row keeps a compact icon slot');
  assert.match(block, /class="chain-row-name"/, 'the row keeps its name');
  assert.match(block, /class="chain-row-meta"/, 'the row keeps its meta');
});

test('the address databases render one inline list, not a card grid', () => {
  const block = section('<h2 id="landing-databases">');
  assert.match(block, /<ul class="address-db-links">/, 'one inline list');
  assert.doesNotMatch(block, /class="address-db-card"/, 'no address-db card remains');
  assert.doesNotMatch(block, /class="address-db-grid"/, 'no address-db grid remains');
  const links = [...block.matchAll(/<a class="address-db-link" href="([^"]+)">/g)];
  assert.equal(links.length, 6, 'six inline links');
  for (const [, href] of links) assert.equal(href, '/wallets', 'every database link points at /wallets');
});

test('the retired address-db grid override is gone from the shell', () => {
  const shell = readFileSync(
    fileURLToPath(new URL('../../src/styles/site-shell.css', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(shell, /\.landing-page \.address-db-grid/, 'the dead grid rule must stay deleted');
});
