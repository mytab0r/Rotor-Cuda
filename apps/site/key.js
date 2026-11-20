/* Private-key explorer. Runs entirely in the browser; no build step, no deps.
 * The key stays in memory only: no URL, no storage, no console output. */
(function () {
  'use strict';

  var WASM_URL = '/rotor_wasm.wasm';
  var TIMEOUT_MS = 8000;
  var URL_KEY_RE = /^\/key\/([0-9a-fA-F]{64})$/;
  var URL_WIF_RE = /^\/key\/([5KLQT][1-9A-HJ-NP-Za-km-z]{50,51})$/;
  var EVM_RPC_URLS = [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://1rpc.io/eth'
  ];
  var SECP_N = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;
  var WEI = 1000000000000000000n;
  var WEI_PER_MICRO = 1000000000000n;
  var DECODER = new TextDecoder('utf-8');
  var cacheApi = window.RotorBalanceCache || null;
  var cacheStore = cacheApi ? cacheApi.createStore() : Promise.resolve(null);
  var BALANCE_LIMIT = 4;

  /* One EVM account, eight networks. Every row carries the same address; the
   * balance is read from each network's public RPC, never assumed. */
  var EVM_CHAINS = {
    evm: { slug: 'ethereum', label: 'Ethereum', symbol: 'ETH', explorer: 'https://etherscan.io/address/' },
    evm_bnb: { slug: 'bnb', label: 'BNB Chain', symbol: 'BNB', rpc: 'https://bsc-rpc.publicnode.com', explorer: 'https://bscscan.com/address/' },
    evm_arbitrum: { slug: 'arbitrum', label: 'Arbitrum', symbol: 'ETH', rpc: 'https://arbitrum-one-rpc.publicnode.com', explorer: 'https://arbiscan.io/address/' },
    evm_optimism: { slug: 'optimism', label: 'Optimism', symbol: 'ETH', rpc: 'https://optimism-rpc.publicnode.com', explorer: 'https://optimistic.etherscan.io/address/' },
    evm_base: { slug: 'base', label: 'Base', symbol: 'ETH', rpc: 'https://base-rpc.publicnode.com', explorer: 'https://basescan.org/address/' },
    evm_polygon: { slug: 'polygon', label: 'Polygon', symbol: 'POL', rpc: 'https://polygon-bor-rpc.publicnode.com', explorer: 'https://polygonscan.com/address/' },
    evm_avalanche: { slug: 'avalanche', label: 'Avalanche', symbol: 'AVAX', rpc: 'https://avalanche-c-chain-rpc.publicnode.com', explorer: 'https://snowtrace.io/address/' },
    evm_zksync: { slug: 'zksync', label: 'zkSync Era', symbol: 'ETH', rpc: 'https://mainnet.era.zksync.io', explorer: 'https://explorer.zksync.io/address/' }
  };
  var EVM_IDS = Object.keys(EVM_CHAINS);

  var PRESETS = {
    all: null,
    ledger: ['btc_p2pkh', 'btc_p2pkh_uncompressed', 'btc_p2sh_p2wpkh', 'btc_p2wpkh', 'btc_p2tr'],
    metamask: EVM_IDS.slice(),
    safepal: ['btc_p2pkh', 'btc_p2pkh_uncompressed', 'btc_p2sh_p2wpkh', 'btc_p2wpkh', 'btc_p2tr'].concat(EVM_IDS, ['tron', 'ltc_p2pkh', 'ltc_p2sh_p2wpkh', 'ltc_p2wpkh', 'doge_p2pkh', 'bch_legacy', 'xrp_classic']),
    tronlink: ['tron'],
    phantom: ['solana']
  };

  /* Primary preset path shown in the derivation row. The page takes a final
   * key, so these labels never change what is derived. */
  var DERIVATION_PATHS = {
    all: "m/44'/0'/0'/0/0",
    ledger: "m/84'/0'/0'/0/0",
    metamask: "m/44'/60'/0'/0/0",
    safepal: "m/44'/0'/0'/0/0",
    tronlink: "m/44'/195'/0'/0/0",
    phantom: "m/501'/0'/0'/0'"
  };
  var DERIVATION_PATH_RE = /^m(?:\/\d+['hH]?)+$/;
  var DERIVATION_PATH_HINT = 'Informational: this page derives addresses from the final key, not from this path.';

  var ID_LABELS = {
    btc_p2pkh: 'Bitcoin legacy (compressed)',
    btc_p2pkh_uncompressed: 'Bitcoin legacy (uncompressed)',
    btc_p2sh_p2wpkh: 'Bitcoin P2SH-P2WPKH',
    btc_p2wpkh: 'Bitcoin native segwit',
    btc_p2tr: 'Bitcoin taproot',
    evm: 'Ethereum',
    evm_bnb: 'BNB Chain',
    evm_arbitrum: 'Arbitrum',
    evm_optimism: 'Optimism',
    evm_base: 'Base',
    evm_polygon: 'Polygon',
    evm_avalanche: 'Avalanche',
    evm_zksync: 'zkSync Era',
    tron: 'TRON',
    solana: 'Solana (ed25519)',
    ltc_p2pkh: 'Litecoin legacy (compressed)',
    ltc_p2sh_p2wpkh: 'Litecoin P2SH-P2WPKH',
    ltc_p2wpkh: 'Litecoin native segwit',
    doge_p2pkh: 'Dogecoin legacy (compressed)',
    bch_legacy: 'Bitcoin Cash legacy (compressed)',
    bch_cashaddr: 'Bitcoin Cash CashAddr (compressed)',
    doge_p2pkh_uncompressed: 'Dogecoin legacy (uncompressed)',
    zcash_p2pkh_uncompressed: 'Zcash transparent (uncompressed)',
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
    bch_cashaddr: 'hash160 of the compressed public key behind the CashAddr version byte 0x00, base32 with the BCH checksum under the "bitcoincash" prefix.',
    doge_p2pkh_uncompressed: 'hash160 of the uncompressed (65-byte) public key with Dogecoin version byte 0x1e, base58check-encoded.',
    zcash_p2pkh_uncompressed: 'hash160 of the uncompressed (65-byte) public key with the two-byte Zcash version 0x1cb8, base58check-encoded.',
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
    bch_cashaddr: "CashAddr · m/44'/145'/0'/0/0",
    doge_p2pkh_uncompressed: "P2PKH (uncompressed) · m/44'/3'/0'/0/0",
    zcash_p2pkh_uncompressed: "P2PKH (uncompressed) · m/44'/133'/0'/0/0",
    xrp_classic: "XRP · m/44'/144'/0'/0/0"
  };
  EVM_IDS.forEach(function (id) {
    PATHS[id] = PATHS.evm;
  });

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
    bch_cashaddr: ['pubkey', 'hash160', 'cashaddr'],
    doge_p2pkh_uncompressed: ['pubkey', 'hash160', 'base58'],
    zcash_p2pkh_uncompressed: ['pubkey', 'hash160', 'base58'],
    xrp_classic: ['pubkey', 'hash160', 'payload', 'checksum', 'base58']
  };

  var STEP_LABELS = {
    pubkey: 'public key',
    hash160: 'hash160 (SHA-256 → RIPEMD-160)',
    payload: 'prefixed payload',
    checksum: 'check bytes',
    base58: 'Base58Check',
    cashaddr: 'CashAddr',
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
    cached: {},
    balanceBusy: false,
    checking: false,
    status: 'idle',
    detected: null,
    deriveSeq: 0,
    debounceTimer: null,
    generation: 0,
    controllers: [],
    exposureTimer: null,
    exposureController: null,
    exposurePostedGeneration: -1,
    urlKey: null,
    urlExposurePosted: false,
    wifNetwork: null
  };

  var AUTO_DERIVE_MS = 200;

  function byId(id) { return document.getElementById(id); }

  var input = byId('priv');
  var curveSelect = byId('curve');
  var randomBtn = byId('random-btn');
  var stepDownBtn = byId('step-down');
  var stepUpBtn = byId('step-up');
  var stepGroup = byId('step-group');
  var clearBtn = byId('clear-btn');
  var statusEl = byId('key-status');
  var statusTextEl = byId('key-status-text');
  var summaryEl = byId('summary');
  var summaryCard = byId('summary-card');
  var keyStats = byId('key-stats');
  var statTotal = byId('stat-total');
  var statHasBalance = byId('stat-has-balance');
  var statActive = byId('stat-active');
  var statChecked = byId('stat-checked');
  var copyAllBtn = byId('copy-all-rows');
  var csvBtn = byId('csv-rows');
  var exportStatus = byId('key-export-status');
  var addressesCard = byId('addresses-card');
  var rowsEl = byId('addr-rows');
  var presetEmpty = byId('preset-empty');
  var evmSharedNote = byId('evm-shared-note');
  var plotEl = byId('curve-plot');
  var slider = byId('curve-slider');
  var caption = byId('curve-caption');
  var derivePathInput = byId('derivation-path');
  var derivePathHint = byId('derivation-path-hint');
  var copyPathBtn = byId('copy-derivation-path');
  var presetButtons = Array.prototype.slice.call(document.querySelectorAll('.key-preset-chips button'));
  var chainButtons = Array.prototype.slice.call(document.querySelectorAll('.key-chain'));
  var pathChips = Array.prototype.slice.call(document.querySelectorAll('.key-path-chip'));
  var typeTiles = Array.prototype.slice.call(document.querySelectorAll('.address-type-card'));
  var btcPanel = byId('btc-panel');
  var btcBalancePanel = byId('btc-balance-panel');
  var btcSelected = byId('btc-selected');
  var btcBalance = byId('btc-balance');
  var btcReceived = byId('btc-received');
  var btcTx = byId('btc-tx');
  var btcHint = byId('btc-summary-hint');
  var balanceRefreshButton = byId('key-balance-refresh');
  var balanceRefreshCount = byId('key-balance-refresh-count');
  var balanceRefreshStatus = byId('key-balance-refresh-status');
  var exposureToggle = byId('exposure-toggle');
  var exposureStatus = byId('exposure-status');
  var urlNotice = byId('key-url-notice');

  /* ------------------------------------------------------------ key parsing */

  function showError(message) {
    setStatus('invalid', 'Invalid key — ' + message);
  }

  /* -------------------------------------------------- input format detection */
  /* Recognises complete and in-progress input without deriving anything.
   * Order preserves the old page: exactly 64 hex characters win over decimal,
   * and every other plain number is decimal. Any other text is a brainwallet
   * phrase. The hint never includes the key itself. */
  var WIF_RE = /^[5KLQT][1-9A-HJ-NP-Za-km-z]{50,51}$/;
  var WIF_PARTIAL_RE = /^[5KLQT][1-9A-HJ-NP-Za-km-z]{8,49}$/;
  var WIF_NETWORK_LABELS = { bitcoin: 'Bitcoin', litecoin: 'Litecoin', dogecoin: 'Dogecoin' };

  function detectFormat(raw) {
    var value = String(raw == null ? '' : raw).trim();
    if (!value) return { kind: 'empty' };
    if (value.charAt(0) === '[') {
      var closed = /\]\s*$/.test(value);
      if (!/^\[[\d,\s]*\]?\s*$/.test(value)) {
        return { kind: 'keypair', error: 'Keypair JSON must be a flat array of byte values 0–255.' };
      }
      if (!closed) return { kind: 'keypair', incomplete: true };
      var parsed;
      try {
        parsed = JSON.parse(value);
      } catch (err) {
        parsed = null;
      }
      if (!Array.isArray(parsed) || (parsed.length !== 32 && parsed.length !== 64) ||
          !parsed.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 255; })) {
        return { kind: 'keypair', error: 'Keypair must be a JSON array of 32 (seed) or 64 (secret key) byte values 0–255.' };
      }
      return { kind: 'keypair', bytes: parsed };
    }
    if (value.slice(0, 2).toLowerCase() === '0x') {
      var hex = value.slice(2);
      if (!/^[0-9a-fA-F]*$/.test(hex)) {
        return { kind: 'hex', error: 'A 0x key may only contain hex digits 0-9 and a-f.' };
      }
      if (hex.length === 64) return { kind: 'hex', length: 64 };
      return {
        kind: 'hex',
        incomplete: hex.length < 64,
        length: hex.length,
        error: hex.length > 64 ? 'Hex keys are exactly 64 characters (you have ' + hex.length + ').' : null
      };
    }
    if (/^[0-9a-fA-F]{64}$/.test(value)) return { kind: 'hex', length: 64 };
    if (/^[0-9]+$/.test(value)) return { kind: 'decimal', length: value.length };
    if (/^[0-9a-fA-F]+$/.test(value)) {
      return {
        kind: 'hex',
        incomplete: value.length < 64,
        length: value.length,
        error: value.length > 64 ? 'Hex keys are exactly 64 characters (you have ' + value.length + ').' : null
      };
    }
    if (WIF_RE.test(value)) return { kind: 'wif', length: value.length };
    if (WIF_PARTIAL_RE.test(value)) return { kind: 'wif', incomplete: true, length: value.length };
    var tools = window.RotorKeyTools;
    if (tools && typeof tools.looksLikeXrpSecret === 'function' && tools.looksLikeXrpSecret(value)) {
      return { kind: 'xrp', length: value.length };
    }
    return { kind: 'brainwallet', length: value.length };
  }

  function formatHint(detected) {
    if (!detected) return '';
    if (detected.kind === 'hex') {
      return detected.length === 64 ? '64-character hex key'
        : 'hex key (' + detected.length + '/64 characters)';
    }
    if (detected.kind === 'wif') {
      return detected.incomplete ? 'WIF (' + detected.length + ' characters so far)'
        : 'WIF (secp256k1)';
    }
    if (detected.kind === 'decimal') return 'decimal integer';
    if (detected.kind === 'xrp') return 'XRP secret (secp256k1)';
    if (detected.kind === 'keypair') {
      var size = detected.bytes && detected.bytes.length === 64 ? '64-byte secret key; first 32 bytes used' : '32-byte seed';
      return 'Solana keypair (' + size + ') — ed25519';
    }
    if (detected.kind === 'brainwallet') return 'brainwallet phrase — key = SHA-256 of the trimmed text';
    return '';
  }

  function setStatus(kind, message) {
    state.status = kind;
    if (statusEl) {
      statusEl.className = 'key-input-status is-' + kind;
      statusEl.setAttribute('aria-live', kind === 'invalid' ? 'assertive' : 'polite');
    }
    if (statusTextEl) statusTextEl.textContent = message;
    var form = byId('key-form');
    if (form) form.setAttribute('aria-busy', kind === 'deriving' ? 'true' : 'false');
    if (!input) return;
    if (kind === 'invalid') input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function updateInputState() {
    var detected = detectFormat(input.value);
    state.detected = detected;
    if (detected.kind === 'empty') {
      return detected;
    }
    if (detected.error) {
      showError(detected.error);
      return detected;
    }
    var label = formatHint(detected);
    setStatus('typing', detected.incomplete
      ? 'Detected: ' + label + ' — keep typing'
      : 'Detected: ' + label);
    return detected;
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

  async function sha256(bytes) {
    var digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
  }

  async function sha512(bytes) {
    var digest = await window.crypto.subtle.digest('SHA-512', bytes);
    return new Uint8Array(digest);
  }

  async function secpPublicKey(bytes) {
    var wasm = await loadWasm();
    var report = deriveReport(wasm, bytes, 0);
    return hexToBytes(report.pubkey_compressed);
  }

  function keyHashFns() {
    return { sha256: sha256, doubleSha256: doubleSha256, sha512: sha512, secpPublicKey: secpPublicKey };
  }

  async function parseKey(raw, curve) {
    var text = raw.trim();
    if (!text) throw new Error('Enter a private key.');
    var detected = detectFormat(text);
    if (detected.kind === 'empty') throw new Error('Enter a private key.');
    if (detected.error) throw new Error(detected.error);
    if (detected.incomplete) throw new Error('The key is incomplete — keep typing or press Enter to derive.');
    var tools = window.RotorKeyTools;
    if (!tools || typeof tools.resolveKeyInput !== 'function') {
      throw new Error('Key support did not load (/key-tools.js).');
    }
    var parsed = await tools.resolveKeyInput(text, keyHashFns());

    if (parsed.format === 'wif' && curve !== 0) {
      throw new Error('A WIF encodes a secp256k1 key; switch the curve to secp256k1.');
    }
    if (parsed.format === 'xrp' && curve !== 0) {
      throw new Error('An XRP secret encodes a secp256k1 key; switch the curve to secp256k1.');
    }
    if (parsed.format === 'keypair' && curve !== 1) {
      throw new Error('A Solana keypair is an ed25519 seed; switch the curve to ed25519.');
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
    randomBtn.disabled = busy;
    stepDownBtn.disabled = busy;
    stepUpBtn.disabled = busy;
    clearBtn.disabled = busy;
  }

  function syncStepGroup(visible) {
    if (stepGroup) stepGroup.hidden = !visible;
  }

  function cancelDebounce() {
    if (state.debounceTimer !== null) {
      window.clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }
  }

  function scheduleDerive() {
    cancelDebounce();
    state.debounceTimer = window.setTimeout(function () {
      state.debounceTimer = null;
      deriveFromInput();
    }, AUTO_DERIVE_MS);
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
    if (summaryCard) summaryCard.hidden = true;
    if (addressesCard) addressesCard.hidden = true;
    if (keyStats) keyStats.hidden = true;
    setExportStatus('');
    state.report = null;
    state.focusId = null;
    if (evmSharedNote) evmSharedNote.hidden = true;
    summaryPlaceholder();
    rowsPlaceholder();
    updateChainAvailability([], null);
    syncSelection(false, false);
    syncBitcoinPanel();
    syncStepGroup(false);
    presetEmpty.hidden = true;
  }

  function updateDerivedStatus() {
    var count = rowsEl.querySelectorAll('.key-row').length;
    var network = state.wifNetwork && WIF_NETWORK_LABELS[state.wifNetwork];
    setStatus('derived', 'Derived ' + count + ' address row' + (count === 1 ? '' : 's') +
      ' from a ' + formatHint(detectFormat(input.value)) +
      (network ? ' (' + network + ' network)' : '') + '.');
  }

  async function runDerive(bytes, curve, seq) {
    cancelBalances();
    setBusy(true);
    setStatus('deriving', 'Deriving addresses…');
    try {
      var wasm = await loadWasm();
      if (seq !== state.deriveSeq) return;
      var report = deriveReport(wasm, bytes, curve);
      if (seq !== state.deriveSeq) return;
      await renderReport(report);
      if (seq !== state.deriveSeq) return;
      updateDerivedStatus();
      syncStepGroup(true);
    } catch (err) {
      if (seq !== state.deriveSeq) return;
      clearResults();
      showError(err && err.message ? err.message : String(err));
    } finally {
      if (seq === state.deriveSeq) setBusy(false);
    }
  }

  async function deriveFromInput() {
    cancelDebounce();
    var detected = updateInputState();
    var seq = ++state.deriveSeq;
    if (detected.kind === 'empty') {
      state.keyBytes = null;
      state.wifNetwork = null;
      setBusy(false);
      clearResults();
      setStatus('idle', 'Paste a key to derive automatically.');
      return;
    }
    if (detected.incomplete) {
      state.keyBytes = null;
      state.wifNetwork = null;
      setBusy(false);
      clearResults();
      setStatus('typing', 'Detected: ' + formatHint(detected) + ' — keep typing');
      return;
    }
    if (detected.error) {
      state.keyBytes = null;
      state.wifNetwork = null;
      setBusy(false);
      clearResults();
      showError(detected.error);
      return;
    }
    var curve = Number(curveSelect.value);
    if (detected.kind === 'keypair' && curve !== 1) {
      /* A Solana keypair is an ed25519 seed; follow the detected format. */
      curveSelect.value = '1';
      syncCurveChoices();
      renderCurve();
      curve = 1;
    }
    var parsed;
    try {
      parsed = await parseKey(input.value, curve);
    } catch (err) {
      if (seq !== state.deriveSeq) return;
      state.keyBytes = null;
      clearResults();
      showError(err && err.message ? err.message : String(err));
      return;
    }
    if (seq !== state.deriveSeq) return;
    state.keyBytes = parsed.bytes;
    state.wifNetwork = parsed.network || null;
    await runDerive(parsed.bytes, curve, seq);
  }

  function randomKey() {
    cancelDebounce();
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
    var seq = ++state.deriveSeq;
    input.value = bytesToHex(bytes);
    state.keyBytes = bytes;
    state.wifNetwork = null;
    updateInputState();
    runDerive(bytes, curve, seq);
  }

  async function stepKey(delta) {
    cancelDebounce();
    var seq = ++state.deriveSeq;
    var curve = Number(curveSelect.value);
    var parsed;
    try {
      parsed = await parseKey(input.value, curve);
    } catch (err) {
      if (seq !== state.deriveSeq) return;
      showError(err && err.message ? err.message : String(err));
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
    state.wifNetwork = null;
    updateInputState();
    await runDerive(bytes, curve, seq);
  }

  function clearKey() {
    cancelDebounce();
    cancelPlannedDerive();
    setBusy(false);
    input.value = '';
    state.keyBytes = null;
    state.wifNetwork = null;
    state.detected = null;
    clearResults();
    setStatus('idle', 'Paste a key to derive automatically.');
    input.focus();
  }

  function cancelPlannedDerive() {
    state.deriveSeq += 1;
  }

  /* ---------------------------------------------------------------- results */

  async function renderReport(report) {
    state.report = report;
    state.balances = {};
    setExportStatus('');
    await renderSummary(report);
    if (summaryCard) summaryCard.hidden = false;
    if (addressesCard) addressesCard.hidden = false;
    attachComputedTypes(report);
    renderAddresses(report);
    attachTon(report);
    if (state.urlKey && !state.urlExposurePosted) scheduleExposure(report, true);
    else hideExposureStatus();
    checkVisibleBalances();
  }

  function doubleSha256(bytes) {
    if (!(window.crypto && window.crypto.subtle)) {
      return Promise.reject(new Error('The XRP checksum needs SHA-256 (a secure context: https or localhost).'));
    }
    return sha256(bytes).then(function (first) {
      return sha256(first);
    });
  }

  function summaryFields(report) {
    return {
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
      var entityHref = field[0].indexOf('WIF') === 0 ? '/key/wif' : field[0] === 'Hex' ? '/key/hex' : '';
      if (entityHref) {
        var entityLink = document.createElement('a');
        entityLink.href = entityHref;
        entityLink.textContent = field[0];
        entityLink.title = 'Open the ' + field[0].toLowerCase() + ' calculator';
        dt.appendChild(entityLink);
      } else {
        dt.textContent = field[0];
      }
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

  function keyFactsGroup(facts) {
    var group = document.createElement('section');
    group.className = 'key-summary-group key-facts-group';
    var heading = document.createElement('h3');
    heading.className = 'key-group-title';
    heading.textContent = 'Key facts';
    group.appendChild(heading);

    var dl = document.createElement('dl');
    dl.className = 'key-form-list';
    facts.forEach(function (fact) {
      if (!fact || !fact.label) return;
      var row = document.createElement('div');
      row.className = 'key-form-row';
      row.setAttribute('data-fact', fact.id || '');
      var dt = document.createElement('dt');
      if (fact.href) {
        var labelLink = document.createElement('a');
        labelLink.href = fact.href;
        labelLink.textContent = fact.label;
        labelLink.title = 'Open the ' + fact.label.toLowerCase() + ' calculator';
        dt.appendChild(labelLink);
      } else {
        dt.textContent = fact.label;
      }
      var dd = document.createElement('dd');
      dd.className = 'mono';
      if (fact.unavailable) {
        dd.className = 'key-fact-unavailable';
        dd.textContent = 'Not available — ' + fact.unavailable;
      } else if (fact.valueHref) {
        var valueLink = document.createElement('a');
        valueLink.href = fact.valueHref;
        valueLink.textContent = fact.value;
        dd.appendChild(valueLink);
      } else {
        dd.textContent = fact.value;
      }
      row.appendChild(dt);
      row.appendChild(dd);
      if (fact.unavailable) {
        var spacer = document.createElement('span');
        spacer.className = 'key-copy-spacer';
        row.appendChild(spacer);
      } else {
        var copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'key-copy key-copy-sm';
        copy.textContent = 'Copy';
        copy.setAttribute('aria-label', 'Copy ' + fact.label + ' value');
        copy.addEventListener('click', function () { copyText(fact.value, copy); });
        row.appendChild(copy);
      }
      dl.appendChild(row);
    });
    group.appendChild(dl);
    return group;
  }

  async function renderSummary(report) {
    var helper = window.RotorKeyTools;
    var facts;
    if (helper && typeof helper.buildKeyFacts === 'function') {
      facts = await helper.buildKeyFacts(report, doubleSha256);
    } else {
      facts = [{
        id: 'error',
        label: 'Key facts',
        unavailable: 'The key-facts helper (/key-tools.js) did not load.'
      }];
    }
    if (keyStats) keyStats.hidden = false;
    summaryEl.textContent = '';
    var fields = summaryFields(report);
    var grid = document.createElement('div');
    grid.className = 'key-summary-grid';
    grid.appendChild(keyFactsGroup(facts));
    grid.appendChild(summaryGroup('Public point', fields.point));
    summaryEl.appendChild(grid);
    updateCounters();
  }

  /* Public display rows: the single EVM account is shown once per network so
   * every chain keeps its own explorer and balance, all with the same address. */
  function displayAddresses(report) {
    var addresses = Array.isArray(report.addresses) ? report.addresses : [];
    var out = [];
    addresses.forEach(function (addr) {
      if (!addr || !addr.id || !addr.address) return;
      if (addr.id === 'evm') {
        EVM_IDS.forEach(function (id, index) {
          out.push({
            id: id,
            label: EVM_CHAINS[id].label,
            address: addr.address,
            steps: index === 0 ? addr.steps : null,
            sharedEvm: true
          });
        });
        return;
      }
      out.push(addr);
    });
    return out;
  }

  function renderAddresses(report) {
    rowsEl.textContent = '';
    var addresses = displayAddresses(report);
    if (!addresses.length) {
      state.focusId = null;
      if (evmSharedNote) evmSharedNote.hidden = true;
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
      rowsEl.appendChild(buildRow(addr));
    });
    rowsEl.insertBefore(buildTableHead(), rowsEl.firstChild);
    if (evmSharedNote) {
      evmSharedNote.hidden = !addresses.some(function (addr) { return addr.sharedEvm; });
    }
    resetBalanceBadges();
    updateChainAvailability(Array.isArray(report.addresses) ? report.addresses : [], report.curve);
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
      updateDerivedStatus();
    }).catch(function () {
      /* Solana and Sui remain usable without the TON bundle */
    });
  }

  /* CashAddr and the uncompressed Dogecoin/Zcash rows are pure encodings of
   * hash160 values the WASM report already returned, so they are appended
   * synchronously before the rows are rendered. */
  function attachComputedTypes(report) {
    var types = window.RotorAddressCodecs;
    if (!types || typeof types.derive !== 'function') return;
    if (!report || !Array.isArray(report.addresses)) return;
    var derived = types.derive(report);
    Object.keys(derived).forEach(function (id) {
      var row = derived[id];
      if (!row || typeof row.address !== 'string' || !row.address) return;
      var present = report.addresses.some(function (existing) {
        return !!existing && existing.id === id;
      });
      if (!present) report.addresses.push(row);
    });
  }

  function explorerFor(id) {
    if (EVM_CHAINS[id]) return EVM_CHAINS[id].explorer;
    if (typeof id === 'string') {
      if (id.indexOf('btc_') === 0) return 'https://mempool.space/address/';
      if (id.indexOf('ltc_') === 0) return 'https://blockchair.com/litecoin/address/';
      if (id.indexOf('doge_') === 0) return 'https://blockchair.com/dogecoin/address/';
      if (id.indexOf('bch_') === 0) return 'https://blockchair.com/bitcoin-cash/address/';
      if (id.indexOf('zcash_') === 0) return 'https://blockchair.com/zcash/address/';
      if (id.indexOf('xrp_') === 0) return 'https://xrpscan.com/account/';
    }
    var map = {
      evm: 'https://etherscan.io/address/',
      tron: 'https://tronscan.org/#/address/',
      solana: 'https://solscan.io/account/',
      sui: 'https://suiscan.xyz/mainnet/account/',
      ton: 'https://tonviewer.com/'
    };
    return map[id] || '';
  }

  function rowList() {
    return Array.prototype.slice.call(rowsEl.querySelectorAll('.key-row'));
  }

  function svgUse(href, className) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className || 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', href);
    svg.appendChild(use);
    return svg;
  }

  /* Chain identity for one address row: icon id from /icons.svg plus ticker. */
  function chainMeta(id) {
    if (EVM_CHAINS[id]) {
      return { ticker: EVM_CHAINS[id].symbol, icon: 'chain-' + EVM_CHAINS[id].slug };
    }
    var table = {
      btc: { ticker: 'BTC', icon: 'chain-bitcoin' },
      ltc: { ticker: 'LTC', icon: 'chain-litecoin' },
      doge: { ticker: 'DOGE', icon: 'chain-dogecoin' },
      bch: { ticker: 'BCH', icon: 'chain-bitcoin-cash' },
      zcash: { ticker: 'ZEC', icon: 'chain-zcash' },
      xrp: { ticker: 'XRP', icon: 'chain-xrp' },
      solana: { ticker: 'SOL', icon: 'chain-solana' },
      sui: { ticker: 'SUI', icon: 'chain-sui' },
      ton: { ticker: 'TON', icon: 'chain-ton' },
      tron: { ticker: 'TRX', icon: 'chain-tron' }
    };
    var prefix = String(id).split('_')[0];
    return table[id] || table[prefix] || { ticker: String(id).toUpperCase(), icon: 'ui-blockchain' };
  }

  var TYPE_LABELS = {
    btc_p2pkh: 'Legacy',
    btc_p2pkh_uncompressed: 'Legacy (u)',
    btc_p2sh_p2wpkh: 'Nested SegWit',
    btc_p2wpkh: 'SegWit',
    btc_p2tr: 'Taproot',
    ltc_p2pkh: 'Legacy',
    ltc_p2sh_p2wpkh: 'Nested SegWit',
    ltc_p2wpkh: 'SegWit',
    doge_p2pkh: 'Legacy',
    doge_p2pkh_uncompressed: 'Legacy (u)',
    bch_legacy: 'Legacy',
    bch_cashaddr: 'CashAddr',
    zcash_p2pkh: 'Transparent',
    zcash_p2pkh_uncompressed: 'Transparent (u)',
    xrp_classic: 'Classic',
    tron: 'Base58',
    solana: 'ed25519',
    sui: 'Account',
    ton: 'v4R2'
  };

  function typeLabel(id) {
    if (EVM_CHAINS[id]) return 'EIP-55';
    return TYPE_LABELS[id] || String(id).replace(/_/g, ' ');
  }

  function pathLabel(id) {
    var path = PATHS[id];
    if (!path) return '';
    var split = path.indexOf(' · ');
    return split >= 0 ? path.slice(split + 3) : path;
  }

  function buildTableHead() {
    var head = document.createElement('div');
    head.className = 'key-table-head';
    head.setAttribute('aria-hidden', 'true');
    [
      ['Chain', 'key-cell-chain'],
      ['Type', 'key-cell-type'],
      ['Path', 'key-cell-path'],
      ['Address', 'key-cell-addr'],
      ['Status', 'key-cell-status'],
      ['', 'key-cell-act']
    ].forEach(function (entry) {
      var cell = document.createElement('span');
      cell.className = 'key-cell ' + entry[1];
      cell.textContent = entry[0];
      head.appendChild(cell);
    });
    return head;
  }

  function copyIconText(text, button, label) {
    writeClipboard(text, function done() {
      var use = button.querySelector('use');
      if (use) use.setAttribute('href', '/icons.svg#ui-check');
      button.classList.add('is-copied');
      button.setAttribute('aria-label', label + ' copied');
      button.setAttribute('title', label + ' copied');
      button.disabled = true;
      window.setTimeout(function () {
        if (use) use.setAttribute('href', '/icons.svg#ui-copy');
        button.classList.remove('is-copied');
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
        button.disabled = false;
      }, 1200);
    });
  }

  function setRowDetails(row, open) {
    var details = row.querySelector('.key-details');
    var toggle = row.querySelector('.key-details-toggle');
    if (!details) return;
    details.hidden = !open;
    if (!toggle) return;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.classList.toggle('is-open', open);
    var name = toggle.getAttribute('data-name') || 'address';
    toggle.setAttribute('aria-label', (open ? 'Hide' : 'Show') + ' details for ' + name);
    toggle.setAttribute('title', (open ? 'Hide' : 'Show') + ' details for ' + name);
  }

  function buildRow(addr) {
    var row = document.createElement('div');
    row.className = 'key-row';
    row.setAttribute('data-id', addr.id);
    row.setAttribute('data-address', addr.address);

    var main = document.createElement('div');
    main.className = 'key-row-main';

    var chain = chainMeta(addr.id);
    var chainCell = document.createElement('span');
    chainCell.className = 'key-cell key-cell-chain';
    var chainLabel = document.createElement('span');
    chainLabel.className = 'visually-hidden';
    chainLabel.textContent = 'Chain: ';
    chainCell.appendChild(chainLabel);
    var chainId = document.createElement('span');
    chainId.className = 'key-chain-id';
    chainId.appendChild(svgUse('/icons.svg#' + chain.icon, 'key-chain-icon'));
    var ticker = document.createElement('span');
    ticker.className = 'key-chain-ticker';
    ticker.textContent = chain.ticker;
    chainId.appendChild(ticker);
    chainCell.appendChild(chainId);
    main.appendChild(chainCell);

    var name = addr.label || ID_LABELS[addr.id] || addr.id;
    var typeCell = document.createElement('span');
    typeCell.className = 'key-cell key-cell-type';
    var typeText = document.createElement('span');
    typeText.className = 'key-format-text';
    typeText.textContent = typeLabel(addr.id);
    typeCell.appendChild(typeText);
    var title = document.createElement('span');
    title.className = 'key-row-title visually-hidden';
    title.textContent = name;
    typeCell.appendChild(title);
    main.appendChild(typeCell);

    var pathCell = document.createElement('span');
    pathCell.className = 'key-cell key-cell-path mono';
    pathCell.textContent = pathLabel(addr.id);
    main.appendChild(pathCell);

    var addrCell = document.createElement('span');
    addrCell.className = 'key-cell key-cell-addr';
    var addrLabel = document.createElement('span');
    addrLabel.className = 'visually-hidden';
    addrLabel.textContent = 'Address: ';
    addrCell.appendChild(addrLabel);
    var code = document.createElement('code');
    code.className = 'mono key-addr';
    code.textContent = addr.address;
    code.title = addr.address;
    addrCell.appendChild(code);
    main.appendChild(addrCell);

    var statusCell = document.createElement('span');
    statusCell.className = 'key-cell key-cell-status';
    var statusLabel = document.createElement('span');
    statusLabel.className = 'visually-hidden';
    statusLabel.textContent = 'Status: ';
    statusCell.appendChild(statusLabel);
    var badge = document.createElement('span');
    badge.className = 'key-balance';
    badge.hidden = true;
    statusCell.appendChild(badge);
    main.appendChild(statusCell);

    var details = document.createElement('div');
    details.className = 'key-details';
    details.id = 'key-details-' + String(addr.id).replace(/[^a-z0-9_-]/gi, '-');
    details.hidden = true;
    var explain = EXPLAIN[addr.id] || (addr.sharedEvm ? EXPLAIN.evm : '');
    if (explain) {
      var sentence = document.createElement('p');
      sentence.className = 'muted key-explain';
      sentence.textContent = explain;
      details.appendChild(sentence);
    }
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

    var actions = document.createElement('span');
    actions.className = 'key-cell key-cell-act';
    var explorer = explorerFor(addr.id);
    if (explorer) {
      var ext = document.createElement('a');
      ext.className = 'icon-btn key-row-action';
      ext.href = explorer + encodeURIComponent(addr.address);
      ext.target = '_blank';
      ext.rel = 'noopener noreferrer';
      ext.title = 'Open ' + name + ' in explorer';
      ext.setAttribute('aria-label', 'Open ' + name + ' in explorer');
      ext.appendChild(svgUse('/icons.svg#ui-external'));
      actions.appendChild(ext);
    }
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'icon-btn key-row-action';
    copy.title = 'Copy ' + name + ' address';
    copy.setAttribute('aria-label', 'Copy ' + name + ' address');
    copy.appendChild(svgUse('/icons.svg#ui-copy'));
    copy.addEventListener('click', function () {
      copyIconText(addr.address, copy, 'Copy ' + name + ' address');
    });
    actions.appendChild(copy);
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'icon-btn key-row-action key-details-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', details.id);
    toggle.setAttribute('data-name', name);
    toggle.setAttribute('aria-label', 'Show details for ' + name);
    toggle.title = 'Show details for ' + name;
    toggle.appendChild(svgUse('/icons.svg#ui-chevron'));
    toggle.addEventListener('click', function () {
      setRowDetails(row, details.hidden);
    });
    actions.appendChild(toggle);
    main.appendChild(actions);

    row.appendChild(main);
    row.appendChild(details);
    return row;
  }

  function writeClipboard(text, done) {
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

  function copyText(text, button) {
    var original = button.textContent;
    writeClipboard(text, function done() {
      button.textContent = 'Copied';
      button.disabled = true;
      window.setTimeout(function () {
        button.textContent = original;
        button.disabled = false;
      }, 1200);
    });
  }

  function copyDerivationPath() {
    if (!derivePathInput || !copyPathBtn) return;
    var value = derivePathInput.value.trim();
    if (!value) {
      commitDerivationPath();
      return;
    }
    var use = copyPathBtn.querySelector('use');
    writeClipboard(value, function done() {
      if (use) use.setAttribute('href', '/icons.svg#ui-check');
      copyPathBtn.classList.add('is-copied');
      copyPathBtn.setAttribute('aria-label', 'Derivation path copied');
      copyPathBtn.setAttribute('title', 'Derivation path copied');
      copyPathBtn.disabled = true;
      window.setTimeout(function () {
        if (use) use.setAttribute('href', '/icons.svg#ui-copy');
        copyPathBtn.classList.remove('is-copied');
        copyPathBtn.setAttribute('aria-label', 'Copy derivation path');
        copyPathBtn.setAttribute('title', 'Copy derivation path');
        copyPathBtn.disabled = false;
      }, 1200);
    });
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

  /* ------------------------------------------------- public row export */
  /* Only derived public data leaves the page: label, address, explorer link
   * and the visible balance. Private keys, WIFs and the key facts are never
   * included. */

  function setExportStatus(message) {
    if (exportStatus) exportStatus.textContent = message;
  }

  function visibleRowData() {
    return rowList().filter(function (row) {
      return !row.classList.contains('hidden');
    }).map(function (row) {
      var title = row.querySelector('.key-row-title');
      var address = row.querySelector('.key-addr');
      var badge = row.querySelector('.key-balance');
      var explorer = row.querySelector('.key-cell-act a[target="_blank"]');
      return {
        chain: row.getAttribute('data-id') || '',
        label: title ? title.textContent : '',
        address: address ? address.textContent : (row.getAttribute('data-address') || ''),
        explorer: explorer ? explorer.href : '',
        balance: badge && !badge.hidden ? badge.textContent.trim() : ''
      };
    });
  }

  function copyAllRows() {
    var rows = visibleRowData();
    if (!rows.length) {
      setExportStatus('No public address rows are visible to copy.');
      return;
    }
    var text = rows.map(function (row) {
      return row.label + '\t' + row.address + (row.balance ? '\t' + row.balance : '');
    }).join('\n');
    writeClipboard(text, function done() {
      setExportStatus('Copied ' + rows.length + ' public address row' + (rows.length === 1 ? '' : 's') + '.');
    });
    if (copyAllBtn) {
      var original = copyAllBtn.textContent;
      copyAllBtn.textContent = 'Copied';
      copyAllBtn.disabled = true;
      window.setTimeout(function () {
        copyAllBtn.textContent = original;
        copyAllBtn.disabled = false;
      }, 1200);
    }
  }

  function csvCell(value) {
    var text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function downloadRowsCsv() {
    var rows = visibleRowData();
    if (!rows.length) {
      setExportStatus('No public address rows are visible to export.');
      return;
    }
    var lines = ['chain,label,address,explorer,balance'];
    rows.forEach(function (row) {
      lines.push([row.chain, row.label, row.address, row.explorer, row.balance].map(csvCell).join(','));
    });
    var blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'rotor-key-addresses.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    setExportStatus('CSV with ' + rows.length + ' public address row' + (rows.length === 1 ? '' : 's') + ' downloaded.');
  }

  /* ------------------------------------------------------- filters/selection */

  function btcRowIds() {
    var ids = [];
    rowList().forEach(function (row) {
      var id = row.getAttribute('data-id');
      if (id && id.indexOf('btc_') === 0) ids.push(id);
    });
    return ids;
  }

  function findRow(id) {
    return rowList().filter(function (row) {
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
    rowList().forEach(function (row) {
      var show = rowMatches(row.getAttribute('data-id'));
      row.classList.toggle('hidden', !show);
      if (show) visible++;
    });
    if (visible === 0) presetEmpty.textContent = emptyMessage();
    presetEmpty.hidden = visible > 0;
    updateCounters();
    checkVisibleBalances();
  }

  function clearPathError() {
    if (!derivePathInput) return;
    derivePathInput.removeAttribute('aria-invalid');
    if (!derivePathHint) return;
    derivePathHint.textContent = DERIVATION_PATH_HINT;
    derivePathHint.classList.remove('is-error');
  }

  function commitDerivationPath() {
    if (!derivePathInput) return;
    var value = derivePathInput.value.trim();
    derivePathInput.value = value;
    if (DERIVATION_PATH_RE.test(value)) {
      clearPathError();
      return;
    }
    derivePathInput.setAttribute('aria-invalid', 'true');
    if (derivePathHint) {
      derivePathHint.textContent = "Use a BIP32 path such as m/44'/0'/0'/0/0.";
      derivePathHint.classList.add('is-error');
    }
  }

  function setDerivationPath(preset) {
    if (!derivePathInput) return;
    derivePathInput.value = DERIVATION_PATHS[preset] || DERIVATION_PATHS.all;
    clearPathError();
  }

  function selectPreset(button) {
    state.preset = button.getAttribute('data-preset');
    var presetSelect = byId('preset-select');
    if (presetSelect) presetSelect.value = state.preset;
    presetButtons.forEach(function (other) {
      other.setAttribute('aria-pressed', String(other === button));
    });
    setDerivationPath(state.preset);
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
      var active = tile.getAttribute('data-row') === state.focusId;
      tile.setAttribute('aria-pressed', String(active));
      tile.classList.toggle('active', active);
    });
    rowList().forEach(function (row) {
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
      setRowDetails(row, true);
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
      var presetSelect = byId('preset-select');
      if (presetSelect) presetSelect.value = 'all';
      setDerivationPath('all');
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
      btcHint.textContent = 'Balances load automatically from mempool.space for the selected Bitcoin address.';
    }
  }

  function syncBitcoinPanel() {
    if (!btcPanel) return;
    var hasVisibleBtc = rowList().some(function (row) {
      var id = row.getAttribute('data-id');
      return !!id && id.indexOf('btc_') === 0 && !row.classList.contains('hidden');
    });
    btcPanel.hidden = !hasVisibleBtc;
    if (btcBalancePanel) btcBalancePanel.hidden = !hasVisibleBtc;
    renderBalanceCards();
  }

  /* --------------------------------------------------------------- balances */

  function retryIcon() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/icons.svg#ui-retry');
    svg.appendChild(use);
    return svg;
  }

  function setBalance(badge, kind, text, onRetry, age) {
    badge.hidden = false;
    badge.className = 'key-balance' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
    badge.textContent = text;
    badge.title = text;
    badge.removeAttribute('aria-label');
    if (age) {
      var ageEl = document.createElement('span');
      ageEl.className = 'balance-age';
      ageEl.textContent = age;
      badge.appendChild(ageEl);
    }
    if (onRetry) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'key-balance-retry';
      button.title = 'Retry this balance';
      button.setAttribute('aria-label', 'Retry balance check for this address');
      button.appendChild(retryIcon());
      button.addEventListener('click', onRetry);
      badge.appendChild(button);
    }
  }

  function setNoProvider(badge) {
    setBalance(badge, 'muted', '—');
    badge.title = 'No balance provider for this chain yet';
    badge.setAttribute('aria-label', 'No balance provider for this chain yet');
  }

  function resetBalanceBadges() {
    Array.prototype.forEach.call(rowsEl.querySelectorAll('.key-balance'), function (badge) {
      badge.textContent = '';
      badge.className = 'key-balance';
      badge.title = '';
      badge.hidden = true;
    });
    rowList().forEach(function (row) {
      delete row.dataset.balanceState;
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
      summary: { balanceSat: sats, receivedSat: funded, txs: txs, amount: sats, chain: 'btc', symbol: 'BTC' }
    };
  }

  async function evmBatch(address, url, signal, chain) {
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
    var wei = BigInt(balance.result);
    var text = formatEth(wei) + ' ' + chain.symbol;
    var nonce = byId[2];
    if (nonce && typeof nonce.result === 'string') text += ' · nonce ' + BigInt(nonce.result).toString();
    return {
      text: text,
      summary: { amount: wei, chain: chain.slug, symbol: chain.symbol }
    };
  }

  async function fetchEvm(address, signal, id) {
    var chain = EVM_CHAINS[id] || EVM_CHAINS.evm;
    /* Ethereum keeps the endpoint fallback; every other network has one
     * public endpoint mapped to it. */
    var urls = id === 'evm' ? EVM_RPC_URLS : [chain.rpc];
    var lastError = null;
    var lastUrl = '';
    for (var i = 0; i < urls.length; i++) {
      var url = urls[i];
      try {
        return await evmBatch(address, url, signal, chain);
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
    throw new Error('no ' + chain.label + ' endpoint answered (last: ' + lastUrl + ': ' + message + ')');
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
    if (response.status === 404) {
      return {
        text: '0 TRX · account not activated',
        summary: { amount: 0n, chain: 'tron', symbol: 'TRX' }
      };
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var raw = await response.text();
    var data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error('unexpected response');
    }
    if (!data || typeof data !== 'object') throw new Error('unexpected response');
    var sun = rawTronBalance(raw);
    var text = formatUnits6(sun, 1000000n) + ' TRX';
    var txs = tronTxCount(data);
    if (txs !== null) text += ' · ' + txs + ' tx';
    return {
      text: text,
      summary: { amount: sun, chain: 'tron', symbol: 'TRX' }
    };
  }

  /* Rows whose identifiers have a working public provider. Kept in one place
   * so the counters and the checks agree on what "N" means. */
  function rowHasProvider(id) {
    if (!id) return false;
    if (id === 'solana' || id === 'sui' || id === 'ton') return false;
    if (id.indexOf('ltc_') === 0 || id.indexOf('doge_') === 0 ||
        id.indexOf('bch_') === 0 || id.indexOf('xrp_') === 0) return false;
    return id.indexOf('btc_') === 0 || !!EVM_CHAINS[id] || id === 'tron';
  }

  function updateCounters() {
    if (!keyStats || !state.report) return;
    var entries = [];
    rowList().forEach(function (row) {
      var id = row.getAttribute('data-id');
      if (!id) return;
      var summary = state.balances[id];
      entries.push({
        address: row.getAttribute('data-address'),
        chain: summary && summary.chain,
        amount: summary && summary.amount,
        state: row.dataset.balanceState || '',
        checkable: rowHasProvider(id),
        visible: !row.classList.contains('hidden')
      });
    });
    var helper = window.RotorKeyTools;
    var counters = helper && typeof helper.balanceCounters === 'function'
      ? helper.balanceCounters(entries)
      : { withBalance: 0, activeChains: 0, checked: 0, total: 0 };
    if (statTotal) {
      statTotal.textContent = '—';
      statTotal.classList.add('empty');
    }
    if (statHasBalance) statHasBalance.textContent = String(counters.withBalance);
    if (statActive) statActive.textContent = String(counters.activeChains);
    if (statChecked) statChecked.textContent = counters.checked + '/' + counters.total;
  }

  function rowCacheInfo(row) {
    var id = row.getAttribute('data-id');
    var address = row.getAttribute('data-address');
    if (!id || !address) return null;
    var provider = null;
    var chain = null;
    if (id.indexOf('btc_') === 0) {
      provider = 'mempool';
      chain = 'bitcoin';
    } else if (EVM_CHAINS[id]) {
      provider = 'evm';
      chain = EVM_CHAINS[id].slug;
    } else if (id === 'tron') {
      provider = 'tronscan';
      chain = 'tron';
    } else {
      return null;
    }
    return {
      provider: provider,
      chain: chain,
      address: address,
      key: cacheApi
        ? cacheApi.cacheKey(provider, chain, address)
        : provider + '|' + chain + '|' + address
    };
  }

  async function cacheGet(key) {
    if (!cacheApi) return null;
    var store = await cacheStore;
    if (!store) return null;
    try { return await store.get(key); } catch (err) { return null; }
  }

  async function cachePut(key, entry) {
    if (!cacheApi) return;
    var store = await cacheStore;
    if (!store) return;
    try { await store.put(key, entry); } catch (err) { /* memory store fallback */ }
  }

  function cachedSummary(value) {
    var summary = value && value.summary;
    if (!summary) return null;
    try {
      return {
        balanceSat: BigInt(String(summary.balanceSat || '0')),
        receivedSat: BigInt(String(summary.receivedSat || '0')),
        txs: Number(summary.txs || 0)
      };
    } catch (err) {
      return null;
    }
  }

  function serializeResult(result) {
    var value = { text: typeof result === 'string' ? result : (result && result.text ? result.text : '') };
    if (result && result.summary) {
      value.summary = {
        balanceSat: String(result.summary.balanceSat),
        receivedSat: String(result.summary.receivedSat),
        txs: Number(result.summary.txs)
      };
    }
    return value;
  }

  function renderCachedRow(row, entry, now) {
    var badge = row.querySelector('.key-balance');
    var info = rowCacheInfo(row);
    if (!badge || !info) return false;
    var value = entry.value || {};
    if (!value.text) return false;
    var summary = cachedSummary(value);
    if (summary) state.balances[row.getAttribute('data-id')] = summary;
    row.dataset.balanceState = 'ok';
    row.dataset.balanceAt = String(entry.fetchedAt || '');
    setBalance(badge, 'ok', value.text, null, cacheApi ? cacheApi.ageLabel(entry, now) : '');
    if (summary) renderBalanceCards();
    return true;
  }

  function keyPendingCount() {
    var now = Date.now();
    var count = 0;
    rowList().forEach(function (row) {
      if (row.classList.contains('hidden')) return;
      var stateName = row.dataset.balanceState;
      if (stateName === 'off' || stateName === 'loading') return;
      var info = rowCacheInfo(row);
      if (!info) return;
      if (stateName === 'err') {
        count += 1;
        return;
      }
      if (!cacheApi) {
        count += 1;
        return;
      }
      if (cacheApi.shouldRefresh(state.cached[info.key], info.provider, now)) count += 1;
    });
    return count;
  }

  function updateKeyRefreshButton() {
    var count = keyPendingCount();
    if (balanceRefreshCount) balanceRefreshCount.textContent = String(count);
    if (balanceRefreshButton) {
      balanceRefreshButton.disabled = count === 0 || state.balanceBusy;
      balanceRefreshButton.setAttribute(
        'aria-label',
        'Refresh ' + count + ' failed or stale ' + (count === 1 ? 'balance' : 'balances')
      );
      balanceRefreshButton.classList.toggle('busy', Boolean(state.balanceBusy));
    }
    if (balanceRefreshStatus) {
      balanceRefreshStatus.textContent = count
        ? count + ' ' + (count === 1 ? 'balance needs' : 'balances need') + ' refresh'
        : 'All visible balances are fresh';
    }
  }

  async function checkRow(row, generation, signal) {
    var badge = row.querySelector('.key-balance');
    var id = row.getAttribute('data-id');
    var address = row.getAttribute('data-address');
    if (!badge || !address || generation !== state.generation) return;
    if (!rowHasProvider(id)) {
      row.dataset.balanceState = 'off';
      setNoProvider(badge);
      updateCounters();
      return;
    }
    var info = rowCacheInfo(row);
    row.dataset.balanceState = 'loading';
    setBalance(badge, 'loading', 'checking…');
    updateCounters();
    var request = async function () {
      if (id.indexOf('btc_') === 0) return fetchBtc(address, signal);
      if (EVM_CHAINS[id]) return fetchEvm(address, signal, id);
      if (id === 'tron') return fetchTron(address, signal);
      throw new Error('no provider in v1');
    };
    try {
      var result = cacheApi
        ? await cacheApi.withRetry(request, { attempts: 2, baseDelay: 600, maxDelay: 4000 })
        : await request();
      if (generation !== state.generation || signal.aborted) return;
      if (result && result.summary) state.balances[id] = result.summary;
      row.dataset.balanceState = 'ok';
      var value = serializeResult(result);
      var entry = null;
      if (cacheApi && info) {
        entry = cacheApi.makeEntry(value, info.provider, Date.now());
        state.cached[info.key] = entry;
        await cachePut(info.key, entry);
      }
      setBalance(badge, 'ok', value.text, null, entry ? cacheApi.ageLabel(entry, Date.now()) : '');
      if (result && result.summary) renderBalanceCards();
      updateCounters();
      updateKeyRefreshButton();
    } catch (err) {
      if (generation !== state.generation || signal.aborted) return;
      var message = err && err.name === 'AbortError'
        ? 'timeout after ' + (TIMEOUT_MS / 1000) + ' s'
        : (err && err.message ? err.message : 'unknown error');
      row.dataset.balanceState = 'err';
      setBalance(badge, 'err', 'lookup failed: ' + message, function () {
        checkVisibleBalances({ onlyRows: [row] });
      });
      updateCounters();
      updateKeyRefreshButton();
    }
  }

  async function checkVisibleBalances(options) {
    var opts = options || {};
    if (!state.report) return;
    if (state.checking && !opts.onlyRows) return;
    rowList().forEach(function (row) {
      if (row.classList.contains('hidden') || rowCacheInfo(row)) return;
      var badge = row.querySelector('.key-balance');
      if (!badge) return;
      row.dataset.balanceState = 'off';
      setNoProvider(badge);
    });
    var only = opts.onlyRows && opts.onlyRows.length ? opts.onlyRows : null;
    var candidates = rowList().filter(function (row) {
      if (row.classList.contains('hidden')) return false;
      if (only && only.indexOf(row) < 0) return false;
      var stateName = row.dataset.balanceState;
      if (stateName === 'loading' || stateName === 'off') return false;
      if (!rowCacheInfo(row)) return false;
      if (!only && !opts.force && (stateName === 'ok' || stateName === 'err')) return false;
      return true;
    });
    if (!candidates.length) {
      updateKeyRefreshButton();
      return;
    }
    var generation = state.generation;
    if (cacheApi) {
      await Promise.all(candidates.map(async function (row) {
        var info = rowCacheInfo(row);
        try {
          var entry = await cacheGet(info.key);
          if (entry) state.cached[info.key] = entry;
        } catch (err) { /* miss */ }
      }));
    }
    if (generation !== state.generation) return;
    var now = Date.now();
    candidates.forEach(function (row) {
      var info = rowCacheInfo(row);
      var entry = state.cached[info.key];
      if (cacheApi && cacheApi.isSuccess(entry)) renderCachedRow(row, entry, now);
    });
    updateCounters();
    updateKeyRefreshButton();
    var pending = candidates.filter(function (row) {
      if (only) return true;
      var info = rowCacheInfo(row);
      if (row.dataset.balanceState === 'err') return true;
      if (cacheApi) return cacheApi.shouldRefresh(state.cached[info.key], info.provider, Date.now());
      return true;
    });
    if (!pending.length) {
      updateKeyRefreshButton();
      return;
    }
    var controllers = [];
    state.checking = true;
    state.balanceBusy = true;
    updateKeyRefreshButton();
    var limit = cacheApi
      ? cacheApi.createLimiter(BALANCE_LIMIT)
      : function (task) { return task(); };
    await Promise.all(pending.map(function (row) {
      return limit(function () {
        if (generation !== state.generation) return;
        var controller = new AbortController();
        controllers.push(controller);
        state.controllers.push(controller);
        return checkRow(row, generation, controller.signal).catch(function () {
          /* per-row failures render inline */
        }).finally(function () {
          var index = state.controllers.indexOf(controller);
          if (index >= 0) state.controllers.splice(index, 1);
        });
      });
    }));
    state.checking = false;
    state.balanceBusy = false;
    updateKeyRefreshButton();
    /* A filter change during the check may reveal rows that were skipped. */
    if (!only && generation === state.generation) checkVisibleBalances();
  }

  if (balanceRefreshButton) {
    balanceRefreshButton.addEventListener('click', function () {
      checkVisibleBalances({ force: true });
    });
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
      showExposureStatus(matched > 0 ? matched + ' registered address(es) matched; their owners were warned.' : 'No registered address matched.', 'ok');
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

    caption.textContent = 'Real-valued view; keys use finite-field math.';
  }

  /* -------------------------------------------------------------- URL key */
  /* A key in the path is already exposed to the browser history and any
   * server logs, so derive it on load and run the registry check without an
   * opt-in. Only the derived addresses leave this page. */
  function initUrlKey() {
    var match = URL_KEY_RE.exec(window.location.pathname);
    var wifMatch = match ? null : URL_WIF_RE.exec(window.location.pathname);
    if (!match && !wifMatch) return;
    state.urlKey = match ? match[1].toLowerCase() : wifMatch[1];
    input.value = state.urlKey;
    var params = new URLSearchParams(window.location.search);
    var curveParam = params.get('curve');
    var chainParam = params.get('chain');
    curveSelect.value = (curveParam === 'ed25519' || (chainParam && ED25519_CHAINS[chainParam])) ? '1' : '0';
    syncCurveChoices();
    renderCurve();
    if (urlNotice) urlNotice.hidden = false;
    deriveFromInput();
  }

  /* ------------------------------------------------------------------ events */

  byId('key-form').addEventListener('submit', function (event) {
    event.preventDefault();
    deriveFromInput();
  });

  input.addEventListener('input', function () {
    var detected = updateInputState();
    if (detected.kind === 'empty' || detected.incomplete || detected.error) {
      cancelDebounce();
      cancelPlannedDerive();
      setBusy(false);
      state.keyBytes = null;
      state.wifNetwork = null;
      clearResults();
      if (detected.kind === 'empty') setStatus('idle', 'Paste a key to derive automatically.');
      return;
    }
    /* Drop any in-flight result for the previous text before waiting. */
    cancelPlannedDerive();
    scheduleDerive();
  });

  input.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    cancelDebounce();
    deriveFromInput();
  });

  randomBtn.addEventListener('click', randomKey);
  stepDownBtn.addEventListener('click', function () { stepKey(-1); });
  stepUpBtn.addEventListener('click', function () { stepKey(1); });
  clearBtn.addEventListener('click', clearKey);
  if (copyAllBtn) copyAllBtn.addEventListener('click', copyAllRows);
  if (csvBtn) csvBtn.addEventListener('click', downloadRowsCsv);

  curveSelect.addEventListener('change', function () {
    renderCurve();
    if (input.value.trim()) {
      /* Re-parse the current field so an edited but unsubmitted key is not
       * silently replaced by the last derived one. */
      cancelDebounce();
      deriveFromInput();
      return;
    }
    cancelDebounce();
    cancelPlannedDerive();
    setBusy(false);
    state.keyBytes = null;
    state.wifNetwork = null;
    clearResults();
    setStatus('idle', 'Paste a key to derive automatically.');
  });

  presetButtons.forEach(function (button) {
    button.addEventListener('click', function () { selectPreset(button); });
  });

  if (copyPathBtn) {
    copyPathBtn.addEventListener('click', copyDerivationPath);
  }

  if (derivePathInput) {
    derivePathInput.addEventListener('blur', commitDerivationPath);
    derivePathInput.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      commitDerivationPath();
    });
    derivePathInput.addEventListener('input', function () {
      if (derivePathInput.getAttribute('aria-invalid') === 'true') clearPathError();
    });
  }

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

  /* Per-chain generator entry points reuse this page: ?chain=<slug> (or a
   * legacy ?type=<row>) preselects the chain filter and, for ed25519 chains,
   * the curve. The derivation itself is unchanged. */
  var CHAIN_PRESETS = {
    bitcoin: 'btc', btc: 'btc',
    ethereum: 'evm', evm: 'evm', bnb: 'evm', arbitrum: 'evm', optimism: 'evm',
    base: 'evm', polygon: 'evm', avalanche: 'evm', zksync: 'evm',
    solana: 'solana', tron: 'tron', xrp: 'xrp',
    litecoin: 'ltc', ltc: 'ltc',
    'bitcoin-cash': 'bch', bch: 'bch',
    dogecoin: 'doge', doge: 'doge',
    zcash: 'zcash', sui: 'sui', ton: 'ton'
  };
  var TYPE_ROWS = {
    legacy: ['btc', 'btc_p2pkh'],
    segwit: ['btc', 'btc_p2wpkh'],
    script: ['btc', 'btc_p2sh_p2wpkh'],
    taproot: ['btc', 'btc_p2tr'],
    evm: ['evm', 'evm'],
    tron: ['tron', 'tron'],
    solana: ['solana', 'solana'],
    ltc_p2pkh: ['ltc', 'ltc_p2pkh'],
    ltc_p2wpkh: ['ltc', 'ltc_p2wpkh'],
    ltc_p2sh_p2wpkh: ['ltc', 'ltc_p2sh_p2wpkh'],
    doge_p2pkh: ['doge', 'doge_p2pkh'],
    bch_legacy: ['bch', 'bch_legacy'],
    xrp_classic: ['xrp', 'xrp_classic'],
    zcash_p2pkh: ['zcash', 'zcash_p2pkh'],
    sui: ['sui', 'sui'],
    ton: ['ton', 'ton']
  };
  var ED25519_CHAINS = { solana: true, sui: true, ton: true };

  (function applyQueryPreset() {
    var params = new URLSearchParams(window.location.search);
    var chainParam = params.get('chain');
    var typeParam = params.get('type');
    var curveParam = params.get('curve');
    var chainId = chainParam
      ? (CHAIN_PRESETS[chainParam] || (CHAIN_PREFIXES[chainParam] ? chainParam : null))
      : null;
    var row = typeParam ? TYPE_ROWS[typeParam] : null;
    if (row && !chainId) chainId = row[0];
    var wantsEd25519 = curveParam === 'ed25519' ||
      (chainId && ED25519_CHAINS[chainId]) ||
      (chainParam && ED25519_CHAINS[chainParam]);
    if (wantsEd25519 && curveSelect.value !== '1') {
      curveSelect.value = '1';
      syncCurveChoices();
    }
    if (chainId) {
      var button = chainButtons.filter(function (item) { return item.getAttribute('data-chain') === chainId; })[0];
      if (button) selectChain(button);
    }
    if (row && row[1]) focusTarget(row[1]);
  })();

  pathChips.forEach(function (chip) {
    chip.addEventListener('click', function () { focusTarget(chip.getAttribute('data-row')); });
  });

  typeTiles.forEach(function (tile) {
    tile.addEventListener('click', function () { focusTarget(tile.getAttribute('data-row')); });
  });

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
    cancelDebounce();
    cancelPlannedDerive();
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
