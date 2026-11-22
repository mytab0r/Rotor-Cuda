/* Private-key explorer. Runs entirely in the browser; no build step, no deps.
 * The key stays in memory only: no URL, no storage, no console output. */
(function () {
  'use strict';

  /* Chain identity and public providers come from data/*.json through the
   * generated globals in chains.generated.js (loaded before this script). */
  var SSOT_ROOT = typeof window !== 'undefined' ? window : globalThis;
  var SSOT_CHAINS = SSOT_ROOT.RotorChains;
  var SSOT_PROVIDERS = SSOT_ROOT.RotorProviders;

  var WASM_URL = typeof window !== 'undefined' && window.RotorAssets
    ? window.RotorAssets.url('/rotor_wasm.wasm')
    : '/rotor_wasm.wasm';
  var TIMEOUT_MS = 8000;
  var EVM_RPC_URLS = SSOT_PROVIDERS.byChain.ethereum.map(function (provider) {
    return provider.url;
  });

  /* One provider by id, or the canonical ordered list. Single-provider chains
   * keep their historical endpoint; Polygon and Optimism carry the full
   * publicnode + dRPC fallback list from data/providers.json. */
  function evmRpcUrls(slug, full) {
    var list = SSOT_PROVIDERS.byChain[slug] || [];
    if (full) return list.map(function (provider) { return provider.url; });
    var preferred = SSOT_PROVIDERS.find(slug, 'publicnode') || list[0];
    return preferred ? [preferred.url] : [];
  }
  var SECP_N = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;
  var WEI = 1000000000000000000n;
  var WEI_PER_MICRO = 1000000000000n;
  var DECODER = new TextDecoder('utf-8');
  var cacheApi = window.RotorBalanceCache || null;
  var cacheStore = cacheApi ? cacheApi.createStore() : Promise.resolve(null);
  var BALANCE_LIMIT = 4;
  /* One public ticker request per six hours; the entry lives in localStorage. */
  var PRICE_CACHE_KEY = 'rotor.prices.v1';
  var PRICE_TTL_MS = 6 * 60 * 60 * 1000;

  /* One EVM account, eight networks. Every row carries the same address; the
   * balance is read from each network's public RPC, never assumed. Explorers
   * and providers come from data/chains.json and data/providers.json. */
  var EVM_CHAINS = {
    evm: { slug: 'ethereum', label: 'Ethereum', symbol: 'ETH', explorer: SSOT_CHAINS.bySlug.ethereum.explorerPrefix },
    evm_bnb: { slug: 'bnb', label: 'BNB Chain', symbol: 'BNB', rpc: evmRpcUrls('bnb'), explorer: SSOT_CHAINS.bySlug.bnb.explorerPrefix },
    evm_arbitrum: { slug: 'arbitrum', label: 'Arbitrum', symbol: 'ETH', rpc: evmRpcUrls('arbitrum'), explorer: SSOT_CHAINS.bySlug.arbitrum.explorerPrefix },
    evm_optimism: { slug: 'optimism', label: 'Optimism', symbol: 'ETH', rpc: evmRpcUrls('optimism', true), explorer: SSOT_CHAINS.bySlug.optimism.explorerPrefix },
    evm_base: { slug: 'base', label: 'Base', symbol: 'ETH', rpc: evmRpcUrls('base'), explorer: SSOT_CHAINS.bySlug.base.explorerPrefix },
    evm_polygon: { slug: 'polygon', label: 'Polygon', symbol: 'POL', rpc: evmRpcUrls('polygon', true), explorer: SSOT_CHAINS.bySlug.polygon.explorerPrefix },
    evm_avalanche: { slug: 'avalanche', label: 'Avalanche', symbol: 'AVAX', rpc: evmRpcUrls('avalanche'), explorer: SSOT_CHAINS.bySlug.avalanche.explorerPrefix },
    evm_zksync: { slug: 'zksync', label: 'zkSync Era', symbol: 'ETH', rpc: evmRpcUrls('zksync'), explorer: SSOT_CHAINS.bySlug.zksync.explorerPrefix }
  };
  var EVM_IDS = Object.keys(EVM_CHAINS);

  /* Donor short names for the eight EVM chain rows. The map keeps each
   * network's real ticker (three of them settle in ETH), while the table
   * names the network itself. */
  var EVM_SHORT = {
    evm: 'ETH',
    evm_bnb: 'BNB',
    evm_arbitrum: 'ARB',
    evm_optimism: 'OP',
    evm_base: 'BASE',
    evm_polygon: 'POL',
    evm_avalanche: 'AVAX',
    evm_zksync: 'zkSync'
  };

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
    ltc_p2tr: 'Litecoin taproot',
    doge_p2pkh: 'Dogecoin legacy (compressed)',
    bch_legacy: 'Bitcoin Cash legacy (compressed)',
    bch_cashaddr: 'Bitcoin Cash CashAddr (compressed)',
    doge_p2pkh_uncompressed: 'Dogecoin legacy (uncompressed)',
    zcash_p2pkh_uncompressed: 'Zcash transparent (uncompressed)',
    xrp_classic: 'XRP classic address',
    zcash_p2pkh: 'Zcash transparent',
    sui: 'Sui account',
    ton: 'TON wallet v4R2',
    ton_w5: 'TON wallet W5'
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
    ton: 'TON wallet: address of the standard v4R2 contract whose StateInit stores this ed25519 public key.',
    ton_w5: 'TON wallet W5: address of the standard wallet_v5 contract whose StateInit stores this ed25519 public key.'
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
    bch_cashaddr: ['pubkey', 'hash160', 'cashaddr'],
    doge_p2pkh_uncompressed: ['pubkey', 'hash160', 'base58'],
    zcash_p2pkh_uncompressed: ['pubkey', 'hash160', 'base58'],
    xrp_classic: ['pubkey', 'hash160', 'payload', 'checksum', 'base58'],
    sui: ['pubkey', 'blake2b'],
    ton_w5: ['pubkey', 'state_init_hash', 'address']
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
    last20: 'last 20 bytes',
    blake2b: 'BLAKE2b-256',
    state_init_hash: 'StateInit hash',
    address: 'address'
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
    secpReport: null,
    edReport: null,
    addressRows: [],
    tonRow: null,
    rangeNote: '',
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
    wifNetwork: null,
    prices: null,
    priceMeta: null,
    priceStatus: 'idle',
    pricePromise: null
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
  var derivePathInput = byId('derivation-path');
  var derivePathHint = byId('derivation-path-hint');
  var copyPathBtn = byId('copy-derivation-path');
  var presetButtons = Array.prototype.slice.call(document.querySelectorAll('.key-preset-chips button'));
  var chainButtons = Array.prototype.slice.call(document.querySelectorAll('.key-chain'));
  var pathChips = Array.prototype.slice.call(document.querySelectorAll('.key-path-chip'));
  var typeTiles = Array.prototype.slice.call(document.querySelectorAll('.address-type-card'));
  var btcPanel = byId('btc-panel');
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
  /* The donor WIF shape, used by all three input contexts: base58, 51-52
   * characters, first character 5/K/L (Bitcoin), T/6 (Litecoin) or Q/6
   * (Dogecoin). Kept identical in key-tools.js and search.js. */
  var WIF_RE = /^[5KLT6Q][1-9A-HJ-NP-Za-km-z]{50,51}$/;
  var WIF_PARTIAL_RE = /^[5KLT6Q][1-9A-HJ-NP-Za-km-z]{8,49}$/;
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
    /* A Solana keypair can also arrive as its 64-byte base58 form. */
    var tools = window.RotorKeyTools;
    if (tools && typeof tools.base58Keypair === 'function' && tools.base58Keypair(value)) {
      return { kind: 'keypair' };
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
      statusEl.title = message;
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
    /* An out-of-range secp256k1 value is not an input error: the page still
     * renders the ed25519 rows and shows a note (see runDerive). */
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
    note.className = 'muted empty-state';
    note.textContent = 'Derive a key to see its numeric forms and public point.';
    summaryEl.appendChild(note);
  }

  function rowsPlaceholder() {
    rowsEl.textContent = '';
    var row = document.createElement('tr');
    var cell = document.createElement('td');
    cell.colSpan = 5;
    var note = document.createElement('div');
    note.className = 'muted empty-state';
    note.textContent = 'Derive a key to see its addresses.';
    cell.appendChild(note);
    row.appendChild(cell);
    rowsEl.appendChild(row);
  }

  function cancelBalances() {
    state.generation += 1;
    state.balances = {};
    state.controllers.forEach(function (controller) {
      try { controller.abort(); } catch (err) { /* already aborted */ }
    });
    state.controllers = [];
    cancelExposure(true);
  }

  function clearResults() {
    cancelBalances();
    if (summaryCard) summaryCard.hidden = true;
    if (addressesCard) addressesCard.hidden = true;
    if (keyStats) keyStats.hidden = true;
    setExportStatus('');
    state.report = null;
    state.secpReport = null;
    state.edReport = null;
    state.addressRows = [];
    state.tonRow = null;
    state.rangeNote = '';
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
    var note = state.rangeNote ? ' ' + state.rangeNote : '';
    setStatus('derived', 'Derived ' + count + ' address row' + (count === 1 ? '' : 's') +
      ' from a ' + formatHint(detectFormat(input.value)) +
      (network ? ' (' + network + ' network)' : '') + '.' + note);
  }

  async function runDerive(bytes, curve, seq) {
    cancelBalances();
    setBusy(true);
    setStatus('deriving', 'Deriving addresses…');
    try {
      var wasm = await loadWasm();
      if (seq !== state.deriveSeq) return;
      /* The donor derives every 32-byte value on both curves: the secp256k1
       * report covers the UTXO/EVM chains and the ed25519 report covers SOL,
       * SUI and the TON wallets. A value at or above the secp256k1 order has
       * no secp report; the ed25519 rows still render and a note explains it. */
      var secpReport = null;
      var rangeNote = '';
      try {
        secpReport = deriveReport(wasm, bytes, 0);
      } catch (err) {
        rangeNote = 'This value is outside the secp256k1 range 1..n-1, so only ' +
          'the ed25519 addresses are shown (' + (err && err.message ? err.message : String(err)) + ').';
      }
      if (seq !== state.deriveSeq) return;
      var edReport = deriveReport(wasm, bytes, 1);
      if (seq !== state.deriveSeq) return;
      state.secpReport = secpReport;
      state.edReport = edReport;
      state.tonRow = null;
      state.rangeNote = secpReport ? '' : rangeNote;
      var primary = curve === 1 || !secpReport ? edReport : secpReport;
      await renderReport(primary);
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
    state.addressRows = mergeAddressRows();
    renderAddresses();
    attachTon();
    var exposureSource = { addresses: state.addressRows };
    if (state.urlKey && !state.urlExposurePosted) scheduleExposure(exposureSource, true);
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

  /* Public-point facts share the Keys grid with the key facts so both
   * columns carry the same number of rows. */
  function pointFacts(report) {
    return [
      { id: 'point-compressed', label: 'Compressed', value: report.pubkey_compressed || '' },
      { id: 'point-uncompressed', label: 'Uncompressed', value: report.pubkey_uncompressed || '' },
      { id: 'point-x', label: 'X', value: report.x || '' },
      { id: 'point-y', label: 'Y', value: report.y || '' },
      { id: 'point-ed25519', label: 'ed25519', value: report.ed_pubkey || '' }
    ].filter(function (fact) { return !!fact.value; });
  }

  /* The directory page number reads as a locale number; the full path stays
   * in the link URL and in the title. */
  function pageFactDisplay(fact) {
    if (!fact || fact.id !== 'page' || !fact.value) return fact;
    var match = String(fact.value).match(/\/(\d+)\/?$/);
    var number = match ? match[1] : '1';
    return {
      id: fact.id,
      label: fact.label,
      value: fact.value,
      valueHref: fact.valueHref || fact.value,
      displayValue: number.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
    };
  }

  function summaryRow(fact) {
    var row = document.createElement('div');
    row.className = 'key-form-row';
    row.setAttribute('data-fact', fact.id || '');
    var dt = document.createElement('dt');
    dt.title = fact.label;
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
      dd.title = dd.textContent;
    } else {
      var code = document.createElement('code');
      code.className = 'mono key-fact-value';
      if (fact.valueHref) {
        var valueLink = document.createElement('a');
        valueLink.href = fact.valueHref;
        valueLink.textContent = fact.displayValue || fact.value;
        valueLink.title = fact.value;
        code.appendChild(valueLink);
      } else {
        code.textContent = fact.displayValue || fact.value;
      }
      dd.appendChild(code);
      dd.title = fact.value;
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
      copy.addEventListener('click', function () {
        copyText(fact.displayValue || fact.value, copy);
      });
      row.appendChild(copy);
    }
    return row;
  }

  function summaryPanel(facts) {
    var panel = document.createElement('div');
    panel.className = 'key-summary-group';
    var dl = document.createElement('dl');
    dl.className = 'key-form-list';
    facts.forEach(function (fact) {
      if (fact && fact.label) dl.appendChild(summaryRow(fact));
    });
    panel.appendChild(dl);
    return panel;
  }

  /* Equal row counts per column; an odd trailing row spans both columns. */
  function summaryGrid(entries) {
    var grid = document.createElement('div');
    grid.className = 'key-summary-grid';
    if (entries.length < 2) {
      grid.appendChild(summaryPanel(entries));
      return grid;
    }
    var half = Math.floor(entries.length / 2);
    grid.appendChild(summaryPanel(entries.slice(0, half)));
    grid.appendChild(summaryPanel(entries.slice(half, half * 2)));
    var tail = entries.slice(half * 2);
    if (tail.length) {
      var wide = summaryPanel(tail);
      wide.classList.add('key-summary-wide');
      grid.appendChild(wide);
    }
    return grid;
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
    var entries = facts.map(pageFactDisplay).concat(pointFacts(report));
    summaryEl.appendChild(summaryGrid(entries));
    updateCounters();
  }

  /* Public display rows: both curves are merged into state.addressRows, the
   * single EVM account becomes the donor's ninth EVM row (a generic 0x parent
   * followed by eight network rows that show the same address as "↑ same"),
   * and chain groups follow the donor order. */
  function displayAddresses() {
    var rows = Array.isArray(state.addressRows) ? state.addressRows : [];
    var helper = window.RotorKeyTools;
    if (helper && typeof helper.expandEvmAddresses === 'function') {
      var networks = EVM_IDS.map(function (id) {
        return { id: id, label: EVM_CHAINS[id].label };
      });
      rows = helper.expandEvmAddresses(rows, networks, 'EVM (shared 0x address)');
    }
    return helper && typeof helper.orderAddressRows === 'function'
      ? helper.orderAddressRows(rows)
      : rows;
  }

  function renderAddresses() {
    rowsEl.textContent = '';
    var addresses = displayAddresses();
    if (!addresses.length) {
      state.focusId = null;
      if (evmSharedNote) evmSharedNote.hidden = true;
      rowsPlaceholder();
      presetEmpty.hidden = true;
      syncSelection(false, false);
      syncBitcoinPanel();
      return;
    }
    addresses.forEach(function (addr) {
      rowsEl.appendChild(buildRow(addr));
    });
    if (evmSharedNote) {
      evmSharedNote.hidden = !addresses.some(function (addr) {
        return addr.sharedEvm || addr.sharedParent;
      });
    }
    resetBalanceBadges();
    updateChainAvailability(addresses, state.report ? state.report.curve : null);
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
      script.src = window.RotorAssets.url('/ton.js');
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

  function attachTon() {
    var report = state.edReport;
    if (!report || !report.ed_pubkey) return;
    if ((state.addressRows || []).some(function (row) { return row.id === 'ton'; })) return;
    loadTon().then(function (ton) {
      return ton.address(report.ed_pubkey);
    }).then(function (address) {
      if (!address || state.edReport !== report) return;
      state.tonRow = { id: 'ton', label: 'TON wallet v4R2', address: address, steps: {}, curve: 'ed25519' };
      state.addressRows = mergeAddressRows();
      renderAddresses();
      updateDerivedStatus();
    }).catch(function () {
      /* Solana, Sui and the W5 row remain usable without the TON bundle */
    });
  }

  /* CashAddr and the uncompressed Dogecoin/Zcash rows are pure encodings of
   * hash160 values the WASM secp report already returned, so they join the
   * merged rows without another derivation. */
  function computedRows(report) {
    var types = window.RotorAddressCodecs;
    if (!types || typeof types.derive !== 'function') return [];
    if (!report || !Array.isArray(report.addresses)) return [];
    var derived = types.derive(report);
    var rows = [];
    Object.keys(derived).forEach(function (id) {
      var row = derived[id];
      if (row && typeof row.address === 'string' && row.address) rows.push(row);
    });
    return rows;
  }

  /* One table for both curves, as the donor renders it. */
  function mergeAddressRows() {
    var helper = window.RotorKeyTools;
    var extras = {
      secp: computedRows(state.secpReport),
      ed25519: state.tonRow ? [state.tonRow] : []
    };
    if (helper && typeof helper.mergeCurveAddresses === 'function') {
      return helper.mergeCurveAddresses(state.secpReport, state.edReport, extras);
    }
    var report = state.report;
    return report && Array.isArray(report.addresses) ? report.addresses.slice() : [];
  }

  function explorerFor(id) {
    if (EVM_CHAINS[id]) return EVM_CHAINS[id].explorer;
    if (typeof id === 'string') {
      if (id.indexOf('btc_') === 0) return SSOT_CHAINS.bySlug.bitcoin.explorerPrefix;
      if (id.indexOf('ltc_') === 0) return SSOT_CHAINS.bySlug.litecoin.explorerPrefix;
      if (id.indexOf('doge_') === 0) return SSOT_CHAINS.bySlug.dogecoin.explorerPrefix;
      if (id.indexOf('bch_') === 0) return SSOT_CHAINS.bySlug['bitcoin-cash'].explorerPrefix;
      if (id.indexOf('zcash_') === 0) return SSOT_CHAINS.bySlug.zcash.explorerPrefix;
      if (id.indexOf('xrp_') === 0) return SSOT_CHAINS.bySlug.xrp.explorerPrefix;
    }
    var map = {
      evm: SSOT_CHAINS.bySlug.ethereum.explorerPrefix,
      tron: SSOT_CHAINS.bySlug.tron.explorerPrefix,
      solana: SSOT_CHAINS.bySlug.solana.explorerPrefix,
      sui: SSOT_CHAINS.bySlug.sui.explorerPrefix,
      ton: SSOT_CHAINS.bySlug.ton.explorerPrefix,
      ton_w5: SSOT_CHAINS.bySlug.ton.explorerPrefix
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
      return {
        ticker: EVM_CHAINS[id].symbol,
        icon: 'chain-' + EVM_CHAINS[id].slug,
        decimals: Number.isInteger(EVM_CHAINS[id].decimals) ? EVM_CHAINS[id].decimals : 18
      };
    }
    var table = {
      btc: { ticker: 'BTC', icon: 'chain-bitcoin', decimals: 8 },
      ltc: { ticker: 'LTC', icon: 'chain-litecoin', decimals: 8 },
      doge: { ticker: 'DOGE', icon: 'chain-dogecoin', decimals: 8 },
      bch: { ticker: 'BCH', icon: 'chain-bitcoin-cash', decimals: 8 },
      zcash: { ticker: 'ZEC', icon: 'chain-zcash', decimals: 8 },
      xrp: { ticker: 'XRP', icon: 'chain-xrp', decimals: 6 },
      solana: { ticker: 'SOL', icon: 'chain-solana', decimals: 9 },
      sui: { ticker: 'SUI', icon: 'chain-sui', decimals: 9 },
      ton: { ticker: 'TON', icon: 'chain-ton', decimals: 9 },
      tron: { ticker: 'TRX', icon: 'chain-tron', decimals: 6 }
    };
    var prefix = String(id).split('_')[0];
    return table[id] || table[prefix] || { ticker: String(id).toUpperCase(), icon: 'ui-blockchain', decimals: 0 };
  }

  function typeLabel(addr) {
    if (!addr) return '';
    if (addr.sharedEvm || addr.sharedParent) return '';
    var helper = window.RotorKeyTools;
    if (helper && typeof helper.addressTypeLabel === 'function') {
      return helper.addressTypeLabel(addr.id);
    }
    return String(addr.id || '').replace(/_/g, ' ');
  }

  function rowGroup(id) {
    var helper = window.RotorKeyTools;
    return helper && typeof helper.rowGroup === 'function'
      ? helper.rowGroup(id)
      : String(id == null ? '' : id);
  }

  function counterChainKey(id) {
    var helper = window.RotorKeyTools;
    return helper && typeof helper.counterChainKey === 'function'
      ? helper.counterChainKey(id)
      : String(id == null ? '' : id);
  }

  function copyIconText(text, button, label) {
    writeClipboard(text, function done() {
      var use = button.querySelector('use');
      if (use) use.setAttribute('href', '/icons.svg#ui-check');
      button.classList.add('is-copied');
      button.setAttribute('aria-label', label + ' copied');
      button.setAttribute('data-tooltip', 'Copied');
      button.disabled = true;
      window.setTimeout(function () {
        if (use) use.setAttribute('href', '/icons.svg#ui-copy');
        button.classList.remove('is-copied');
        button.setAttribute('aria-label', label);
        button.setAttribute('data-tooltip', 'Copy address');
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
    toggle.setAttribute('data-tooltip', (open ? 'Hide' : 'Show') + ' details');
  }

  function visuallyHidden(text) {
    var span = document.createElement('span');
    span.className = 'visually-hidden';
    span.textContent = text;
    return span;
  }

  /* Derivation steps and the long descriptive label stay available in the
   * row's third action; the donor table itself only shows the short type. */
  function buildRowDetails(addr, name) {
    var details = document.createElement('div');
    details.className = 'key-details';
    details.id = 'key-details-' + String(addr.id).replace(/[^a-z0-9_-]/gi, '-');
    details.hidden = true;
    var explain = EXPLAIN[addr.id] || (addr.sharedParent ? EXPLAIN.evm : '');
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
    return details;
  }

  function buildRow(addr) {
    var row = document.createElement('tr');
    row.className = 'key-row';
    row.setAttribute('data-id', addr.id);
    row.setAttribute('data-address', addr.address);
    row.setAttribute('data-curve', addr.curve || '');
    row.setAttribute('data-group', rowGroup(addr.id));
    if (addr.sharedParent) row.setAttribute('data-parent', '1');

    var name = addr.label || ID_LABELS[addr.id] || addr.id;

    var chainCell = document.createElement('td');
    chainCell.className = 'key-cell-chain';
    chainCell.appendChild(visuallyHidden('Chain: '));
    if (addr.sharedParent) {
      var literal = document.createElement('span');
      literal.className = 'key-chain-literal';
      literal.textContent = '0x';
      chainCell.appendChild(literal);
    } else {
      var chain = chainMeta(addr.id);
      var chainId = document.createElement('span');
      chainId.className = 'key-chain-id';
      chainId.appendChild(svgUse('/icons.svg#' + chain.icon, 'key-chain-icon'));
      var ticker = document.createElement('span');
      ticker.className = 'key-chain-ticker';
      ticker.textContent = addr.sharedEvm ? (EVM_SHORT[addr.id] || chain.ticker) : chain.ticker;
      chainId.appendChild(ticker);
      chainCell.appendChild(chainId);
    }
    row.appendChild(chainCell);

    var typeCell = document.createElement('td');
    typeCell.className = 'key-cell-type';
    var typeText = document.createElement('span');
    typeText.className = 'key-format-text';
    typeText.textContent = addr.sharedParent ? 'EVM' : typeLabel(addr);
    typeText.title = name;
    typeCell.appendChild(typeText);
    var title = document.createElement('span');
    title.className = 'key-row-title visually-hidden';
    title.textContent = name;
    typeCell.appendChild(title);
    row.appendChild(typeCell);

    var addrCell = document.createElement('td');
    addrCell.className = 'key-cell-addr';
    addrCell.appendChild(visuallyHidden('Address: '));
    if (addr.sharedEvm) {
      var same = document.createElement('span');
      same.className = 'key-same';
      same.textContent = '↑ same';
      same.title = addr.address;
      same.setAttribute('aria-label', 'Same address as the shared EVM 0x row');
      addrCell.appendChild(same);
    } else {
      var code = document.createElement('code');
      code.className = 'mono key-addr';
      code.textContent = addr.address;
      code.title = addr.address;
      addrCell.appendChild(code);
    }
    row.appendChild(addrCell);

    var statusCell = document.createElement('td');
    statusCell.className = 'key-cell-status';
    statusCell.appendChild(visuallyHidden('Status: '));
    var badge = document.createElement('span');
    badge.className = 'key-balance';
    badge.hidden = true;
    statusCell.appendChild(badge);
    if (addr.sharedParent) {
      badge.hidden = false;
      badge.className = 'key-balance empty';
      badge.textContent = '—';
      badge.title = 'The shared 0x address; balances are shown on the eight network rows.';
    }
    row.appendChild(statusCell);

    var actCell = document.createElement('td');
    actCell.className = 'key-cell-act';
    var actions = document.createElement('div');
    actions.className = 'key-actions';
    if (!addr.sharedEvm) {
      var details = buildRowDetails(addr, name);
      addrCell.appendChild(details);

      var explorer = explorerFor(addr.sharedParent ? 'evm' : addr.id);
      if (explorer) {
        var ext = document.createElement('a');
        ext.className = 'icon-button icon-button--quiet icon-button--lg';
        ext.href = explorer + encodeURIComponent(addr.address);
        ext.target = '_blank';
        ext.rel = 'noopener noreferrer';
        ext.setAttribute('data-tooltip', 'Open in explorer');
        ext.setAttribute('aria-label', 'Open ' + name + ' in explorer');
        ext.appendChild(svgUse('/icons.svg#ui-external'));
        actions.appendChild(ext);
      }
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'icon-button icon-button--quiet icon-button--lg';
      copy.setAttribute('data-tooltip', 'Copy address');
      copy.setAttribute('aria-label', 'Copy ' + name + ' address');
      copy.appendChild(svgUse('/icons.svg#ui-copy'));
      copy.addEventListener('click', function () {
        copyIconText(addr.address, copy, 'Copy ' + name + ' address');
      });
      actions.appendChild(copy);
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'icon-button icon-button--quiet icon-button--lg key-details-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', details.id);
      toggle.setAttribute('data-name', name);
      toggle.setAttribute('aria-label', 'Show details for ' + name);
      toggle.setAttribute('data-tooltip', 'Show details');
      toggle.appendChild(svgUse('/icons.svg#ui-chevron'));
      toggle.addEventListener('click', function () {
        setRowDetails(row, details.hidden);
      });
      actions.appendChild(toggle);
    }
    actCell.appendChild(actions);
    row.appendChild(actCell);
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
      copyPathBtn.setAttribute('data-tooltip', 'Derivation path copied');
      copyPathBtn.disabled = true;
      window.setTimeout(function () {
        if (use) use.setAttribute('href', '/icons.svg#ui-copy');
        copyPathBtn.classList.remove('is-copied');
        copyPathBtn.setAttribute('aria-label', 'Copy derivation path');
        copyPathBtn.setAttribute('data-tooltip', 'Copy derivation path');
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
        !chainHasRows(state.chain, state.addressRows)) {
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

  /* The Chain cell is drawn once per visible run: its rowspan is recomputed
   * from the rows actually shown, so an added row (Litecoin taproot, TON W5)
   * needs no markup change. */
  function applyGroupSpans() {
    var rows = rowList();
    var helper = window.RotorKeyTools;
    var plan = helper && typeof helper.groupAddressRows === 'function'
      ? helper.groupAddressRows(rows.map(function (row) {
          return {
            group: row.getAttribute('data-group') || '',
            visible: !row.classList.contains('hidden')
          };
        }))
      : rows.map(function () { return { span: 0 }; });
    rows.forEach(function (row, index) {
      var cell = row.querySelector('.key-cell-chain');
      if (!cell) return;
      var span = plan[index] ? plan[index].span : 0;
      if (span > 0) {
        cell.hidden = false;
        cell.rowSpan = span;
      } else {
        cell.hidden = true;
        cell.rowSpan = 1;
      }
    });
  }

  function applyFilters() {
    if (!state.report) {
      presetEmpty.hidden = true;
      applyGroupSpans();
      return;
    }
    var visible = 0;
    rowList().forEach(function (row) {
      var show = rowMatches(row.getAttribute('data-id'));
      row.classList.toggle('hidden', !show);
      if (show) visible++;
    });
    applyGroupSpans();
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

  function syncBitcoinPanel() {
    if (!btcPanel) return;
    var hasVisibleBtc = rowList().some(function (row) {
      var id = row.getAttribute('data-id');
      return !!id && id.indexOf('btc_') === 0 && !row.classList.contains('hidden');
    });
    btcPanel.hidden = !hasVisibleBtc;
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

  function setBalance(badge, kind, text, options) {
    var settings = options || {};
    badge.hidden = false;
    badge.className = 'key-balance' + (kind ? ' ' + kind : '');
    badge.textContent = '';
    if (kind === 'loading') {
      var spinner = document.createElement('span');
      spinner.className = 'key-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      badge.appendChild(spinner);
    }
    if (text) {
      var label = document.createElement('span');
      label.className = 'key-balance-text';
      label.textContent = text;
      badge.appendChild(label);
    }
    badge.title = settings.title || text;
    if (settings.ariaLabel) badge.setAttribute('aria-label', settings.ariaLabel);
    else badge.removeAttribute('aria-label');
    if (settings.age) {
      var ageEl = document.createElement('span');
      ageEl.className = 'balance-age';
      ageEl.textContent = settings.age;
      badge.appendChild(ageEl);
    }
    if (settings.onRetry) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon-button icon-button--quiet icon-button--lg';
      button.setAttribute('data-tooltip', 'Retry this balance');
      button.setAttribute('aria-label', 'Retry balance check for this address');
      button.appendChild(retryIcon());
      button.addEventListener('click', settings.onRetry);
      badge.appendChild(button);
    }
  }

  function setNoProvider(badge) {
    setBalance(badge, 'empty', '—', {
      title: 'No balance provider for this chain yet',
      ariaLabel: 'No balance provider for this chain yet'
    });
  }

  /* One formatter for the row and its title. Missing provider decimals fall
   * back to the chain metadata (TRX 6, SOL 9, BTC 8, EVM 18, ...), never to a
   * blanket 18. */
  function normalizedSummary(summary, id) {
    if (!summary) return summary;
    var meta = chainMeta(id);
    return {
      amount: summary.amount,
      chain: summary.chain,
      symbol: summary.symbol || meta.ticker,
      decimals: Number.isInteger(summary.decimals) ? summary.decimals : meta.decimals,
      active: summary.active === true,
      txs: summary.txs,
      nonce: summary.nonce,
      lastTxAt: summary.lastTxAt,
      note: summary.note,
      balanceSat: summary.balanceSat,
      receivedSat: summary.receivedSat
    };
  }

  function renderBalanceOutcome(row, badge, summary, meta) {
    var settings = meta || {};
    var id = row.getAttribute('data-id');
    var normalized = normalizedSummary(summary, id);
    var amount = 0n;
    try {
      amount = BigInt(normalized && normalized.amount != null ? normalized.amount : 0);
    } catch (err) {
      amount = 0n;
    }
    var helper = window.RotorKeyTools;
    var lastTxAge = normalized && normalized.lastTxAt ? timeAgo(normalized.lastTxAt) : '';
    var line = helper && typeof helper.balanceLine === 'function'
      ? helper.balanceLine(normalized, { age: settings.age, lastTxAge: lastTxAge })
      : '';
    row.classList.toggle('has-balance', amount > 0n);
    row.classList.toggle('is-active', !!(normalized && normalized.active === true));
    row.dataset.active = normalized && normalized.active === true ? '1' : '0';
    if (amount > 0n) {
      setBalance(badge, 'ok', line, {
        title: line,
        ariaLabel: line + ' balance'
      });
      return;
    }
    if (normalized && normalized.active === true) {
      setBalance(badge, 'active', line || '✓', {
        title: line || 'Active, zero balance',
        ariaLabel: line || 'Active, zero balance'
      });
      return;
    }
    setBalance(badge, 'empty', line || '-', {
      title: line || 'Checked; no balance or activity',
      ariaLabel: line || 'Checked, no balance or activity'
    });
  }

  function resetBalanceBadges() {
    Array.prototype.forEach.call(rowsEl.querySelectorAll('.key-balance'), function (badge) {
      badge.textContent = '';
      badge.className = 'key-balance';
      badge.title = '';
      badge.removeAttribute('aria-label');
      badge.hidden = true;
    });
    rowList().forEach(function (row) {
      delete row.dataset.balanceState;
      delete row.dataset.active;
      row.classList.remove('has-balance', 'is-active');
    });
    Array.prototype.forEach.call(rowsEl.querySelectorAll('[data-parent="1"] .key-balance'), function (badge) {
      badge.hidden = false;
      badge.className = 'key-balance empty';
      badge.textContent = '—';
      badge.title = 'The shared 0x address; balances are shown on the eight network rows.';
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

  function timeAgo(ms) {
    return cacheApi && typeof cacheApi.relativeTime === 'function'
      ? cacheApi.relativeTime(ms, Date.now())
      : '';
  }

  /* One status line for both the backend and the direct TronScan path.
   * Missing fields keep the page's "—" convention instead of a fake zero. */
  function tronText(sun, txs, lastTxAt) {
    var parts = [];
    parts.push(sun === null || sun === undefined ? '—' : formatUnits6(sun, 1000000n) + ' TRX');
    if (txs !== null && txs !== undefined) parts.push(String(txs) + ' tx');
    var age = lastTxAt === null || lastTxAt === undefined ? '' : timeAgo(lastTxAt);
    if (age) parts.push('last ' + age);
    return parts.join(' · ');
  }

  function formatEth(wei) {
    var whole = wei / WEI;
    var fraction = (wei % WEI) / WEI_PER_MICRO;
    var text = fraction.toString().padStart(6, '0').replace(/0+$/, '');
    return text ? whole.toString() + '.' + text : whole.toString();
  }

  async function fetchBtc(address, signal) {
    var response = await fetchWithTimeout(SSOT_PROVIDERS.find('bitcoin', 'mempool').url + '/address/' + encodeURIComponent(address), null, signal);
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
      summary: {
        amount: sats,
        chain: 'btc',
        symbol: 'BTC',
        decimals: 8,
        active: txs > 0,
        balanceSat: sats,
        receivedSat: funded,
        txs: txs
      }
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
    var nonceCount = 0n;
    if (nonce && typeof nonce.result === 'string') {
      nonceCount = BigInt(nonce.result);
      text += ' · nonce ' + nonceCount.toString();
    }
    return {
      text: text,
      summary: {
        amount: wei,
        chain: chain.slug,
        symbol: chain.symbol,
        decimals: 18,
        active: nonceCount > 0n,
        nonce: Number(nonceCount)
      }
    };
  }

  async function fetchEvm(address, signal, id) {
    var chain = EVM_CHAINS[id] || EVM_CHAINS.evm;
    /* Ethereum keeps the endpoint fallback; Polygon and Optimism carry the
     * canonical publicnode + dRPC list. The other networks have one public
     * endpoint mapped to them. */
    var urls = id === 'evm' ? EVM_RPC_URLS : (Array.isArray(chain.rpc) ? chain.rpc : [chain.rpc]);
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

  async function fetchTronDirect(address, signal) {
    var response = await fetchWithTimeout(SSOT_PROVIDERS.find('tron', 'tronscan').url + '/account?address=' + encodeURIComponent(address), null, signal);
    if (response.status === 404) {
      return {
        text: '0 TRX · account not activated',
        summary: {
          amount: 0n,
          chain: 'tron',
          symbol: 'TRX',
          decimals: 6,
          active: false,
          txs: 0,
          note: 'account not activated'
        }
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
    var txs = tronTxCount(data);
    return {
      text: tronText(sun, txs, null),
      summary: {
        amount: sun,
        chain: 'tron',
        symbol: 'TRX',
        decimals: 6,
        active: txs !== null && txs > 0,
        txs: txs
      }
    };
  }

  async function fetchTron(address, signal) {
    /* Same-origin first: the coordinator holds the TronScan key. A static
     * host (404) or a coordinator without the key (501) falls back to the
     * previous direct public request; every other failure is surfaced. */
    var response = await fetchWithTimeout('/api/v1/chain/tron/address?address=' + encodeURIComponent(address), null, signal);
    if (response.status === 404 || response.status === 501) {
      return fetchTronDirect(address, signal);
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var data;
    try {
      data = await response.json();
    } catch (err) {
      throw new Error('unexpected response');
    }
    if (!data || typeof data !== 'object' || data.chain !== 'tron') throw new Error('unexpected response');
    var sun = null;
    if (data.balance_sun !== null && data.balance_sun !== undefined) {
      try {
        sun = BigInt(String(data.balance_sun));
      } catch (err) {
        throw new Error('unexpected response');
      }
    }
    var txs = typeof data.tx_count === 'number' && isFinite(data.tx_count) ? data.tx_count : null;
    var lastTxAt = typeof data.last_tx_at === 'number' && isFinite(data.last_tx_at) ? data.last_tx_at : null;
    return {
      text: tronText(sun, txs, lastTxAt),
      summary: {
        amount: sun === null ? 0n : sun,
        chain: 'tron',
        symbol: 'TRX',
        decimals: 6,
        active: txs !== null && txs > 0,
        txs: txs,
        lastTxAt: lastTxAt
      }
    };
  }

  /* Free public providers. They take the derived public address only and
   * answer CORS-friendly JSON, so the four chains below need no API key. */
  async function parseProviderJson(response, parserName) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var data = await response.json();
    if (data && data.error && data.error.message) throw new Error(data.error.message);
    var parser = cacheApi && typeof cacheApi[parserName] === 'function' ? cacheApi[parserName] : null;
    var parsed = parser ? parser(data) : null;
    if (!parsed) throw new Error('unexpected response');
    return parsed;
  }

  async function fetchXrp(address, signal) {
    var response = await fetchWithTimeout(
      SSOT_PROVIDERS.find('xrp', 'xrpscan').url + '/account/' + encodeURIComponent(address),
      null,
      signal
    );
    if (response.status === 404) {
      return {
        text: '0 XRP · account not activated',
        summary: {
          amount: 0n,
          chain: 'xrp',
          symbol: 'XRP',
          decimals: 6,
          active: false,
          txs: 0,
          note: 'account not activated'
        }
      };
    }
    var parsed = await parseProviderJson(response, 'parseXrpAccount');
    var drops = BigInt(parsed.amount);
    var txs = parsed.tx;
    return {
      text: drops.toLocaleString('en-US') + ' drops' + (txs === null ? '' : ' · ' + txs + ' tx'),
      summary: {
        amount: drops,
        chain: 'xrp',
        symbol: 'XRP',
        decimals: 6,
        active: txs === null ? drops > 0n : txs > 0,
        txs: txs
      }
    };
  }

  async function rpcJson(url, method, params, signal) {
    var response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params })
    }, signal);
    return response;
  }

  /* The official RPC is primary; publicnode serves the same mainnet JSON-RPC
   * when the official host rejects the browser (it answers 403 to some
   * origins). */
  var SOLANA_RPC_URLS = SSOT_PROVIDERS.byChain.solana.map(function (provider) {
    return provider.url;
  });

  async function fetchSolana(address, signal) {
    var lastError = null;
    for (var i = 0; i < SOLANA_RPC_URLS.length; i += 1) {
      try {
        var response = await rpcJson(SOLANA_RPC_URLS[i], 'getBalance', [address], signal);
        var parsed = await parseProviderJson(response, 'parseSolanaBalance');
        var lamports = BigInt(parsed.amount);
        return {
          text: lamports.toLocaleString('en-US') + ' lamports',
          summary: {
            amount: lamports,
            chain: 'solana',
            symbol: 'SOL',
            decimals: 9,
            active: lamports > 0n
          }
        };
      } catch (err) {
        if (signal && signal.aborted) throw err;
        lastError = err;
      }
    }
    throw lastError || new Error('unexpected response');
  }

  async function fetchSui(address, signal) {
    /* The public Sui JSON-RPC fullnodes are deprecated (-32601); the GraphQL
     * gateway returns the same MIST balance and allows browser CORS. */
    var response = await fetchWithTimeout(SSOT_PROVIDERS.find('sui', 'graphql').url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($a: SuiAddress!){address(address:$a){balance(coinType:"0x2::sui::SUI"){totalBalance}}}',
        variables: { a: address }
      })
    }, signal);
    var parsed = await parseProviderJson(response, 'parseSuiBalance');
    var mist = BigInt(parsed.amount);
    return {
      text: mist.toLocaleString('en-US') + ' MIST',
      summary: {
        amount: mist,
        chain: 'sui',
        symbol: 'SUI',
        decimals: 9,
        active: mist > 0n
      }
    };
  }

  async function fetchTon(address, signal) {
    var response = await fetchWithTimeout(
      SSOT_PROVIDERS.find('ton', 'toncenter').url + '/getAddressBalance?address=' + encodeURIComponent(address),
      null,
      signal
    );
    var parsed = await parseProviderJson(response, 'parseTonBalance');
    var nanotons = BigInt(parsed.amount);
    return {
      text: nanotons.toLocaleString('en-US') + ' nanotons',
      summary: {
        amount: nanotons,
        chain: 'ton',
        symbol: 'TON',
        decimals: 9,
        active: nanotons > 0n
      }
    };
  }

  /* BlockCypher's keyless balance endpoint allows browser CORS for both
   * Litecoin (incl. taproot) and Dogecoin; amounts arrive in atomic units. */
  async function fetchBlockcypher(address, signal, chainClass) {
    var response = await fetchWithTimeout(
      SSOT_PROVIDERS.find(chainClass === 'ltc' ? 'litecoin' : 'dogecoin', 'blockcypher').url +
        '/addrs/' + encodeURIComponent(address) + '/balance',
      null,
      signal
    );
    var parsed = await parseProviderJson(response, 'parseBlockcypherBalance');
    var sats = BigInt(parsed.amount);
    var received = parsed.received === null ? null : BigInt(parsed.received);
    var txs = parsed.txs;
    var txLabel = txs === null ? '' : ' · ' + txs + ' tx';
    return {
      text: sats.toLocaleString('en-US') + ' sats' + txLabel,
      summary: {
        amount: sats,
        chain: chainClass,
        symbol: chainClass === 'ltc' ? 'LTC' : 'DOGE',
        decimals: 8,
        active: txs > 0,
        balanceSat: sats,
        receivedSat: received,
        txs: txs
      }
    };
  }

  /* Haskoin's keyless BCH endpoint answers CORS-friendly JSON: one entry per
   * requested address with satoshis in `confirmed` + `unconfirmed`. */
  async function fetchHaskoinBch(address, signal) {
    var response = await fetchWithTimeout(
      SSOT_PROVIDERS.find('bitcoin-cash', 'haskoin').url + '/address/balances?addresses=' + encodeURIComponent(address),
      null,
      signal
    );
    var parsed = await parseProviderJson(response, 'parseHaskoinBch');
    var sats = BigInt(parsed.confirmed) + BigInt(parsed.unconfirmed);
    if (sats < 0n) sats = 0n;
    var txs = parsed.txs;
    var txLabel = txs === null ? '' : ' · ' + txs + ' tx';
    return {
      text: sats.toLocaleString('en-US') + ' sats' + txLabel,
      summary: {
        amount: sats,
        chain: 'bch',
        symbol: 'BCH',
        decimals: 8,
        active: sats > 0n || (txs !== null && txs > 0),
        balanceSat: sats,
        txs: txs
      }
    };
  }

  /* Rows whose identifiers have a working public provider. Kept in one place
   * so the counters and the checks agree on what "N" means. ZEC still has no
   * free keyless provider (Blockchair answers 430 without a key). */
  function rowHasProvider(id) {
    if (!id) return false;
    if (id === 'solana' || id === 'sui' || id === 'ton' || id === 'ton_w5') return true;
    if (id.indexOf('xrp_') === 0) return true;
    if (id.indexOf('ltc_') === 0 || id.indexOf('doge_') === 0) return true;
    if (id.indexOf('bch_') === 0) return true;
    if (id.indexOf('zcash_') === 0) return false;
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
        chain: counterChainKey(id),
        amount: summary && summary.amount,
        active: !!(summary && summary.active),
        state: row.dataset.balanceState || '',
        checkable: rowHasProvider(id),
        visible: !row.classList.contains('hidden')
      });
    });
    var helper = window.RotorKeyTools;
    var counters = helper && typeof helper.balanceCounters === 'function'
      ? helper.balanceCounters(entries, 18)
      : { withBalance: 0, activeChains: 0, checked: 0, total: 18 };
    renderTotalValue();
    if (statHasBalance) statHasBalance.textContent = String(counters.withBalance);
    if (statActive) statActive.textContent = String(counters.activeChains);
    if (statChecked) statChecked.textContent = counters.checked + '/' + counters.total;
  }

  /* ---------------------------------------------------------------- prices */
  /* Public ticker only: symbols, never a key, address or balance. A successful
   * response is cached for six hours; a failed refresh keeps the previous
   * cache and marks it stale instead of inventing a number. */
  function readPriceCache() {
    try {
      var raw = window.localStorage.getItem(PRICE_CACHE_KEY);
      if (!raw) return null;
      var entry = JSON.parse(raw);
      return entry && typeof entry === 'object' ? entry : null;
    } catch (err) {
      return null;
    }
  }

  function writePriceCache(entry) {
    try {
      window.localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(entry));
    } catch (err) {
      /* private mode or a full quota: keep the in-memory copy */
    }
  }

  function applyPrices(prices, meta) {
    state.prices = prices;
    state.priceMeta = meta || null;
    updateCounters();
  }

  function ensurePrices() {
    var helper = window.RotorKeyTools;
    if (!helper || typeof helper.priceRequestUrl !== 'function') {
      state.priceStatus = 'unavailable';
      return Promise.resolve();
    }
    if (state.prices) return Promise.resolve();
    if (state.pricePromise) return state.pricePromise;
    var cached = readPriceCache();
    if (helper.priceCacheState(cached, Date.now(), PRICE_TTL_MS) === 'fresh') {
      state.priceStatus = 'ready';
      applyPrices(cached.prices, { fetchedAt: cached.fetchedAt, stale: false });
      return Promise.resolve();
    }
    state.priceStatus = 'loading';
    state.pricePromise = (async function () {
      try {
        var response = await fetchWithTimeout(
          helper.priceRequestUrl(),
          { headers: { Accept: 'application/json' } },
          null
        );
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var data = await response.json();
        var prices = helper.parsePriceResponse(data);
        if (!Object.keys(prices).length) throw new Error('no ticker prices');
        var entry = { prices: prices, fetchedAt: Date.now(), source: 'binance' };
        writePriceCache(entry);
        state.priceStatus = 'ready';
        applyPrices(prices, { fetchedAt: entry.fetchedAt, stale: false });
      } catch (err) {
        if (cached && cached.prices) {
          state.priceStatus = 'stale';
          applyPrices(cached.prices, { fetchedAt: cached.fetchedAt, stale: true });
        } else {
          state.priceStatus = 'unavailable';
          state.prices = null;
          state.priceMeta = null;
          updateCounters();
        }
      } finally {
        state.pricePromise = null;
      }
    })();
    return state.pricePromise;
  }

  function pricedRow(row) {
    var id = row.getAttribute('data-id');
    if (!id || row.dataset.balanceState !== 'ok') return null;
    var summary = state.balances[id];
    if (!summary || summary.amount === null || summary.amount === undefined) return null;
    var meta = chainMeta(id);
    return {
      chain: summary.chain || meta.ticker,
      symbol: summary.symbol || meta.ticker,
      amount: summary.amount,
      decimals: Number.isInteger(summary.decimals) ? summary.decimals : meta.decimals
    };
  }

  function renderTotalValue() {
    if (!statTotal) return;
    var helper = window.RotorKeyTools;
    var entries = [];
    var addressRows = 0;
    var loading = false;
    rowList().forEach(function (row) {
      if (row.getAttribute('data-parent') === '1') return;
      addressRows += 1;
      if (row.dataset.balanceState === 'loading') loading = true;
      var entry = pricedRow(row);
      if (entry) entries.push(entry);
    });
    statTotal.classList.add('empty');
    if (loading || state.priceStatus === 'loading') {
      statTotal.textContent = '…';
      statTotal.title = loading
        ? 'Waiting for balances to settle before showing a USD total.'
        : 'Waiting for the price ticker.';
      statTotal.setAttribute('aria-label', 'Total value is still loading');
      return;
    }
    if (!state.prices || !helper || typeof helper.fiatTotals !== 'function') {
      statTotal.textContent = '—';
      statTotal.title = 'No price source reachable';
      statTotal.setAttribute('aria-label', 'No price source reachable');
      return;
    }
    var totals = helper.fiatTotals(entries, state.prices);
    var excluded = addressRows - totals.included;
    if (totals.included === 0) {
      statTotal.textContent = '—';
      statTotal.title = 'No loaded balance has a USD price' +
        (excluded ? '; ' + excluded + ' row(s) excluded.' : '.');
      statTotal.setAttribute('aria-label', statTotal.title);
      return;
    }
    var amount = helper.formatUsd(totals.cents);
    var when = helper.formatPriceTime(state.priceMeta && state.priceMeta.fetchedAt);
    statTotal.classList.remove('empty');
    statTotal.textContent = amount;
    statTotal.title = 'Exact total ' + amount + ' from ' + totals.included + ' priced row(s)' +
      (when ? '; prices fetched ' + when : '') +
      (state.priceMeta && state.priceMeta.stale ? '; stale cache' : '') +
      (excluded ? '; ' + excluded + ' row(s) excluded (no price or no balance)' : '') + '.';
    statTotal.setAttribute(
      'aria-label',
      'Total value ' + amount + (excluded ? ', ' + excluded + (excluded === 1 ? ' row' : ' rows') + ' excluded' : '')
    );
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
    } else if (id.indexOf('xrp_') === 0) {
      provider = 'xrpscan';
      chain = 'xrp';
    } else if (id === 'solana') {
      provider = 'solana';
      chain = 'solana';
    } else if (id === 'sui') {
      provider = 'sui';
      chain = 'sui';
    } else if (id === 'ton' || id === 'ton_w5') {
      provider = 'toncenter';
      chain = 'ton';
    } else if (id.indexOf('ltc_') === 0) {
      provider = 'blockcypher';
      chain = 'ltc';
    } else if (id.indexOf('doge_') === 0) {
      provider = 'blockcypher';
      chain = 'doge';
    } else if (id.indexOf('bch_') === 0) {
      provider = 'haskoin';
      chain = 'bch';
    } else {
      return null;
    }
    return {
      provider: provider,
      chain: chain,
      address: address,
      key: cacheApi
        ? cacheApi.cacheKey('v2:' + provider, chain, address)
        : 'v2:' + provider + '|' + chain + '|' + address
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
    if (!summary || summary.amount === undefined || summary.amount === null || summary.amount === '') return null;
    try {
      return {
        amount: BigInt(String(summary.amount)),
        chain: summary.chain || '',
        symbol: summary.symbol || '',
        decimals: Number.isInteger(summary.decimals) ? summary.decimals : undefined,
        active: summary.active === true,
        txs: Number.isInteger(summary.txs) ? summary.txs : undefined,
        nonce: Number.isInteger(summary.nonce) ? summary.nonce : undefined,
        lastTxAt: Number.isFinite(summary.lastTxAt) ? summary.lastTxAt : undefined,
        note: summary.note || '',
        balanceSat: BigInt(String(summary.balanceSat || '0')),
        receivedSat: BigInt(String(summary.receivedSat || '0'))
      };
    } catch (err) {
      return null;
    }
  }

  function serializeResult(result) {
    var value = { text: typeof result === 'string' ? result : (result && result.text ? result.text : '') };
    var summary = result && result.summary;
    if (summary) {
      value.summary = {
        amount: summary.amount == null ? '0' : String(summary.amount),
        chain: summary.chain || '',
        symbol: summary.symbol || '',
        decimals: Number.isInteger(summary.decimals) ? summary.decimals : undefined,
        active: summary.active === true,
        txs: Number.isInteger(summary.txs) ? summary.txs : undefined,
        nonce: Number.isInteger(summary.nonce) ? summary.nonce : undefined,
        lastTxAt: Number.isFinite(summary.lastTxAt) ? summary.lastTxAt : undefined,
        note: summary.note || '',
        balanceSat: String(summary.balanceSat == null ? '0' : summary.balanceSat),
        receivedSat: String(summary.receivedSat == null ? '0' : summary.receivedSat)
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
    if (summary) {
      renderBalanceOutcome(row, badge, summary, {
        age: cacheApi ? cacheApi.ageLabel(entry, now) : ''
      });
    } else {
      setBalance(badge, 'ok', value.text, { title: value.text, age: cacheApi ? cacheApi.ageLabel(entry, now) : '' });
    }
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
    setBalance(badge, 'loading', 'Checking', { title: 'Checking balance…', ariaLabel: 'Checking balance' });
    updateCounters();
    var request = async function () {
      if (id.indexOf('btc_') === 0) return fetchBtc(address, signal);
      if (EVM_CHAINS[id]) return fetchEvm(address, signal, id);
      if (id === 'tron') return fetchTron(address, signal);
      if (id.indexOf('xrp_') === 0) return fetchXrp(address, signal);
      if (id === 'solana') return fetchSolana(address, signal);
      if (id === 'sui') return fetchSui(address, signal);
      if (id === 'ton' || id === 'ton_w5') return fetchTon(address, signal);
      if (id.indexOf('ltc_') === 0) return fetchBlockcypher(address, signal, 'ltc');
      if (id.indexOf('doge_') === 0) return fetchBlockcypher(address, signal, 'doge');
      if (id.indexOf('bch_') === 0) return fetchHaskoinBch(address, signal);
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
      if (result && result.summary) {
        renderBalanceOutcome(row, badge, result.summary, {
          age: entry ? cacheApi.ageLabel(entry, Date.now()) : ''
        });
      } else {
        setBalance(badge, 'ok', value.text, {
          title: value.text,
          age: entry ? cacheApi.ageLabel(entry, Date.now()) : ''
        });
      }
      updateCounters();
      updateKeyRefreshButton();
    } catch (err) {
      if (generation !== state.generation || signal.aborted) return;
      var message = err && err.name === 'AbortError'
        ? 'timeout after ' + (TIMEOUT_MS / 1000) + ' s'
        : (err && err.message ? err.message : 'unknown error');
      row.dataset.balanceState = 'err';
      row.dataset.active = '0';
      row.classList.remove('has-balance', 'is-active');
      setBalance(badge, 'err', '!', {
        title: 'Lookup failed: ' + message,
        ariaLabel: 'Balance lookup failed: ' + message,
        onRetry: function () {
          checkVisibleBalances({ onlyRows: [row] });
        }
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
      if (row.getAttribute('data-parent') === '1') {
        row.dataset.balanceState = 'off';
        return;
      }
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
    exposureStatus.removeAttribute('title');
    exposureStatus.className = 'key-exposure-status';
    exposureStatus.hidden = true;
  }

  function showExposureStatus(short, full, kind) {
    if (!exposureStatus) return;
    exposureStatus.textContent = short;
    exposureStatus.title = full || short;
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
    showExposureStatus('Checking exposure…',
      'Checking ' + addresses.length + ' address(es) against the Crypto registry…', '');
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
      showExposureStatus(matched > 0 ? matched + ' registered match' + (matched === 1 ? '' : 'es') : 'No registry match',
        matched > 0 ? matched + ' registered address(es) matched; their owners were warned.' : 'No registered address matched.', 'ok');
    } catch (err) {
      if (generation !== state.generation || (!auto && !exposureToggle.checked)) return;
      if (err && err.name === 'AbortError') {
        showExposureStatus('Exposure check timed out.', 'Exposure check timed out.', 'err');
        return;
      }
      showExposureStatus('Exposure check failed',
        'Exposure check failed: ' + (err && err.message ? err.message : 'unknown error'), 'err');
    } finally {
      window.clearTimeout(timer);
      if (state.exposureController === controller) state.exposureController = null;
    }
  }


  /* -------------------------------------------------------------- URL key */
  /* A key in the path is already exposed to the browser history and any
   * server logs, so derive it on load and run the registry check without an
   * opt-in. Only the derived addresses leave this page. The coordinator also
   * embeds the raw value as window.__ROTOR_KEY__, which keeps arbitrary
   * XRP/keypair values out of path parsing. */
  function initUrlKey() {
    var raw = typeof window.__ROTOR_KEY__ === 'string' ? window.__ROTOR_KEY__ : '';
    if (!raw) {
      var path = window.location.pathname;
      if (path.indexOf('/key/') !== 0) return;
      if (path === '/key/hex' || path === '/key/wif' || path === '/key/decimal') return;
      try {
        raw = decodeURIComponent(path.slice('/key/'.length));
      } catch (err) {
        return;
      }
    }
    if (!raw || raw.indexOf('/') >= 0) return;
    var detected = detectFormat(raw);
    if (detected.kind === 'empty') return;
    /* Arbitrary text is not silently hashed as a brainwallet: the donor
     * serves these URLs with a client-side invalid state, so the page keeps
     * the value in the field and says why it cannot derive a key. */
    if (detected.kind === 'decimal' || detected.kind === 'brainwallet') {
      input.value = raw;
      if (urlNotice) urlNotice.hidden = false;
      showError('text is not a private key; use a 64-hex key, WIF, keypair or XRP secret');
      return;
    }
    state.urlKey = detected.kind === 'hex' ? raw.toLowerCase() : raw;
    input.value = state.urlKey;
    var params = new URLSearchParams(window.location.search);
    var curveParam = params.get('curve');
    var chainParam = params.get('chain');
    curveSelect.value = (curveParam === 'ed25519' || (detected.kind === 'keypair') ||
      (chainParam && ED25519_CHAINS[chainParam])) ? '1' : '0';
    syncCurveChoices();
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

  /* The formats popover: an absolutely positioned card so opening it never
   * changes the meta row height or the page scroll. Escape and an outside
   * click close it; Escape returns focus to the trigger. */
  (function setupInfoPopover() {
    var infoBtn = byId('key-info-btn');
    var infoPopover = byId('key-info-popover');
    if (!infoBtn || !infoPopover) return;

    function closeInfoPopover(returnFocus) {
      if (infoPopover.hidden) return;
      infoPopover.hidden = true;
      infoPopover.style.maxHeight = '';
      infoBtn.setAttribute('aria-expanded', 'false');
      if (returnFocus) infoBtn.focus();
    }

    function openInfoPopover() {
      if (window.RotorTooltip) window.RotorTooltip.hide();
      infoPopover.hidden = false;
      /* Keep the card inside the viewport even when it opens near the bottom
       * edge on a short screen; the body scrolls instead of the page moving. */
      var rect = infoPopover.getBoundingClientRect();
      var cap = Math.min(360, window.innerHeight - rect.top - 8, window.innerHeight * 0.6);
      infoPopover.style.maxHeight = Math.max(160, cap) + 'px';
      infoBtn.setAttribute('aria-expanded', 'true');
      infoPopover.focus({ preventScroll: true });
    }

    infoBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      if (infoPopover.hidden) openInfoPopover();
      else closeInfoPopover(true);
    });
    document.addEventListener('click', function (event) {
      if (infoPopover.hidden) return;
      if (infoPopover.contains(event.target) || infoBtn.contains(event.target)) return;
      closeInfoPopover(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !infoPopover.hidden) {
        event.preventDefault();
        closeInfoPopover(true);
      }
    });
  })();

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
  ensurePrices();
  initUrlKey();
})();
