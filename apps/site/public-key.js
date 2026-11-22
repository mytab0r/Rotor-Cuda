/* Public key to addresses: the point and the encodings come from the local
 * wasm core. No private key, no network, no storage. */
(function () {
  'use strict';

  /* Chain explorers come from data/chains.json through the generated globals
   * in chains.generated.js (loaded before this script). */
  var SSOT_ROOT = typeof window !== 'undefined' ? window : globalThis;
  var SSOT_CHAINS = SSOT_ROOT.RotorChains;

  var byId = function (id) { return document.getElementById(id); };
  var form = byId('pubkey-form');
  if (!form) return;

  var input = byId('pubkey-input');
  var errorBox = byId('pubkey-error');
  var result = byId('pubkey-result');
  var facts = byId('pubkey-facts');
  var addresses = byId('pubkey-addresses');
  var submit = byId('pubkey-submit');
  var state = { wasm: null, promise: null, busy: false };

  var EXPLORERS = {
    btc_p2pkh: SSOT_CHAINS.bySlug.bitcoin.explorerPrefix,
    btc_p2pkh_uncompressed: SSOT_CHAINS.bySlug.bitcoin.explorerPrefix,
    btc_p2sh_p2wpkh: SSOT_CHAINS.bySlug.bitcoin.explorerPrefix,
    btc_p2wpkh: SSOT_CHAINS.bySlug.bitcoin.explorerPrefix,
    btc_p2tr: SSOT_CHAINS.bySlug.bitcoin.explorerPrefix,
    evm: SSOT_CHAINS.bySlug.ethereum.explorerPrefix,
    tron: SSOT_CHAINS.bySlug.tron.explorerPrefix
  };

  function fail(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  }

  function loadWasm() {
    if (state.wasm) return Promise.resolve(state.wasm);
    if (state.promise) return state.promise;
    state.promise = window.RotorKeyTools.loadWasm(window.RotorAssets.url('/rotor_wasm.wasm')).then(function (wasm) {
      if (typeof wasm.public_key_report !== 'function') {
        throw new Error('This build of the calculation core has no public_key_report export. Reload the page.');
      }
      state.wasm = wasm;
      return wasm;
    });
    state.promise.catch(function () { state.promise = null; });
    return state.promise;
  }

  function copyText(text, button) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      fail('Clipboard access is unavailable in this browser. Select the value and copy it manually.');
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      button.textContent = 'Copied';
      window.setTimeout(function () { button.textContent = 'Copy'; }, 1200);
    }, function () {
      fail('Clipboard access was denied. Select the value and copy it manually.');
    });
  }

  function factRow(label, value) {
    var line = document.createElement('div');
    line.className = 'key-form-row';
    var term = document.createElement('dt');
    term.textContent = label;
    var detail = document.createElement('dd');
    var code = document.createElement('code');
    code.className = 'mono detail-value';
    code.textContent = value;
    detail.appendChild(code);
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'key-copy';
    copy.textContent = 'Copy';
    copy.addEventListener('click', function () { copyText(value, copy); });
    line.appendChild(term);
    line.appendChild(detail);
    line.appendChild(copy);
    return line;
  }

  function addressRow(entry) {
    var block = document.createElement('div');
    block.className = 'seed-row';
    var head = document.createElement('div');
    head.className = 'seed-row-head';
    var title = document.createElement('h3');
    title.textContent = entry.label;
    var id = document.createElement('span');
    id.className = 'seed-path mono';
    id.textContent = entry.id;
    head.appendChild(title);
    head.appendChild(id);
    block.appendChild(head);

    var line = document.createElement('div');
    line.className = 'key-addr-line';
    var prefix = EXPLORERS[entry.id];
    var value = document.createElement(prefix ? 'a' : 'code');
    value.className = 'mono key-addr';
    value.textContent = entry.address;
    if (prefix) {
      value.href = prefix + entry.address;
      value.target = '_blank';
      value.rel = 'noopener noreferrer';
      value.title = 'Open in explorer';
    }
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'key-copy';
    copy.textContent = 'Copy';
    copy.addEventListener('click', function () { copyText(entry.address, copy); });
    line.appendChild(value);
    line.appendChild(copy);
    block.appendChild(line);
    return block;
  }

  async function derive() {
    if (state.busy) return;
    fail('');
    var raw = input.value.trim().replace(/[\s_]+/g, '').replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]+$/.test(raw) || (raw.length !== 66 && raw.length !== 130)) {
      fail('A secp256k1 public key is 66 hex characters (compressed) or 130 (uncompressed).');
      input.focus();
      return;
    }
    state.busy = true;
    submit.disabled = true;
    submit.textContent = 'Deriving…';
    result.hidden = true;
    try {
      var wasm = await loadWasm();
      var upload = window.RotorKeyTools.upload(wasm, raw.toLowerCase());
      var status;
      try {
        status = wasm.public_key_report(upload.pointer, upload.length) >>> 0;
      } finally {
        wasm.dealloc(upload.pointer, upload.length);
      }
      if (status !== 0) throw new Error(window.RotorKeyTools.wasmError(wasm));
      var report = window.RotorKeyTools.wasmResultJson(wasm);

      facts.textContent = '';
      facts.appendChild(factRow('Input form', report.input_format));
      facts.appendChild(factRow('Compressed', report.pubkey_compressed));
      facts.appendChild(factRow('Uncompressed', report.pubkey_uncompressed));
      facts.appendChild(factRow('X', report.x));
      facts.appendChild(factRow('Y', report.y));

      addresses.textContent = '';
      report.addresses.forEach(function (entry) {
        addresses.appendChild(addressRow(entry));
      });
      result.hidden = false;
      result.scrollIntoView({ behavior: window.RotorKeyTools.scrollBehavior(), block: 'start' });
    } catch (err) {
      fail(err && err.message ? err.message : 'Derivation failed.');
    } finally {
      state.busy = false;
      submit.disabled = false;
      submit.textContent = 'Derive addresses';
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    derive();
  });

  byId('pubkey-clear').addEventListener('click', function () {
    input.value = '';
    facts.textContent = '';
    addresses.textContent = '';
    result.hidden = true;
    fail('');
    input.focus();
  });
})();
