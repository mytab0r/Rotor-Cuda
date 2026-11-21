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
      var response = await fetch(window.RotorAssets
        ? window.RotorAssets.url('/rotor_wasm.wasm')
        : '/rotor_wasm.wasm');
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

  var scanForm = document.getElementById('milk-scan-form');
  var scanButton = document.getElementById('milk-scan');
  var scanStatus = document.getElementById('milk-scan-status');
  var scanError = document.getElementById('milk-scan-error');
  var scanResult = document.getElementById('milk-scan-result');

  function addressProfile(address) {
    if (/^bc1p/i.test(address)) return { path: "m/86'/0'/0'/0/0", id: 'btc_p2tr' };
    if (/^bc1/i.test(address)) return { path: "m/84'/0'/0'/0/0", id: 'btc_p2wpkh' };
    if (/^3/.test(address)) return { path: "m/49'/0'/0'/0/0", id: 'btc_p2sh_p2wpkh' };
    return { path: "m/44'/0'/0'/0/0", id: 'btc_p2pkh' };
  }

  if (scanForm) {
    scanForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      var address = document.getElementById('milk-address-input').value.trim();
      var start = Number(document.getElementById('milk-seed-start').value);
      var count = Number(document.getElementById('milk-seed-count').value);
      if (!address) {
        scanError.textContent = 'Enter the address you control.';
        scanError.hidden = false;
        return;
      }
      if (!Number.isInteger(start) || start < 0 || start > 0xffffffff ||
          !Number.isInteger(count) || count < 1 || count > 2000) {
        scanError.textContent = 'Use a seed in 0…4294967295 and a count of 1…2000.';
        scanError.hidden = false;
        return;
      }
      scanError.hidden = true;
      scanResult.hidden = true;
      scanButton.disabled = true;
      scanButton.textContent = 'Scanning…';
      var profile = addressProfile(address);
      var target = address.toLowerCase();
      var wasm;
      try {
        wasm = await loadWasm();
      } catch (err) {
        scanError.textContent = err.message || 'The derivation core did not load.';
        scanError.hidden = false;
        scanButton.disabled = false;
        scanButton.textContent = 'Scan range';
        return;
      }
      var found = false;
      for (var offset = 0; offset < count; offset += 1) {
        var seed = (start + offset) >>> 0;
        if (start + offset > 0xffffffff) break;
        var entropy = bxSeed(seed);
        var mnemonic = window.RotorSeed.entropyToMnemonic(entropy);
        var keyHex = window.RotorSeed.derive(mnemonic, '', profile.path);
        var report = deriveReport(wasm, keyHex);
        var derived = addressOf(report, profile.id);
        if (derived && derived.toLowerCase() === target) {
          document.getElementById('milk-scan-seed').textContent = String(seed);
          document.getElementById('milk-scan-mnemonic').textContent = mnemonic;
          document.getElementById('milk-scan-wif').textContent = report && report.wif_compressed ? report.wif_compressed : '';
          scanResult.hidden = false;
          scanStatus.textContent = 'Match found after ' + (offset + 1) + ' seeds.';
          found = true;
          break;
        }
        if (offset % 10 === 9) {
          scanStatus.textContent = 'Checked ' + (offset + 1) + ' of ' + count + ' seeds…';
          await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
        }
      }
      if (!found) scanStatus.textContent = 'No match in seeds ' + start + '…' + (start + count - 1) + '.';
      scanButton.disabled = false;
      scanButton.textContent = 'Scan range';
    });
  }

  var browseForm = document.getElementById('milk-browse-form');
  var browseRows = document.getElementById('milk-browse-rows');
  var browseStatus = document.getElementById('milk-browse-status');
  var browseRange = document.getElementById('milk-browse-range');
  var browsePrev = document.getElementById('milk-browse-prev');
  var browseNext = document.getElementById('milk-browse-next');
  var browseStart = 0;
  var browseBusy = false;

  async function renderSeedPage(start) {
    if (browseBusy) return;
    browseBusy = true;
    browseStart = Math.max(0, Math.min(0xffffffff - 59, Math.floor(start) || 0));
    document.getElementById('milk-browse-start').value = String(browseStart);
    browseRange.textContent = 'seeds ' + browseStart + '…' + (browseStart + 59);
    browseRows.textContent = '';
    browseStatus.textContent = 'Deriving 60 wallets in your browser…';
    var wasm = await loadWasm();
    for (var offset = 0; offset < 60; offset += 1) {
      var seed = browseStart + offset;
      if (seed > 0xffffffff) break;
      var entropy = bxSeed(seed);
      var mnemonic = window.RotorSeed.entropyToMnemonic(entropy);
      var keyHex = window.RotorSeed.derive(mnemonic, '', "m/44'/0'/0'/0/0");
      var report = deriveReport(wasm, keyHex);
      var address = addressOf(report, 'btc_p2pkh');
      var row = document.createElement('div');
      row.className = 'seed-row';
      var head = document.createElement('div');
      head.className = 'seed-row-head';
      var title = document.createElement('h3');
      title.textContent = 'Seed ' + seed;
      var link = document.createElement('a');
      link.className = 'seed-path mono';
      link.href = '/key/' + encodeURIComponent(report && report.wif_compressed ? report.wif_compressed : keyHex);
      link.textContent = report && report.wif_compressed ? report.wif_compressed : keyHex;
      head.appendChild(title);
      head.appendChild(link);
      row.appendChild(head);
      var line = document.createElement('div');
      line.className = 'key-addr-line';
      var addressCode = document.createElement('code');
      addressCode.className = 'mono key-addr';
      addressCode.textContent = address;
      line.appendChild(addressCode);
      row.appendChild(line);
      browseRows.appendChild(row);
      if (offset % 5 === 4) {
        browseStatus.textContent = 'Derived ' + (offset + 1) + ' of 60…';
        await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
      }
    }
    browseStatus.textContent = 'Seeds ' + browseStart + '…' + (browseStart + 59) + ' derived locally. Balances are not checked on this page.';
    browseBusy = false;
  }

  if (browseForm) {
    browseForm.addEventListener('submit', function (event) {
      event.preventDefault();
      renderSeedPage(Number(document.getElementById('milk-browse-start').value));
    });
    browsePrev.addEventListener('click', function () { renderSeedPage(browseStart - 60); });
    browseNext.addEventListener('click', function () { renderSeedPage(browseStart + 60); });
  }
})();
