/* Validates the /site-map data file: route coverage, donor links and honest
 * status values. Run with: node apps/site/site-map-test.mjs */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const file = new URL('./site-map-data.js', import.meta.url);
const code = fs.readFileSync(file, 'utf8');
const sandbox = {};
new Function('window', code)(sandbox);
const data = sandbox.RotorSiteMapData;

assert.ok(data, 'site-map-data.js must assign window.RotorSiteMapData');
assert.ok(Array.isArray(data.ours), 'ours must be an array');
assert.ok(Array.isArray(data.donors), 'donors must be an array');
assert.ok(Array.isArray(data.features), 'features must be an array');
assert.equal(data.chains.length, 18, '18 chain routes are expected');

const allowed = new Set(['parity', 'partial', 'missing', 'ours-only']);
const presence = new Set(['present', 'partial', 'missing']);
const oursByPath = new Map(data.ours.map((route) => [route.path, route]));
const donorById = new Map(data.donors.map((donor) => [donor.id, donor]));

assert.equal(oursByPath.size, data.ours.length, 'duplicate ours paths');
assert.equal(donorById.size, data.donors.length, 'duplicate donor ids');

for (const route of data.ours) {
  assert.ok(route.path && route.title && route.area, `ours route fields: ${route.path}`);
  assert.ok(allowed.has(route.status), `bad route status: ${route.path} ${route.status}`);
  assert.ok(!('missing' === route.status), `ours route cannot be missing: ${route.path}`);
  for (const id of route.donorIds) {
    assert.ok(donorById.has(id), `${route.path} references unknown donor ${id}`);
  }
}

for (const donor of data.donors) {
  assert.ok(donor.source === 'pkf' || donor.source === 'ss', `donor source: ${donor.id}`);
  assert.ok(allowed.has(donor.status), `bad donor status: ${donor.id} ${donor.status}`);
  if (donor.status === 'missing') {
    assert.equal(donor.ours, null, `missing donor must have no Rotor route: ${donor.id}`);
  } else if (donor.ours && !donor.ours.startsWith('/key?')) {
    assert.ok(oursByPath.has(donor.ours), `donor ${donor.id} points at unknown route ${donor.ours}`);
  }
}

for (const chain of data.chains) {
  assert.ok(oursByPath.has('/private-keys/' + chain[0]), `missing /private-keys/${chain[0]}`);
  assert.ok(oursByPath.has('/mnemonic-seeds/' + chain[0]), `missing /mnemonic-seeds/${chain[0]}`);
  assert.ok(oursByPath.has('/brainwallet/' + chain[0]), `missing /brainwallet/${chain[0]}`);
  assert.ok(donorById.has('pkf:/brainwallet/' + chain[0]), `missing donor /brainwallet/${chain[0]}`);
}

const requiredOurs = [
  '/', '/private-keys', '/key', '/key/hex', '/key/wif', '/key/decimal',
  '/mnemonic-seeds', '/seed', '/mnemonic-converter',
  '/bitcoin-puzzle', '/bitcoin-puzzle/<n>/detail', '/bitcoin-puzzle/<n>/random',
  '/brainwallet', '/brainwallet/bitcoin', '/brainwallet/ethereum', '/brainwallet-generator',
  '/tools', '/vanity', '/milk-sad', '/hex-dec-bin', '/public-key', '/pubkey-add',
  '/reconstruction', '/keystore-parser', '/wallets', '/cabinet/wallet', '/cabinet',
  '/faq', '/disclaimer', '/donate', '/docs'
];
for (const path of requiredOurs) {
  assert.ok(oursByPath.has(path), `missing required Rotor route ${path}`);
}

const requiredDonors = {
  pkf: [
    '/', '/private-keys', '/key/<hex|wif|decimal>', '/mnemonic-seeds',
    '/mnemonic-converter', '/bitcoin-puzzle', '/brainwallet', '/brainwallet/bitcoin',
    '/brainwallet/ethereum', '/brainwallet-generator', '/vanity-generator',
    '/keystore-parser', '/public-key', '/hex-dec-bin', '/pubkey-add', '/reconstruction',
    '/richest', '/bitcoin-dormant', '/satoshi-wallets', '/whale-tracker',
    '/wallet-viewer', '/wallets', '/faq', '/disclaimer', '/donate'
  ],
  ss: [
    '/PrivateKeyHex', '/PrivateKeyWif', '/PrivateKeyEth', '/PrivateKeyTron',
    '/PrivateKeySegwit', '/PrivateKey_wif_to_hex', '/Bech32', '/PublicKey',
    '/PubkeyAdd', '/Reconstruction', '/HexDecBin', '/Transaction_decoded_Bitcoin',
    '/decode_ethereum_transaction', '/Easy_bitcoin_transaction_online',
    '/Easy_ethereum_transaction_online', '/Easy_bnb_transaction_online',
    '/Easy_tron_trx_transaction_online', '/Easy_usdt_erc20_transaction_online',
    '/wallets', '/richest', '/bitcoin-puzzle', '/vanity-generator',
    '/keystore-parser', '/dashboard', '/results', '/scaner', '/programs', '/rent',
    '/benchmark', '/about'
  ]
};
for (const [source, paths] of Object.entries(requiredDonors)) {
  for (const path of paths) {
    assert.ok(donorById.has(`${source}:${path}`), `missing donor route ${source}:${path}`);
  }
}

const featureIds = new Set();
for (const item of data.features) {
  assert.ok(item.id && item.capability, 'feature id and capability are required');
  assert.ok(!featureIds.has(item.id), `duplicate feature id ${item.id}`);
  featureIds.add(item.id);
  assert.ok(presence.has(item.donor), `bad donor presence: ${item.id}`);
  assert.ok(presence.has(item.rotor), `bad rotor presence: ${item.id}`);
  assert.ok(allowed.has(item.status), `bad feature status: ${item.id}`);
  if (item.rotor === 'missing') {
    assert.equal(item.status, 'missing', `missing Rotor capability must be missing: ${item.id}`);
  }
  if (item.donor === 'present' && item.rotor === 'present') {
    assert.ok(['parity', 'ours-only'].includes(item.status), `both present should be parity: ${item.id}`);
  }
  assert.ok(Array.isArray(item.sources), `feature sources: ${item.id}`);
}

const count = (list, status) => list.filter((item) => item.status === status).length;
const missingDonors = data.donors.filter((donor) => donor.status === 'missing').length;

console.log(
  `site-map OK: ${data.ours.length} ours, ${data.donors.length} donors, ` +
  `${data.features.length} features; ours parity ${count(data.ours, 'parity')}, ` +
  `partial ${count(data.ours, 'partial')}, ours-only ${count(data.ours, 'ours-only')}, ` +
  `donor-only missing ${missingDonors}`
);
