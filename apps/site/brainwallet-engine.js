/* Pure helpers shared by the brainwallet pages and their Node test.
 *
 * This module never touches the DOM, storage, the URL or the network. It
 * selects which of the existing wasm `derive_report` address rows a page
 * shows, builds explorer links and turns a passphrase into its SHA-256 key
 * (the same transform the key search uses). Address math stays in the wasm
 * core; this file only picks and labels the already-derived rows. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorBrainwallet = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var WARNING_TEXT = 'Brainwallets are unsafe for real funds. A SHA-256 passphrase can be ' +
    'guessed or found in public wordlists, and anyone who knows the phrase controls the ' +
    'funds. Use only throwaway phrases you are authorized to test; never a phrase that ' +
    'protects money. This page runs entirely in your browser and does not look anything up.';

  var EXPLORERS = {
    btc_p2pkh: 'https://mempool.space/address/',
    btc_p2pkh_uncompressed: 'https://mempool.space/address/',
    btc_p2sh_p2wpkh: 'https://mempool.space/address/',
    btc_p2wpkh: 'https://mempool.space/address/',
    btc_p2tr: 'https://mempool.space/address/',
    evm: 'https://etherscan.io/address/'
  };

  var FOCUS = {
    all: {
      wif: true,
      ids: ['btc_p2pkh', 'btc_p2wpkh', 'btc_p2tr', 'evm']
    },
    bitcoin: {
      wif: true,
      ids: ['btc_p2pkh', 'btc_p2wpkh', 'btc_p2tr']
    },
    ethereum: {
      wif: false,
      ids: ['evm']
    }
  };

  /* A tiny list is enough for a throwaway phrase: the generated words are not
   * meant to be memorable or secret, only an obvious test input. */
  var WORDS = [
    'amber', 'anchor', 'bamboo', 'beacon', 'birch', 'cactus', 'canyon', 'cedar',
    'cobalt', 'copper', 'coral', 'dawn', 'delta', 'ember', 'falcon', 'fern',
    'flint', 'glacier', 'harbor', 'indigo', 'ivory', 'juniper', 'lagoon', 'maple',
    'meadow', 'nectar', 'onyx', 'orbit', 'pebble', 'quartz', 'raven', 'river',
    'saffron', 'silver', 'tundra', 'velvet', 'willow', 'zephyr'
  ];

  function focusConfig(focus) {
    return FOCUS[focus] || FOCUS.all;
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) {
      out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return out;
  }

  /* key = SHA-256(UTF-8 phrase.trim()), matching search.js's brainwallet path. */
  async function phraseKey(phrase, subtle) {
    var text = String(phrase == null ? '' : phrase).trim();
    if (!text) throw new Error('Enter a passphrase to test.');
    if (!subtle || typeof subtle.digest !== 'function') {
      throw new Error('Web Crypto (SHA-256) is unavailable. Open this page over HTTPS or localhost in a modern browser.');
    }
    var encoded = new TextEncoder().encode(text);
    try {
      return new Uint8Array(await subtle.digest('SHA-256', encoded));
    } finally {
      encoded.fill(0);
    }
  }

  function explorerUrl(id, address) {
    var prefix = EXPLORERS[id];
    if (!prefix || !address) return '';
    return prefix + encodeURIComponent(address);
  }

  function addressRows(report, focus) {
    var config = focusConfig(focus);
    var byId = {};
    var entries = report && Array.isArray(report.addresses) ? report.addresses : [];
    entries.forEach(function (entry) {
      if (entry && entry.id) byId[entry.id] = entry;
    });
    var rows = [];
    config.ids.forEach(function (id) {
      var entry = byId[id];
      if (!entry || !entry.address) return;
      rows.push({
        id: id,
        label: entry.label || id,
        address: entry.address,
        explorer: explorerUrl(id, entry.address)
      });
    });
    return rows;
  }

  function keyFields(report, focus) {
    if (!report) return [];
    var fields = [['Private key (hex)', report.priv_hex || '']];
    if (focusConfig(focus).wif) {
      fields.push(['WIF (compressed)', report.wif_compressed || '']);
      fields.push(['WIF (uncompressed)', report.wif_uncompressed || '']);
    }
    return fields.filter(function (field) { return Boolean(field[1]); });
  }

  /* Fill-in-only random phrase. Uses the platform CSPRNG when available; the
   * caller must still wait for an explicit Derive click. */
  function randomPhrase(cryptoObj, count) {
    if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
      throw new Error('This browser has no secure random source for a test phrase.');
    }
    var words = [];
    var wanted = count || 5;
    var buffer = new Uint32Array(1);
    var limit = Math.floor(0x100000000 / WORDS.length) * WORDS.length;
    while (words.length < wanted) {
      cryptoObj.getRandomValues(buffer);
      if (buffer[0] >= limit) continue;
      words.push(WORDS[buffer[0] % WORDS.length]);
    }
    return words.join(' ');
  }

  return {
    WARNING_TEXT: WARNING_TEXT,
    bytesToHex: bytesToHex,
    phraseKey: phraseKey,
    explorerUrl: explorerUrl,
    addressRows: addressRows,
    keyFields: keyFields,
    randomPhrase: randomPhrase
  };
});
