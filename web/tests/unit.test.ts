/* Unit tests for the TypeScript glue: word counting/validation, scheme
 * selection, path helpers and the target selection the page's controls drive. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAINS,
  addressOf,
  batchIndices,
  coin,
  countWords,
  csvText,
  normalizePhrase,
  selectedTargets,
  withIndex,
} from '../src/lib/seed-core.js';
import { loadVendor, loadWasm } from './harness.js';

loadVendor();
const wasm = await loadWasm();

test('countWords collapses whitespace and handles an empty phrase', () => {
  assert.equal(countWords(undefined), 0);
  assert.equal(countWords('   '), 0);
  assert.equal(countWords('abandon\tability\nabout'), 3);
  assert.equal(countWords('ABANDON Ability about'), 3);
});

test('normalizePhrase lowercases and collapses whitespace', () => {
  assert.equal(normalizePhrase('  Abandon \n\tAbility  '), 'abandon ability');
});

test('batchIndices produces the same next-five window as the page', () => {
  assert.deepEqual(batchIndices(20, 5), [20, 21, 22, 23, 24]);
  assert.deepEqual(batchIndices(1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(batchIndices(0, 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(batchIndices(18, 5), [18, 19, 20, 21, 22]);
  assert.deepEqual(batchIndices(-3, 0), []);
});

test('withIndex replaces the last segment only when the template is hardened', () => {
  assert.equal(withIndex("m/44'/0'/0'/0/0", 7), "m/44'/0'/0'/0/7");
  assert.equal(withIndex("m/44'/0'/0'/1", 3), "m/44'/0'/0'/3");
  assert.equal(withIndex("m/44'/0'/0'/1'", 3), "m/44'/0'/0'/3'");
  assert.equal(withIndex("m/44'/0'/0'/0/H", 2), "m/44'/0'/0'/0/2'");
});

test('selectedTargets: Electrum old has one Bitcoin target', () => {
  const targets = selectedTargets('electrum-old', 'ethereum', 'ignored', true);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.chain, 'bitcoin');
  assert.equal(targets[0]?.preset.id, 'btc_p2pkh_uncompressed');
  assert.equal(targets[0]?.preset.path, 'old');
});

test('selectedTargets: "all chains" takes the default preset per chain', () => {
  const targets = selectedTargets('bip39', 'all', '', false);
  assert.equal(targets.length, 7);
  assert.deepEqual(
    targets.map((target) => target.preset.id),
    ['btc_p2pkh', 'evm', 'tron', 'ltc_p2pkh', 'doge_p2pkh', 'bch_legacy', 'xrp_classic'],
  );
});

test('selectedTargets: "all chains" + all paths expands every preset in chain order', () => {
  const targets = selectedTargets('bip39', 'all', '', true);
  assert.equal(targets.length, 12);
  assert.deepEqual(
    targets.map((target) => target.preset.id),
    [
      'btc_p2pkh',
      'btc_p2sh_p2wpkh',
      'btc_p2wpkh',
      'btc_p2tr',
      'evm',
      'tron',
      'ltc_p2pkh',
      'ltc_p2sh_p2wpkh',
      'ltc_p2wpkh',
      'doge_p2pkh',
      'bch_legacy',
      'xrp_classic',
    ],
  );
});

test('selectedTargets: chain + path preset is honoured, all paths expands it', () => {
  const single = selectedTargets('bip39', 'bitcoin', "m/84'/0'/0'/0/0|btc_p2wpkh", false);
  assert.equal(single.length, 1);
  assert.equal(single[0]?.preset.id, 'btc_p2wpkh');
  const all = selectedTargets('bip39', 'bitcoin', "m/84'/0'/0'/0/0|btc_p2wpkh", true);
  assert.equal(all.length, CHAINS.bitcoin?.presets.length ?? 0);
  const fallback = selectedTargets('bip39', 'dogecoin', 'not-a-preset', false);
  assert.equal(fallback[0]?.preset.id, 'doge_p2pkh');
});

test('Electrum old results use the uncompressed address id', () => {
  const report = {
    pubkey_compressed: '',
    addresses: [
      { id: 'btc_p2pkh', address: 'compressed' },
      { id: 'btc_p2pkh_uncompressed', address: 'uncompressed' },
    ],
  };
  assert.equal(addressOf(report, 'btc_p2pkh_uncompressed'), 'uncompressed');
  assert.equal(addressOf(report, 'missing'), '');
  assert.equal(addressOf(null, 'btc_p2pkh'), '');
});

test('coin and csv helpers keep the current formatting', () => {
  assert.equal(coin(0, 8), '0');
  assert.equal(coin(0.5, 8), '<0.00000001');
  assert.equal(coin(1, 8), '0.00000001');
  assert.equal(coin(100000000n, 8), '1');
  assert.equal(coin(1500000000000000000n, 18), '1.5');
  assert.equal(csvText([{ chainLabel: 'Bitcoin, "main"', path: 'old/0/0', address: 'bc1q' }]), 'chain,path,address\n"Bitcoin, ""main""",old/0/0,bc1q\n');
});

test('the vendored wasm exposes the derive_report used by the page', () => {
  assert.equal(typeof wasm.alloc, 'function');
  assert.equal(typeof wasm.derive_report, 'function');
  assert.ok(wasm.memory instanceof WebAssembly.Memory);
});
