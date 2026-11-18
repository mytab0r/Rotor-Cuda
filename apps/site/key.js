/* Private-key explorer. Runs entirely in the browser; no build step, no deps.
 * The key stays in memory only: no URL, no storage, no console output. */
(function () {
  'use strict';

  var WASM_URL = '/rotor_wasm.wasm';
  var TIMEOUT_MS = 8000;
  var URL_KEY_RE = /^\/key\/([0-9a-fA-F]{64})$/;
  var EVM_RPC_URLS = [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://1rpc.io/eth'
  ];
  var SECP_N = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;
  var WEI = 1000000000000000000n;
  var WEI_PER_MICRO = 1000000000000n;
  var BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var DECODER = new TextDecoder('utf-8');

  var PRESETS = {
    all: null,
    ledger: ['btc_p2pkh', 'btc_p2pkh_uncompressed', 'btc_p2sh_p2wpkh', 'btc_p2wpkh', 'btc_p2tr'],
    metamask: ['evm'],
    safepal: ['btc_p2pkh', 'btc_p2pkh_uncompressed', 'btc_p2sh_p2wpkh', 'btc_p2wpkh', 'btc_p2tr', 'evm', 'tron', 'ltc_p2pkh', 'ltc_p2sh_p2wpkh', 'ltc_p2wpkh', 'doge_p2pkh', 'bch_legacy', 'xrp_classic'],
    tronlink: ['tron'],
    phantom: ['solana']
  };

  var ID_LABELS = {
    btc_p2pkh: 'Bitcoin legacy (compressed)',
    btc_p2pkh_uncompressed: 'Bitcoin legacy (uncompressed)',
    btc_p2sh_p2wpkh: 'Bitcoin P2SH-P2WPKH',
    btc_p2wpkh: 'Bitcoin native segwit',
    btc_p2tr: 'Bitcoin taproot',
    evm: 'Ethereum / EVM',
    tron: 'TRON',
    solana: 'Solana (ed25519)',
    ltc_p2pkh: 'Litecoin legacy (compressed)',
    ltc_p2sh_p2wpkh: 'Litecoin P2SH-P2WPKH',
    ltc_p2wpkh: 'Litecoin native segwit',
    doge_p2pkh: 'Dogecoin legacy (compressed)',
    bch_legacy: 'Bitcoin Cash legacy (compressed)',
    xrp_classic: 'XRP classic address',
    zcash_p2pkh: 'Zcash transparent',
    sui: 'Sui account',
    ton: 'TON wallet v4R2'
  };

  var EXPLAIN = {
    btc_p2pkh: 'hash160 of the compressed public key, prefixed with version byte 0x00 and base58check-encoded.',
    btc_p2pkh_uncompressed: 'hash160 of the uncompressed (65-byte) public key, prefixed with 0x00 and base58check-encoded.',
    btc_p2sh_p2wpkh: 'witness v0 redeem script 0x0014 || hash160(pubkey); hash160 of that script with version 0x05, base58check.',
    btc_p2wpkh: 'hash160 of the compressed key used as the witness v0 program; bech32 with human-readable part "bc".',
    btc_p2tr: 'x-only key tweaked for an empty script path: t = hash_TapTweak(x(P)), Q = P + tG; witness v1, bech32m.',
    evm: 'last 20 bytes of keccak256 of the uncompressed key (without the 0x04 prefix), shown with the EIP-55 checksum.',
    tron: '0x41 || last 20 bytes of the same keccak256 hash, base58check-encoded.',
    solana: 'base58 of the 32-byte ed25519 public key; no hash step.',
    ltc_p2pkh: 'hash160 of the compressed public key with Litecoin version byte 0x30, base58check-encoded.',
    ltc_p2sh_p2wpkh: 'P2SH redeem script 0x0014 || hash160(pubkey) with Litecoin version byte 0x32, base58check.',
    ltc_p2wpkh: 'witness v0 program hash160(pubkey) with the "ltc" human-readable part, bech32.',
    doge_p2pkh: 'hash160 of the compressed public key with Dogecoin version byte 0x1e, base58check-encoded.',
    bch_legacy: 'Bitcoin Cash legacy address: hash160(pubkey) with version byte 0x00, base58check.',
    xrp_classic: 'XRP classic address: 0x00 || hash160(pubkey), base58check (Ripple alphabet).',
    zcash_p2pkh: 'Zcash transparent address: two-byte version 0x1cb8 || hash160(pubkey), base58check.',
    sui: 'Sui account: BLAKE2b-256 of the 0x00 ed25519 flag plus the public key, shown as 0x hex.',
    ton: 'TON wallet: address of the standard v4R2 contract whose StateInit stores this ed25519 public key.'
  };

  var PATHS = {
    btc_p2pkh: "P2PKH · m/44'/0'/0'/0/0",
    btc_p2pkh_uncompressed: "P2PKH (uncompressed) · m/44'/0'/0'/0/0",
    btc_p2sh_p2wpkh: "P2SH-P2WPKH · m/49'/0'/0'/0/0",
    btc_p2wpkh: "P2WPKH · m/84'/0'/0'/0/0",
    btc_p2tr: "P2TR · m/86'/0'/0'/0/0",
    evm: "EVM · m/44'/60'/0'/0/0",
    tron: "TRON · m/44'/195'/0'/0/0",
    solana: 'Solana · ed25519 seed',
    ltc_p2pkh: "P2PKH · m/44'/2'/0'/0/0",
    ltc_p2sh_p2wpkh: "P2SH-P2WPKH · m/49'/2'/0'/0/0",
    ltc_p2wpkh: "P2WPKH · m/84'/2'/0'/0/0",
    doge_p2pkh: "P2PKH · m/44'/3'/0'/0/0",
    bch_legacy: "P2PKH · m/44'/145'/0'/0/0",
    xrp_classic: "XRP · m/44'/144'/0'/0/0"
  };

  var STEP_ORDER = {
    btc_p2pkh: ['pubkey', 'hash160', 'payload', 'checksum', 'base58'],
    btc_p2pkh_uncompressed: ['pubkey', 'hash160', 'payload', 'checksum', 'base58'],
    btc_p2sh_p2wpkh: ['pubkey', 'hash160', 'redeem', 'script_hash', 'payload', 'checksum', 'base58'],
    btc_p2wpkh: ['pubkey', 'hash160', 'hrp', 'witness_version', 'program', 'checksum'],
    btc_p2tr: ['internal_x', 'tweak', 'output_x', 'parity', 'program'],
    evm: ['pubkey', 'keccak', 'last20'],
    tron: ['pubkey', 'keccak', 'last20', 'payload', 'checksum', 'base58'],
    solana: ['pubkey'],
    ltc_p2pkh: ['pubkey', 'hash160', 'payload', 'checksum', 'base58'],
    ltc_p2sh_p2wpkh: ['pubkey', 'hash160', 'redeem', 'script_hash', 'payload', 'checksum', 'base58'],
    ltc_p2wpkh: ['pubkey', 'hash160', 'hrp', 'witness_version', 'program', 'checksum'],
    doge_p2pkh: ['pubkey', 'hash160', 'payload', 'checksum', 'base58'],
    bch_legacy: ['pubkey', 'hash160', 'payload', 'checksum', 'base58'],
    xrp_classic: ['pubkey', 'hash160', 'payload', 'checksum', 'base58']
  };

  var STEP_LABELS = {
    pubkey: 'public key',
    hash160: 'hash160 (SHA-256 → RIPEMD-160)',
    payload: 'prefixed payload',
    checksum: 'check bytes',
    base58: 'Base58Check',
    redeem: 'redeem script',
    script_hash: 'hash160 of redeem script',
    hrp: 'human-readable part',
    witness_version: 'witness version',
    program: 'witness program',
    internal_x: 'internal key x',
    tweak: 'TapTweak hash',
    output_x: 'output key x',
    parity: 'parity',
    keccak: 'Keccak-256',
    last20: 'last 20 bytes'
  };

  /* Address-row ids grouped by chain tab. Prefixes match both exact ids
   * (evm, tron, solana) and families (btc_*, ltc_*, ...). */
  var CHAIN_PREFIXES = {
    btc: ['btc_'],
    evm: ['evm'],
    tron: ['tron'],
    solana: ['solana'],
    ltc: ['ltc_'],
    doge: ['doge_'],
    bch: ['bch_'],
    xrp: ['xrp_'],
    zcash: ['zcash_'],
    sui: ['sui'],
    ton: ['ton']
  };

  var CHAIN_NAMES = {
    ltc: 'Litecoin',
    doge: 'Dogecoin',
    bch: 'Bitcoin Cash',
    xrp: 'XRP'
  };

  var state = {
    wasm: null,
    wasmPromise: null,
    keyBytes: null,
    report: null,
    preset: 'all',
    chain: 'all',
    focusId: null,
    balances: {},
    checking: false,
    deriving: false,
    generation: 0,
    controllers: [],
    exposureTimer: null,
    exposureController: null,
    exposurePostedGeneration: -1,
    urlKey: null,
    urlExposurePosted: false
  };

  function byId(id) { return document.getElementById(id); }

  var input = byId('priv');
  var curveSelect = byId('curve');
  var deriveBtn = byId('derive-btn');
  var randomBtn = byId('random-btn');
  var stepDownBtn = byId('step-down');
  var stepUpBtn = byId('step-up');
  var clearBtn = byId('clear-btn');
  var errorBox = byId('key-error');
  var summaryEl = byId('summary');
  var rowsEl = byId('addr-rows');
  var presetEmpty = byId('preset-empty');
  var onlineToggle = byId('online-toggle');
  var checkBtn = byId('check-balances');
  var plotEl = byId('curve-plot');
  var slider = byId('curve-slider');
  var caption = byId('curve-caption');
  var presetButtons = Array.prototype.slice.call(document.querySelectorAll('.key-presets button'));
  var chainButtons = Array.prototype.slice.call(document.querySelectorAll('.key-chain'));
  var pathChips = Array.prototype.slice.call(document.querySelectorAll('.key-path-chip'));
  var typeTiles = Array.prototype.slice.call(document.querySelectorAll('.key-type'));
  var btcPanel = byId('btc-panel');
  var btcSelected = byId('btc-selected');
  var btcBalance = byId('btc-balance');
  var btcReceived = byId('btc-received');
  var btcTx = byId('btc-tx');
  var btcHint = byId('btc-summary-hint');
  var exposureToggle = byId('exposure-toggle');
  var exposureStatus = byId('exposure-status');
  var urlNotice = byId('key-url-notice');

  /* ------------------------------------------------------------ key parsing */

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function hideError() {
    errorBox.textContent = '';
    errorBox.hidden = true;
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      var part = bytes[i].toString(16);
      hex += part.length === 1 ? '0' + part : part;
    }
    return hex;
  }

  function bytesToBigInt(bytes) {
    var hex = bytesToHex(bytes);
    return BigInt('0x' + (hex || '0'));
  }

  function decimalToBytes(text) {
    var value = BigInt(text);
    if (value >= (1n << 256n)) throw new Error('The decimal key is wider than 256 bits.');
    return hexToBytes(value.toString(16).padStart(64, '0'));
  }

  function base58Decode(text) {
    var value = 0n;
    for (var i = 0; i < text.length; i++) {
      var index = BASE58.indexOf(text.charAt(i));
      if (index < 0) throw new Error('Invalid base58 character in the WIF.');
      value = value * 58n + BigInt(index);
    }
    var leading = 0;
    while (leading < text.length && text.charAt(leading) === '1') leading++;
    var hex = value === 0n ? '' : value.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    var body = hex ? hexToBytes(hex) : new Uint8Array(0);
    var out = new Uint8Array(leading + body.length);
    out.set(body, leading);
    return out;
  }

  async function sha256(bytes) {
    var digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
  }

  async function decodeWif(text) {
    if (!(window.crypto && window.crypto.subtle)) {
      throw new Error('WIF checksums need a secure context (https or localhost) in this browser.');
    }
    var raw = base58Decode(text);
    if (raw.length !== 37 && raw.length !== 38) throw new Error('Not a valid Bitcoin WIF length.');
    if (raw[0] !== 0x80) throw new Error('Not a Bitcoin mainnet WIF.');
    if (raw.length === 38 && raw[33] !== 0x01) throw new Error('Invalid WIF compression marker.');
    var payload = raw.slice(0, raw.length - 4);
    var checksum = raw.slice(raw.length - 4);
    var hash = await sha256(await sha256(payload));
    for (var i = 0; i < 4; i++) {
      if (hash[i] !== checksum[i]) throw new Error('WIF checksum mismatch.');
    }
    return raw.slice(1, 33);
  }

  async function parseKey(raw, curve) {
    var text = raw.trim();
    if (!text) throw new Error('Enter a private key.');
    var parsed = null;

    if (/^0[xX][0-9a-fA-F]{64}$/.test(text)) parsed = { bytes: hexToBytes(text.slice(2)), format: 'hex' };
    else if (/^[0-9a-fA-F]{64}$/.test(text)) parsed = { bytes: hexToBytes(text), format: 'hex' };
    else if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(text)) parsed = { bytes: await decodeWif(text), format: 'wif' };
    else if (/^[0-9]+$/.test(text)) parsed = { bytes: decimalToBytes(text), format: 'decimal' };
    else throw new Error('Unrecognized format. Use 64 hex characters (optionally 0x-prefixed), a decimal integer, or a Bitcoin WIF.');

    if (parsed.format === 'wif' && curve !== 0) {
      throw new Error('A WIF encodes a secp256k1 key; switch the curve to secp256k1.');
    }
    var value = bytesToBigInt(parsed.bytes);
    if (curve === 0 && (value === 0n || value >= SECP_N)) {
      throw new Error('secp256k1 keys must be in the range 1 .. n-1.');
    }
    return parsed;
  }

  function randomScalar() {
    var bytes = new Uint8Array(32);
    for (;;) {
      window.crypto.getRandomValues(bytes);
      var value = bytesToBigInt(bytes);
      if (value > 0n && value < SECP_N) return bytes;
    }
  }

  /* -------------------------------------------------------------- wasm core */

  function loadWasm() {
    if (state.wasm) return Promise.resolve(state.wasm);
    if (state.wasmPromise) return state.wasmPromise;

    state.wasmPromise = (async function () {
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
          throw new Error('This build of ' + WASM_URL + ' has no "' + required[i] + '" export yet. The derivation core needs the new ABI (rebuild crates/rotor-wasm).');
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
    if (!ptr) throw new Error('WASM memory exhausted (requested ' + bytes.length + ' bytes).');
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
      wasm.dealloc(ptr, bytes.length);
    }
  }

  /* ---------------------------------------------------------------- deriving */

  function setBusy(busy) {
    state.deriving = busy;
    deriveBtn.disabled = busy;
    deriveBtn.textContent = busy ? 'Calculating…' : 'Calculate';
    randomBtn.disabled = busy;
    stepDownBtn.disabled = busy;
    stepUpBtn.disabled = busy;
    clearBtn.disabled = busy;
  }

  function summaryPlaceholder() {
    summaryEl.textContent = '';
    var note = document.createElement('p');
    note.className = 'muted key-empty';
    note.textContent = 'Derive a key to see its numeric forms and public point.';
    summaryEl.appendChild(note);
  }

  function rowsPlaceholder() {
    rowsEl.textContent = '';
    var note = document.createElement('p');
    note.className = 'muted key-empty';
    note.textContent = 'Derive a key to see its addresses.';
    rowsEl.appendChild(note);
  }

  function cancelBalances() {
    state.generation += 1;
    state.balances = {};
    state.controllers.forEach(function (controller) {
      try { controller.abort(); } catch (err) { /* already aborted */ }
    });
    state.controllers = [];
    cancelExposure(true);
    renderBalanceCards();
  }

  function clearResults() {
    cancelBalances();
    state.report = null;
    state.focusId = null;
    summaryPlaceholder();
    rowsPlaceholder();
    updateChainAvailability([], null);
    syncSelection(false, false);
    syncBitcoinPanel();
    presetEmpty.hidden = true;
    checkBtn.disabled = true;
    checkBtn.textContent = 'Check balances';
  }

  async function runDerive(bytes, curve) {
    cancelBalances();
    hideError();
    setBusy(true);
    try {
      var wasm = await loadWasm();
      renderReport(deriveReport(wasm, bytes, curve));
    } catch (err) {
      clearResults();
      showError(err && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deriveFromInput() {
    if (state.deriving) return;
    hideError();
    var curve = Number(curveSelect.value);
    var parsed;
    try {
      parsed = await parseKey(input.value, curve);
    } catch (err) {
      state.keyBytes = null;
      clearResults();
      showError(err.message);
      return;
    }
    state.keyBytes = parsed.bytes;
    await runDerive(parsed.bytes, curve);
  }

  function randomKey() {
    if (state.deriving) return;
    hideError();
    var curve = Number(curveSelect.value);
    var bytes;
    try {
      if (curve === 0) {
        bytes = randomScalar();
      } else {
        bytes = new Uint8Array(32);
        window.crypto.getRandomValues(bytes);
      }
    } catch (err) {
      showError('This browser cannot generate a random key: ' + err.message);
      return;
    }
    input.value = bytesToHex(bytes);
    state.keyBytes = bytes;
    runDerive(bytes, curve);
  }

  async function stepKey(delta) {
    if (state.deriving) return;
    hideError();
    var curve = Number(curveSelect.value);
    var parsed;
    try {
      parsed = await parseKey(input.value, curve);
    } catch (err) {
      showError(err.message);
      return;
    }
    var value = bytesToBigInt(parsed.bytes);
    if (curve === 0) {
      var span = SECP_N - 1n;
      value = ((value - 1n + BigInt(delta) + span) % span) + 1n;
    } else {
      var modulo = 1n << 256n;
      value = ((value + BigInt(delta)) % modulo + modulo) % modulo;
    }
    var bytes = hexToBytes(value.toString(16).padStart(64, '0'));
    input.value = bytesToHex(bytes);
    state.keyBytes = bytes;
    await runDerive(bytes, curve);
  }

  function clearKey() {
    hideError();
    input.value = '';
    state.keyBytes = null;
    clearResults();
    input.focus();
  }

  /* ---------------------------------------------------------------- results */

  function renderReport(report) {
    state.report = report;
    state.balances = {};
    renderSummary(report);
    renderAddresses(report);
    attachTon(report);
    checkBtn.textContent = 'Check balances';
    checkBtn.disabled = !onlineToggle.checked || state.checking;
    if (state.urlKey && !state.urlExposurePosted) scheduleExposure(report, true);
    else if (exposureToggle && exposureToggle.checked) scheduleExposure(report, false);
    else hideExposureStatus();
  }

  function summaryFields(report) {
    return {
      key: [
        ['Curve', report.curve || ''],
        ['Hex', report.priv_hex || ''],
        ['WIF (compressed)', report.wif_compressed || ''],
        ['WIF (uncompressed)', report.wif_uncompressed || '']
      ],
      point: [
        ['Compressed', report.pubkey_compressed || ''],
        ['Uncompressed', report.pubkey_uncompressed || ''],
        ['X', report.x || ''],
        ['Y', report.y || ''],
        ['ed25519', report.ed_pubkey || '']
      ]
    };
  }

  function summaryGroup(title, fields) {
    var group = document.createElement('section');
    group.className = 'key-summary-group';
    var heading = document.createElement('h3');
    heading.className = 'key-group-title';
    heading.textContent = title;
    group.appendChild(heading);

    var dl = document.createElement('dl');
    dl.className = 'key-form-list';
    fields.forEach(function (field) {
      var value = field[1];
      if (!value) return;
      var row = document.createElement('div');
      row.className = 'key-form-row';
      var dt = document.createElement('dt');
      dt.textContent = field[0];
      var dd = document.createElement('dd');
      dd.className = 'mono';
      dd.textContent = value;
      row.appendChild(dt);
      row.appendChild(dd);
      if (field[0] === 'Curve') {
        var spacer = document.createElement('span');
        spacer.className = 'key-copy-spacer';
        row.appendChild(spacer);
      } else {
        var copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'key-copy key-copy-sm';
        copy.textContent = 'Copy';
        copy.setAttribute('aria-label', 'Copy ' + field[0] + ' value');
        copy.addEventListener('click', function () { copyText(value, copy); });
        row.appendChild(copy);
      }
      dl.appendChild(row);
    });
    group.appendChild(dl);
    return group;
  }

  function renderSummary(report) {
    summaryEl.textContent = '';
    var fields = summaryFields(report);
    var grid = document.createElement('div');
    grid.className = 'key-summary-grid';
    grid.appendChild(summaryGroup('Key', fields.key));
    grid.appendChild(summaryGroup('Public point', fields.point));
    summaryEl.appendChild(grid);
  }

  function renderAddresses(report) {
    rowsEl.textContent = '';
    var addresses = Array.isArray(report.addresses) ? report.addresses : [];
    if (!addresses.length) {
      state.focusId = null;
      var note = document.createElement('p');
      note.className = 'muted key-empty';
      note.textContent = 'The derivation core returned no address rows.';
      rowsEl.appendChild(note);
      presetEmpty.hidden = true;
      syncSelection(false, false);
      syncBitcoinPanel();
      return;
    }
    addresses.forEach(function (addr) {
      if (!addr || !addr.id || !addr.address) return;
      rowsEl.appendChild(buildRow(addr));
    });
    resetBalanceBadges();
    updateChainAvailability(addresses, report.curve);
    ensureBtcFocus();
    applyFilters();
    syncSelection(false, false);
    syncBitcoinPanel();
  }

  function orderedSteps(id, steps) {
    var order = (STEP_ORDER[id] || []).slice();
    Object.keys(steps).forEach(function (key) {
      if (order.indexOf(key) < 0) order.push(key);
    });
    return order.filter(function (key) {
      var value = steps[key];
      return value !== null && value !== undefined && value !== '';
    });
  }

  var tonLoader = null;
  function loadTon() {
    if (window.RotorTon) return Promise.resolve(window.RotorTon);
    if (tonLoader) return tonLoader;
    tonLoader = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = '/ton.js';
      script.onload = function () {
        if (window.RotorTon) resolve(window.RotorTon);
        else reject(new Error('TON library did not load.'));
      };
      script.onerror = function () { reject(new Error('TON library did not load.')); };
      document.head.appendChild(script);
    });
    tonLoader.catch(function () { tonLoader = null; });
    return tonLoader;
  }

  function attachTon(report) {
    if (!report || report.curve !== 'ed25519' || !report.ed_pubkey) return;
    if (Array.isArray(report.addresses) && report.addresses.some(function (row) { return row.id === 'ton'; })) return;
    loadTon().then(function (ton) {
      return ton.address(report.ed_pubkey);
    }).then(function (address) {
      if (!address || state.report !== report) return;
      report.addresses.push({ id: 'ton', label: 'TON wallet v4R2', address: address, steps: {} });
      renderAddresses(report);
    }).catch(function () {
      /* Solana and Sui remain usable without the TON bundle */
    });
  }

  function buildRow(addr) {
    var row = document.createElement('div');
    row.className = 'key-row';
    row.setAttribute('data-id', addr.id);
    row.setAttribute('data-address', addr.address);

    var head = document.createElement('div');
    head.className = 'key-row-head';
    var title = document.createElement('h3');
    title.className = 'key-row-title';
    title.textContent = addr.label || ID_LABELS[addr.id] || addr.id;
    head.appendChild(title);
    if (PATHS[addr.id]) {
      var path = document.createElement('span');
      path.className = 'key-row-path';
      path.textContent = PATHS[addr.id];
      head.appendChild(path);
    }
    var badge = document.createElement('span');
    badge.className = 'key-balance';
    badge.hidden = true;
    head.appendChild(badge);
    row.appendChild(head);

    var line = document.createElement('div');
    line.className = 'key-addr-line';
    var code = document.createElement('code');
    code.className = 'mono key-addr';
    code.textContent = addr.address;
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'key-copy';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy ' + (addr.label || addr.id) + ' address');
    copy.addEventListener('click', function () { copyText(addr.address, copy); });
    line.appendChild(code);
    line.appendChild(copy);
    row.appendChild(line);

    if (EXPLAIN[addr.id]) {
      var sentence = document.createElement('p');
      sentence.className = 'muted key-explain';
      sentence.textContent = EXPLAIN[addr.id];
      row.appendChild(sentence);
    }

    var details = document.createElement('details');
    details.className = 'key-steps';
    var summary = document.createElement('summary');
    summary.textContent = 'Show calculation';
    details.appendChild(summary);

    var steps = addr.steps && typeof addr.steps === 'object' ? addr.steps : null;
    if (steps) {
      var keys = orderedSteps(addr.id, steps);
      if (keys.length) {
        var list = document.createElement('ol');
        list.className = 'key-step-list';
        keys.forEach(function (key, index) {
          var item = document.createElement('li');
          var num = document.createElement('span');
          num.className = 'key-step-num';
          num.textContent = (index + 1) + ' ·';
          var label = document.createElement('span');
          label.className = 'key-step-label';
          label.textContent = STEP_LABELS[key] || key.replace(/_/g, ' ');
          var value = document.createElement('span');
          value.className = 'key-step-value mono';
          value.textContent = String(steps[key]);
          item.appendChild(num);
          item.appendChild(label);
          item.appendChild(value);
          list.appendChild(item);
        });
        details.appendChild(list);
      }
    }

    row.appendChild(details);
    return row;
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

  /* ------------------------------------------------------- filters/selection */

  function btcRowIds() {
    var ids = [];
    Array.prototype.forEach.call(rowsEl.children, function (row) {
      var id = row.getAttribute('data-id');
      if (id && id.indexOf('btc_') === 0) ids.push(id);
    });
    return ids;
  }

  function findRow(id) {
    return Array.prototype.filter.call(rowsEl.children, function (row) {
      return row.getAttribute('data-id') === id;
    })[0] || null;
  }

  function ensureBtcFocus() {
    var ids = btcRowIds();
    if (!ids.length) {
      state.focusId = null;
      return;
    }
    if (state.focusId === 'summary') return;
    if (!state.focusId || ids.indexOf(state.focusId) < 0) {
      state.focusId = ids.indexOf('btc_p2pkh') >= 0 ? 'btc_p2pkh' : ids[0];
    }
  }

  function chainHasRows(chain, addresses) {
    var prefixes = CHAIN_PREFIXES[chain];
    if (!prefixes || !addresses) return false;
    return addresses.some(function (addr) {
      if (!addr || !addr.id || !addr.address) return false;
      return prefixes.some(function (prefix) {
        return addr.id === prefix || addr.id.indexOf(prefix) === 0;
      });
    });
  }

  function updateChainAvailability(addresses, curve) {
    /* "soon" means the secp256k1 core does not report this chain yet. On
     * ed25519 only Solana exists, so absence there is expected, not pending. */
    var showSoon = curve === 'secp256k1';
    chainButtons.forEach(function (button) {
      var chain = button.getAttribute('data-chain');
      var badge = button.querySelector('.key-soon');
      if (!badge) return;
      var pending = showSoon && !chainHasRows(chain, addresses);
      badge.hidden = !pending;
      button.classList.toggle('key-chain-soon', pending);
    });
  }

  function emptyMessage() {
    var name = CHAIN_NAMES[state.chain];
    if (name && state.report && state.report.curve !== 'ed25519' &&
        !chainHasRows(state.chain, state.report.addresses)) {
      return name + ' addresses are coming soon. The derivation core does not report ' +
        state.chain + '_* rows yet.';
    }
    return 'No rows match this chain and wallet preset on the selected curve.';
  }

  function rowMatches(id) {
    var preset = PRESETS[state.preset];
    if (preset && preset.indexOf(id) < 0) return false;
    if (state.chain === 'all') return true;
    var prefixes = CHAIN_PREFIXES[state.chain];
    if (!prefixes) return false;
    return prefixes.some(function (prefix) {
      return id === prefix || id.indexOf(prefix) === 0;
    });
  }

  function applyFilters() {
    if (!state.report) {
      presetEmpty.hidden = true;
      return;
    }
    var visible = 0;
    Array.prototype.forEach.call(rowsEl.children, function (row) {
      var show = rowMatches(row.getAttribute('data-id'));
      row.classList.toggle('hidden', !show);
      if (show) visible++;
    });
    if (visible === 0) presetEmpty.textContent = emptyMessage();
    presetEmpty.hidden = visible > 0;
  }

  function selectPreset(button) {
    state.preset = button.getAttribute('data-preset');
    var presetSelect = byId('preset-select');
    if (presetSelect) presetSelect.value = state.preset;
    presetButtons.forEach(function (other) {
      other.setAttribute('aria-pressed', String(other === button));
    });
    applyFilters();
    syncBitcoinPanel();
  }

  function selectChain(button) {
    state.chain = button.getAttribute('data-chain');
    chainButtons.forEach(function (other) {
      other.setAttribute('aria-pressed', String(other === button));
    });
    applyFilters();
    syncBitcoinPanel();
  }

  function scrollBehavior() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'auto';
    return 'smooth';
  }

  function syncSelection(open, scroll) {
    pathChips.forEach(function (chip) {
      chip.setAttribute('aria-pressed', String(chip.getAttribute('data-row') === state.focusId));
    });
    typeTiles.forEach(function (tile) {
      tile.setAttribute('aria-pressed', String(tile.getAttribute('data-row') === state.focusId));
    });
    Array.prototype.forEach.call(rowsEl.children, function (row) {
      row.classList.toggle('key-row-focus', !!state.focusId && row.getAttribute('data-id') === state.focusId);
    });
    summaryEl.classList.toggle('key-focus', state.focusId === 'summary');
    if (!state.focusId) return;
    if (state.focusId === 'summary') {
      if (scroll) summaryEl.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      return;
    }
    var row = findRow(state.focusId);
    if (!row) return;
    if (open) {
      var details = row.querySelector('details');
      if (details) details.open = true;
    }
    if (scroll) row.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
  }

  function focusTarget(id) {
    if (!id) return;
    state.focusId = id;
    if (id !== 'summary') {
      state.preset = 'all';
      presetButtons.forEach(function (button) {
        button.setAttribute('aria-pressed', String(button.getAttribute('data-preset') === 'all'));
      });
      if (id.indexOf('btc_') === 0) {
        state.chain = 'btc';
        chainButtons.forEach(function (button) {
          button.setAttribute('aria-pressed', String(button.getAttribute('data-chain') === 'btc'));
        });
      }
      applyFilters();
    }
    syncSelection(true, true);
    syncBitcoinPanel();
  }

  function selectedBtcId() {
    var ids = btcRowIds();
    if (state.focusId && ids.indexOf(state.focusId) >= 0) return state.focusId;
    if (ids.indexOf('btc_p2pkh') >= 0) return 'btc_p2pkh';
    return ids[0] || null;
  }

  function formatBtc(sats) {
    var unit = 100000000n;
    var whole = sats / unit;
    var fraction = (sats % unit).toString().padStart(8, '0').replace(/0+$/, '');
    return fraction ? whole.toString() + '.' + fraction : whole.toString();
  }

  function setCardValue(el, text) {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('empty', text === '—');
  }

  function renderBalanceCards() {
    if (!btcBalance || !btcPanel || btcPanel.hidden) return;
    var id = selectedBtcId();
    var summary = id ? state.balances[id] : null;
    var row = id ? findRow(id) : null;
    if (btcSelected) {
      if (row) {
        var title = row.querySelector('.key-row-title');
        var addr = row.querySelector('.key-addr');
        btcSelected.textContent = (title ? title.textContent : id) + (addr ? ' · ' + addr.textContent : '');
      } else {
        btcSelected.textContent = '';
      }
    }
    if (summary) {
      setCardValue(btcBalance, formatBtc(summary.balanceSat) + ' BTC');
      setCardValue(btcReceived, summary.receivedSat.toLocaleString('en-US') + ' sat');
      setCardValue(btcTx, String(summary.txs));
      btcHint.textContent = 'Balance, received and transaction count come from mempool.space for the selected Bitcoin address.';
    } else {
      setCardValue(btcBalance, '—');
      setCardValue(btcReceived, '—');
      setCardValue(btcTx, '—');
      btcHint.textContent = 'Enable online lookups and press Check balances to fill these values for the selected Bitcoin address.';
    }
  }

  function syncBitcoinPanel() {
    if (!btcPanel) return;
    var hasVisibleBtc = Array.prototype.some.call(rowsEl.children, function (row) {
      var id = row.getAttribute('data-id');
      return !!id && id.indexOf('btc_') === 0 && !row.classList.contains('hidden');
    });
    btcPanel.hidden = !hasVisibleBtc;
    renderBalanceCards();
  }

  /* --------------------------------------------------------------- balances */

  function setBalance(badge, kind, text) {
    badge.hidden = false;
    badge.className = 'key-balance' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
    badge.textContent = text;
  }

  function resetBalanceBadges() {
    Array.prototype.forEach.call(rowsEl.querySelectorAll('.key-balance'), function (badge) {
      badge.textContent = '';
      badge.className = 'key-balance';
      badge.hidden = true;
    });
  }

  function abortError() {
    var err = new Error('aborted');
    err.name = 'AbortError';
    return err;
  }

  async function fetchWithTimeout(url, options, parentSignal) {
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    var onParentAbort = null;
    if (parentSignal) {
      if (parentSignal.aborted) {
        window.clearTimeout(timer);
        throw abortError();
      }
      onParentAbort = function () { controller.abort(); };
      parentSignal.addEventListener('abort', onParentAbort);
    }
    try {
      var settings = options || {};
      settings.signal = controller.signal;
      return await fetch(url, settings);
    } finally {
      window.clearTimeout(timer);
      if (parentSignal && onParentAbort) parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  function numberOrZero(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0;
  }

  function formatUnits6(value, unit) {
    var whole = value / unit;
    var fraction = value % unit;
    var text = fraction.toString().padStart(6, '0').replace(/0+$/, '');
    return text ? whole.toString() + '.' + text : whole.toString();
  }

  function formatEth(wei) {
    var whole = wei / WEI;
    var fraction = (wei % WEI) / WEI_PER_MICRO;
    var text = fraction.toString().padStart(6, '0').replace(/0+$/, '');
    return text ? whole.toString() + '.' + text : whole.toString();
  }

  async function fetchBtc(address, signal) {
    var response = await fetchWithTimeout('https://mempool.space/api/address/' + encodeURIComponent(address), null, signal);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var data = await response.json();
    var chain = data.chain_stats || {};
    var mempool = data.mempool_stats || {};
    var funded = BigInt(Math.trunc(numberOrZero(chain.funded_txo_sum))) +
      BigInt(Math.trunc(numberOrZero(mempool.funded_txo_sum)));
    var spent = BigInt(Math.trunc(numberOrZero(chain.spent_txo_sum))) +
      BigInt(Math.trunc(numberOrZero(mempool.spent_txo_sum)));
    var sats = funded - spent;
    if (sats < 0n) sats = 0n;
    var txs = numberOrZero(chain.tx_count) + numberOrZero(mempool.tx_count);
    return {
      text: sats.toLocaleString('en-US') + ' sats · ' + txs + ' tx',
      summary: { balanceSat: sats, receivedSat: funded, txs: txs }
    };
  }

  async function evmBatch(address, url, signal) {
    var body = [
      { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] },
      { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionCount', params: [address, 'latest'] }
    ];
    var response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, signal);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var data = await response.json();
    var items = Array.isArray(data) ? data : [data];
    var byId = {};
    items.forEach(function (item) {
      if (item && item.id !== undefined) byId[item.id] = item;
    });
    var balance = byId[1];
    if (!balance || typeof balance.result !== 'string') {
      var reason = balance && balance.error && balance.error.message
        ? balance.error.message
        : (data && data.error && data.error.message ? data.error.message : 'unexpected response');
      throw new Error(reason);
    }
    var text = formatEth(BigInt(balance.result)) + ' ETH';
    var nonce = byId[2];
    if (nonce && typeof nonce.result === 'string') text += ' · nonce ' + BigInt(nonce.result).toString();
    return text;
  }

  async function fetchEvm(address, signal) {
    var lastError = null;
    var lastUrl = '';
    for (var i = 0; i < EVM_RPC_URLS.length; i++) {
      var url = EVM_RPC_URLS[i];
      try {
        return await evmBatch(address, url, signal);
      } catch (err) {
        /* Network/CORS errors, non-OK HTTP, JSON-RPC errors and malformed
         * results all fall through to the next public endpoint. */
        if (signal && signal.aborted) throw err;
        lastUrl = url;
        lastError = err;
      }
    }
    var message = lastError && lastError.name === 'AbortError'
      ? 'timeout after ' + (TIMEOUT_MS / 1000) + ' s'
      : (lastError && lastError.message ? lastError.message : 'unknown error');
    throw new Error('no EVM endpoint answered (last: ' + lastUrl + ': ' + message + ')');
  }

  function tronTxCount(data) {
    if (typeof data.totalTransactionCount === 'number') return data.totalTransactionCount;
    if (typeof data.transactionCount === 'number') return data.transactionCount;
    var incoming = typeof data.transactions_in === 'number' ? data.transactions_in : null;
    var outgoing = typeof data.transactions_out === 'number' ? data.transactions_out : null;
    if (incoming !== null || outgoing !== null) return (incoming || 0) + (outgoing || 0);
    return null;
  }

  function rawTronBalance(raw) {
    /* Keep the sun value as a string: JSON.parse would round past 2^53. */
    var match = /"balance"\s*:\s*"?(\d+)"?/.exec(raw);
    return match ? BigInt(match[1]) : 0n;
  }

  async function fetchTron(address, signal) {
    var response = await fetchWithTimeout('https://apilist.tronscanapi.com/api/account?address=' + encodeURIComponent(address), null, signal);
    if (response.status === 404) return '0 TRX · account not activated';
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var raw = await response.text();
    var data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error('unexpected response');
    }
    if (!data || typeof data !== 'object') throw new Error('unexpected response');
    var text = formatUnits6(rawTronBalance(raw), 1000000n) + ' TRX';
    var txs = tronTxCount(data);
    if (txs !== null) text += ' · ' + txs + ' tx';
    return text;
  }

  async function checkRow(row, generation, signal) {
    var badge = row.querySelector('.key-balance');
    var id = row.getAttribute('data-id');
    var address = row.getAttribute('data-address');
    if (!badge || !address || generation !== state.generation) return;
    if (id === 'solana') {
      setBalance(badge, 'muted', 'no provider in v1');
      return;
    }
    if (id.indexOf('ltc_') === 0 || id.indexOf('doge_') === 0 ||
        id.indexOf('bch_') === 0 || id.indexOf('xrp_') === 0) {
      setBalance(badge, 'muted', 'no provider in v1');
      return;
    }
    setBalance(badge, 'loading', 'checking…');
    try {
      var result;
      if (id.indexOf('btc_') === 0) result = await fetchBtc(address, signal);
      else if (id === 'evm') result = await fetchEvm(address, signal);
      else if (id === 'tron') result = await fetchTron(address, signal);
      else throw new Error('no provider in v1');
      if (generation !== state.generation || signal.aborted) return;
      if (result && result.summary) state.balances[id] = result.summary;
      setBalance(badge, 'ok', typeof result === 'string' ? result : result.text);
      if (result && result.summary) renderBalanceCards();
    } catch (err) {
      if (generation !== state.generation || signal.aborted) return;
      var message = err && err.name === 'AbortError'
        ? 'timeout after ' + (TIMEOUT_MS / 1000) + ' s'
        : (err && err.message ? err.message : 'unknown error');
      setBalance(badge, 'err', 'lookup failed: ' + message);
    }
  }

  async function checkBalances() {
    if (state.checking || !state.report || !onlineToggle.checked) return;
    var rows = Array.prototype.filter.call(rowsEl.children, function (row) {
      return !row.classList.contains('hidden');
    });
    if (!rows.length) return;
    var generation = state.generation;
    var controllers = [];
    state.checking = true;
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking…';
    try {
      await Promise.all(rows.map(function (row) {
        var controller = new AbortController();
        controllers.push(controller);
        state.controllers.push(controller);
        return checkRow(row, generation, controller.signal).catch(function () { /* per-row failures render inline */ });
      }));
    } finally {
      controllers.forEach(function (controller) {
        var index = state.controllers.indexOf(controller);
        if (index >= 0) state.controllers.splice(index, 1);
      });
      state.checking = false;
      checkBtn.textContent = 'Check balances';
      checkBtn.disabled = !onlineToggle.checked || !state.report;
    }
  }

  /* -------------------------------------------------------------- exposure */

  function hideExposureStatus() {
    if (!exposureStatus) return;
    exposureStatus.textContent = '';
    exposureStatus.className = 'key-exposure-status';
    exposureStatus.hidden = true;
  }

  function showExposureStatus(message, kind) {
    if (!exposureStatus) return;
    exposureStatus.textContent = message;
    exposureStatus.className = 'key-exposure-status' + (kind ? ' ' + kind : '');
    exposureStatus.hidden = false;
  }

  function cancelExposure(clearStatus) {
    if (state.exposureTimer !== null) {
      window.clearTimeout(state.exposureTimer);
      state.exposureTimer = null;
    }
    if (state.exposureController) {
      try { state.exposureController.abort(); } catch (err) { /* already aborted */ }
      state.exposureController = null;
    }
    if (clearStatus) hideExposureStatus();
  }

  function exposureChain(id) {
    if (id === 'evm' || id === 'tron' || id === 'solana') return id;
    if (typeof id === 'string' && id.indexOf('btc_') === 0) return 'btc';
    return null;
  }

  function exposureAddresses(report) {
    var rows = report && Array.isArray(report.addresses) ? report.addresses : [];
    var seen = {};
    var out = [];
    rows.forEach(function (row) {
      if (!row || typeof row.address !== 'string' || !row.address) return;
      var chain = exposureChain(row.id);
      if (!chain) return;
      var key = chain + ':' + row.address;
      if (seen[key]) return;
      seen[key] = true;
      out.push({ chain: chain, address: row.address });
    });
    return out;
  }

  function scheduleExposure(report, auto) {
    if (!report) return;
    var generation = state.generation;
    if (auto) {
      /* One request per key: the URL key derives once even if the page is
       * re-rendered by later interaction. */
      if (state.urlExposurePosted || state.exposurePostedGeneration === generation) return;
      state.urlExposurePosted = true;
    } else {
      if (!exposureToggle || !exposureToggle.checked) return;
      /* One request per derive: re-checking the box for the same report does
       * not send a second list. */
      if (state.exposurePostedGeneration === generation) return;
    }
    state.exposurePostedGeneration = generation;
    cancelExposure(false);
    hideExposureStatus();
    state.exposureTimer = window.setTimeout(function () {
      state.exposureTimer = null;
      postExposure(report, generation, auto);
    }, 350);
  }

  async function postExposure(report, generation, auto) {
    if (generation !== state.generation || (!auto && !exposureToggle.checked)) return;
    var addresses = exposureAddresses(report).slice(0, 50);
    if (!addresses.length) return;

    var controller = new AbortController();
    state.exposureController = controller;
    var timer = window.setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    showExposureStatus('Checking ' + addresses.length + ' address(es) against the Rotor registry…', '');
    try {
      var response = await fetch('/api/v1/monitor/exposure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: addresses }),
        signal: controller.signal
      });
      var data = null;
      try { data = await response.json(); } catch (err) { data = null; }
      if (generation !== state.generation) return;
      if (!response.ok) {
        throw new Error(data && data.error ? data.error : 'HTTP ' + response.status);
      }
      var matched = data && typeof data.matched === 'number' ? data.matched : 0;
      showExposureStatus(matched + ' registered address(es) matched; their owners were warned.', 'ok');
    } catch (err) {
      if (generation !== state.generation || (!auto && !exposureToggle.checked)) return;
      if (err && err.name === 'AbortError') {
        showExposureStatus('Exposure check timed out.', 'err');
        return;
      }
      showExposureStatus('Exposure check failed: ' +
        (err && err.message ? err.message : 'unknown error'), 'err');
    } finally {
      window.clearTimeout(timer);
      if (state.exposureController === controller) state.exposureController = null;
    }
  }


  var PLOT_WIDTH = 360;
  var PLOT_HEIGHT = 260;
  var PLOT_BOX = { left: 36, right: 18, top: 14, bottom: 28 };

  function plotDomains(kind) {
    if (kind === 'secp') {
      return { x0: -2.2, x1: 3.4, y0: -7, y1: 7, xticks: [-2, -1, 0, 1, 2, 3], yticks: [-6, -4, -2, 0, 2, 4, 6] };
    }
    return { x0: -1.15, x1: 1.15, y0: -1.15, y1: 1.15, xticks: [-1, 0, 1], yticks: [-1, 0, 1] };
  }

  function plotMapper(dom) {
    var width = PLOT_WIDTH - PLOT_BOX.left - PLOT_BOX.right;
    var height = PLOT_HEIGHT - PLOT_BOX.top - PLOT_BOX.bottom;
    var sx = width / (dom.x1 - dom.x0);
    var sy = height / (dom.y1 - dom.y0);
    return function (x, y) {
      return [PLOT_BOX.left + (x - dom.x0) * sx, PLOT_BOX.top + (dom.y1 - y) * sy];
    };
  }

  function curveDomain(kind) {
    if (kind === 'secp') return [-Math.cbrt(7), 3.4];
    return [-1, 1];
  }

  function curveY(kind, x) {
    if (kind === 'secp') return Math.sqrt(Math.max(0, x * x * x + 7));
    var d = -121665 / 121666;
    return Math.sqrt(Math.max(0, (1 - x * x) / (1 - d * x * x)));
  }

  function curvePath(kind, sign, map) {
    var range = curveDomain(kind);
    var steps = 140;
    var parts = [];
    for (var i = 0; i <= steps; i++) {
      var x = range[0] + (range[1] - range[0]) * (i / steps);
      var point = map(x, sign * curveY(kind, x));
      parts.push((i === 0 ? 'M' : 'L') + point[0].toFixed(1) + ' ' + point[1].toFixed(1));
    }
    return parts.join(' ');
  }

  function gridMarkup(dom, map) {
    var parts = [];
    var left = PLOT_BOX.left;
    var right = PLOT_WIDTH - PLOT_BOX.right;
    var top = PLOT_BOX.top;
    var bottom = PLOT_HEIGHT - PLOT_BOX.bottom;
    dom.xticks.forEach(function (tick) {
      var p = map(tick, 0);
      parts.push('<line class="key-gridline" x1="' + p[0].toFixed(1) + '" y1="' + top + '" x2="' + p[0].toFixed(1) + '" y2="' + bottom + '"></line>');
      parts.push('<text x="' + p[0].toFixed(1) + '" y="' + (bottom + 13) + '" text-anchor="middle">' + tick + '</text>');
    });
    dom.yticks.forEach(function (tick) {
      var p = map(0, tick);
      parts.push('<line class="key-gridline" x1="' + left + '" y1="' + p[1].toFixed(1) + '" x2="' + right + '" y2="' + p[1].toFixed(1) + '"></line>');
      parts.push('<text x="' + (left - 6) + '" y="' + (p[1] + 3).toFixed(1) + '" text-anchor="end">' + tick + '</text>');
    });
    var origin = map(0, 0);
    parts.push('<line class="key-axis" x1="' + left + '" y1="' + origin[1].toFixed(1) + '" x2="' + right + '" y2="' + origin[1].toFixed(1) + '"></line>');
    parts.push('<line class="key-axis" x1="' + origin[0].toFixed(1) + '" y1="' + top + '" x2="' + origin[0].toFixed(1) + '" y2="' + bottom + '"></line>');
    return parts.join('');
  }

  function coord(value) {
    return (Math.round(value * 1000) / 1000).toString();
  }

  function renderCurve() {
    var kind = Number(curveSelect.value) === 0 ? 'secp' : 'ed';
    var dom = plotDomains(kind);
    var map = plotMapper(dom);
    var range = curveDomain(kind);
    var max = Number(slider.max) || 100;
    var value = Math.min(Math.max(1, Number(slider.value) || 1), max);
    var t = (value - 1) / (max - 1);
    var markerX = range[0] + (range[1] - range[0]) * t;
    var markerY = curveY(kind, markerX);
    var marker = map(markerX, markerY);

    var parts = ['<svg viewBox="0 0 ' + PLOT_WIDTH + ' ' + PLOT_HEIGHT + '" role="img" aria-label="' +
      (kind === 'secp' ? 'secp256k1' : 'ed25519') + ' curve illustration">'];
    parts.push(gridMarkup(dom, map));
    parts.push('<path class="key-curve" d="' + curvePath(kind, 1, map) + '"></path>');
    parts.push('<path class="key-curve" d="' + curvePath(kind, -1, map) + '"></path>');
    parts.push('<circle class="key-marker-ring" cx="' + marker[0].toFixed(1) + '" cy="' + marker[1].toFixed(1) + '" r="8"></circle>');
    parts.push('<circle class="key-marker" cx="' + marker[0].toFixed(1) + '" cy="' + marker[1].toFixed(1) + '" r="4.5"></circle>');
    parts.push('</svg>');
    plotEl.innerHTML = parts.join('');

    var equation = kind === 'secp'
      ? 'y² = x³ + 7'
      : 'x² + y² = 1 + d x²y², d = −121665/121666';
    caption.textContent = 'Real-valued illustration: the ' + (kind === 'secp' ? 'secp256k1' : 'ed25519') +
      ' shape (' + equation + '), highlighted point x = ' + coord(markerX) + ', y = ' + coord(markerY) +
      '. Actual key arithmetic is over a finite field, not over the reals.';
  }

  /* -------------------------------------------------------------- URL key */
  /* A key in the path is already exposed to the browser history and any
   * server logs, so derive it on load and run the registry check without an
   * opt-in. Only the derived addresses leave this page. */
  function initUrlKey() {
    var match = URL_KEY_RE.exec(window.location.pathname);
    if (!match) return;
    state.urlKey = match[1].toLowerCase();
    input.value = state.urlKey;
    var curveParam = new URLSearchParams(window.location.search).get('curve');
    curveSelect.value = curveParam === 'ed25519' ? '1' : '0';
    renderCurve();
    if (urlNotice) urlNotice.hidden = false;
    deriveFromInput();
  }

  /* ------------------------------------------------------------------ events */

  byId('key-form').addEventListener('submit', function (event) {
    event.preventDefault();
    deriveFromInput();
  });

  randomBtn.addEventListener('click', randomKey);
  stepDownBtn.addEventListener('click', function () { stepKey(-1); });
  stepUpBtn.addEventListener('click', function () { stepKey(1); });
  clearBtn.addEventListener('click', clearKey);

  curveSelect.addEventListener('change', function () {
    renderCurve();
    if (input.value.trim()) {
      /* Re-parse the current field so an edited but unsubmitted key is not
       * silently replaced by the last derived one. */
      deriveFromInput();
      return;
    }
    state.keyBytes = null;
    hideError();
    clearResults();
  });

  presetButtons.forEach(function (button) {
    button.addEventListener('click', function () { selectPreset(button); });
  });

  chainButtons.forEach(function (button) {
    button.addEventListener('click', function () { selectChain(button); });
  });

  var curveChoices = Array.prototype.slice.call(document.querySelectorAll('[data-curve-choice]'));
  function syncCurveChoices() {
    curveChoices.forEach(function (button) {
      var active = button.getAttribute('data-curve-choice') === curveSelect.value;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  curveChoices.forEach(function (button) {
    button.addEventListener('click', function () {
      if (curveSelect.value === button.getAttribute('data-curve-choice')) return;
      curveSelect.value = button.getAttribute('data-curve-choice');
      syncCurveChoices();
      curveSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  curveSelect.addEventListener('change', syncCurveChoices);
  syncCurveChoices();

  var presetSelect = byId('preset-select');
  if (presetSelect) {
    presetSelect.addEventListener('change', function () {
      var target = presetButtons.filter(function (button) {
        return button.getAttribute('data-preset') === presetSelect.value;
      })[0];
      if (target) selectPreset(target);
    });
  }

  (function focusRequestedType() {
    var type = new URLSearchParams(window.location.search).get('type');
    if (!type) return;
    var chain = {
      legacy: 'btc', segwit: 'btc', script: 'btc', taproot: 'btc',
      evm: 'evm', tron: 'tron', solana: 'solana',
      ltc_p2pkh: 'ltc', ltc_p2wpkh: 'ltc', ltc_p2sh_p2wpkh: 'ltc',
      doge_p2pkh: 'doge', bch_legacy: 'bch', xrp_classic: 'xrp'
    }[type];
    if (!chain) return;
    var button = chainButtons.filter(function (item) { return item.getAttribute('data-chain') === chain; })[0];
    if (button) selectChain(button);
  })();

  pathChips.forEach(function (chip) {
    chip.addEventListener('click', function () { focusTarget(chip.getAttribute('data-row')); });
  });

  typeTiles.forEach(function (tile) {
    tile.addEventListener('click', function () { focusTarget(tile.getAttribute('data-row')); });
  });

  onlineToggle.addEventListener('change', function () {
    if (!onlineToggle.checked) cancelBalances();
    resetBalanceBadges();
    checkBtn.textContent = 'Check balances';
    checkBtn.disabled = !onlineToggle.checked || !state.report;
  });

  checkBtn.addEventListener('click', checkBalances);

  if (exposureToggle) {
    exposureToggle.addEventListener('change', function () {
      if (!exposureToggle.checked) {
        cancelExposure(true);
        return;
      }
      if (state.report) scheduleExposure(state.report, false);
    });
  }

  slider.addEventListener('input', renderCurve);

  window.addEventListener('pagehide', function () {
    cancelBalances();
    cancelExposure(false);
    input.value = '';
    state.keyBytes = null;
    state.report = null;
  });

  summaryPlaceholder();
  rowsPlaceholder();
  renderCurve();
  initUrlKey();
})();
