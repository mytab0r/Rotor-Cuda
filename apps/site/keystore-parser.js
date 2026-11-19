/* Ethereum V3 keystore decryption in the tab. The JSON and the password are
 * read here and passed only to the local wasm core; nothing is stored. */
(function () {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };
  var form = byId('keystore-form');
  if (!form) return;

  var jsonInput = byId('keystore-json');
  var passwordInput = byId('keystore-password');
  var errorBox = byId('keystore-error');
  var result = byId('keystore-result');
  var facts = byId('keystore-facts');
  var statusLine = byId('keystore-status');
  var submit = byId('keystore-submit');
  var state = { busy: false };

  function fail(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
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

  function hexField(value, bytes, label) {
    var text = String(value == null ? '' : value).trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]*$/.test(text) || text.length !== bytes * 2) {
      throw new Error('The keystore field "' + label + '" must be ' + bytes * 2 + ' hex characters.');
    }
    return text.toLowerCase();
  }

  function intField(value, label, minimum) {
    var number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum) {
      throw new Error('The keystore field "' + label + '" must be an integer >= ' + minimum + '.');
    }
    return number;
  }

  function factRow(label, value, href) {
    var line = document.createElement('div');
    line.className = 'key-form-row';
    var term = document.createElement('dt');
    term.textContent = label;
    var detail = document.createElement('dd');
    var node;
    if (href) {
      node = document.createElement('a');
      node.className = 'mono detail-value';
      node.href = href;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    } else {
      node = document.createElement('code');
      node.className = 'mono detail-value';
    }
    node.textContent = value;
    detail.appendChild(node);
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

  function parseKeystore(text) {
    var json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error('The input is not valid JSON.');
    }
    if (!json || typeof json !== 'object') throw new Error('The keystore must be a JSON object.');
    if (Number(json.version) !== 3) {
      throw new Error('Unsupported keystore version "' + json.version + '". Only V3 UTC/JSON keystores are handled.');
    }
    var crypto = json.crypto || json.Crypto;
    if (!crypto || typeof crypto !== 'object') throw new Error('The keystore has no "crypto" object.');
    if (String(crypto.cipher || '').toLowerCase() !== 'aes-128-ctr') {
      throw new Error('Unsupported cipher "' + crypto.cipher + '". Only aes-128-ctr is handled.');
    }
    var cipherparams = crypto.cipherparams || {};
    var params = crypto.kdfparams || {};
    var dklen = intField(params.dklen, 'kdfparams.dklen', 1);
    var kdf = String(params.kdf || crypto.kdf || '').toLowerCase();
    var saltHex = String(params.salt == null ? '' : params.salt).trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]+$/.test(saltHex) || saltHex.length % 2 !== 0) {
      throw new Error('The keystore field "kdfparams.salt" must be a non-empty even-length hex string.');
    }
    var request = {
      kdfName: kdf,
      n: 0,
      r: 0,
      p: 0,
      c: 0,
      dklen: dklen,
      salt: saltHex.toLowerCase(),
      iv: hexField(cipherparams.iv, 16, 'cipherparams.iv'),
      ciphertext: hexField(crypto.ciphertext, 32, 'ciphertext'),
      mac: hexField(crypto.mac, 16, 'mac')
    };
    if (kdf === 'scrypt') {
      request.kdfId = 0;
      request.n = intField(params.n, 'kdfparams.n', 2);
      request.r = intField(params.r, 'kdfparams.r', 1);
      request.p = intField(params.p, 'kdfparams.p', 1);
    } else if (kdf === 'pbkdf2') {
      var prf = String(params.prf || 'hmac-sha256').toLowerCase();
      if (prf !== 'hmac-sha256') {
        throw new Error('Unsupported PBKDF2 PRF "' + params.prf + '". Only hmac-sha256 is handled.');
      }
      request.kdfId = 1;
      request.c = intField(params.c, 'kdfparams.c', 1);
    } else {
      throw new Error('Unsupported KDF "' + (kdf || 'missing') + '". This page supports scrypt and pbkdf2 (HMAC-SHA256).');
    }
    request.declaredAddress = String(json.address || '').replace(/^0x/i, '').toLowerCase();
    return request;
  }

  async function deriveAddress(wasm, keyHex) {
    var upload = window.RotorKeyTools.upload(wasm, window.RotorKeyTools.hexToBytes(keyHex));
    var code;
    try {
      code = wasm.derive_report(upload.pointer, 0) >>> 0;
    } finally {
      wasm.dealloc(upload.pointer, upload.length);
    }
    if (code !== 0) throw new Error('The decrypted key could not be derived: ' + window.RotorKeyTools.wasmError(wasm));
    return window.RotorKeyTools.wasmResultJson(wasm);
  }

  async function decrypt(request) {
    var wasm = await window.RotorKeyTools.loadWasm('/rotor_wasm.wasm');
    if (typeof wasm.keystore_decrypt !== 'function' || typeof wasm.derive_report !== 'function') {
      throw new Error('This build of the calculation core has no keystore export. Reload the page.');
    }
    var salt = window.RotorKeyTools.upload(wasm, window.RotorKeyTools.hexToBytes(request.salt));
    var iv = window.RotorKeyTools.upload(wasm, window.RotorKeyTools.hexToBytes(request.iv));
    var ciphertext = window.RotorKeyTools.upload(wasm, window.RotorKeyTools.hexToBytes(request.ciphertext));
    var mac = window.RotorKeyTools.upload(wasm, window.RotorKeyTools.hexToBytes(request.mac));
    var password = window.RotorKeyTools.upload(wasm, new TextEncoder().encode(passwordInput.value));
    var code;
    try {
      code = wasm.keystore_decrypt(
        request.kdfId, request.n, request.r, request.p, request.c, request.dklen,
        salt.pointer, salt.length,
        iv.pointer, iv.length,
        ciphertext.pointer, ciphertext.length,
        mac.pointer, mac.length,
        password.pointer, password.length
      ) >>> 0;
      if (code !== 0) throw new Error(window.RotorKeyTools.wasmError(wasm));
      var keyHex = window.RotorKeyTools.wasmText(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0);
      return await deriveAddress(wasm, keyHex);
    } finally {
      wasm.dealloc(salt.pointer, salt.length);
      wasm.dealloc(iv.pointer, iv.length);
      wasm.dealloc(ciphertext.pointer, ciphertext.length);
      wasm.dealloc(mac.pointer, mac.length);
      wasm.dealloc(password.pointer, password.length);
    }
  }

  async function run() {
    if (state.busy) return;
    fail('');
    result.hidden = true;
    var request;
    try {
      request = parseKeystore(jsonInput.value);
    } catch (err) {
      fail(err && err.message ? err.message : 'The keystore could not be read.');
      return;
    }
    state.busy = true;
    submit.disabled = true;
    submit.textContent = 'Decrypting…';
    try {
      var report = await decrypt(request);
      var entries = {};
      report.addresses.forEach(function (entry) { entries[entry.id] = entry.address; });
      var evm = entries.evm || '';
      facts.textContent = '';
      facts.appendChild(factRow('Address', evm, evm ? 'https://etherscan.io/address/' + evm : ''));
      facts.appendChild(factRow('Private key (hex)', report.priv_hex));
      facts.appendChild(factRow('WIF (compressed)', report.wif_compressed));
      if (entries.btc_p2pkh) {
        facts.appendChild(factRow('Bitcoin P2PKH', entries.btc_p2pkh,
          'https://mempool.space/address/' + entries.btc_p2pkh));
      }
      facts.appendChild(factRow('KDF', request.kdfName === 'scrypt'
        ? 'scrypt n=' + request.n + ' r=' + request.r + ' p=' + request.p
        : 'pbkdf2 c=' + request.c));
      var matches = '';
      if (request.declaredAddress) {
        matches = evm.toLowerCase().replace(/^0x/, '') === request.declaredAddress
          ? ' The address matches the keystore "address" field.'
          : ' Warning: the derived address does not match the keystore "address" field.';
      } else {
        matches = ' The keystore has no "address" field to compare against.';
      }
      statusLine.textContent = 'Decrypted locally with AES-128-CTR.' + matches +
        ' The password and file were not sent anywhere.';
      result.hidden = false;
      result.scrollIntoView({ behavior: window.RotorKeyTools.scrollBehavior(), block: 'start' });
    } catch (err) {
      fail(err && err.message ? err.message : 'Decryption failed.');
    } finally {
      state.busy = false;
      submit.disabled = false;
      submit.textContent = 'Decrypt';
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    run();
  });

  byId('keystore-clear').addEventListener('click', function () {
    jsonInput.value = '';
    passwordInput.value = '';
    facts.textContent = '';
    result.hidden = true;
    fail('');
    jsonInput.focus();
  });

  window.addEventListener('pagehide', function () {
    jsonInput.value = '';
    passwordInput.value = '';
  });
})();
