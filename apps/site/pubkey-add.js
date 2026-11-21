/* P + Q, P - Q and k * P on secp256k1: the point arithmetic runs in the
   local wasm core. */
(function () {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };
  var form = byId('add-form');
  if (!form) return;

  var first = byId('add-first');
  var second = byId('add-second');
  var operation = byId('add-op');
  var secondLabel = byId('add-second-label');
  var secondHint = byId('add-second-hint');
  var errorBox = byId('add-error');
  var result = byId('add-result');
  var resultTitle = byId('add-result-title');
  var facts = byId('add-facts');
  var submit = byId('add-submit');
  var state = { wasm: null, promise: null, busy: false };

  var OPERATIONS = {
    add: {
      secondLabel: 'Public key Q',
      secondPlaceholder: '02… or 04…',
      hint: 'P + Q adds two public keys. Each input accepts a 66-hex compressed or 130-hex uncompressed public key.',
      submit: 'Add P + Q',
      title: 'P + Q'
    },
    subtract: {
      secondLabel: 'Public key Q',
      secondPlaceholder: '02… or 04…',
      hint: 'P − Q computes P + (−Q). Each input accepts a 66-hex compressed or 130-hex uncompressed public key.',
      submit: 'Subtract P − Q',
      title: 'P − Q'
    },
    mul: {
      secondLabel: 'Scalar k (64 hex)',
      secondPlaceholder: '64 hex characters, 1 to n−1',
      hint: 'k · P multiplies the point P by the scalar k. The scalar is 32-byte big-endian hex in the range 1 to n−1.',
      submit: 'Multiply k · P',
      title: 'k · P'
    }
  };

  function currentOperation() {
    return OPERATIONS[operation.value] ? operation.value : 'add';
  }

  function fail(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  }

  function idle() {
    submit.textContent = OPERATIONS[currentOperation()].submit;
    submit.disabled = false;
  }

  function applyOperation() {
    var config = OPERATIONS[currentOperation()];
    secondLabel.textContent = config.secondLabel;
    second.placeholder = config.secondPlaceholder;
    secondHint.textContent = config.hint;
    facts.textContent = '';
    result.hidden = true;
    fail('');
    idle();
  }

  function loadWasm() {
    if (state.wasm) return Promise.resolve(state.wasm);
    if (state.promise) return state.promise;
    state.promise = window.RotorKeyTools.loadWasm(window.RotorAssets.url('/rotor_wasm.wasm')).then(function (wasm) {
      if (typeof wasm.public_key_add !== 'function' ||
          typeof wasm.public_key_subtract !== 'function' ||
          typeof wasm.public_key_mul !== 'function') {
        throw new Error('This build of the calculation core has no point arithmetic exports. Reload the page.');
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

  function validPoint(raw) {
    return /^[0-9a-f]+$/.test(raw) && (raw.length === 66 || raw.length === 130);
  }

  function validScalar(raw) {
    return /^[0-9a-f]{64}$/.test(raw);
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

  async function compute() {
    if (state.busy) return;
    fail('');
    var type = currentOperation();
    var config = OPERATIONS[type];
    var a = normalize(first.value);
    var b = normalize(second.value);
    var scalarMode = type === 'mul';
    if (!validPoint(a)) {
      fail('Public key P must be 66 hex characters (compressed) or 130 (uncompressed).');
      first.focus();
      return;
    }
    if (scalarMode ? !validScalar(b) : !validPoint(b)) {
      fail(scalarMode
        ? 'Scalar k must be 64 hex characters (32 bytes).'
        : 'Public key Q must be 66 hex characters (compressed) or 130 (uncompressed).');
      second.focus();
      return;
    }
    state.busy = true;
    submit.disabled = true;
    submit.textContent = 'Computing…';
    result.hidden = true;
    try {
      var wasm = await loadWasm();
      var uploadA = window.RotorKeyTools.upload(wasm, a);
      var uploadB;
      try {
        uploadB = window.RotorKeyTools.upload(wasm, b);
        var status;
        try {
          if (type === 'subtract') {
            status = wasm.public_key_subtract(uploadA.pointer, uploadA.length, uploadB.pointer, uploadB.length) >>> 0;
          } else if (scalarMode) {
            status = wasm.public_key_mul(uploadA.pointer, uploadA.length, uploadB.pointer, uploadB.length) >>> 0;
          } else {
            status = wasm.public_key_add(uploadA.pointer, uploadA.length, uploadB.pointer, uploadB.length) >>> 0;
          }
        } finally {
          wasm.dealloc(uploadB.pointer, uploadB.length);
        }
        if (status !== 0) throw new Error(window.RotorKeyTools.wasmError(wasm));
        var report = window.RotorKeyTools.wasmResultJson(wasm);

        resultTitle.textContent = config.title;
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
      fail(err && err.message ? err.message : 'The point operation failed.');
    } finally {
      state.busy = false;
      idle();
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    compute();
  });

  operation.addEventListener('change', applyOperation);

  byId('add-clear').addEventListener('click', function () {
    first.value = '';
    second.value = '';
    facts.textContent = '';
    result.hidden = true;
    fail('');
    first.focus();
  });

  applyOperation();
})();
