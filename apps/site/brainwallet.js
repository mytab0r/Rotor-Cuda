/* Brainwallet calculator pages. Runs entirely in the browser; no build step,
 * no dependencies. The passphrase, its SHA-256 key and the derived key stay in
 * memory only: no URL, no storage, no logs and no network lookup of results.
 * Address math comes from the shared wasm `derive_report` export, the same
 * engine the /key page uses. */
(function () {
  'use strict';

  var engine = window.RotorBrainwallet;
  var WASM_URL = '/rotor_wasm.wasm';
  var DECODER = new TextDecoder('utf-8');

  var state = {
    wasm: null,
    wasmPromise: null,
    busy: false
  };

  function byId(id) { return document.getElementById(id); }

  var input = byId('brainwallet-input') || byId('brain-pass');
  var deriveBtn = byId('brainwallet-derive') || byId('brain-derive');
  var errorBox = byId('brainwallet-error') || byId('brain-error');
  var statusBox = byId('brainwallet-status');
  var resultsEl = byId('brainwallet-results') || byId('brain-results');
  if (!input || !deriveBtn || !resultsEl) return;

  var form = input.form || (input.closest ? input.closest('form') : null);
  var idleLabel = deriveBtn.textContent || 'Derive';
  if (!engine) {
    if (errorBox) {
      errorBox.textContent = 'The brainwallet engine did not load. Reload the page.';
      errorBox.hidden = false;
    }
    deriveBtn.disabled = true;
    return;
  }
  var focus = (form && form.getAttribute('data-brain-chain')) ||
    resultsEl.getAttribute('data-brain-chain') || 'all';

  if (form) form.classList.add('brainwallet-form');
  resultsEl.classList.add('brainwallet-results');
  if (!errorBox) {
    errorBox = document.createElement('p');
    errorBox.id = 'brainwallet-error';
    errorBox.className = 'error brainwallet-error';
    errorBox.setAttribute('role', 'alert');
    errorBox.hidden = true;
    (form || input).parentNode.insertBefore(errorBox, (form || input).nextSibling);
  }

  /* Legacy page shells may not carry the static warning; add it once. */
  (function ensureWarning() {
    if (document.querySelector('#brain-warning, .brainwallet-warning, [data-brain-warning]')) return;
    var warning = document.createElement('p');
    warning.id = 'brain-warning';
    warning.className = 'notice brainwallet-warning';
    warning.setAttribute('role', 'note');
    warning.textContent = engine.WARNING_TEXT;
    var anchor = form || input;
    anchor.parentNode.insertBefore(warning, anchor);
  })();

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

  function setStatus(text) {
    if (!statusBox) return;
    statusBox.textContent = text || '';
    statusBox.hidden = !text;
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
      group.appendChild(fieldRow(field[0], field[1]));
    });
    return group;
  }

  function addressRow(row) {
    var item = document.createElement('div');
    item.className = 'brainwallet-address';
    var caption = document.createElement('span');
    caption.className = 'brainwallet-row-label';
    caption.textContent = row.label;

    var line = document.createElement('div');
    line.className = 'key-addr-line';
    var code = document.createElement('code');
    code.className = 'mono key-addr brainwallet-addr';
    code.textContent = row.address;
    line.appendChild(code);
    line.appendChild(copyButton(row.address, row.label + ' address'));

    if (row.explorer) {
      var link = document.createElement('a');
      link.className = 'brainwallet-explorer';
      link.href = row.explorer;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open in explorer';
      link.setAttribute('aria-label', 'Open ' + row.label + ' in an external explorer');
      line.appendChild(link);
    }

    item.appendChild(caption);
    item.appendChild(line);
    return item;
  }

  function addressGroup(rows) {
    var group = document.createElement('section');
    group.className = 'brainwallet-group';
    var heading = document.createElement('h3');
    heading.className = 'brainwallet-group-title';
    heading.textContent = 'Derived addresses';
    group.appendChild(heading);

    if (!rows.length) {
      group.appendChild(note('The derivation core returned no address rows for this page. ' +
        'That is not a safety result: it does not mean the phrase is unused or that the address is empty.'));
      return group;
    }
    rows.forEach(function (row) { group.appendChild(addressRow(row)); });
    return group;
  }

  function renderReport(report, hashHex) {
    resultsEl.textContent = '';
    var fragment = document.createDocumentFragment();

    fragment.appendChild(fieldGroup('Phrase hash', [
      ['SHA-256 of the UTF-8 passphrase', hashHex]
    ]));
    fragment.appendChild(fieldGroup('Private key', engine.keyFields(report, focus)));
    fragment.appendChild(addressGroup(engine.addressRows(report, focus)));

    fragment.appendChild(note('No balance, registry or network lookup was performed. An address ' +
      'that appears unused does not make this phrase safe; a phrase that matches nothing here ' +
      'was simply never checked against the chain.'));
    resultsEl.appendChild(fragment);
  }

  function placeholder(text) {
    resultsEl.textContent = '';
    resultsEl.appendChild(note(text));
  }

  /* ---------------------------------------------------------------- deriving */

  async function onSubmit(event) {
    if (event) event.preventDefault();
    if (state.busy) return;

    hideError();
    setStatus('');
    var phrase = input.value.trim();
    if (!phrase) {
      showError('Enter a passphrase to test.');
      input.focus();
      return;
    }

    var subtle = window.crypto && window.crypto.subtle;
    setBusy(true);
    placeholder('Hashing the phrase and deriving addresses in this browser…');
    var keyBytes = null;
    try {
      keyBytes = await engine.phraseKey(phrase, subtle);
      var hashHex = engine.bytesToHex(keyBytes);
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
      if (keyBytes) keyBytes.fill(0);
      setBusy(false);
    }
  }

  function clearAll() {
    input.value = '';
    hideError();
    setStatus('');
    placeholder('Enter a throwaway passphrase and press Derive.');
  }

  function generatePhrase() {
    hideError();
    setStatus('');
    try {
      input.value = engine.randomPhrase(window.crypto);
    } catch (err) {
      showError(err && err.message ? err.message : String(err));
      return;
    }
    resultsEl.textContent = '';
    placeholder('Random test phrase filled in. Press Derive to calculate — nothing is derived until you do.');
    input.focus();
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

  var generateBtn = byId('brainwallet-generate');
  if (generateBtn) generateBtn.addEventListener('click', generatePhrase);
  var clearBtn = byId('brainwallet-clear');
  if (clearBtn) clearBtn.addEventListener('click', clearAll);

  /* The passphrase and every derived value live only while the page is open. */
  window.addEventListener('pagehide', function () {
    input.value = '';
    hideError();
    setStatus('');
    resultsEl.textContent = '';
  });
})();
