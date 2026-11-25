/* The curated key pages and the build-time derivation.
 *
 * The vectors are the ones the live page already produces for keys 1-3; the
 * point of the test is that the Astro build reads the same WASM report and the
 * same browser helpers, not a second implementation. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CURATED_KEYS, DEFAULT_KEY } from '../src/lib/key-curated.js';
import { deriveKeyPage } from '../src/lib/key-core.js';
import { groupRows } from '../src/lib/key-model.js';

const KEY_1 = '0'.repeat(63) + '1';
const KEY_2 = '0'.repeat(63) + '2';
const KEY_3 = '0'.repeat(63) + '3';

test('the curated set is at least three unique 64-hex keys and starts at key 1', () => {
  assert.ok(CURATED_KEYS.length >= 3);
  assert.equal(DEFAULT_KEY.hex, KEY_1);
  const seen = new Set<string>();
  for (const key of CURATED_KEYS) {
    assert.match(key.hex, /^[0-9a-f]{64}$/);
    assert.equal(key.path, `/key/${key.hex}`);
    assert.ok(!seen.has(key.hex));
    seen.add(key.hex);
  }
});

test('key 1 derives the 31-row donor table and the eight donor facts', async () => {
  const page = await deriveKeyPage(KEY_1);
  assert.equal(page.rows.length, 31);
  assert.deepEqual(
    page.facts.map((fact) => fact.id),
    ['hex', 'decimal', 'wif', 'wif_u', 'keypair', 'xrp', 'pubkey', 'page'],
  );
  const facts = new Map(page.facts.map((fact) => [fact.id, fact]));
  assert.equal(facts.get('hex')?.value, KEY_1);
  assert.equal(facts.get('decimal')?.value, '1');
  assert.equal(facts.get('wif')?.value, 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn');
  assert.equal(facts.get('wif_u')?.value, '5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf');
  assert.equal(facts.get('pubkey')?.value, '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  assert.ok(facts.get('keypair')?.value);
  assert.ok(facts.get('xrp')?.value);
  assert.equal(facts.get('page')?.valueHref, '/private-keys/bitcoin');
  assert.equal(facts.get('page')?.displayValue, 'Page 1');

  assert.deepEqual(
    page.extras.map((fact) => fact.id),
    ['point-compressed', 'point-uncompressed', 'point-x', 'point-y'],
  );
  assert.equal(page.extras[0]?.value, '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');

  const first = page.rows.find((row) => row.id === 'btc_p2pkh');
  assert.equal(first?.address, '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH');
  assert.equal(first?.chain, 'Bitcoin');
  assert.equal(first?.type, 'Legacy');
  const ton = ['ton_v3r2', 'ton_v4r2', 'ton_w5'].map((id) => page.rows.find((row) => row.id === id));
  for (const row of ton) assert.match(row?.address ?? '', /^EQ/);
  assert.equal(new Set(ton.map((row) => row?.address)).size, 3, 'each TON wallet version has its own address');
  const evm = page.rows.find((row) => row.id === 'evm');
  assert.equal(evm?.address, '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  assert.equal(evm?.type, '↑ same');
  assert.equal(page.model.rows.length, 31);
});

test('keys 2 and 3 derive the same first legacy address the static page renders', async () => {
  const [two, three] = await Promise.all([deriveKeyPage(KEY_2), deriveKeyPage(KEY_3)]);
  assert.equal(two.rows.find((row) => row.id === 'btc_p2pkh')?.address, '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP');
  assert.equal(three.rows.find((row) => row.id === 'btc_p2pkh')?.address, '1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb');
  assert.notEqual(two.facts.find((fact) => fact.id === 'wif')?.value, three.facts.find((fact) => fact.id === 'wif')?.value);
});

test('a value at the secp256k1 order keeps the ed25519 rows and reports the range', async () => {
  const order = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
  const page = await deriveKeyPage(order);
  assert.ok(page.secpError);
  assert.ok(page.rows.some((row) => row.id === 'solana'));
  assert.ok(!page.rows.some((row) => row.id === 'btc_p2pkh'));
});

test('groupRows spans each contiguous chain run, not just the previous row', async () => {
  const page = await deriveKeyPage(KEY_1);
  const grouped = groupRows(page.rows.map((row) => ({ id: row.id, group: row.group })));
  const spanFor = (id: string) => grouped.find((entry) => entry.row.id === id)?.span;
  assert.equal(spanFor('btc_p2pkh'), 5, 'Bitcoin is one five-row group');
  assert.equal(spanFor('ltc_p2pkh'), 4, 'Litecoin is one four-row group');
  assert.equal(spanFor('bch_legacy'), 2);
  assert.equal(spanFor('doge_p2pkh'), 2);
  assert.equal(spanFor('ton_v4r2'), 3, 'TON is one three-row group');
  assert.equal(spanFor('zcash_p2pkh'), 2);
  for (const id of ['evm', 'evm_bnb', 'evm_arbitrum', 'evm_optimism', 'evm_base', 'evm_polygon', 'evm_avalanche', 'evm_zksync']) {
    assert.equal(spanFor(id), 1, `${id} keeps its own chain cell`);
  }
  assert.equal(grouped.filter((entry) => entry.first).length, 19, 'one Chain cell per contiguous group');
});
