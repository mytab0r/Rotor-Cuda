/* Milk Sad seed-range helpers shared by the /milk-sad page and the cabinet
 * wallet's local security check.
 *
 * The module is pure apart from the injected `derive` callback: it never
 * touches the DOM, storage or the network. `scanRange` walks a bounded 32-bit
 * seed range and compares the derived Bitcoin address with the address the
 * user supplied. A no-match result covers only that range, never the whole
 * 2^32 weak set. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorMilkSad = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_SEEDS = 2000;

  function mt19937(seed) {
    var state = new Uint32Array(624);
    state[0] = seed >>> 0;
    for (var i = 1; i < 624; i += 1) {
      var previous = state[i - 1] ^ (state[i - 1] >>> 30);
      state[i] = (Math.imul(1812433253, previous) + i) >>> 0;
    }
    var index = 624;
    function twist() {
      for (var j = 0; j < 624; j += 1) {
        var y = (state[j] & 0x80000000) | (state[(j + 1) % 624] & 0x7fffffff);
        state[j] = state[(j + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      index = 0;
    }
    return function next() {
      if (index >= 624) twist();
      var y = state[index++];
      y ^= y >>> 11;
      y ^= (y << 7) & 0x9d2c5680;
      y ^= (y << 15) & 0xefc60000;
      y ^= y >>> 18;
      return y >>> 0;
    };
  }

  function bxSeed(seed) {
    var next = mt19937(seed >>> 0);
    var scaling = Math.floor(0xffffffff / 256);
    var past = 256 * scaling;
    var bytes = new Uint8Array(32);
    for (var i = 0; i < 32; i += 1) {
      var value;
      do { value = next(); } while (value >= past);
      bytes[i] = Math.floor(value / scaling);
    }
    return Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  /* The address type fixes the BIP44/49/84/86 path and the derived row. */
  function addressProfile(address) {
    if (/^bc1p/i.test(address)) return { path: "m/86'/0'/0'/0/0", id: 'btc_p2tr' };
    if (/^bc1/i.test(address)) return { path: "m/84'/0'/0'/0/0", id: 'btc_p2wpkh' };
    if (/^3/.test(address)) return { path: "m/49'/0'/0'/0/0", id: 'btc_p2sh_p2wpkh' };
    return { path: "m/44'/0'/0'/0/0", id: 'btc_p2pkh' };
  }

  /* Walk [start, start + count) and stop at the first derived address that
   * matches. `derive(entropyHex, profile)` may be synchronous or async and
   * must return { address, mnemonic, wif } (or null). */
  async function scanRange(options) {
    var settings = options || {};
    var address = String(settings.address == null ? '' : settings.address).trim();
    var start = Number(settings.start);
    var count = Number(settings.count);
    var maxSeeds = Number(settings.maxSeeds) || MAX_SEEDS;
    var derive = settings.derive;
    var onProgress = typeof settings.onProgress === 'function' ? settings.onProgress : function () {};
    var yieldTo = typeof settings.yieldTo === 'function'
      ? settings.yieldTo
      : function () { return Promise.resolve(); };
    var yieldEvery = Number(settings.yieldEvery) || 10;

    if (!address) throw new Error('Enter the address you control.');
    if (!Number.isInteger(start) || start < 0 || start > 0xffffffff) {
      throw new Error('Use a seed in 0…4294967295.');
    }
    if (!Number.isInteger(count) || count < 1 || count > maxSeeds) {
      throw new Error('Use a count of 1…' + maxSeeds + '.');
    }
    if (typeof derive !== 'function') throw new Error('scanRange needs a derive function.');

    var profile = addressProfile(address);
    var target = address.toLowerCase();
    var checked = 0;
    for (var offset = 0; offset < count; offset += 1) {
      if (start + offset > 0xffffffff) break;
      var seed = (start + offset) >>> 0;
      var derived = await derive(bxSeed(seed), profile);
      checked = offset + 1;
      if (derived && derived.address && String(derived.address).toLowerCase() === target) {
        return {
          matched: true,
          seed: seed,
          mnemonic: derived.mnemonic || '',
          wif: derived.wif || '',
          checked: checked,
          profile: profile.id
        };
      }
      if (offset % yieldEvery === yieldEvery - 1) {
        onProgress(checked, count);
        await yieldTo();
      }
    }
    return { matched: false, checked: checked, profile: profile.id };
  }

  return {
    MAX_SEEDS: MAX_SEEDS,
    mt19937: mt19937,
    bxSeed: bxSeed,
    addressProfile: addressProfile,
    scanRange: scanRange
  };
});
