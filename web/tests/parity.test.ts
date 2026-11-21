/* Parity with the current /mnemonic-converter implementation.
 *
 * Every fixed vector below is the one already asserted by apps/site/seed-test.mjs
 * and apps/site/mnemonic-seeds-test.mjs. The new page's derivation functions
 * must produce the same keys, addresses and seed bytes. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addressOf,
  countWords,
  deriveEntries,
  deriveMore,
  phraseHint,
  reportFor,
  schemeForPhrase,
  type DeriveOutcome,
  type DerivationResult,
} from '../src/lib/seed-core.js';
import { loadVendor, loadWasm } from './harness.js';

const vendor = loadVendor();
const wasm = await loadWasm();

const BIP39_PHRASE = 'abandon '.repeat(11) + 'about';
const OLD_PHRASE =
  'hardly point goal hallway patience key stone difference ready caught listen fact';
const OLD_SEED_HEX = '8edad31a95e7d59f8837667510d75a4d';
const SEGWIT_PHRASE =
  'wild father tree among universe such mobile favorite target dynamic credit identify';
const STANDARD_PHRASE =
  'cram swing cover prefer miss modify ritual silly deliver chunk behind inform able';

function first(outcome: DeriveOutcome): DerivationResult {
  const row = outcome.rows[0];
  assert.ok(row, 'the derivation produced no rows');
  return row;
}

test('BIP39 vector: abandon…about derives the same key and address', async () => {
  const outcome = await deriveEntries({
    phrase: BIP39_PHRASE,
    passphrase: '',
    scheme: 'bip39',
    chain: 'bitcoin',
    pathValue: "m/44'/0'/0'/0/0|btc_p2pkh",
    allPaths: false,
    count: 1,
    wasm,
  });
  const row = first(outcome);
  assert.equal(row.path, "m/44'/0'/0'/0/0");
  assert.equal(
    row.privHex,
    'e284129cc0922579a535bbf4d1a3b25773090d28c909bc0fed73b5e0222cc372',
    'BIP39 private key',
  );
  assert.equal(row.address, '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA', 'BIP39 address');
  assert.equal(outcome.info.seedType, 'bip39');
});

test('BIP39: the passphrase changes the derived seed like the current page', async () => {
  const plain = await vendor.crypto.bip39Seed(BIP39_PHRASE, '');
  const withPass = await vendor.crypto.bip39Seed(BIP39_PHRASE, 'TREZOR');
  assert.notDeepEqual(plain, withPass, 'passphrase must change the seed');

  const outcome = await deriveEntries({
    phrase: BIP39_PHRASE,
    passphrase: 'TREZOR',
    scheme: 'bip39',
    chain: 'bitcoin',
    pathValue: "m/49'/0'/0'/0/0|btc_p2sh_p2wpkh",
    allPaths: false,
    count: 1,
    wasm,
  });
  const row = first(outcome);
  const bundled = vendor.seed.derive(BIP39_PHRASE, 'TREZOR', "m/49'/0'/0'/0/0");
  assert.equal(row.privHex, bundled, 'same key as the bundled scure implementation');
});

test('BIP39 derivation matches the bundled implementation on the four presets', async () => {
  const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const presets = [
    { path: "m/44'/0'/0'/0/0", id: 'btc_p2pkh' },
    { path: "m/49'/0'/0'/0/0", id: 'btc_p2sh_p2wpkh' },
    { path: "m/84'/0'/0'/0/0", id: 'btc_p2wpkh' },
    { path: "m/86'/0'/0'/0/0", id: 'btc_p2tr' },
  ];
  for (const preset of presets) {
    const outcome = await deriveEntries({
      phrase,
      passphrase: 'TREZOR',
      scheme: 'bip39',
      chain: 'bitcoin',
      pathValue: preset.path + '|' + preset.id,
      allPaths: false,
      count: 1,
      wasm,
    });
    assert.equal(first(outcome).privHex, vendor.seed.derive(phrase, 'TREZOR', preset.path), preset.path);
  }
});

test('the vendored BIP32 chain matches the bundled implementation on arbitrary paths', async () => {
  const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const seed = await vendor.crypto.bip39Seed(phrase, 'TREZOR');
  const pubkeyFor = async (keyHex: string) =>
    Uint8Array.from(Buffer.from(reportFor(wasm, keyHex).pubkey_compressed, 'hex'));
  for (const path of ["m/44'/0'/0'/0/0", "m/49'/0'/0'/0/4", "m/84'/0'/0'/1/7", "m/86'/0'/0'/0/2"]) {
    const ours = await vendor.crypto.bip32PrivateKey(seed, path, pubkeyFor);
    assert.equal(ours, vendor.seed.derive(phrase, 'TREZOR', path), path);
  }
});

test('BIP39: twenty consecutive addresses are distinct and start with the vector', async () => {
  const outcome = await deriveEntries({
    phrase: BIP39_PHRASE,
    passphrase: '',
    scheme: 'bip39',
    chain: 'bitcoin',
    pathValue: "m/44'/0'/0'/0/0|btc_p2pkh",
    allPaths: false,
    count: 20,
    wasm,
  });
  assert.equal(outcome.rows.length, 20);
  assert.equal(outcome.rows[0]?.address, '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
  assert.equal(new Set(outcome.rows.map((row) => row.address)).size, 20);
  assert.equal(outcome.rows[19]?.path, "m/44'/0'/0'/0/19");
});

test('Electrum old: phrase, private keys and addresses match the vectors', async () => {
  const old = vendor.crypto.validateOld(OLD_PHRASE);
  assert.equal(old.seedHex, OLD_SEED_HEX);

  const outcome = await deriveEntries({
    phrase: OLD_PHRASE,
    passphrase: '',
    scheme: 'electrum-old',
    chain: 'bitcoin',
    pathValue: 'old',
    allPaths: false,
    count: 2,
    wasm,
  });
  assert.equal(outcome.rows.length, 2);
  assert.equal(
    outcome.rows[0]?.privHex,
    '490aa18749841c21f4ece6da50898645578736ce0e38cd67568c14e3c47c9d95',
    'old address 0 private key',
  );
  assert.equal(outcome.rows[0]?.address, '18v3oDeH9LCmeKrbC2nYgLP5UKva1NpMG', 'old address 0');
  assert.equal(outcome.rows[1]?.address, '1BDoTF94QViEdnNuL4n6gQ8LgihBNCwXDT', 'old address 1');
  assert.equal(outcome.rows[0]?.path, 'old/0/0');
  assert.equal(outcome.rows[1]?.path, 'old/0/1');
});

test('Electrum old: load more continues from the rendered count', async () => {
  const firstBatch = await deriveEntries({
    phrase: OLD_PHRASE,
    passphrase: '',
    scheme: 'electrum-old',
    chain: 'bitcoin',
    pathValue: 'old',
    allPaths: false,
    count: 1,
    wasm,
  });
  const more = await deriveMore(firstBatch.snapshot, 5, { wasm });
  assert.equal(more.rows.length, 5);
  assert.equal(more.rows[0]?.path, 'old/0/1');
  assert.equal(more.rows[0]?.address, '1BDoTF94QViEdnNuL4n6gQ8LgihBNCwXDT');
  assert.equal(more.rows[4]?.path, 'old/0/5');
});

test('Electrum seed versions match the published vectors', async () => {
  assert.equal(await vendor.crypto.electrumSeedType(SEGWIT_PHRASE), 'segwit');
  assert.equal(await vendor.crypto.electrumSeedType(STANDARD_PHRASE), 'standard');
  assert.equal(await vendor.crypto.electrumSeedType(BIP39_PHRASE), '');

  const master = await vendor.crypto.electrumSeed(SEGWIT_PHRASE, '');
  assert.equal(
    Buffer.from(master).toString('hex'),
    'aac2a6302e48577ab4b46f23dbae0774e2e62c796f797d0a1b5faeb528301e3064342dafb79069e7c4c6b8c38ae11d7a973bec0d4f70626f8cc5184a8d0b0756',
    'Electrum master seed',
  );
  const withPassphrase = await vendor.crypto.electrumSeed(
    SEGWIT_PHRASE,
    'Did you ever hear the tragedy of Darth Plagueis the Wise?',
  );
  assert.equal(
    Buffer.from(withPassphrase).toString('hex'),
    '4aa29f2aeb0127efb55138ab9e7be83b36750358751906f86c662b21a1ea1370f949e6d1a12fa56d3d93cadda93038c76ac8118597364e46f5156fde6183c82f',
    'Electrum master seed with passphrase',
  );
});

test('Electrum BIP39: validation, derivation and parity with the current engine', async () => {
  const segwit = await vendor.crypto.validateElectrumBip39(SEGWIT_PHRASE);
  assert.equal(segwit.seedType, 'segwit');
  assert.equal(segwit.words.length, 12);
  const standard = await vendor.crypto.validateElectrumBip39(STANDARD_PHRASE);
  assert.equal(standard.seedType, 'standard');
  assert.equal(standard.words.length, 13);
  await assert.rejects(
    () => vendor.crypto.validateElectrumBip39(BIP39_PHRASE),
    /not an Electrum BIP39 seed/,
  );

  const outcome = await deriveEntries({
    phrase: SEGWIT_PHRASE,
    passphrase: '',
    scheme: 'electrum-bip39',
    chain: 'bitcoin',
    pathValue: "m/84'/0'/0'/0/0|btc_p2wpkh",
    allPaths: false,
    count: 1,
    wasm,
  });
  const seed = await vendor.crypto.electrumSeed(SEGWIT_PHRASE, '');
  const expectedKey = await vendor.crypto.bip32PrivateKey(seed, "m/84'/0'/0'/0/0", async (keyHex) =>
    Uint8Array.from(Buffer.from(reportFor(wasm, keyHex).pubkey_compressed, 'hex')),
  );
  assert.equal(first(outcome).privHex, expectedKey);
  assert.equal(first(outcome).address, addressOf(reportFor(wasm, expectedKey), 'btc_p2wpkh'));
  assert.ok(first(outcome).address.startsWith('bc1q'));
});

test('the live word counter normalizes whitespace', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('  abandon \n ability\t'), 2);
  assert.equal(countWords(BIP39_PHRASE), 12);
  assert.equal(countWords(OLD_PHRASE), 12);
});

test('validity hints follow the derive rules for every scheme', async () => {
  assert.equal(await phraseHint(BIP39_PHRASE, 'bip39'), 'Valid BIP39 phrase.');
  assert.equal(
    await phraseHint('abandon '.repeat(11).trim(), 'bip39'),
    'BIP39 uses 12, 15, 18, 21 or 24 words.',
  );
  assert.equal(
    await phraseHint('zzzz '.repeat(12).trim(), 'bip39'),
    'Some words are not in the BIP39 wordlist.',
  );
  assert.equal(await phraseHint('abandon '.repeat(12).trim(), 'bip39'), 'BIP39 checksum does not match.');
  assert.equal(await phraseHint(OLD_PHRASE, 'electrum-old'), 'Valid Electrum old phrase.');
  assert.equal(
    await phraseHint('hardly point goal hallway patience key stone difference ready caught listen', 'electrum-old'),
    'Electrum old phrases use 12 or 24 words.',
  );
  assert.equal(
    await phraseHint(SEGWIT_PHRASE, 'electrum-bip39'),
    'Valid Electrum BIP39 phrase (segwit).',
  );
  assert.equal(
    await phraseHint(STANDARD_PHRASE, 'electrum-bip39'),
    'Valid Electrum BIP39 phrase (standard).',
  );
  assert.equal(
    await phraseHint('science dawn member doll dutch real can brick knife deny drive list', 'electrum-bip39'),
    'Electrum 2FA seeds are not supported here.',
  );
  assert.equal(await phraseHint(BIP39_PHRASE, 'electrum-bip39'), 'Not an Electrum BIP39 seed-version phrase.');
  assert.equal(await phraseHint('abandon', 'electrum-bip39'), 'An Electrum seed needs at least two words.');
});

test('scheme selection restores the same scheme as the current page', () => {
  assert.equal(schemeForPhrase(BIP39_PHRASE), 'bip39');
  assert.equal(schemeForPhrase(OLD_PHRASE), 'electrum-old');
  assert.equal(schemeForPhrase(SEGWIT_PHRASE), 'electrum-bip39');
  assert.equal(schemeForPhrase(STANDARD_PHRASE), 'electrum-bip39');
});

test('Electrum old errors are the same as the current page', async () => {
  await assert.rejects(
    () =>
      deriveEntries({
        phrase: OLD_PHRASE,
        passphrase: 'not allowed',
        scheme: 'electrum-old',
        chain: 'bitcoin',
        pathValue: 'old',
        allPaths: false,
        count: 1,
        wasm,
      }),
    /Electrum old seeds do not support a passphrase/,
  );
  await assert.rejects(
    () =>
      deriveEntries({
        phrase: 'abandon '.repeat(11).trim(),
        passphrase: '',
        scheme: 'bip39',
        chain: 'bitcoin',
        pathValue: "m/44'/0'/0'/0/0|btc_p2pkh",
        allPaths: false,
        count: 1,
        wasm,
      }),
    /A BIP39 mnemonic has 12, 15, 18, 21 or 24 words; this one has 11\./,
  );
});
