/* Build-time chain-directory derivation: the WASM report mapping and the
 * CashAddr bridge. The fixed vectors are the same public key-1 values the
 * browser key page and the WASM smoke test use. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveDirectoryRows, formatsFor } from '../src/lib/chain-directory.js';

const KEY1 = '0000000000000000000000000000000000000000000000000000000000000001';

test('formats match the address families the page documents', () => {
  assert.equal(formatsFor('bitcoin').length, 4);
  assert.equal(formatsFor('litecoin').length, 4);
  assert.equal(formatsFor('bitcoin-cash').length, 2);
  assert.equal(formatsFor('ethereum').length, 1);
  assert.equal(formatsFor('solana').length, 1);
  assert.equal(formatsFor('ton').length, 1);
  assert.throws(() => formatsFor('bitcoin-testnet'), /no address formats/);
});

test('key 1 has the canonical Bitcoin and Ethereum vectors', async () => {
  const bitcoin = await deriveDirectoryRows('bitcoin', 1);
  assert.equal(bitcoin[0]?.keyHex, KEY1);
  assert.equal(bitcoin[0]?.address, '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH');

  const ethereum = await deriveDirectoryRows('ethereum', 1);
  assert.equal(ethereum[0]?.address, '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
});

test('Bitcoin Cash keeps the legacy and CashAddr views of one hash160', async () => {
  const rows = await deriveDirectoryRows('bitcoin-cash', 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.formatId, 'bch_legacy');
  assert.equal(rows[0]?.address, '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH');
  assert.equal(rows[1]?.formatId, 'bch_cashaddr');
  assert.match(rows[1]?.address ?? '', /^bitcoincash:q[0-9a-z]+$/);
});

test('ed25519 chains render a base58 account and a TON W5 address', async () => {
  const solana = await deriveDirectoryRows('solana', 1);
  assert.match(solana[0]?.address ?? '', /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

  const sui = await deriveDirectoryRows('sui', 1);
  assert.match(sui[0]?.address ?? '', /^0x[0-9a-f]{64}$/);

  const ton = await deriveDirectoryRows('ton', 1);
  assert.match(ton[0]?.address ?? '', /^[A-Za-z0-9_-]{48}$/);
});

test('a page group is key-major and deterministic', async () => {
  const first = await deriveDirectoryRows('bitcoin', 2);
  const second = await deriveDirectoryRows('bitcoin', 2);
  assert.deepEqual(first, second);
  assert.equal(first.length, 8);
  assert.deepEqual(
    first.map((row) => row.formatId),
    [
      'btc_p2pkh',
      'btc_p2sh_p2wpkh',
      'btc_p2wpkh',
      'btc_p2tr',
      'btc_p2pkh',
      'btc_p2sh_p2wpkh',
      'btc_p2wpkh',
      'btc_p2tr',
    ],
  );
  assert.equal(first[4]?.keyHex, '0000000000000000000000000000000000000000000000000000000000000002');
  assert.equal(new Set(first.map((row) => row.address)).size, 8);
});
