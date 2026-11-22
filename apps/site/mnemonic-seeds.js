/* Mnemonic seeds directory: enumerate deterministic BIP39 phrases from the
 * entropy space and derive addresses in this tab. Phrases and keys are never
 * stored, put into the URL or sent anywhere; only public balances are fetched. */
(function () {
  'use strict';

  /* Chain identity and public providers come from data/*.json through the
   * generated globals in chains.generated.js (loaded before this script). */
  var SSOT_ROOT = typeof window !== 'undefined' ? window : globalThis;
  var SSOT_CHAINS = SSOT_ROOT.RotorChains;
  var SSOT_PROVIDERS = SSOT_ROOT.RotorProviders;
  var AMOUNT = SSOT_ROOT.RotorAmount;

  var WASM_URL = typeof window !== 'undefined' && window.RotorAssets
    ? window.RotorAssets.url('/rotor_wasm.wasm')
    : '/rotor_wasm.wasm';
  var DECODER = new TextDecoder('utf-8');
  var ED_SEED_KEY = new TextEncoder().encode('ed25519 seed');
  var ROWS_PER_PAGE = 60n;

  /* The donor shows a Received amount too small for the native coin cell in
   * atomic units: `sat` for BTC-family chains, `zat` for Zcash. Declared before
   * the export block so the Node test can call `receivedText` without a DOM. */
  var ATOMIC_UNITS = {
    bitcoin: 'sat',
    litecoin: 'sat',
    dogecoin: 'sat',
    'bitcoin-cash': 'sat',
    zcash: 'zat'
  };

  /* EVM chains share one JSON-RPC method; the primary URL per chain comes
   * from data/providers.json through the generated globals. */
  var RPC = {};
  SSOT_PROVIDERS.groups['evm-mainnet'].forEach(function (slug) {
    RPC[slug] = SSOT_PROVIDERS.first(slug).url;
  });

  function evmConfig() {
    return {
      types: [
        {
          value: 'legacy',
          label: 'Address',
          desc: '0x…',
          field: 'evm',
          path: "m/44'/60'/0'/0/0"
        }
      ],
      presets: [
        { id: 'master', label: 'Master Key', path: 'm', desc: 'BIP-32 root' },
        { id: 'bip44', label: 'BIP44', path: "m/44'/60'/0'/0/0", desc: '0x...' }
      ]
    };
  }

  var CHAINS = {
    bitcoin: {
      types: [
        { value: 'legacy', label: 'Legacy', desc: 'P2PKH', field: 'btc_p2pkh', path: "m/44'/0'/0'/0/0" },
        { value: 'segwit', label: 'SegWit', desc: 'P2WPKH', field: 'btc_p2wpkh', path: "m/84'/0'/0'/0/0" },
        { value: 'script', label: 'Nested SegWit', desc: 'P2SH', field: 'btc_p2sh_p2wpkh', path: "m/49'/0'/0'/0/0" },
        { value: 'taproot', label: 'Taproot', desc: 'P2TR', field: 'btc_p2tr', path: "m/86'/0'/0'/0/0" }
      ],
      presets: [
        { id: 'master', label: 'Master Key', path: 'm', desc: 'BIP-32 root' },
        { id: 'bip44', label: 'BIP44 Legacy', path: "m/44'/0'/0'/0/0", desc: '1...' },
        { id: 'bip84', label: 'BIP84 SegWit', path: "m/84'/0'/0'/0/0", desc: 'bc1q...' },
        { id: 'bip49', label: 'BIP49 Nested', path: "m/49'/0'/0'/0/0", desc: '3...' },
        { id: 'bip86', label: 'BIP86 Taproot', path: "m/86'/0'/0'/0/0", desc: 'bc1p...' }
      ]
    },
    ethereum: evmConfig(),
    bnb: evmConfig(),
    arbitrum: evmConfig(),
    optimism: evmConfig(),
    base: evmConfig(),
    polygon: evmConfig(),
    avalanche: evmConfig(),
    zksync: evmConfig(),
    solana: {
      types: [
        { value: 'legacy', label: 'Address', desc: 'base58', field: 'solana', path: "m/44'/501'/0'/0'" }
      ],
      presets: [
        { id: 'master', label: 'Master Key', path: 'm', desc: 'BIP-32 root' },
        { id: 'phantom', label: 'Phantom · BIP44', path: "m/44'/501'/0'/0'", desc: 'base58' }
      ]
    },
    tron: {
      types: [
        { value: 'legacy', label: 'Address', desc: 'T…', field: 'tron', path: "m/44'/195'/0'/0/0" }
      ],
      presets: [
        { id: 'master', label: 'Master Key', path: 'm', desc: 'BIP-32 root' },
        { id: 'bip44', label: 'BIP44', path: "m/44'/195'/0'/0/0", desc: 'T...' }
      ]
    },
    xrp: {
      types: [
        { value: 'legacy', label: 'Classic', desc: 'r…', field: 'xrp_classic', path: "m/44'/144'/0'/0/0" }
      ],
      presets: [
        { id: 'master', label: 'Master Key', path: 'm', desc: 'BIP-32 root' },
        { id: 'bip44', label: 'BIP44', path: "m/44'/144'/0'/0/0", desc: 'r...' }
      ]
    },
    litecoin: {
      types: [
        { value: 'legacy', label: 'Legacy', desc: 'P2PKH · L…', field: 'ltc_p2pkh', path: "m/44'/2'/0'/0/0" },
        { value: 'segwit', label: 'SegWit', desc: 'P2WPKH · ltc1q…', field: 'ltc_p2wpkh', path: "m/84'/2'/0'/0/0" },
        { value: 'script', label: 'Nested SegWit', desc: 'P2SH · M…', field: 'ltc_p2sh_p2wpkh', path: "m/49'/2'/0'/0/0" }
      ],
      presets: [
        { id: 'master', label: 'Master Key', path: 'm', desc: 'BIP-32 root' },
        { id: 'bip84', label: 'BIP84', path: "m/84'/2'/0'/0/0", desc: 'ltc1q...' },
        { id: 'bip44', label: 'BIP44', path: "m/44'/2'/0'/0/0", desc: 'L...' }
      ]
    },
    dogecoin: {
      types: [{ value: 'legacy', label: 'Legacy', desc: 'P2PKH · D…', field: 'doge_p2pkh', path: "m/44'/3'/0'/0/0" }],
      presets: [
        { id: 'master', label: 'Master Key', path: 'm', desc: 'BIP-32 root' },
        { id: 'bip44', label: 'BIP44', path: "m/44'/3'/0'/0/0", desc: 'D...' }
      ]
    },
    'bitcoin-cash': {
      types: [{ value: 'legacy', label: 'Legacy', desc: 'P2PKH · 1…', field: 'bch_legacy', path: "m/44'/145'/0'/0/0" }],
      presets: [
        { id: 'master', label: 'Master Key', path: 'm', desc: 'BIP-32 root' },
        { id: 'bip44-bch', label: 'BIP44 BCH', path: "m/44'/145'/0'/0/0", desc: '1...' },
        { id: 'bip44-btc', label: 'BIP44 BTC', path: "m/44'/0'/0'/0/0", desc: '1...' }
      ]
    },
    zcash: {
      types: [{ value: 'legacy', label: 'Transparent', desc: 't1…', field: 'zcash_p2pkh', path: "m/44'/133'/0'/0/0" }],
      presets: [
        { id: 'master', label: 'Master Key', path: 'm', desc: 'BIP-32 root' },
        { id: 'bip44', label: 'BIP44', path: "m/44'/133'/0'/0/0", desc: 't1...' }
      ]
    },
    sui: {
      types: [{ value: 'legacy', label: 'Address', desc: '0x…', field: 'sui', path: "m/44'/784'/0'/0'/0'" }],
      presets: [
        { id: 'master', label: 'Master Key', path: 'm', desc: 'BIP-32 root' },
        { id: 'bip44', label: 'BIP44', path: "m/44'/784'/0'/0'/0'", desc: '0x...' }
      ]
    },
    /* TON derives ed25519 keys with SLIP-0010 at the donor's path
     * m/44'/607'/0'. Wallet v4R2 needs the wallet contract builder in
     * /ton.js (loaded lazily on this page only); W5 comes from the WASM
     * report as `ton_w5`. */
    ton: {
      types: [
        { value: 'ton', label: 'Wallet v4R2', desc: 'EQ…', field: 'ton', path: "m/44'/607'/0'" },
        { value: 'ton_w5', label: 'Wallet W5', desc: 'EQ…/UQ…', field: 'ton_w5', path: "m/44'/607'/0'" }
      ],
      presets: [
        { id: 'master', label: 'Master Key', path: 'm', desc: 'BIP-32 root' },
        { id: 'tonkeeper', label: 'Tonkeeper', path: "m/44'/607'/0'", desc: 'V4/W5' }
      ]
    }
  };

  /* Copy and key helpers are pure enough to test under Node: the directory
   * page exports them before the chain guard below. Copying happens only on
   * an explicit click; nothing is stored, logged or put into the URL. */

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

  function copyText(text, button) {
    var label = button && button.getAttribute ? button.getAttribute('aria-label') : '';
    function done() {
      if (!button || !button.classList) return;
      button.classList.add('is-copied');
      if (label) button.setAttribute('aria-label', 'Copied');
      window.setTimeout(function () {
        button.classList.remove('is-copied');
        if (label) button.setAttribute('aria-label', label);
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

  /* The row's key cell links the derived hex private key. The donor's seed
   * directory does not show WIF forms; the key page derives those. */
  function privateKeyFor(chainName, report) {
    if (!report) return '';
    return report.priv_hex || '';
  }

  function privateKeyHref(chainName, key) {
    return key ? '/key/' + encodeURIComponent(key) : '';
  }

  /* Query string for one seed-directory URL. `bits=128` and the chain's
   * default address type are omitted, as in the donor; a preset is preferred
   * over a custom path. */
  function directoryQuery(opts) {
    var options = opts || {};
    var params = new URLSearchParams();
    if (options.bits && options.bits !== 128) params.set('bits', String(options.bits));
    if (options.type && options.type !== (options.defaultType || 'legacy')) {
      params.set('type', options.type);
    }
    if (options.preset) params.set('preset', options.preset);
    else if (options.path) params.set('path', options.path);
    var query = params.toString();
    return query ? '?' + query : '';
  }

  /* Address lines for one seed row: Bitcoin legacy keeps the compressed and
   * uncompressed forms, every other selection has a single address. */
  function addressEntriesFor(chain, type, map, field) {
    var entries = [];
    if (!map) return entries;
    if (chain === 'bitcoin' && type === 'legacy') {
      if (map.btc_p2pkh) entries.push({ prefix: 'c', address: map.btc_p2pkh });
      if (map.btc_p2pkh_uncompressed) entries.push({ prefix: 'u', address: map.btc_p2pkh_uncompressed });
    } else if (map[field]) {
      entries.push({ prefix: '', address: map[field] });
    }
    return entries;
  }

  /* The phrase is public list data, but 12-24 words per row is a wall of
   * text. Rows start with the first two and last word and expand on demand;
   * nothing is hidden from the copy button, which always gets entry.phrase. */
  function compactPhrase(phrase) {
    var words = String(phrase || '').trim().split(/\s+/).filter(Boolean);
    if (words.length <= 3) return words.join(' ');
    return words[0] + ' ' + words[1] + ' … ' + words[words.length - 1];
  }

  window.RotorMnemonicSeeds = {
    copyText: copyText,
    privateKeyFor: privateKeyFor,
    privateKeyHref: privateKeyHref,
    directoryQuery: directoryQuery,
    addressEntriesFor: addressEntriesFor,
    compactPhrase: compactPhrase,
    receivedText: receivedText,
    providerMetaFor: providerMetaFor,
    chainConfig: function (name) { return CHAINS[name] || null; },
    solanaBatchBody: solanaBatchBody
  };

  var root = document.querySelector('.mnemonic-seeds-page');
  if (!root) return;

  var chain = root.getAttribute('data-chain') || '';
  if (!chain) return; // directory mode: the static page lists the chains.

  document.body.classList.remove('mnemonic-directory-mode');
  document.body.classList.add('mnemonic-chain-mode');

  var config = CHAINS[chain];
  var balanceLabel = document.getElementById('mnemonic-balance-label');
  if (balanceLabel) {
    var unit = SSOT_CHAINS.bySlug[chain] || SSOT_CHAINS.bySlug.bitcoin;
    balanceLabel.textContent = (root.getAttribute('data-symbol') || unit.symbol) + ' Balance';
  }
  var byId = function (id) { return document.getElementById(id); };
  var rowsEl = byId('mnemonic-rows');
  var errorBox = byId('mnemonic-error');
  var noteText = byId('mnemonic-note-text');
  var deriveText = byId('mnemonic-derive-text');
  var deriveBar = byId('mnemonic-derive-bar');
  var deriveProgress = byId('mnemonic-derive-progress');
  var pageNumberEl = byId('mnemonic-page-number');
  var totalPagesEl = byId('mnemonic-total-pages');
  var pagePercentEl = byId('mnemonic-page-percent');
  var pageBar = byId('mnemonic-page-bar');
  var pageProgress = byId('mnemonic-page-progress');
  var pathInput = byId('mnemonic-path-input');
  var bitsSelect = byId('mnemonic-bits');
  var presetsEl = byId('mnemonic-path-presets');
  var applyButton = byId('mnemonic-path-apply');
  var typeCards = byId('mnemonic-type-cards');
  var pageInput = byId('mnemonic-page-input');
  var refreshButton = byId('mnemonic-balance-refresh');
  var refreshCount = byId('mnemonic-balance-refresh-count');
  var refreshStatus = byId('mnemonic-balance-refresh-status');
  var cacheApi = window.RotorBalanceCache || null;
  var cacheStore = cacheApi ? cacheApi.createStore() : Promise.resolve(null);
  var BALANCE_JITTER_MS = 400;

  /* Read at call time so the shared module may load before or after this one. */
  function balanceProvidersApi() {
    return window.RotorBalanceProviders || null;
  }

  var state = {
    disposed: false,
    wasmPromise: null,
    tonPromise: null,
    tonError: null,
    entries: [],
    cached: {},
    balanceBusy: false,
    run: 0,
    balanceRun: 0
  };

  function fail(message) {
    if (!errorBox) return;
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  }

  function setNote(message, isError) {
    if (!noteText) return;
    noteText.textContent = message;
    noteText.classList.toggle('err', Boolean(isError));
  }

  /* ------------------------------------------------------------ routes */

  var params = new URLSearchParams(window.location.search);
  var bits = Number(params.get('bits'));
  if (bits !== 192 && bits !== 256) bits = 128;
  var entropyBytes = bits / 8;

  var typeValue = params.get('type') || '';
  var activeType = null;
  (config && config.types ? config.types : []).forEach(function (kind) {
    if (kind.value === typeValue) activeType = kind;
  });
  if (!activeType) activeType = config && config.types.length ? config.types[0] : null;
  var defaultTypeValue = config && config.types.length ? config.types[0].value : 'legacy';

  var presetId = params.get('preset') || '';
  var explicitPreset = Boolean(presetId);
  var customPath = params.get('path') || '';
  var presets = config && config.presets ? config.presets : [];
  var activePreset = null;
  presets.forEach(function (preset) {
    if (preset.id === presetId) activePreset = preset;
  });
  var activePath = customPath
    || (activePreset ? activePreset.path : (activeType ? activeType.path : ''));
  if (!customPath && !activePreset) {
    presets.forEach(function (preset) {
      if (preset.path === activePath) activePreset = preset;
    });
  }

  var requestedPage = parseBigInt(root.getAttribute('data-page') || '1');
  var totalEntropy = 1n << BigInt(bits);
  var totalPages = (totalEntropy + ROWS_PER_PAGE - 1n) / ROWS_PER_PAGE;
  var page = requestedPage < 1n ? 1n : requestedPage > totalPages ? totalPages : requestedPage;

  function parseBigInt(text) {
    var value = String(text || '').trim();
    if (!/^\d+$/.test(value)) return 1n;
    try {
      return BigInt(value);
    } catch (err) {
      return 1n;
    }
  }

  function formatCount(value) {
    var text = value.toString();
    if (text.length <= 12) return text;
    return Number(value).toExponential(2).replace('e+', 'E+');
  }

  function pageHref(targetPage, overrides, explicitPage) {
    var changes = overrides || {};
    var nextBits = changes.bits !== undefined ? changes.bits : bits;
    var nextType = changes.type !== undefined ? changes.type : activeType.value;
    var nextPreset = changes.preset !== undefined
      ? changes.preset
      : (activePreset ? activePreset.id : '');
    var nextPath = changes.path !== undefined
      ? changes.path
      : (changes.preset !== undefined ? '' : customPath);
    var defaultPresetId = '';
    presets.forEach(function (preset) {
      if (preset.path === activeType.path) defaultPresetId = preset.id;
    });
    var presetExplicit = changes.preset !== undefined
      ? Boolean(changes.preset)
      : explicitPreset;
    if (nextPreset && nextPreset === defaultPresetId && !nextPath && !presetExplicit) {
      nextPreset = '';
    }
    var base = targetPage <= 1n && !explicitPage
      ? '/mnemonic-seeds/' + chain
      : '/mnemonic-seeds/' + chain + '/' + targetPage.toString();
    return base + directoryQuery({
      bits: nextBits,
      type: nextType,
      defaultType: defaultTypeValue,
      preset: nextPreset,
      path: nextPath
    });
  }

  /* ------------------------------------------------------------- paths */

  function pathSegments(text, requireHardened) {
    var value = String(text || '').trim();
    if (!/^[mM](?:\/\d+'?)*$/.test(value)) {
      throw new Error("Path must look like m/44'/0'/0'/0/0.");
    }
    if (value === 'm' || value === 'M') return [];
    return value.slice(2).split('/').map(function (part) {
      var hardened = part.charAt(part.length - 1) === "'";
      var digits = hardened ? part.slice(0, -1) : part;
      var index = Number(digits);
      if (!Number.isSafeInteger(index) || index >= 2147483648) {
        throw new Error('Invalid path index: ' + part);
      }
      if (requireHardened && !hardened) {
        throw new Error("ed25519 paths must be hardened, for example m/44'/501'/0'/0'.");
      }
      return { index: index, hardened: hardened };
    });
  }

  /* ------------------------------------------------------------- crypto */

  function hexToBytes(hex) {
    var length = hex.length / 2;
    var out = new Uint8Array(length);
    for (var i = 0; i < length; i += 1) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  function bytesToHex(bytes) {
    return Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function entropyHex(index, byteLength) {
    var hex = index.toString(16);
    if (hex.length > byteLength * 2) {
      throw new Error('Seed index is outside the selected word count.');
    }
    return hex.padStart(byteLength * 2, '0');
  }

  async function hmacSha512(keyBytes, dataBytes) {
    var key = await window.crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-512' },
      false,
      ['sign']
    );
    var signature = await window.crypto.subtle.sign('HMAC', key, dataBytes);
    return new Uint8Array(signature);
  }

  /* SLIP-0010 ed25519: every child key is hardened. */
  async function slip10(seed, pathText) {
    var segments = pathSegments(pathText, true);
    var master = await hmacSha512(ED_SEED_KEY, seed);
    var key = master.slice(0, 32);
    var chainCode = master.slice(32);
    for (var i = 0; i < segments.length; i += 1) {
      var index = (segments[i].index + 0x80000000) >>> 0;
      var data = new Uint8Array(37);
      data[0] = 0;
      data.set(key, 1);
      data[33] = (index >>> 24) & 0xff;
      data[34] = (index >>> 16) & 0xff;
      data[35] = (index >>> 8) & 0xff;
      data[36] = index & 0xff;
      var child = await hmacSha512(chainCode, data);
      key = child.slice(0, 32);
      chainCode = child.slice(32);
    }
    return key;
  }

  /* --------------------------------------------------------------- wasm */

  function loadWasm() {
    if (state.wasmPromise) return state.wasmPromise;
    state.wasmPromise = (async function () {
      var response = await fetch(WASM_URL);
      if (!response.ok) throw new Error('Cannot load the derivation core: HTTP ' + response.status);
      var module;
      try {
        module = await WebAssembly.instantiateStreaming(response.clone(), {});
      } catch (err) {
        module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      }
      return module.instance ? module.instance.exports : module.exports;
    })();
    state.wasmPromise.catch(function () { state.wasmPromise = null; });
    return state.wasmPromise;
  }

  function readString(wasm, ptr, length) {
    if (!ptr || !length) return '';
    return DECODER.decode(new Uint8Array(wasm.memory.buffer, ptr, length));
  }

  function reportFor(wasm, keyHex, curve) {
    var bytes = hexToBytes(keyHex);
    var ptr = wasm.alloc(bytes.length) >>> 0;
    if (!ptr) throw new Error('WASM memory exhausted.');
    try {
      new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
      var status = wasm.derive_report(ptr, curve) >>> 0;
      if (status !== 0) {
        var detail = readString(wasm, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0);
        throw new Error(detail || ('derivation status ' + status));
      }
      return JSON.parse(readString(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0));
    } finally {
      wasm.dealloc(ptr, bytes.length);
    }
  }

  /* TON v4R2 addresses are built from the ed25519 public key by /ton.js.
   * The bundle is ~220 KB, so it is fetched lazily and only on the TON page;
   * a rejected promise is dropped so a later attempt may retry. */
  function loadTon() {
    if (window.RotorTon) return Promise.resolve(window.RotorTon);
    if (state.tonPromise) return state.tonPromise;
    state.tonPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = window.RotorAssets && typeof window.RotorAssets.url === 'function'
        ? window.RotorAssets.url('/ton.js')
        : '/ton.js';
      script.async = true;
      script.onload = function () {
        if (window.RotorTon) resolve(window.RotorTon);
        else reject(new Error('The TON wallet library did not load.'));
      };
      script.onerror = function () { reject(new Error('Cannot load /ton.js.')); };
      document.head.appendChild(script);
    });
    state.tonPromise.catch(function () { state.tonPromise = null; });
    return state.tonPromise;
  }

  function addressMap(report) {
    var map = {};
    if (!report || !Array.isArray(report.addresses)) return map;
    report.addresses.forEach(function (entry) {
      if (entry && entry.id) map[entry.id] = entry.address || '';
    });
    return map;
  }

  /* ------------------------------------------------------------ rendering */

  function explorerUrl(address) {
    var prefix = root.getAttribute('data-explorer') || '';
    return prefix ? prefix + encodeURIComponent(address) : '';
  }

  function renderPageInfo() {
    if (pageNumberEl) pageNumberEl.textContent = '#' + formatCount(page);
    if (totalPagesEl) totalPagesEl.textContent = '#' + formatCount(totalPages);
    var percent = totalPages > 0n ? (Number(page) / Number(totalPages)) * 100 : 0;
    var text = percent.toFixed(4) + '%';
    if (pagePercentEl) pagePercentEl.textContent = text;
    if (pageBar) pageBar.style.width = text;
    if (pageProgress) {
      pageProgress.setAttribute('aria-valuenow', percent.toFixed(2));
    }
    if (pageInput) pageInput.value = page.toString();
  }

  function renderPager() {
    var first = byId('mnemonic-first');
    var prev = byId('mnemonic-prev');
    var next = byId('mnemonic-next');
    var last = byId('mnemonic-last');
    var random = byId('mnemonic-random');
    var previousPage = page > 1n ? page - 1n : 1n;
    var nextPage = page < totalPages ? page + 1n : page;
    if (first) setPager(first, pageHref(1n), page <= 1n);
    // The donor's Previous link points at `/1` even when already on page 1.
    if (prev) setPager(prev, pageHref(previousPage, null, page <= 1n), page <= 1n);
    if (next) setPager(next, pageHref(nextPage), page >= totalPages);
    if (last) setPager(last, pageHref(totalPages), page >= totalPages);
    if (random) {
      var sample = new Uint8Array(32);
      window.crypto.getRandomValues(sample);
      var value = BigInt('0x' + bytesToHex(sample)) % totalPages + 1n;
      setPager(random, pageHref(value), false);
    }
  }

  function setPager(link, href, disabled) {
    link.setAttribute('href', href);
    link.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    if (disabled) {
      link.addEventListener('click', function (event) { event.preventDefault(); });
    }
  }

  function renderBits() {
    if (bitsSelect) bitsSelect.value = String(bits);
  }

  function renderTypeCards() {
    if (!typeCards) return;
    typeCards.textContent = '';
    config.types.forEach(function (kind) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'address-type-card' + (kind === activeType ? ' active' : '');
      var name = document.createElement('span');
      name.className = 'type-name';
      name.textContent = kind.label;
      var desc = document.createElement('span');
      desc.className = 'type-desc';
      desc.textContent = kind.desc;
      button.appendChild(name);
      button.appendChild(desc);
      button.addEventListener('click', function () {
        // Keep the current page, preset and path; only the address type changes.
        window.location.assign(pageHref(page, { type: kind.value }));
      });
      typeCards.appendChild(button);
    });
  }

  function renderPresets() {
    if (!presetsEl) return;
    presetsEl.textContent = '';
    presets.forEach(function (preset) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset-btn chip';
      button.title = preset.desc ? preset.desc + ' · ' + preset.path : preset.path;
      button.textContent = preset.label;
      button.setAttribute('aria-pressed', activePreset === preset ? 'true' : 'false');
      button.addEventListener('click', function () {
        window.location.assign(pageHref(page, { preset: preset.id, path: '' }));
      });
      presetsEl.appendChild(button);
    });
  }

  function applyPath() {
    var value = pathInput.value.trim();
    try {
      pathSegments(value, Number(root.getAttribute('data-curve')) === 1);
    } catch (err) {
      fail(err.message);
      return;
    }
    window.location.assign(pageHref(page, { path: value, preset: '' }));
  }

  function iconUse(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/icons.svg#' + name);
    svg.appendChild(use);
    return svg;
  }

  function iconButton(iconId, label, handler) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button icon-button--quiet icon-button--lg';
    button.setAttribute('data-tooltip', label);
    button.setAttribute('aria-label', label);
    button.appendChild(iconUse(iconId));
    button.addEventListener('click', handler);
    return button;
  }

  function createRow(entry) {
    var row = document.createElement('div');
    row.className = 'key-row mnemonic-row';
    /* Balance instrumentation lives on the row element, matching browse.js:
     * a verifier can select [data-balance-state] on both directories. */
    entry.row = row;

    var keyCell = document.createElement('div');
    keyCell.className = 'col-key';
    var seed = document.createElement('span');
    seed.className = 'mnemonic-seed key-label';
    seed.textContent = 'Seed #' + entry.index.toString();
    keyCell.appendChild(seed);
    var keyLink = document.createElement('a');
    keyLink.className = 'private-key mono mnemonic-key';
    keyLink.textContent = 'Deriving…';
    keyCell.appendChild(keyLink);
    var keyCopy = iconButton('ui-copy', 'Copy private key', function () {
      if (entry.key) copyText(entry.key, keyCopy);
    });
    keyCopy.disabled = true;
    keyCell.appendChild(keyCopy);

    var address = document.createElement('div');
    address.className = 'col-address';
    var pending = document.createElement('span');
    pending.className = 'cell-skeleton';
    pending.textContent = 'Calculating…';
    address.appendChild(pending);

    var balance = document.createElement('div');
    balance.className = 'col-balance';
    balance.textContent = '-';

    var mnemonic = document.createElement('div');
    mnemonic.className = 'col-mnemonic';
    var mnemonicLabel = document.createElement('span');
    mnemonicLabel.className = 'mnemonic-label key-label';
    mnemonicLabel.textContent = 'Mnemonic';
    var mnemonicText = document.createElement('span');
    mnemonicText.className = 'mnemonic-text';
    mnemonicText.textContent = 'Deriving…';
    var mnemonicCopy = iconButton('ui-copy', 'Copy mnemonic', function () {
      if (entry.phrase) copyText(entry.phrase, mnemonicCopy);
    });
    mnemonicCopy.disabled = true;
    mnemonic.appendChild(mnemonicLabel);
    mnemonic.appendChild(mnemonicText);
    mnemonic.appendChild(mnemonicCopy);

    row.appendChild(keyCell);
    row.appendChild(address);
    row.appendChild(balance);
    row.appendChild(mnemonic);
    rowsEl.appendChild(row);
    entry.keyLink = keyLink;
    entry.keyCopy = keyCopy;
    entry.addressCell = address;
    entry.balanceCell = balance;
    entry.phraseText = mnemonicText;
    entry.phraseCopy = mnemonicCopy;
  }

  function fillRow(entry) {
    entry.phraseText.textContent = entry.phrase;
    entry.phraseText.title = entry.phrase;
    entry.phraseCopy.disabled = false;
    entry.key = privateKeyFor(chain, entry.report);
    if (entry.key) {
      entry.keyLink.href = entry.keyHref;
      entry.keyLink.textContent = entry.key;
      entry.keyLink.title = entry.key;
      entry.keyCopy.disabled = false;
    }
    entry.addressCell.textContent = '';
    var entries = addressEntriesFor(chain, activeType.value, entry.addressMap, activeType.field);
    entry.addresses = entries;
    if (!entries.length) {
      entry.addressCell.textContent = 'Not available for this address type.';
      return;
    }
    entries.forEach(function (item) {
      var line = document.createElement('div');
      line.className = 'mnemonic-addr-line';
      if (item.prefix) {
        var prefix = document.createElement('span');
        prefix.className = 'addr-label';
        prefix.textContent = '(' + item.prefix + ')';
        line.appendChild(prefix);
      }
      var link = document.createElement('a');
      link.className = 'mono address-link';
      link.href = explorerUrl(item.address) || '#';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = item.address;
      link.title = item.address;
      line.appendChild(link);
      entry.addressCell.appendChild(line);
    });
  }

  function fillRowError(entry, err) {
    resetPhrase(entry);
    entry.addressCell.textContent = err && err.message ? err.message : 'Derivation failed.';
  }

  function resetPhrase(entry) {
    if (entry.phraseText) entry.phraseText.textContent = '-';
    if (entry.phraseCopy) entry.phraseCopy.disabled = true;
  }

  function setDeriveProgress(done, total) {
    var percent = total ? Math.round((done / total) * 100) : 0;
    if (deriveBar) deriveBar.style.width = percent + '%';
    if (deriveProgress) deriveProgress.setAttribute('aria-valuenow', String(percent));
    if (deriveText) deriveText.textContent = 'Deriving seed ' + done + ' of ' + total + '…';
  }

  /* ------------------------------------------------------------- balances */

  /* The donor shows a tiny Received amount in atomic units (`sat`, `zat` for
   * Zcash); Balance always stays in the native unit. The donor doc records only
   * "small", not the constant: 0.0001 coin (10,000 sat) is the cut used here,
   * above which the native unit stays readable. */
  function receivedText(value, decimals, symbol, chainName) {
    return AMOUNT.receivedText(value, decimals, symbol, ATOMIC_UNITS[chainName]);
  }

  /* Balance provider for a chain name. Pure (no captured page state) so the
   * Node test can assert it without a DOM; `providerMeta` binds the page.
   * LTC, DOGE and ZEC read SoChain per address (2500 requests/hour keyless,
   * CORS), so a 60-row page uses ~2.4% of the provider budget. */
  function providerMetaFor(chainName, evmSymbol) {
    var meta = SSOT_CHAINS.bySlug[chainName];
    if (!meta) return null;
    if (chainName === 'bitcoin') {
      return { provider: 'blockchain.info', chain: 'bitcoin', decimals: meta.decimals, symbol: meta.symbol };
    }
    if (RPC[chainName]) {
      return { provider: 'evm', chain: chainName, decimals: meta.decimals, symbol: evmSymbol || meta.symbol };
    }
    if (chainName === 'solana') {
      return { provider: 'solana', chain: 'solana', decimals: meta.decimals, symbol: meta.symbol };
    }
    if (chainName === 'bitcoin-cash') {
      return { provider: 'haskoin-bch', chain: 'bitcoin-cash', decimals: 8, symbol: 'BCH' };
    }
    if (chainName === 'litecoin' || chainName === 'dogecoin' || chainName === 'zcash') {
      return { provider: 'sochain', chain: chainName, decimals: meta.decimals, symbol: meta.symbol };
    }
    if (chainName === 'tron') {
      return { provider: 'tronscan', chain: 'tron', decimals: 6, symbol: 'TRX' };
    }
    if (chainName === 'xrp') {
      return { provider: 'xrpscan', chain: 'xrp', decimals: 6, symbol: 'XRP' };
    }
    if (chainName === 'sui') {
      return { provider: 'sui', chain: 'sui', decimals: 9, symbol: 'SUI' };
    }
    if (chainName === 'ton') {
      return { provider: 'tonapi', chain: 'ton', decimals: 9, symbol: 'TON' };
    }
    return null;
  }

  function providerMeta() {
    return providerMetaFor(chain, root.getAttribute('data-symbol') || '');
  }

  /* One `.balance-info` line per derived address, packed with the balance,
   * TX count and received amount as in the donor's seed directory. */
  function balanceLine(record, cached, errors, meta) {
    var line = document.createElement('div');
    line.className = 'balance-info';
    if (errors && errors[record.address]) {
      line.classList.add('err');
      line.textContent = 'unavailable ';
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'icon-button icon-button--outline icon-button--lg';
      retry.setAttribute('data-tooltip', 'Retry this balance');
      retry.setAttribute('aria-label', 'Retry balance check for this address');
      retry.appendChild(iconUse('ui-retry'));
      retry.addEventListener('click', function () {
        loadBalances({ manual: true, onlyEntries: [record.entry], force: true });
      });
      line.appendChild(retry);
      return { line: line, ok: false, failed: true };
    }
    var picked = cached[record.key];
    if (!cacheApi || !cacheApi.isSuccess(picked)) {
      line.textContent = '-';
      return { line: line, ok: false, failed: false };
    }
    var value = picked.value || {};
    var balance = document.createElement('span');
    balance.className = 'bal';
    balance.textContent = AMOUNT.coin(value.balance, meta.decimals) + ' ' + meta.symbol;
    line.appendChild(balance);
    if (value.tx !== undefined && value.tx !== null) {
      var tx = document.createElement('span');
      tx.className = 'tx' + (Number(value.tx) > 0 ? ' has-tx' : '');
      tx.textContent = value.tx + ' tx';
      line.appendChild(tx);
    }
    if (value.received !== undefined && value.received !== null) {
      var recv = document.createElement('span');
      recv.className = 'recv' + (Number(value.received) > 0 ? ' has-recv' : '');
      recv.textContent = '↓ ' + receivedText(value.received, meta.decimals, meta.symbol, chain);
      line.appendChild(recv);
    }
    line.title = value.balance + ' ' + meta.symbol;
    return { line: line, ok: true, failed: false };
  }

  function setBalanceState(entry, stateName, cachedEntry) {
    if (!entry.row) return;
    entry.row.dataset.balanceState = stateName;
    entry.row.dataset.balanceAt = String(cachedEntry && cachedEntry.fetchedAt ? cachedEntry.fetchedAt : '');
  }

  function renderEntry(entry, cached, errors, meta) {
    var cell = entry.balanceCell;
    if (!cell) return;
    cell.textContent = '';
    if (!entry.records || !entry.records.length) {
      cell.textContent = '-';
      entry.balanceState = 'missing';
      setBalanceState(entry, 'missing', null);
      return;
    }
    var now = Date.now();
    var ok = false;
    var failed = false;
    var fresh = true;
    entry.records.forEach(function (record) {
      var result = balanceLine(record, cached, errors, meta);
      if (result.ok) ok = true;
      if (result.failed) failed = true;
      var picked = cached[record.key];
      if (!cacheApi || !cacheApi.isFresh(picked, meta.provider, now)) fresh = false;
      cell.appendChild(result.line);
    });
    cell.classList.toggle('has-balance', ok);
    entry.balanceState = failed ? 'err' : ok ? (fresh ? 'ok' : 'stale') : 'missing';
    var first = entry.records.length ? cached[entry.records[0].key] : null;
    setBalanceState(entry, entry.balanceState, first);
  }

  function errorMessage(err) {
    return err && err.message ? err.message : 'Balance unavailable.';
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

  function balanceRecords(meta) {
    var records = [];
    state.entries.forEach(function (entry) {
      entry.records = [];
      (entry.addresses || []).forEach(function (item) {
        if (!item.address) return;
        var record = {
          entry: entry,
          address: item.address,
          key: cacheApi ? cacheApi.cacheKey(meta.provider, meta.chain, item.address) : item.address
        };
        entry.records.push(record);
        records.push(record);
      });
    });
    return records;
  }

  async function readCached(records) {
    var out = {};
    if (!cacheApi) return out;
    await Promise.all(records.map(async function (record) {
      out[record.key] = await cacheGet(record.key);
    }));
    return out;
  }

  function renderSummary(records, cached, meta) {
    // Lamport totals stay exact for Solana, as EVM wei does.
    var big = meta.provider === 'evm' || meta.provider === 'solana';
    var sumBig = 0n;
    var sumNum = 0;
    var receivedBig = 0n;
    var received = 0;
    var tx = 0;
    var any = false;
    var hasReceived = false;
    var hasTx = false;
    records.forEach(function (record) {
      var entry = cached[record.key];
      if (!cacheApi || !cacheApi.isSuccess(entry)) return;
      var value = entry.value || {};
      any = true;
      if (big) sumBig += BigInt(value.balance || 0);
      else sumNum += Number(value.balance || 0);
      if (value.received !== undefined) {
        if (big) receivedBig += BigInt(value.received || 0);
        else received += Number(value.received);
        hasReceived = true;
      }
      if (value.tx !== undefined) {
        tx += Number(value.tx);
        hasTx = true;
      }
    });
    if (!any) {
      setSummary('—', '—', '—');
      return;
    }
    setSummary(
      AMOUNT.coin(big ? sumBig : sumNum, meta.decimals) + ' ' + meta.symbol,
      hasReceived ? receivedText(big ? receivedBig : received, meta.decimals, meta.symbol, chain) : '—',
      hasTx ? String(tx) : '—'
    );
  }

  function setSummary(balance, received, tx) {
    var balanceEl = byId('mnemonic-total-balance');
    var receivedEl = byId('mnemonic-total-received');
    var txEl = byId('mnemonic-total-tx');
    if (balanceEl) balanceEl.textContent = balance;
    if (receivedEl) receivedEl.textContent = received;
    if (txEl) txEl.textContent = tx;
  }

  function refreshPendingCount(records, meta) {
    if (!meta) return 0;
    var now = Date.now();
    var count = 0;
    records.forEach(function (record) {
      if (record.entry.balanceState === 'err') {
        count += 1;
        return;
      }
      if (!cacheApi) {
        count += 1;
        return;
      }
      if (cacheApi.shouldRefresh(state.cached[record.key], meta.provider, now)) count += 1;
    });
    return count;
  }

  function updateRefreshButton(records, meta) {
    var count = refreshPendingCount(records || [], meta);
    if (refreshCount) refreshCount.textContent = String(count);
    if (refreshButton) {
      refreshButton.disabled = !meta || count === 0 || state.balanceBusy;
      refreshButton.setAttribute(
        'aria-label',
        'Refresh ' + count + ' failed or stale ' + (count === 1 ? 'balance' : 'balances')
      );
      refreshButton.classList.toggle('busy', Boolean(state.balanceBusy));
    }
    if (refreshStatus) {
      refreshStatus.textContent = count
        ? count + ' ' + (count === 1 ? 'balance needs' : 'balances need') + ' refresh'
        : 'All visible balances are fresh';
    }
  }

  function applyView(records, cached, meta, errors) {
    state.entries.forEach(function (entry) {
      if (entry.records) renderEntry(entry, cached, errors, meta);
    });
    renderSummary(records, cached, meta);
    updateRefreshButton(records, meta);
  }

  /* Thin views over the shared provider module so this page and the
   * private-key directory use one implementation. */
  function solanaBatchBody(addresses) {
    var api = balanceProvidersApi();
    return api ? api.solanaBatchBody(addresses) : null;
  }

  function fetchProvider(meta, addresses) {
    var api = balanceProvidersApi();
    if (!api) return Promise.resolve({ values: {}, errors: {} });
    return api.fetchProvider(meta, addresses);
  }

  async function fetchAndApply(records, pending, run, meta) {
    var addresses = [];
    pending.forEach(function (record) {
      if (addresses.indexOf(record.address) < 0) addresses.push(record.address);
    });
    if (!addresses.length) return;
    state.balanceBusy = true;
    pending.forEach(function (record) {
      if (record.entry && record.entry.row) record.entry.row.dataset.balanceState = 'loading';
    });
    updateRefreshButton(records, meta);
    var result;
    try {
      result = await fetchProvider(meta, addresses);
    } catch (err) {
      result = { values: {}, errors: {} };
      addresses.forEach(function (address) { result.errors[address] = errorMessage(err); });
    }
    if (state.disposed || run !== state.balanceRun) {
      state.balanceBusy = false;
      return;
    }
    var now = Date.now();
    var entries = {};
    records.forEach(function (record) {
      if (!cacheApi || result.values[record.address] === undefined) return;
      var entry = cacheApi.makeEntry(result.values[record.address], meta.provider, now);
      state.cached[record.key] = entry;
      entries[record.key] = entry;
    });
    await Promise.all(Object.keys(entries).map(function (key) {
      return cachePut(key, entries[key]);
    }));
    state.balanceBusy = false;
    applyView(records, state.cached, meta, result.errors);
    var failed = Object.keys(result.errors).length;
    setNote(
      failed
        ? 'Some balances could not be refreshed (' + failed + '); cached values stay visible.'
        : 'Balances loaded from public providers in your browser; only public addresses were sent.',
      failed > 0
    );
  }

  async function loadBalances(options) {
    var opts = options || {};
    var run = ++state.balanceRun;
    if (state.disposed) return;
    var meta = providerMeta();
    if (!meta) {
      state.entries.forEach(function (entry) { setBalanceState(entry, 'missing', null); });
      setSummary('—', '—', '—');
      setNote('Live balance lookup is not available for this chain here; each address links to its explorer.');
      updateRefreshButton([], null);
      return;
    }
    var records = balanceRecords(meta);
    if (!records.length) {
      state.entries.forEach(function (entry) { setBalanceState(entry, 'missing', null); });
      setSummary('—', '—', '—');
      setNote('No derived public address to send; nothing was sent. Each address links to its explorer.');
      updateRefreshButton([], meta);
      return;
    }
    var only = opts.onlyEntries && opts.onlyEntries.length ? opts.onlyEntries : null;
    var cached = await readCached(records);
    if (state.disposed || run !== state.balanceRun) return;
    state.cached = cached;
    applyView(records, cached, meta, null);
    var pending = records.filter(function (record) {
      if (only && only.indexOf(record.entry) < 0) return false;
      if (opts.force) return true;
      if (!cacheApi) return true;
      return cacheApi.shouldRefresh(cached[record.key], meta.provider, Date.now());
    });
    updateRefreshButton(records, meta);
    if (!pending.length) {
      setNote(opts.manual
        ? 'All selected balances are fresh; no request was sent.'
        : 'Balances loaded from the local cache; nothing was sent.');
      return;
    }
    setNote(opts.manual ? 'Refreshing failed or stale balances…' : 'Checking public balances in your browser…');
    if (!opts.manual) {
      var wait = cacheApi ? cacheApi.jitterDelay(BALANCE_JITTER_MS) : 0;
      await new Promise(function (resolve) { window.setTimeout(resolve, wait); });
      if (state.disposed || run !== state.balanceRun) return;
    }
    await fetchAndApply(records, pending, run, meta);
  }

  if (refreshButton) {
    refreshButton.addEventListener('click', function () {
      loadBalances({ manual: true });
    });
  }

  /* ----------------------------------------------------------------- boot */

  async function deriveEntry(entry, wasm) {
    var hex = entropyHex(entry.index, entropyBytes);
    var phrase = window.RotorSeed.entropyToMnemonic(hex);
    entry.phrase = phrase;
    var report;
    if (Number(root.getAttribute('data-curve')) === 1) {
      var seed = hexToBytes(window.RotorSeed.seedHex(phrase, ''));
      var key = await slip10(seed, activePath);
      report = reportFor(wasm, bytesToHex(key), 1);
    } else {
      var keyHex = window.RotorSeed.derive(phrase, '', activePath);
      report = reportFor(wasm, keyHex, 0);
    }
    entry.report = report;
    entry.addressMap = addressMap(report);
    if (chain === 'ton' && !entry.addressMap.ton) {
      /* W5 rows come from the WASM report; only the v4R2 row needs the
       * /ton.js bundle, so a failure must not blank the W5 page. */
      var needsV4 = activeType.field === 'ton';
      if (state.tonError && needsV4) throw state.tonError;
      if (!report || !report.ed_pubkey) {
        if (needsV4) throw new Error('The derivation report has no ed25519 public key.');
      } else if (!state.tonError) {
        try {
          var ton = await loadTon();
          entry.addressMap.ton = await ton.address(report.ed_pubkey);
        } catch (err) {
          state.tonError = err;
          if (needsV4) throw err;
        }
      }
    }
    entry.address = entry.addressMap[activeType.field] || '';
    entry.key = privateKeyFor(chain, report);
    entry.keyHref = privateKeyHref(chain, entry.key) +
      (Number(root.getAttribute('data-curve')) === 1 ? '?curve=ed25519' : '');
    fillRow(entry);
  }

  async function deriveAll(wasm) {
    var token = ++state.run;
    var total = state.entries.length;
    for (var i = 0; i < total; i += 3) {
      if (state.disposed || token !== state.run) return;
      var end = Math.min(i + 3, total);
      for (var j = i; j < end; j += 1) {
        try {
          await deriveEntry(state.entries[j], wasm);
        } catch (err) {
          fillRowError(state.entries[j], err);
        }
      }
      setDeriveProgress(end, total);
      await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
    }
    if (state.disposed || token !== state.run) return;
    if (deriveText) deriveText.textContent = 'Derived ' + total + ' seeds in this browser.';
    if (deriveBar) deriveBar.style.width = '100%';
    if (deriveProgress) deriveProgress.setAttribute('aria-valuenow', '100');
    loadBalances();
  }

  async function boot() {
    // Mark the active chain tab.
    Array.prototype.forEach.call(
      document.querySelectorAll('#mnemonic-chain-tabs .chain-tab'),
      function (tab) {
        if (tab.getAttribute('href') === '/mnemonic-seeds/' + chain) {
          tab.classList.add('active');
          tab.setAttribute('aria-current', 'page');
        }
      }
    );

    if (!config || config.unsupported) {
      var reason = config && config.unsupported
        ? config.unsupported
        : 'This chain is not part of the mnemonic seed directory yet.';
      document.body.classList.add('mnemonic-unsupported');
      fail(reason);
      if (deriveText) deriveText.textContent = 'Unsupported chain.';
      if (rowsEl) rowsEl.textContent = '';
      if (typeCards) typeCards.textContent = '';
      return;
    }

    if (!window.RotorSeed) {
      fail('The seed library did not load. Reload the page.');
      return;
    }

    try {
      pathSegments(activePath, Number(root.getAttribute('data-curve')) === 1);
    } catch (err) {
      fail(err.message);
      return;
    }

    if (Number(root.getAttribute('data-curve')) === 1 &&
        (!window.crypto || !window.crypto.subtle)) {
      fail('ed25519 derivation needs Web Crypto (HTTPS or localhost). Open this page over HTTPS.');
      return;
    }

    pathInput.value = activePath;
    renderPageInfo();
    renderPager();
    renderBits();
    renderTypeCards();
    renderPresets();
    if (bitsSelect) {
      bitsSelect.addEventListener('change', function () {
        var value = Number(bitsSelect.value);
        if (value !== 128 && value !== 192 && value !== 256) return;
        // A different word count changes the entropy space, so start at page 1.
        window.location.assign(pageHref(1n, { bits: value }));
      });
    }
    applyButton.addEventListener('click', applyPath);
    pathInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyPath();
      }
    });
    var jump = byId('mnemonic-jump');
    if (jump) {
      jump.addEventListener('submit', function (event) {
        event.preventDefault();
        var digits = (pageInput.value || '').replace(/[^0-9]/g, '');
        var target = digits ? BigInt(digits) : 1n;
        if (target < 1n) target = 1n;
        if (target > totalPages) target = totalPages;
        window.location.assign(pageHref(target));
      });
    }
    ['mnemonic-first', 'mnemonic-prev', 'mnemonic-next', 'mnemonic-last'].forEach(function (id) {
      var link = byId(id);
      if (link) {
        link.addEventListener('click', function (event) {
          if (link.getAttribute('aria-disabled') === 'true') event.preventDefault();
        });
      }
    });
    rowsEl.textContent = '';
    var startIndex = (page - 1n) * ROWS_PER_PAGE;
    var remaining = totalEntropy - startIndex;
    var count = remaining >= ROWS_PER_PAGE ? Number(ROWS_PER_PAGE) : Number(remaining);
    for (var i = 0; i < count; i += 1) {
      var index = startIndex + BigInt(i);
      var entry = { index: index };
      state.entries.push(entry);
      createRow(entry);
    }
    setDeriveProgress(0, count);

    var wasm;
    try {
      wasm = await loadWasm();
    } catch (err) {
      fail(err && err.message ? err.message : 'The derivation core did not load.');
      state.entries.forEach(function (entry) {
        resetPhrase(entry);
        entry.addressCell.textContent = 'Derivation core unavailable.';
      });
      return;
    }
    await deriveAll(wasm);
  }

  window.addEventListener('pagehide', function () {
    state.disposed = true;
    state.run += 1;
    state.entries = [];
    if (rowsEl) rowsEl.textContent = '';
  });

  boot();
})();
