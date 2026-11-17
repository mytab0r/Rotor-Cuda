/* Brainwallet calculator. Runs entirely in the browser; no build step, no deps.
 * The passphrase, its hash and the derived key stay in memory only: no URL,
 * no storage, no logs and no network lookup of the results. */
(function () {
  'use strict';

  var WASM_URL = '/rotor_wasm.wasm';
  var DECODER = new TextDecoder('utf-8');
  var ENCODER = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  var ADDRESSES = [
    { id: 'btc_p2pkh', label: 'Bitcoin legacy (P2PKH)' },
    { id: 'btc_p2wpkh', label: 'Bitcoin native segwit (P2WPKH)' },
    { id: 'btc_p2tr', label: 'Bitcoin taproot (P2TR)' },
    { id: 'evm', label: 'Ethereum / EVM' },
    { id: 'tron', label: 'TRON' }
  ];

  var WARNING_TEXT = 'Brainwallets are unsafe. A SHA-256 passphrase can be guessed or ' +
    'found in wordlists, and anyone who knows the phrase controls the funds. Do not use ' +
    'this for real money. Only test phrases you are authorized to check. Nothing on this ' +
    'page is sent anywhere; the derived addresses are not looked up.';

  var state = {
    wasm: null,
    wasmPromise: null,
    busy: false
  };

  function byId(id) { return document.getElementById(id); }

  var input = byId('brain-pass') || byId('brainwallet-input');
  var deriveBtn = byId('brain-derive') || byId('brainwallet-derive');
  var errorBox = byId('brain-error');
  var resultsEl = byId('brain-results') || byId('brainwallet-results');
  if (!input || !deriveBtn || !resultsEl) return;

  var form = input.form || (input.closest ? input.closest('form') : null);
  var idleLabel = deriveBtn.textContent || 'Derive';
  if (form) form.classList.add('brainwallet-form');
  resultsEl.classList.add('brainwallet-results');
  if (!errorBox) {
    errorBox = document.createElement('p');
    errorBox.id = 'brain-error';
    errorBox.className = 'error brainwallet-error';
    errorBox.setAttribute('role', 'alert');
    errorBox.hidden = true;
    (form || input).parentNode.insertBefore(errorBox, (form || input).nextSibling);
  }

  function ensureWarning() {
    if (document.querySelector('#brain-warning, .brainwallet-warning, [data-brain-warning], .key-page .notice[role="note"]')) return;
    var warning = document.createElement('p');
    warning.id = 'brain-warning';
    warning.className = 'notice brainwallet-warning';
    warning.setAttribute('role', 'note');
    warning.textContent = WARNING_TEXT;
    var anchor = form || input;
    anchor.parentNode.insertBefore(warning, anchor);
  }
  ensureWarning();

  /* -------------------------------------------------------------- wasm core */

  function loadWasm() {
    if (state.wasm) return Promise.resolve(state.wasm);
    if (state.wasmPromise) return state.wasmPromise;

    state.wasmPromise = (async function () {
      if (typeof WebAssembly === 'undefined') {
        throw new Error('WebAssembly is unavailable in this browser.');
      }
      var response;
      try {
        response = await fetch(WASM_URL);
      } catch (err) {
        throw new Error('Cannot load ' + WASM_URL + ': ' + (err && err.message ? err.message : String(err)));
      }
      if (!response.ok) throw new Error('Cannot load ' + WASM_URL + ': HTTP ' + response.status);

      var module;
      try {
        module = await WebAssembly.instantiateStreaming(response.clone(), {});
      } catch (err) {
        module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      }
      var wasm = module.instance ? module.instance.exports : module.exports;
      var required = ['alloc', 'dealloc', 'derive_report', 'result_ptr', 'result_len', 'error_ptr', 'error_len'];
      for (var i = 0; i < required.length; i++) {
        if (typeof wasm[required[i]] !== 'function') {
          throw new Error('This build of ' + WASM_URL + ' has no "' + required[i] + '" export. The derivation core is incomplete.');
        }
      }
      if (!wasm.memory) throw new Error(WASM_URL + ' does not export memory.');
      state.wasm = wasm;
      return wasm;
    })();

    state.wasmPromise.catch(function () { state.wasmPromise = null; });
    return state.wasmPromise;
  }

  function readWasmString(wasm, ptr, length) {
    if (!ptr || !length) return '';
    return DECODER.decode(new Uint8Array(wasm.memory.buffer, ptr, length));
  }

  function deriveReport(wasm, bytes, curve) {
    var ptr = wasm.alloc(bytes.length) >>> 0;
    if (!ptr) throw new Error('WASM memory exhausted.');
    try {
      new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
      var status = wasm.derive_report(ptr, curve) >>> 0;
      if (status !== 0) {
        var detail = readWasmString(wasm, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0);
        throw new Error('Derivation failed' + (detail ? ': ' + detail : ' (status ' + status + ')'));
      }
      var text = readWasmString(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0);
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error('The derivation core returned invalid JSON.');
      }
    } finally {
      try {
        new Uint8Array(wasm.memory.buffer, ptr, bytes.length).fill(0);
      } catch (err) { /* memory may have grown; nothing else to wipe */ }
      wasm.dealloc(ptr, bytes.length);
    }
  }

  /* ----------------------------------------------------------------- output */

  function showError(message) {
    errorBox.textContent = message || 'Derivation failed.';
    errorBox.hidden = false;
  }

  function hideError() {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function setBusy(busy) {
    state.busy = busy;
    deriveBtn.disabled = busy;
    deriveBtn.textContent = busy ? 'Deriving…' : idleLabel;
    resultsEl.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function note(text) {
    var p = document.createElement('p');
    p.className = 'muted brainwallet-note';
    p.textContent = text;
    return p;
  }

  function copyText(text, button) {
    var original = button.textContent;
    function done() {
      button.textContent = 'Copied';
      button.disabled = true;
      window.setTimeout(function () {
        button.textContent = original;
        button.disabled = false;
      }, 1200);
    }
    function fallback() {
      legacyCopy(text);
      done();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(area);
    }
  }

  function copyButton(value, label) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'key-copy brainwallet-copy';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy ' + label);
    button.addEventListener('click', function () { copyText(value, button); });
    return button;
  }

  function fieldRow(label, value) {
    var row = document.createElement('div');
    row.className = 'brainwallet-row';

    var body = document.createElement('div');
    body.className = 'brainwallet-row-body';
    var caption = document.createElement('span');
    caption.className = 'brainwallet-row-label';
    caption.textContent = label;
    var code = document.createElement('code');
    code.className = 'mono brainwallet-row-value';
    code.textContent = value;
    body.appendChild(caption);
    body.appendChild(code);

    row.appendChild(body);
    row.appendChild(copyButton(value, label));
    return row;
  }

  function fieldGroup(title, fields) {
    var group = document.createElement('section');
    group.className = 'brainwallet-group';
    var heading = document.createElement('h3');
    heading.className = 'brainwallet-group-title';
    heading.textContent = title;
    group.appendChild(heading);
    fields.forEach(function (field) {
      if (!field[1]) return;
      group.appendChild(fieldRow(field[0], field[1]));
    });
    return group;
  }

  function addressRow(label, address) {
    var row = document.createElement('div');
    row.className = 'brainwallet-address';
    var caption = document.createElement('span');
    caption.className = 'brainwallet-row-label';
    caption.textContent = label;

    var line = document.createElement('div');
    line.className = 'key-addr-line';
    var code = document.createElement('code');
    code.className = 'mono key-addr brainwallet-addr';
    code.textContent = address;
    line.appendChild(code);
    line.appendChild(copyButton(address, label + ' address'));

    row.appendChild(caption);
    row.appendChild(line);
    return row;
  }

  function addressGroup(report) {
    var group = document.createElement('section');
    group.className = 'brainwallet-group';
    var heading = document.createElement('h3');
    heading.className = 'brainwallet-group-title';
    heading.textContent = 'Derived addresses';
    group.appendChild(heading);

    var byIdMap = {};
    var entries = Array.isArray(report.addresses) ? report.addresses : [];
    entries.forEach(function (entry) {
      if (entry && entry.id) byIdMap[entry.id] = entry;
    });

    var shown = 0;
    ADDRESSES.forEach(function (item) {
      var entry = byIdMap[item.id];
      if (!entry || !entry.address) return;
      shown += 1;
      group.appendChild(addressRow(entry.label || item.label, entry.address));
    });

    if (!shown) {
      group.appendChild(note('Nothing was derived for this phrase. That is not a safety result: ' +
        'it does not mean the phrase is unused or that the address is empty.'));
    }
    return group;
  }

  function renderReport(report, hashHex) {
    resultsEl.textContent = '';
    var fragment = document.createDocumentFragment();

    fragment.appendChild(fieldGroup('Phrase hash', [
      ['SHA-256 of the UTF-8 passphrase', hashHex]
    ]));
    fragment.appendChild(fieldGroup('Private key (WIF)', [
      ['WIF compressed', report.wif_compressed || ''],
      ['WIF uncompressed', report.wif_uncompressed || '']
    ]));
    fragment.appendChild(addressGroup(report));

    var tail = note('No balance, registry or network lookup was performed. An address that ' +
      'appears unused does not make this phrase safe; a phrase that matches nothing here ' +
      'was simply never checked against the chain.');
    fragment.appendChild(tail);

    resultsEl.appendChild(fragment);
  }

  function placeholder(text) {
    resultsEl.textContent = '';
    resultsEl.appendChild(note(text));
  }

  /* ---------------------------------------------------------------- deriving */

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return out;
  }

  async function onSubmit(event) {
    if (event) event.preventDefault();
    if (state.busy) return;

    hideError();
    var phrase = input.value.trim();
    if (!phrase) {
      showError('Enter a passphrase to test.');
      input.focus();
      return;
    }

    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle || typeof subtle.digest !== 'function') {
      showError('Web Crypto (SHA-256) is unavailable. Open this page over HTTPS or localhost in a modern browser.');
      return;
    }
    if (!ENCODER) {
      showError('TextEncoder is unavailable in this browser, so the phrase cannot be encoded.');
      return;
    }

    setBusy(true);
    placeholder('Hashing the phrase and deriving addresses in this browser…');
    var encoded = null;
    var keyBytes = null;
    try {
      encoded = ENCODER.encode(phrase);
      keyBytes = new Uint8Array(await subtle.digest('SHA-256', encoded));
      encoded.fill(0);
      encoded = null;
      var hashHex = bytesToHex(keyBytes);
      var wasm = await loadWasm();
      var report = deriveReport(wasm, keyBytes, 0);
      if (!report || typeof report !== 'object') {
        throw new Error('The derivation core returned an unexpected report.');
      }
      renderReport(report, hashHex);
    } catch (err) {
      resultsEl.textContent = '';
      placeholder('No result. Nothing was derived.');
      showError(err && err.message ? err.message : String(err));
    } finally {
      if (encoded) encoded.fill(0);
      if (keyBytes) keyBytes.fill(0);
      setBusy(false);
    }
  }

  if (form) {
    form.addEventListener('submit', onSubmit);
    deriveBtn.addEventListener('click', function (event) {
      if (deriveBtn.type === 'submit') return;
      onSubmit(event);
    });
  } else {
    deriveBtn.addEventListener('click', onSubmit);
  }
})();
