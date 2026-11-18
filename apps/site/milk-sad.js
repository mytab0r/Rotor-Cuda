/* Milk Sad timestamp audit: reproduce one bx seed from a known time only. */
(function () {
  'use strict';

  var form = document.getElementById('milk-form');
  if (!form) return;

  var input = document.getElementById('milk-timestamp');
  var button = document.getElementById('milk-derive');
  var errorBox = document.getElementById('milk-error');
  var result = document.getElementById('milk-result');
  var dateEl = document.getElementById('milk-date');
  var mnemonicEl = document.getElementById('milk-mnemonic');
  var addressEl = document.getElementById('milk-address');
  var wifEl = document.getElementById('milk-wif');
  var keyLink = document.getElementById('milk-key-link');
  var state = { wasm: null, promise: null };

  function fail(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  }

  function loadWasm() {
    if (state.promise) return state.promise;
    state.promise = (async function () {
      var response = await fetch('/rotor_wasm.wasm');
      if (!response.ok) throw new Error('Cannot load the derivation core.');
      var module;
      try {
        module = await WebAssembly.instantiateStreaming(response.clone(), {});
      } catch (err) {
        module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      }
      state.wasm = module.instance ? module.instance.exports : module.exports;
      return state.wasm;
    })();
    state.promise.catch(function () { state.promise = null; });
    return state.promise;
  }

  function mt19937(seed) {
    var state = new Uint32Array(624);
    state[0] = seed >>> 0;
    for (var i = 1; i < 624; i += 1) {
      var previous = state[i - 1] ^ (state[i - 1] >>> 30);
      state[i] = (Math.imul(1812433253, previous) + i) >>> 0;
    }
    var index = 624;
    function twist() {
      for (var i = 0; i < 624; i += 1) {
        var y = (state[i] & 0x80000000) | (state[(i + 1) % 624] & 0x7fffffff);
        state[i] = state[(i + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
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

  function readString(wasm, ptr, length) {
    if (!ptr || !length) return '';
    return new TextDecoder('utf-8').decode(new Uint8Array(wasm.memory.buffer, ptr, length));
  }

  function deriveReport(wasm, hex) {
    var bytes = new Uint8Array(32);
    for (var i = 0; i < 32; i += 1) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    var ptr = wasm.alloc(32) >>> 0;
    try {
      new Uint8Array(wasm.memory.buffer, ptr, 32).set(bytes);
      if ((wasm.derive_report(ptr, 0) >>> 0) !== 0) return null;
      return JSON.parse(readString(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0));
    } finally {
      wasm.dealloc(ptr, 32);
    }
  }

  function addressOf(report, id) {
    if (!report || !Array.isArray(report.addresses)) return '';
    for (var i = 0; i < report.addresses.length; i += 1) {
      if (report.addresses[i].id === id) return report.addresses[i].address || '';
    }
    return '';
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    fail('');
    var seed = Number(input.value);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      fail('Enter a 32-bit seed between 0 and 4294967295.');
      input.focus();
      return;
    }
    if (!window.RotorSeed) {
      fail('The seed library did not load. Reload the page.');
      return;
    }
    button.disabled = true;
    button.textContent = 'Deriving…';
    try {
      var wasm = await loadWasm();
      var entropy = bxSeed(seed);
      var mnemonic = window.RotorSeed.entropyToMnemonic(entropy);
      var keyHex = window.RotorSeed.derive(mnemonic, '', "m/44'/0'/0'/0/0");
      var report = deriveReport(wasm, keyHex);
      var address = addressOf(report, 'btc_p2pkh');
      dateEl.textContent = 'MT19937 seed ' + seed;
      mnemonicEl.textContent = mnemonic;
      addressEl.textContent = address;
      wifEl.textContent = report && report.wif_compressed ? report.wif_compressed : '';
      keyLink.textContent = keyHex;
      keyLink.href = '/key/' + keyHex;
      result.hidden = false;
    } catch (err) {
      fail(err && err.message ? err.message : 'Derivation failed.');
    } finally {
      button.disabled = false;
      button.textContent = 'Derive weak wallet';
    }
  });

  input.value = '0';
})();
