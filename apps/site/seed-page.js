/* BIP39/BIP32 seed converter: derivation and rendering stay in this tab. */
(function () {
  'use strict';

  var WASM_URL = '/rotor_wasm.wasm';
  var DECODER = new TextDecoder('utf-8');
  var PATHS = [
    { id: 'btc_p2pkh', label: 'Bitcoin · Legacy', path: "m/44'/0'/0'/0/0" },
    { id: 'btc_p2wpkh', label: 'Bitcoin · Native SegWit', path: "m/84'/0'/0'/0/0" },
    { id: 'btc_p2tr', label: 'Bitcoin · Taproot', path: "m/86'/0'/0'/0/0" },
    { id: 'evm', label: 'Ethereum / EVM', path: "m/44'/60'/0'/0/0" },
    { id: 'tron', label: 'TRON', path: "m/44'/195'/0'/0/0" },
    { id: 'ltc_p2pkh', label: 'Litecoin · Legacy', path: "m/44'/2'/0'/0/0" },
    { id: 'doge_p2pkh', label: 'Dogecoin', path: "m/44'/3'/0'/0/0" },
    { id: 'bch_legacy', label: 'Bitcoin Cash', path: "m/44'/145'/0'/0/0" },
    { id: 'xrp_classic', label: 'XRP', path: "m/44'/144'/0'/0/0" }
  ];

  var byId = function (id) { return document.getElementById(id); };
  var form = byId('seed-form');
  if (!form) return;

  var phraseInput = byId('seed-phrase');
  var passphraseInput = byId('seed-passphrase');
  var deriveBtn = byId('seed-derive');
  var errorBox = byId('seed-error');
  var result = byId('seed-result');
  var rowsEl = byId('seed-rows');
  var countEl = byId('seed-count');
  var state = { wasm: null, promise: null, busy: false };

  function fail(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  }

  function loadWasm() {
    if (state.promise) return state.promise;
    state.promise = (async function () {
      var response = await fetch(WASM_URL);
      if (!response.ok) throw new Error('Cannot load the derivation core: HTTP ' + response.status);
      var module;
      try {
        module = await WebAssembly.instantiateStreaming(response.clone(), {});
      } catch (err) {
        module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      }
      var wasm = module.instance ? module.instance.exports : module.exports;
      state.wasm = wasm;
      return wasm;
    })();
    state.promise.catch(function () { state.promise = null; });
    return state.promise;
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(32);
    for (var i = 0; i < 32; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function readString(wasm, ptr, length) {
    if (!ptr || !length) return '';
    return DECODER.decode(new Uint8Array(wasm.memory.buffer, ptr, length));
  }

  function reportFor(wasm, keyHex) {
    var bytes = hexToBytes(keyHex);
    var ptr = wasm.alloc(bytes.length) >>> 0;
    if (!ptr) throw new Error('WASM memory exhausted.');
    try {
      new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
      if ((wasm.derive_report(ptr, 0) >>> 0) !== 0) return null;
      return JSON.parse(readString(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0));
    } finally {
      wasm.dealloc(ptr, bytes.length);
    }
  }

  function addressOf(report, id) {
    if (!report || !Array.isArray(report.addresses)) return '';
    for (var i = 0; i < report.addresses.length; i += 1) {
      if (report.addresses[i].id === id) return report.addresses[i].address || '';
    }
    return '';
  }

  function copyText(text, button) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(text).then(function () {
      button.textContent = 'Copied';
      window.setTimeout(function () { button.textContent = 'Copy'; }, 1200);
    });
  }

  function rowFor(entry) {
    var row = document.createElement('div');
    row.className = 'seed-row';
    var head = document.createElement('div');
    head.className = 'seed-row-head';
    var title = document.createElement('h3');
    title.textContent = entry.label;
    var path = document.createElement('span');
    path.className = 'seed-path mono';
    path.textContent = entry.path;
    head.appendChild(title);
    head.appendChild(path);
    row.appendChild(head);

    var addressLine = document.createElement('div');
    addressLine.className = 'key-addr-line';
    var address = document.createElement('code');
    address.className = 'mono key-addr';
    address.textContent = entry.address;
    var copyAddress = document.createElement('button');
    copyAddress.type = 'button';
    copyAddress.className = 'key-copy';
    copyAddress.textContent = 'Copy';
    copyAddress.addEventListener('click', function () { copyText(entry.address, copyAddress); });
    addressLine.appendChild(address);
    addressLine.appendChild(copyAddress);
    row.appendChild(addressLine);

    var details = document.createElement('details');
    details.className = 'key-steps';
    var summary = document.createElement('summary');
    summary.textContent = 'Private key and WIF';
    details.appendChild(summary);
    var body = document.createElement('div');
    body.className = 'seed-key-body';
    [['Hex', entry.hex], ['WIF (compressed)', entry.wif]].forEach(function (pair) {
      if (!pair[1]) return;
      var line = document.createElement('div');
      line.className = 'detail-line';
      var label = document.createElement('span');
      label.className = 'detail-label';
      label.textContent = pair[0];
      var value = document.createElement('code');
      value.className = 'mono detail-value';
      value.textContent = pair[1];
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-btn';
      copy.textContent = 'Copy';
      copy.addEventListener('click', function () { copyText(pair[1], copy); });
      line.appendChild(label);
      line.appendChild(value);
      line.appendChild(copy);
      body.appendChild(line);
    });
    details.appendChild(body);
    row.appendChild(details);
    return row;
  }

  async function deriveAll() {
    if (state.busy) return;
    fail('');
    var phrase = phraseInput.value.trim();
    if (!window.RotorSeed) {
      fail('The seed library did not load. Reload the page.');
      return;
    }
    if (!window.RotorSeed.validate(phrase)) {
      fail('That is not a valid English BIP39 phrase. Check the words and their order.');
      phraseInput.focus();
      return;
    }
    state.busy = true;
    deriveBtn.disabled = true;
    deriveBtn.textContent = 'Deriving…';
    rowsEl.textContent = '';
    result.hidden = true;
    try {
      var wasm = await loadWasm();
      var passphrase = passphraseInput.value;
      var rows = [];
      PATHS.forEach(function (item) {
        var keyHex = window.RotorSeed.derive(phrase, passphrase, item.path);
        var report = reportFor(wasm, keyHex);
        rows.push({
          label: item.label,
          path: item.path,
          hex: keyHex,
          wif: report && report.wif_compressed ? report.wif_compressed : '',
          address: addressOf(report, item.id)
        });
      });
      rows.forEach(function (entry) { rowsEl.appendChild(rowFor(entry)); });
      countEl.textContent = rows.length + ' paths';
      result.hidden = false;
      result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      fail(err && err.message ? err.message : 'Derivation failed.');
    } finally {
      state.busy = false;
      deriveBtn.disabled = false;
      deriveBtn.textContent = 'Derive addresses';
    }
  }

  (function restoreSearchPhrase() {
    var phrase = '';
    try {
      phrase = sessionStorage.getItem('rotor-seed-phrase') || '';
      sessionStorage.removeItem('rotor-seed-phrase');
    } catch (err) { phrase = ''; }
    if (!phrase) return;
    phraseInput.value = phrase;
    deriveAll();
  })();

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    deriveAll();
  });

  byId('seed-generate').addEventListener('click', function () {
    if (!window.RotorSeed) return;
    phraseInput.value = window.RotorSeed.generate();
    passphraseInput.value = '';
    fail('New phrase generated. Write it down offline; it is not saved.');
  });

  byId('seed-clear').addEventListener('click', function () {
    phraseInput.value = '';
    passphraseInput.value = '';
    rowsEl.textContent = '';
    result.hidden = true;
    fail('');
    phraseInput.focus();
  });

  window.addEventListener('pagehide', function () {
    phraseInput.value = '';
    passphraseInput.value = '';
  });
})();
