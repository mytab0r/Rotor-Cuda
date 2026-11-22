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
  var scanner = window.RotorMilkSad;

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
    if (!scanner) {
      fail('The scan library did not load. Reload the page.');
      return;
    }
    button.disabled = true;
    button.textContent = 'Deriving…';
    try {
      var wasm = await loadWasm();
      var entropy = scanner.bxSeed(seed);
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
      if (!scanner) {
        scanError.textContent = 'The scan library did not load. Reload the page.';
        scanError.hidden = false;
        return;
      }
      scanError.hidden = true;
      scanResult.hidden = true;
      scanButton.disabled = true;
      scanButton.textContent = 'Scanning…';
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
      var outcome;
      try {
        outcome = await scanner.scanRange({
          address: address,
          start: start,
          count: count,
          derive: function (entropy, profile) {
            var mnemonic = window.RotorSeed.entropyToMnemonic(entropy);
            var keyHex = window.RotorSeed.derive(mnemonic, '', profile.path);
            var report = deriveReport(wasm, keyHex);
            return {
              address: addressOf(report, profile.id),
              mnemonic: mnemonic,
              wif: report && report.wif_compressed ? report.wif_compressed : ''
            };
          },
          onProgress: function (checked, total) {
            scanStatus.textContent = 'Checked ' + checked + ' of ' + total + ' seeds…';
          },
          yieldTo: function () {
            return new Promise(function (resolve) { window.setTimeout(resolve, 0); });
          }
        });
      } catch (err) {
        scanError.textContent = err && err.message ? err.message : 'The scan failed.';
        scanError.hidden = false;
        outcome = null;
      }
      if (outcome && outcome.matched) {
        document.getElementById('milk-scan-seed').textContent = String(outcome.seed);
        document.getElementById('milk-scan-mnemonic').textContent = outcome.mnemonic;
        document.getElementById('milk-scan-wif').textContent = outcome.wif;
        scanResult.hidden = false;
        scanStatus.textContent = 'Match found after ' + outcome.checked + ' seeds.';
      } else if (outcome) {
        scanStatus.textContent = 'No match in seeds ' + start + '…' + (start + outcome.checked - 1) + '.';
      }
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
      var entropy = scanner.bxSeed(seed);
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
