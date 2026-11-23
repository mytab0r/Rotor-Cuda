/* Build-time mnemonic-seed derivation: the entropy set, BIP39/BIP32 and
 * SLIP-0010 paths, and the report-id mapping. The fixed vectors are the public
 * examples every BIP39 tool reproduces. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveSeedRows, seedFormatsFor, seedPathsFor } from '../src/lib/seed-directory.js';

const ZERO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('formats cover every chain and the paths this project uses', () => {
  assert.equal(seedFormatsFor('bitcoin').length, 4);
  assert.equal(seedFormatsFor('litecoin').length, 3);
  assert.equal(seedFormatsFor('bitcoin-cash').length, 2);
  assert.equal(seedFormatsFor('ton').length, 2);
  assert.deepEqual(seedPathsFor('bitcoin'), [
    "m/44'/0'/0'/0/0",
    "m/49'/0'/0'/0/0",
    "m/84'/0'/0'/0/0",
    "m/86'/0'/0'/0/0",
  ]);
  assert.deepEqual(seedPathsFor('ton'), ["m/44'/607'/0'"]);
  assert.throws(() => seedFormatsFor('bitcoin-testnet'), /no seed formats/);
});

test('index 0 is the all-zero BIP39 example and index 1 follows it', async () => {
  const rows = await deriveSeedRows('bitcoin', 2);
  assert.equal(rows[0]?.index, 0);
  assert.equal(rows[0]?.phrase, ZERO_PHRASE);
  assert.notEqual(rows[1]?.phrase, rows[0]?.phrase);
  assert.equal(rows[1]?.phrase.split(' ').length, 12);
});

test('Bitcoin rows keep the four standard paths and vectors', async () => {
  const rows = await deriveSeedRows('bitcoin', 1);
  assert.equal(rows[0]?.cells.length, 4);
  assert.deepEqual(
    rows[0]?.cells.map((cell) => cell.formatId),
    ['btc_p2pkh', 'btc_p2sh_p2wpkh', 'btc_p2wpkh', 'btc_p2tr'],
  );
  assert.equal(rows[0]?.cells[0]?.address, '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
  assert.match(rows[0]?.cells[2]?.address ?? '', /^bc1q/);
  assert.match(rows[0]?.cells[3]?.address ?? '', /^bc1p/);
});

test('EVM chains share the BIP44 coin-60 account', async () => {
  for (const slug of ['ethereum', 'bnb', 'arbitrum', 'optimism', 'base', 'polygon', 'avalanche', 'zksync']) {
    const rows = await deriveSeedRows(slug, 1);
    assert.equal(rows[0]?.cells.length, 1);
    assert.equal(rows[0]?.cells[0]?.address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  }
});

test('ed25519 chains use SLIP-0010 and the chain-specific address', async () => {
  const solana = await deriveSeedRows('solana', 1);
  assert.match(solana[0]?.cells[0]?.address ?? '', /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

  const sui = await deriveSeedRows('sui', 1);
  assert.match(sui[0]?.cells[0]?.address ?? '', /^0x[0-9a-f]{64}$/);

  const ton = await deriveSeedRows('ton', 1);
  assert.equal(ton[0]?.cells.length, 2);
  assert.match(ton[0]?.cells[0]?.address ?? '', /^[A-Za-z0-9_-]{48}$/);
  assert.match(ton[0]?.cells[1]?.address ?? '', /^[A-Za-z0-9_-]{48}$/);
  assert.notEqual(ton[0]?.cells[0]?.address, ton[0]?.cells[1]?.address);
});

test('Bitcoin Cash keeps one hash160 in two encodings', async () => {
  const rows = await deriveSeedRows('bitcoin-cash', 1);
  assert.equal(rows[0]?.cells[0]?.address, '1mW6fDEMjKrDHvLvoEsaeLxSCzZBf3Bfg');
  assert.match(rows[0]?.cells[1]?.address ?? '', /^bitcoincash:q[0-9a-z]+$/);
});

test('the example set is deterministic across calls', async () => {
  const first = await deriveSeedRows('litecoin', 2);
  const second = await deriveSeedRows('litecoin', 2);
  assert.deepEqual(first, second);
  assert.equal(first[0]?.cells.length, 3);
  assert.equal(new Set(first.flatMap((row) => row.cells.map((cell) => cell.address))).size, 6);
});
