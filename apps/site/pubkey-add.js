/* P + Q on secp256k1: the point arithmetic runs in the local wasm core. */
(function () {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };
  var form = byId('add-form');
  if (!form) return;

  var first = byId('add-first');
  var second = byId('add-second');
  var errorBox = byId('add-error');
  var result = byId('add-result');
  var facts = byId('add-facts');
  var submit = byId('add-submit');
  var state = { wasm: null, promise: null, busy: false };

  function fail(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  }

  function loadWasm() {
    if (state.wasm) return Promise.resolve(state.wasm);
    if (state.promise) return state.promise;
    state.promise = window.RotorKeyTools.loadWasm('/rotor_wasm.wasm').then(function (wasm) {
      if (typeof wasm.public_key_add !== 'function') {
        throw new Error('This build of the calculation core has no public_key_add export. Reload the page.');
      }
      state.wasm = wasm;
      return wasm;
    });
    state.promise.catch(function () { state.promise = null; });
    return state.promise;
  }

  function normalize(value) {
    return String(value || '').trim().replace(/[\s_]+/g, '').replace(/^0x/i, '').toLowerCase();
  }

  function valid(raw) {
    return /^[0-9a-f]+$/.test(raw) && (raw.length === 66 || raw.length === 130);
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

  async function add() {
    if (state.busy) return;
    fail('');
    var a = normalize(first.value);
    var b = normalize(second.value);
    if (!valid(a) || !valid(b)) {
      fail('Each public key must be 66 hex characters (compressed) or 130 (uncompressed).');
      (!valid(a) ? first : second).focus();
      return;
    }
    state.busy = true;
    submit.disabled = true;
    submit.textContent = 'Adding…';
    result.hidden = true;
    try {
      var wasm = await loadWasm();
      var uploadA = window.RotorKeyTools.upload(wasm, a);
      var uploadB;
      try {
        uploadB = window.RotorKeyTools.upload(wasm, b);
        var status;
        try {
          status = wasm.public_key_add(uploadA.pointer, uploadA.length, uploadB.pointer, uploadB.length) >>> 0;
        } finally {
          wasm.dealloc(uploadB.pointer, uploadB.length);
        }
        if (status !== 0) throw new Error(window.RotorKeyTools.wasmError(wasm));
        var report = window.RotorKeyTools.wasmResultJson(wasm);

        facts.textContent = '';
        facts.appendChild(factRow('Compressed', report.pubkey_compressed));
        facts.appendChild(factRow('Uncompressed', report.pubkey_uncompressed));
        facts.appendChild(factRow('X', report.x));
        facts.appendChild(factRow('Y', report.y));
        result.hidden = false;
        result.scrollIntoView({ behavior: window.RotorKeyTools.scrollBehavior(), block: 'start' });
      } finally {
        wasm.dealloc(uploadA.pointer, uploadA.length);
      }
    } catch (err) {
      fail(err && err.message ? err.message : 'Point addition failed.');
    } finally {
      state.busy = false;
      submit.disabled = false;
      submit.textContent = 'Add P + Q';
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    add();
  });

  byId('add-clear').addEventListener('click', function () {
    first.value = '';
    second.value = '';
    facts.textContent = '';
    result.hidden = true;
    fail('');
    first.focus();
  });
})();
