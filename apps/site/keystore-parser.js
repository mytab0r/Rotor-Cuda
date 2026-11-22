/* Ethereum V3 keystore decryption in the tab. The JSON and the password are
 * read here and passed only to the local wasm core; nothing is stored. */
(function () {
  'use strict';

  /* Chain explorers come from data/chains.json through the generated globals
   * in chains.generated.js (loaded before this script). */
  var SSOT_ROOT = typeof window !== 'undefined' ? window : globalThis;
  var SSOT_CHAINS = SSOT_ROOT.RotorChains;

  /* Published Ethereum "Web3 Secret Storage Definition" V3 test vector
   * (PBKDF2/HMAC-SHA256, 262144 iterations). The wasm core was used to
   * decrypt it with password "testpassword" and the derived EVM address
   * matched the declared one; it is a public test key with no funds. */
  var KEYSTORE_EXAMPLES = [{
    id: 'web3-secret-storage-pbkdf2',
    label: 'Web3 secret-storage V3 test vector (PBKDF2)',
    password: 'testpassword',
    address: '0x008aeeda4d805471df9b2a5b0f38a0c3bcba786b',
    json: JSON.stringify({
      address: '008aeeda4d805471df9b2a5b0f38a0c3bcba786b',
      crypto: {
        cipher: 'aes-128-ctr',
        cipherparams: { iv: '6087dab2f9fdbbfaddc31a909735c1e6' },
        ciphertext: '5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46',
        kdf: 'pbkdf2',
        kdfparams: {
          c: 262144,
          dklen: 32,
          prf: 'hmac-sha256',
          salt: 'ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd'
        },
        mac: '517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2'
      },
      id: '3198bc9c-6672-5ab3-d995-4942343ae5b6',
      version: 3
    }, null, 2)
  }];

  // The JSON parser is also required from a Node test; the page code below
  // needs a DOM, so stop after exporting when there is none.
  if (typeof module === 'object' && module.exports) {
    module.exports = { parseKeystore: parseKeystore, KEYSTORE_EXAMPLES: KEYSTORE_EXAMPLES };
  }
  if (typeof document === 'undefined') return;

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
  var dropzone = byId('keystore-dropzone');
  var fileInput = byId('keystore-file');
  var fileName = byId('keystore-file-name');
  var exampleButton = byId('keystore-example');
  var dragDepth = 0;
  var state = { busy: false };

  /* Keystores are tiny JSON documents; cap the read so a stray large file
   * cannot lock the tab up during JSON.parse. */
  var MAX_FILE_BYTES = 64 * 1024;

  function fail(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  }

  function showFileNote(text) {
    fileName.textContent = text || '';
    fileName.hidden = !text;
  }

  function clearFile() {
    showFileNote('');
    if (fileInput) fileInput.value = '';
  }

  function readKeystoreFile(file) {
    if (!file) {
      fail('No file was dropped. Choose a JSON/UTC keystore file or paste it above.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      fail('The file "' + file.name + '" is ' + Math.ceil(file.size / 1024) +
        ' KiB; this page accepts at most 64 KiB.');
      clearFile();
      return;
    }
    file.text().then(function (text) {
      if (!text.trim()) {
        fail('The file "' + file.name + '" is empty.');
        return;
      }
      fail('');
      jsonInput.value = text;
      showFileNote('Loaded file: ' + file.name);
    }, function () {
      fail('The file "' + file.name + '" could not be read.');
    });
  }

  function hasFiles(event) {
    var types = event.dataTransfer && event.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
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

  /* Standard keystores store a full 32-byte MAC; legacy ones store the first
   * 16 bytes. Both are accepted by the wasm core. */
  function macField(value) {
    var text = String(value == null ? '' : value).trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]*$/.test(text) || (text.length !== 32 && text.length !== 64)) {
      throw new Error('The keystore field "mac" must be 32 (16-byte legacy) or 64 (32-byte) hex characters.');
    }
    return text.toLowerCase();
  }

  function intField(value, label, minimum) {
    var number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > 0xffffffff) {
      throw new Error('The keystore field "' + label + '" must be an integer >= ' + minimum +
        ' and <= 4294967295.');
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
    var params = crypto.kdfparams;
    var arrayForm = Array.isArray(params);
    if (arrayForm) {
      if (params.length !== 3) {
        throw new Error('The keystore field "kdfparams" as an array must be [n, r, p].');
      }
      // Legacy positional scrypt form: n, r, p; salt and dklen stay on "crypto".
      params = { n: params[0], r: params[1], p: params[2], salt: crypto.salt, dklen: crypto.dklen };
    } else if (!params || typeof params !== 'object') {
      throw new Error('The keystore has no "kdfparams" object or array.');
    }
    var dklen = intField(params.dklen, 'kdfparams.dklen', 1);
    var kdf = String(params.kdf || crypto.kdf || '').toLowerCase();
    if (arrayForm && kdf !== 'scrypt') {
      throw new Error('The array "kdfparams" form is only valid for scrypt.');
    }
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
      mac: macField(crypto.mac)
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
    request.version = 3;
    request.id = String(json.id == null ? '' : json.id).trim();
    request.cipher = String(crypto.cipher || '').trim();
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
    var report = window.RotorKeyTools.wasmResultJson(wasm);
    if (typeof wasm.clear_result === 'function') wasm.clear_result();
    return report;
  }

  async function decrypt(request) {
    var wasm = await window.RotorKeyTools.loadWasm(window.RotorAssets.url('/rotor_wasm.wasm'));
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
      if (typeof wasm.clear_result === 'function') wasm.clear_result();
      return await deriveAddress(wasm, keyHex);
    } finally {
      wasm.dealloc(salt.pointer, salt.length);
      wasm.dealloc(iv.pointer, iv.length);
      wasm.dealloc(ciphertext.pointer, ciphertext.length);
      wasm.dealloc(mac.pointer, mac.length);
      if (password.length > 0) {
        new Uint8Array(wasm.memory.buffer, password.pointer, password.length).fill(0);
      }
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
      passwordInput.value = '';
      var entries = {};
      report.addresses.forEach(function (entry) { entries[entry.id] = entry.address; });
      var evm = entries.evm || '';
      facts.textContent = '';
      facts.appendChild(factRow('Address', evm, evm ? SSOT_CHAINS.bySlug.ethereum.explorerPrefix + evm : ''));
      facts.appendChild(factRow('Private key (hex)', report.priv_hex));
      facts.appendChild(factRow('WIF (compressed)', report.wif_compressed));
      if (entries.btc_p2pkh) {
        facts.appendChild(factRow('Bitcoin P2PKH', entries.btc_p2pkh,
          SSOT_CHAINS.bySlug.bitcoin.explorerPrefix + entries.btc_p2pkh));
      }
      facts.appendChild(factRow('KDF', request.kdfName === 'scrypt'
        ? 'scrypt n=' + request.n + ' r=' + request.r + ' p=' + request.p
        : 'pbkdf2 c=' + request.c));
      facts.appendChild(factRow('Keystore id', request.id || 'Not declared'));
      facts.appendChild(factRow('Keystore version', String(request.version)));
      facts.appendChild(factRow('Cipher', request.cipher));
      facts.appendChild(factRow('Declared address',
        request.declaredAddress ? '0x' + request.declaredAddress : 'Not declared'));
      var matches = '';
      if (request.declaredAddress) {
        matches = evm && evm.toLowerCase().replace(/^0x/, '') === request.declaredAddress
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

  if (dropzone) {
    dropzone.addEventListener('dragenter', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      dropzone.classList.add('is-dragover');
    });
    dropzone.addEventListener('dragover', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    dropzone.addEventListener('dragleave', function (event) {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropzone.classList.remove('is-dragover');
    });
    dropzone.addEventListener('drop', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      dropzone.classList.remove('is-dragover');
      var files = event.dataTransfer.files;
      if (!files || files.length === 0) {
        fail('No file was dropped. Choose a JSON/UTC keystore file or paste it above.');
        return;
      }
      if (files.length > 1) {
        fail('Drop one keystore file at a time.');
        return;
      }
      readKeystoreFile(files[0]);
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) readKeystoreFile(fileInput.files[0]);
    });
  }

  if (exampleButton) {
    exampleButton.addEventListener('click', function () {
      var example = KEYSTORE_EXAMPLES[0];
      jsonInput.value = example.json;
      passwordInput.value = example.password;
      fail('');
      showFileNote('Example loaded: ' + example.label + ' (public test key, password "' +
        example.password + '")');
      jsonInput.focus();
    });
  }

  byId('keystore-clear').addEventListener('click', function () {
    jsonInput.value = '';
    passwordInput.value = '';
    facts.textContent = '';
    result.hidden = true;
    fail('');
    clearFile();
    jsonInput.focus();
  });

  window.addEventListener('pagehide', function () {
    jsonInput.value = '';
    passwordInput.value = '';
    facts.textContent = '';
    result.hidden = true;
    clearFile();
  });
})();
