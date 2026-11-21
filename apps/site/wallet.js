/* Cabinet wallet page: local encrypted vault, watch-only address list and
 * opt-in public balance lookups. All key material stays in this tab.
 *
 * Security rules followed here:
 *  - the vault record is the only stored form (wallet-vault.js, AES-GCM);
 *  - no passphrase, WIF or hex key in localStorage, the URL, logs or requests;
 *  - labels and provider text are rendered with textContent only;
 *  - lock clears the decrypted entries and passphrase from memory;
 *  - idle auto-lock after 10 minutes and lock on pagehide.
 *
 * This phase adds an EVM send flow and a Bitcoin testnet send flow:
 * the forms and validation live in wallet-evm.js / wallet-btc.js, the review
 * must be confirmed before signing, the signature is produced by
 * evm_sign_tx / btc_sign_tx in the local WASM core and the signed raw
 * transaction is broadcast directly to a public provider. Sepolia is the
 * default EVM network; a mainnet network is only signable after the user arms
 * it for the session, and the arm resets on lock, unlock and reload. */
(function () {
  'use strict';

  /* Build-prefixed URL for lazily loaded scripts and wasm. theme.js owns the
   * helper (it runs first); the local branch keeps a standalone page working. */
  function assetUrl(path) {
    if (typeof window === 'undefined') return path;
    if (window.RotorAssets && typeof window.RotorAssets.url === 'function') {
      return window.RotorAssets.url(path);
    }
    var build = document.documentElement.getAttribute('data-build');
    return build ? '/a/' + build + path : path;
  }

  var VAULT_DB = 'rotor-wallet';
  var VAULT_STORE = 'vault';
  var VAULT_KEY = 'vault';
  var IDLE_MS = 10 * 60 * 1000;
  var IDLE_CHECK_MS = 15 * 1000;
  var WASM_URL = assetUrl('/rotor_wasm.wasm');
  var TIMEOUT_MS = 10000;
  var MAX_LABEL = 64;
  var BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var WIF_MIN_LENGTH = 50;
  var WIF_MAX_LENGTH = 53;

  /* Address rows come from the wasm derive_report report; the explorer and
   * provider URLs mirror apps/site/key.js. */
  var CHAINS = [
    { slug: 'bitcoin', label: 'Bitcoin', curve: 0, addressId: 'btc_p2wpkh', explorer: 'https://mempool.space/address/' },
    { slug: 'bitcoin-testnet', label: 'Bitcoin testnet', curve: 0, addressId: 'btc_p2wpkh', explorer: 'https://mempool.space/testnet/address/', btcApi: 'https://mempool.space/testnet/api', network: 1 },
    { slug: 'ethereum', label: 'Ethereum', curve: 0, addressId: 'evm', explorer: 'https://etherscan.io/address/', rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'], symbol: 'ETH' },
    { slug: 'bnb', label: 'BNB Chain', curve: 0, addressId: 'evm', explorer: 'https://bscscan.com/address/', rpc: ['https://bsc-dataseed.binance.org'], symbol: 'BNB' },
    { slug: 'arbitrum', label: 'Arbitrum', curve: 0, addressId: 'evm', explorer: 'https://arbiscan.io/address/', rpc: ['https://arb1.arbitrum.io/rpc'], symbol: 'ETH' },
    { slug: 'optimism', label: 'Optimism', curve: 0, addressId: 'evm', explorer: 'https://optimistic.etherscan.io/address/', rpc: ['https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org'], symbol: 'ETH' },
    { slug: 'base', label: 'Base', curve: 0, addressId: 'evm', explorer: 'https://basescan.org/address/', rpc: ['https://mainnet.base.org'], symbol: 'ETH' },
    { slug: 'polygon', label: 'Polygon', curve: 0, addressId: 'evm', explorer: 'https://polygonscan.com/address/', rpc: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'], symbol: 'POL' },
    { slug: 'avalanche', label: 'Avalanche', curve: 0, addressId: 'evm', explorer: 'https://snowtrace.io/address/', rpc: ['https://api.avax.network/ext/bc/C/rpc'], symbol: 'AVAX' },
    { slug: 'zksync', label: 'zkSync', curve: 0, addressId: 'evm', explorer: 'https://explorer.zksync.io/address/', rpc: ['https://mainnet.era.zksync.io'], symbol: 'ETH' },
    { slug: 'litecoin', label: 'Litecoin', curve: 0, addressId: 'ltc_p2wpkh', explorer: 'https://blockchair.com/litecoin/address/' },
    { slug: 'bitcoin-cash', label: 'Bitcoin Cash', curve: 0, addressId: 'bch_legacy', explorer: 'https://blockchair.com/bitcoin-cash/address/' },
    { slug: 'dogecoin', label: 'Dogecoin', curve: 0, addressId: 'doge_p2pkh', explorer: 'https://blockchair.com/dogecoin/address/' },
    { slug: 'zcash', label: 'Zcash', curve: 0, addressId: 'zcash_p2pkh', explorer: 'https://blockchair.com/zcash/address/' },
    { slug: 'xrp', label: 'XRP', curve: 0, addressId: 'xrp_classic', explorer: 'https://xrpscan.com/account/' },
    { slug: 'tron', label: 'TRON', curve: 0, addressId: 'tron', explorer: 'https://tronscan.org/#/address/' },
    { slug: 'solana', label: 'Solana', curve: 1, addressId: 'solana', explorer: 'https://solscan.io/account/' },
    { slug: 'sui', label: 'Sui', curve: 1, addressId: 'sui', explorer: 'https://suiscan.xyz/mainnet/account/' },
    { slug: 'ton', label: 'TON', curve: 1, addressId: 'ton', explorer: 'https://tonviewer.com/' }
  ];

  var CHAIN_BY_SLUG = {};
  CHAINS.forEach(function (chain) { CHAIN_BY_SLUG[chain.slug] = chain; });

  var state = {
    record: null,
    passphrase: '',
    entries: [],
    derived: {},
    unlocked: false,
    lastActivity: 0,
    wasm: null,
    wasmPromise: null,
    tonPromise: null,
    lookup: false,
    generation: 0,
    rows: {},
    deriving: {},
    preparing: false,
    sending: false,
    review: null,
    reviewEntryId: null,
    mainnetArmed: false,
    btcPreparing: false,
    btcSending: false,
    btcReview: null,
    btcReviewEntryId: null,
    seedWordCount: 12
  };

  var vault = window.RotorWalletVault;
  var evmSend = window.RotorEvmSend;
  var btcSend = window.RotorBtcSend;
  var byId = function (id) { return document.getElementById(id); };
  var createForm = byId('wallet-create-form');
  var unlockForm = byId('wallet-unlock-form');
  var importForm = byId('wallet-import-form');
  var setupCard = byId('wallet-setup');
  var unlockCard = byId('wallet-unlock');
  var panel = byId('wallet-panel');
  var entriesEl = byId('wallet-entries');
  var emptyEl = byId('wallet-empty');
  var stateEl = byId('wallet-state');
  var lookupToggle = byId('wallet-lookup-toggle');
  var importSecret = byId('wallet-secret');
  var importChain = byId('wallet-chain');
  var importLabel = byId('wallet-label');

  /* Seed-phrase block: phrase generation and one-chain derivation. */
  var seedPhrase = byId('wallet-seed-phrase');
  var seedStrength = byId('wallet-seed-strength');
  var seedInfo = byId('wallet-seed-info');
  var seedGenerate = byId('wallet-seed-generate');
  var seedAdd = byId('wallet-seed-add');
  var seedWordButtons = document.querySelectorAll('[data-seed-words]');

  /* Send form (EVM Sepolia). Nothing in this block holds a private key. */
  var sendCard = byId('wallet-send');
  var sendForm = byId('wallet-send-form');
  var sendEntrySelect = byId('wallet-send-entry');
  var sendNetworkSelect = byId('wallet-send-network');
  var sendProviderSelect = byId('wallet-send-provider');
  var sendArmedRow = byId('wallet-send-armed-row');
  var sendArmedCheckbox = byId('wallet-send-armed');
  var sendFromLine = byId('wallet-send-from');
  var sendToInput = byId('wallet-send-to');
  var sendValueInput = byId('wallet-send-value');
  var sendDataInput = byId('wallet-send-data');
  var sendGasInput = byId('wallet-send-gas');
  var sendPriorityInput = byId('wallet-send-priority');
  var sendMaxFeeInput = byId('wallet-send-max-fee');
  var sendStatus = byId('wallet-send-status');
  var sendPrepareButton = byId('wallet-send-prepare');
  var sendReviewBox = byId('wallet-send-review');
  var sendReviewList = byId('wallet-review-list');
  var sendReviewWarnings = byId('wallet-review-warnings');
  var sendReviewUnsigned = byId('wallet-review-unsigned');
  var sendConfirmButton = byId('wallet-send-confirm');
  var sendCancelButton = byId('wallet-send-cancel');
  var sendResultBox = byId('wallet-send-result');
  var sendProviderNote = byId('wallet-send-provider-note');
  var sendHashEl = byId('wallet-send-hash');
  var sendExplorerLink = byId('wallet-send-explorer');
  var sendSignedEl = byId('wallet-send-signed');

  /* Bitcoin testnet send form. Nothing in this block holds a private key. */
  var btcCard = byId('wallet-btc-send');
  var btcForm = byId('wallet-btc-form');
  var btcEntrySelect = byId('wallet-btc-entry');
  var btcFromLine = byId('wallet-btc-from');
  var btcToInput = byId('wallet-btc-to');
  var btcAmountInput = byId('wallet-btc-amount');
  var btcRateInput = byId('wallet-btc-fee-rate');
  var btcStatus = byId('wallet-btc-status');
  var btcPrepareButton = byId('wallet-btc-prepare');
  var btcReviewBox = byId('wallet-btc-review');
  var btcReviewList = byId('wallet-btc-review-list');
  var btcReviewWarnings = byId('wallet-btc-review-warnings');
  var btcReviewUnsigned = byId('wallet-btc-review-unsigned');
  var btcConfirmButton = byId('wallet-btc-confirm');
  var btcCancelButton = byId('wallet-btc-cancel');
  var btcResultBox = byId('wallet-btc-result');
  var btcProviderNote = byId('wallet-btc-provider-note');
  var btcTxidEl = byId('wallet-btc-txid');
  var btcExplorerLink = byId('wallet-btc-explorer');
  var btcSignedEl = byId('wallet-btc-signed');

  if (!vault) {
    showUnavailable('The wallet codec did not load. Reload the page.');
    return;
  }
  if (!evmSend) {
    /* The vault still works watch-only; sending stays unavailable and says so. */
    if (sendCard) sendCard.hidden = true;
  }
  if (!btcSend) {
    if (btcCard) btcCard.hidden = true;
  }

  /* ------------------------------------------------------------- small utils */

  function setError(id, message) {
    var box = byId(id);
    if (!box) return;
    box.hidden = !message;
    box.textContent = message || '';
  }

  function errorText(err) {
    return err && err.message ? err.message : 'unknown error';
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i += 1) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
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

  function bytesToHex(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i += 1) {
      var part = bytes[i].toString(16);
      hex += part.length === 1 ? '0' + part : part;
    }
    return hex;
  }

  function randomId() {
    var bytes = new Uint8Array(8);
    window.crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  function chainSpec(slug) {
    return CHAIN_BY_SLUG[slug] || null;
  }

  function chainLabel(slug) {
    var spec = chainSpec(slug);
    return spec ? spec.label : slug;
  }

  function showUnavailable(message) {
    var box = byId('wallet-unavailable');
    box.textContent = message;
    box.hidden = false;
    if (setupCard) setupCard.hidden = true;
    if (unlockCard) unlockCard.hidden = true;
    if (panel) panel.hidden = true;
    if (sendCard) sendCard.hidden = true;
  }

  /* ----------------------------------------------------------- IndexedDB */

  function indexedDbAvailable() {
    try {
      return typeof window.indexedDB !== 'undefined' && window.indexedDB !== null;
    } catch (err) {
      return false;
    }
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var request;
      try {
        request = window.indexedDB.open(VAULT_DB, 1);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(VAULT_STORE)) db.createObjectStore(VAULT_STORE);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () {
        reject(request.error || new Error('IndexedDB open failed'));
      };
      request.onblocked = function () {
        reject(new Error('IndexedDB is blocked by another tab'));
      };
    });
  }

  function withStore(mode, action) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx;
        try {
          tx = db.transaction(VAULT_STORE, mode);
        } catch (err) {
          db.close();
          reject(err);
          return;
        }
        var request = action(tx.objectStore(VAULT_STORE));
        var result;
        var settled = false;
        function finish(err) {
          if (settled) return;
          settled = true;
          db.close();
          if (err) reject(err);
          else resolve(result);
        }
        request.onsuccess = function () { result = request.result; };
        request.onerror = function () { finish(request.error || new Error('IndexedDB request failed')); };
        tx.oncomplete = function () { finish(null); };
        tx.onerror = function () { finish(tx.error || new Error('IndexedDB transaction failed')); };
        tx.onabort = function () { finish(tx.error || new Error('IndexedDB transaction aborted')); };
      });
    });
  }

  function readRecord() {
    return withStore('readonly', function (store) { return store.get(VAULT_KEY); })
      .then(function (raw) {
        if (!raw) return null;
        var record;
        try {
          record = JSON.parse(raw);
        } catch (err) {
          throw new Error('The stored vault record is not valid JSON.');
        }
        vault.validateRecord(record);
        return record;
      });
  }

  function writeRecord(record) {
    vault.validateRecord(record);
    return withStore('readwrite', function (store) {
      return store.put(JSON.stringify(record), VAULT_KEY);
    });
  }

  /* ---------------------------------------------------------------- wasm */

  function loadWasm() {
    if (state.wasm) return Promise.resolve(state.wasm);
    if (state.wasmPromise) return state.wasmPromise;
    state.wasmPromise = fetch(WASM_URL).then(function (response) {
      if (!response.ok) throw new Error('Cannot load ' + WASM_URL + ': HTTP ' + response.status);
      return WebAssembly.instantiateStreaming(response, {}).catch(function () {
        return fetch(WASM_URL).then(function (again) {
          return again.arrayBuffer().then(function (buffer) {
            return WebAssembly.instantiate(buffer, {});
          });
        });
      });
    }).then(function (module) {
      var wasm = module.instance ? module.instance.exports : module.exports;
      var required = ['alloc', 'dealloc', 'derive_report', 'derive_report_network',
        'result_ptr', 'result_len', 'error_ptr', 'error_len', 'clear_result',
        'evm_unsigned_tx', 'evm_sign_tx', 'btc_unsigned_tx', 'btc_sign_tx'];
      for (var i = 0; i < required.length; i += 1) {
        if (typeof wasm[required[i]] !== 'function') {
          throw new Error('The wasm core has no "' + required[i] + '" export.');
        }
      }
      if (!wasm.memory) throw new Error(WASM_URL + ' does not export memory.');
      state.wasm = wasm;
      return wasm;
    });
    state.wasmPromise.catch(function () { state.wasmPromise = null; });
    return state.wasmPromise;
  }

  function wasmText(wasm, pointer, length) {
    if (!pointer || !length) return '';
    return new TextDecoder('utf-8').decode(new Uint8Array(wasm.memory.buffer, pointer, length));
  }

  function deriveReport(wasm, bytes, curve, network) {
    var pointer = wasm.alloc(bytes.length) >>> 0;
    if (!pointer) throw new Error('WASM memory exhausted.');
    try {
      new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
      /* Testnet addresses must come from derive_report_network; the mainnet
       * export has no network parameter. */
      var status = network === 1
        ? wasm.derive_report_network(pointer, bytes.length, curve, 1) >>> 0
        : wasm.derive_report(pointer, curve) >>> 0;
      if (status !== 0) {
        var detail = wasmText(wasm, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0);
        throw new Error('Derivation failed' + (detail ? ': ' + detail : ' (status ' + status + ')'));
      }
      var text = wasmText(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0);
      return JSON.parse(text);
    } finally {
      wasm.dealloc(pointer, bytes.length);
    }
  }

  function unsignedTx(fields) {
    return loadWasm().then(function (wasm) {
      return evmSend.callWasmString(wasm, 'evm_unsigned_tx', JSON.stringify(fields));
    });
  }

  async function signTxWithEntry(entry, fields) {
    var parsed = await parseEntry(entry);
    var keyHex = bytesToHex(parsed.key);
    var request = {
      chain_id: fields.chain_id,
      nonce: fields.nonce,
      max_priority_fee: fields.max_priority_fee,
      max_fee: fields.max_fee,
      gas_limit: fields.gas_limit,
      to: fields.to,
      value: fields.value,
      data: fields.data,
      private_key: '0x' + keyHex
    };
    var text = JSON.stringify(request);
    try {
      var wasm = await loadWasm();
      return evmSend.callWasmString(wasm, 'evm_sign_tx', text);
    } finally {
      /* The key crossed only this tab's memory and the wasm request; drop it. */
      parsed.key.fill(0);
      keyHex = null;
      request = null;
      text = null;
    }
  }

  /* The reviewed request is the only input; the key is added here, at the
   * explicit Confirm step, and never stored in the review object. */
  async function signBtcWithEntry(entry, request) {
    var parsed = await parseEntry(entry);
    var keyHex = bytesToHex(parsed.key);
    var full = {
      network: request.network,
      inputs: request.inputs,
      outputs: request.outputs,
      private_key: '0x' + keyHex
    };
    var text = JSON.stringify(full);
    try {
      var wasm = await loadWasm();
      return btcSend.callWasmString(wasm, 'btc_sign_tx', text);
    } finally {
      parsed.key.fill(0);
      keyHex = null;
      full = null;
      text = null;
    }
  }

  function unsignedBtcTx(fields) {
    return loadWasm().then(function (wasm) {
      return btcSend.callWasmString(wasm, 'btc_unsigned_tx', JSON.stringify(fields));
    });
  }

  function loadTon() {
    if (window.RotorTon) return Promise.resolve(window.RotorTon);
    if (state.tonPromise) return state.tonPromise;
    state.tonPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = assetUrl('/ton.js');
      script.onload = function () {
        if (window.RotorTon) resolve(window.RotorTon);
        else reject(new Error('The TON library did not load.'));
      };
      script.onerror = function () { reject(new Error('The TON library did not load.')); };
      document.head.appendChild(script);
    });
    state.tonPromise.catch(function () { state.tonPromise = null; });
    return state.tonPromise;
  }

  /* --------------------------------------------------------- seed phrase */

  var seedScripts = {};
  var seedWordSet = null;
  var seedStrengthSeq = 0;

  /* Load a lazily-needed script once. The seed bundle and its crypto helpers
   * are not part of the page's blocking scripts. */
  function ensureScript(globalName, src) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (seedScripts[globalName]) return seedScripts[globalName];
    seedScripts[globalName] = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.onload = function () {
        if (window[globalName]) resolve(window[globalName]);
        else reject(new Error(globalName + ' did not load.'));
      };
      script.onerror = function () { reject(new Error('Cannot load ' + src + '.')); };
      document.head.appendChild(script);
    });
    seedScripts[globalName].catch(function () { seedScripts[globalName] = null; });
    return seedScripts[globalName];
  }

  function ensureSeedLibraries() {
    if (window.RotorSeed && window.RotorSeedCrypto) return Promise.resolve();
    return ensureScript('RotorSeed', assetUrl('/seed.js')).then(function () {
      return ensureScript('RotorSeedCrypto', assetUrl('/seed-crypto.js'));
    });
  }

  function seedWordMap() {
    if (!seedWordSet) {
      seedWordSet = Object.create(null);
      var words = window.RotorSeed && window.RotorSeed.wordlist;
      if (!Array.isArray(words)) throw new Error('The BIP39 wordlist did not load.');
      for (var i = 0; i < words.length; i += 1) seedWordSet[words[i]] = true;
    }
    return seedWordSet;
  }

  function normalizeSeedPhrase() {
    return String(seedPhrase ? seedPhrase.value : '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function seedEntropyBits(count) {
    /* BIP39: entropy bits = 32 x words / 3, only for the five valid lengths. */
    return [12, 15, 18, 21, 24].indexOf(count) >= 0 ? (count * 32) / 3 : 0;
  }

  /* The tooltip primitive is a short hover/focus label; the long estimate is
   * visible text (see #wallet-seed-estimate). */
  function updateSeedTooltip(bits) {
    if (!seedInfo) return;
    if (bits >= 256) seedInfo.setAttribute('data-tooltip', '256-bit ≈ 3.7×10^57 years');
    else if (bits === 128) seedInfo.setAttribute('data-tooltip', '128-bit ≈ 1.1×10^19 years');
    else seedInfo.setAttribute('data-tooltip', bits + '-bit entropy');
  }

  async function analyzeSeedPhrase() {
    var phrase = normalizeSeedPhrase();
    var words = phrase ? phrase.split(' ') : [];
    if (!words.length) return { ok: false, empty: true, words: words, bits: 0 };
    var bits = seedEntropyBits(words.length);
    if (!bits) {
      return {
        ok: false,
        words: words,
        bits: 0,
        message: 'BIP39 uses 12, 15, 18, 21 or 24 words; this one has ' + words.length + '.'
      };
    }
    await ensureSeedLibraries();
    var known = seedWordMap();
    for (var i = 0; i < words.length; i += 1) {
      if (!known[words[i]]) {
        return {
          ok: false,
          words: words,
          bits: bits,
          message: '"' + words[i] + '" is not in the BIP39 wordlist.'
        };
      }
    }
    if (!window.RotorSeed.validate(phrase)) {
      return { ok: false, words: words, bits: bits, message: 'BIP39 checksum does not match.' };
    }
    return { ok: true, phrase: phrase, words: words, bits: bits };
  }

  async function refreshSeedStrength() {
    if (!seedStrength || !seedAdd) return;
    var seq = (seedStrengthSeq += 1);
    var selectedBits = seedEntropyBits(state.seedWordCount);
    var info;
    try {
      info = await analyzeSeedPhrase();
    } catch (err) {
      if (seq !== seedStrengthSeq) return;
      seedStrength.textContent = 'Cannot check the phrase: ' + errorText(err);
      seedAdd.disabled = true;
      return;
    }
    if (seq !== seedStrengthSeq) return;
    updateSeedTooltip(info.bits || selectedBits);
    if (info.empty) {
      seedStrength.textContent = state.seedWordCount + ' words · ' + selectedBits +
        '-bit entropy · generate or paste a phrase';
      seedAdd.disabled = true;
      return;
    }
    if (!info.ok) {
      seedStrength.textContent = info.words.length + ' words' +
        (info.bits ? ' · ' + info.bits + '-bit entropy' : '') + ' · ' + info.message;
      seedAdd.disabled = true;
      return;
    }
    seedStrength.textContent = info.words.length + ' words · ' + info.bits +
      '-bit entropy · BIP39 checksum ok';
    seedAdd.disabled = false;
  }

  function resetSeedPhrase() {
    if (seedPhrase) seedPhrase.value = '';
    refreshSeedStrength().catch(function () {});
  }

  /* BIP32 needs a compressed public key; the wasm core owns all curve work. */
  async function seedPubkeyFor(keyHex) {
    var wasm = await loadWasm();
    var report = deriveReport(wasm, hexToBytes(keyHex), 0, 0);
    if (!report || typeof report.pubkey_compressed !== 'string') {
      throw new Error('The derivation core returned no compressed public key.');
    }
    return hexToBytes(report.pubkey_compressed);
  }

  async function addSeedKey() {
    setError('wallet-add-error', '');
    if (!state.unlocked) {
      setError('wallet-add-error', 'Unlock the vault first.');
      return;
    }
    var chainSlug = importChain.value;
    if (!chainSlug) {
      setError('wallet-add-error', 'Choose a chain for the derived key.');
      return;
    }
    var info;
    try {
      info = await analyzeSeedPhrase();
    } catch (err) {
      setError('wallet-add-error', errorText(err));
      return;
    }
    if (!info.ok) {
      setError('wallet-add-error', info.message || 'Paste a valid BIP39 phrase first.');
      return;
    }
    var path = window.RotorSeedCrypto.seedPathFor(chainSlug);
    if (!path) {
      setError('wallet-add-error', chainLabel(chainSlug) +
        ' has no BIP44 preset on this page. Import a WIF or hex key instead.');
      return;
    }
    var spec = chainSpec(chainSlug);
    seedAdd.disabled = true;
    try {
      var seed = await window.RotorSeedCrypto.bip39Seed(info.phrase, '');
      var keyHex = await window.RotorSeedCrypto.bip32PrivateKey(seed, path, seedPubkeyFor);
      var parsed = {
        chain: chainSlug,
        curve: spec.curve,
        addressId: spec.addressId,
        network: spec.network || 0,
        key: hexToBytes(keyHex),
        secret_type: 'hex',
        secret: keyHex
      };
      var derived;
      try {
        derived = await deriveAddress(parsed);
      } catch (err) {
        setError('wallet-add-error', 'Address derivation failed, so the key was not stored: ' + errorText(err));
        seedAdd.disabled = false;
        return;
      }
      await addParsedEntry(parsed, derived, importLabel.value);
    } catch (err) {
      setError('wallet-add-error', err.duplicate ? err.message : 'Cannot save the vault: ' + errorText(err));
      seedAdd.disabled = false;
      return;
    }
    importLabel.value = '';
    resetSeedPhrase();
    renderEntries();
  }

  /* ------------------------------------------------------------- key parsing */

  function base58Decode(text) {
    var value = 0n;
    for (var i = 0; i < text.length; i += 1) {
      var index = BASE58.indexOf(text.charAt(i));
      if (index < 0) throw new Error('invalid base58 character');
      value = value * 58n + BigInt(index);
    }
    var leading = 0;
    while (leading < text.length && text.charAt(leading) === '1') leading += 1;
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
      throw new Error('WIF checksums need WebCrypto (https or localhost).');
    }
    var raw;
    try {
      raw = base58Decode(text);
    } catch (err) {
      throw new Error('Not a valid WIF: ' + errorText(err) + '.');
    }
    if (raw.length !== 37 && raw.length !== 38) {
      throw new Error('Not a valid WIF length.');
    }
    var compressed = raw.length === 38;
    if (compressed && raw[33] !== 0x01) {
      throw new Error('Invalid WIF compression marker.');
    }
    var payload = raw.slice(0, raw.length - 4);
    var checksum = raw.slice(raw.length - 4);
    var hash = await sha256(await sha256(payload));
    for (var i = 0; i < 4; i += 1) {
      if (hash[i] !== checksum[i]) throw new Error('WIF checksum mismatch.');
    }
    return { version: raw[0], compressed: compressed, key: raw.slice(1, 33) };
  }

  function wifTarget(wif) {
    if (wif.version === 0x80) {
      return {
        chain: 'bitcoin',
        addressId: wif.compressed ? 'btc_p2wpkh' : 'btc_p2pkh_uncompressed'
      };
    }
    if (wif.version === 0xb0) {
      if (!wif.compressed) throw new Error('Uncompressed Litecoin WIF is not supported in this phase.');
      return { chain: 'litecoin', addressId: 'ltc_p2wpkh' };
    }
    if (wif.version === 0x9e) {
      if (!wif.compressed) throw new Error('Uncompressed Dogecoin WIF is not supported in this phase.');
      return { chain: 'dogecoin', addressId: 'doge_p2pkh' };
    }
    if (wif.version === 0xef) {
      /* Testnet WIF: store it and derive tb1 through derive_report_network. */
      return { chain: 'bitcoin-testnet', addressId: 'btc_p2wpkh', network: 1 };
    }
    if (wif.version === 0xf1) {
      throw new Error('This is a Dogecoin testnet WIF (version 0xF1). Dogecoin testnet is not supported in this phase, so the key was not stored.');
    }
    throw new Error('Unsupported WIF version 0x' + wif.version.toString(16).padStart(2, '0') +
      '. Supported: Bitcoin mainnet, Bitcoin testnet, Litecoin and Dogecoin mainnet.');
  }

  /* Turn an imported secret into the derivation request. The WIF version
   * chooses the chain and address row; hex always needs an explicit chain. */
  async function parseSecret(text, chainSlug) {
    var value = text.trim();
    if (!value) throw new Error('Paste a WIF or a 64-character hex key.');
    var hexMatch = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(value);
    if (hexMatch) {
      if (!chainSlug) throw new Error('Choose the chain for a hex key.');
      var spec = chainSpec(chainSlug);
      if (!spec) throw new Error('Unsupported chain.');
      return {
        chain: chainSlug,
        curve: spec.curve,
        addressId: spec.addressId,
        network: spec.network || 0,
        key: hexToBytes(hexMatch[1].toLowerCase()),
        secret_type: 'hex',
        secret: hexMatch[1].toLowerCase()
      };
    }
    if (value.length < WIF_MIN_LENGTH || value.length > WIF_MAX_LENGTH || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) {
      throw new Error('Unrecognized format. Use a WIF or 64 hex characters (optionally 0x-prefixed).');
    }
    var wif = await decodeWif(value);
    var target = wifTarget(wif);
    return {
      chain: target.chain,
      curve: 0,
      addressId: target.addressId,
      network: target.network || 0,
      key: wif.key,
      secret_type: 'wif',
      secret: value
    };
  }

  /* Re-parse a stored entry on unlock. The chain is part of the record; a WIF
   * whose version does not match the stored chain is an error, not a guess. */
  async function parseEntry(entry) {
    if (entry.secret_type === 'hex') {
      var spec = chainSpec(entry.chain);
      if (!spec) throw new Error('Unsupported chain "' + entry.chain + '".');
      if (!/^[0-9a-f]{64}$/.test(entry.secret)) {
        throw new Error('The stored hex key is malformed.');
      }
      return {
        chain: entry.chain,
        curve: spec.curve,
        addressId: spec.addressId,
        network: spec.network || 0,
        key: hexToBytes(entry.secret)
      };
    }
    var wif = await decodeWif(entry.secret);
    var target = wifTarget(wif);
    if (target.chain !== entry.chain) {
      throw new Error('The stored WIF belongs to ' + chainLabel(target.chain) +
        ', not ' + chainLabel(entry.chain) + '.');
    }
    return {
      chain: entry.chain,
      curve: 0,
      addressId: target.addressId,
      network: target.network || 0,
      key: wif.key
    };
  }

  async function deriveAddress(parsed) {
    var wasm = await loadWasm();
    var report = deriveReport(wasm, parsed.key, parsed.curve, parsed.network || 0);
    if (parsed.addressId === 'ton') {
      if (!report.ed_pubkey) throw new Error('The derivation core returned no ed25519 public key.');
      var ton = await loadTon();
      var address = await ton.address(report.ed_pubkey);
      if (!address) throw new Error('TON address derivation returned an empty value.');
      return { address: address, chain: parsed.chain, id: 'ton', label: 'TON wallet v4R2' };
    }
    var rows = Array.isArray(report.addresses) ? report.addresses : [];
    var row = null;
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].id === parsed.addressId) { row = rows[i]; break; }
    }
    if (!row || typeof row.address !== 'string' || !row.address) {
      throw new Error('The derivation core returned no "' + parsed.addressId + '" address.');
    }
    return { address: row.address, chain: parsed.chain, id: parsed.addressId, label: row.label || parsed.addressId };
  }

  /* ------------------------------------------------------------------ views */

  function clearInputs() {
    importSecret.value = '';
    importLabel.value = '';
    importChain.value = '';
    if (seedPhrase) seedPhrase.value = '';
    byId('wallet-create-pass').value = '';
    byId('wallet-create-pass2').value = '';
    byId('wallet-unlock-pass').value = '';
  }

  function showLocked(message) {
    state.unlocked = false;
    state.passphrase = '';
    state.entries = [];
    state.derived = {};
    state.deriving = {};
    state.rows = {};
    state.generation += 1;
    if (entriesEl) entriesEl.textContent = '';
    if (panel) panel.hidden = true;
    if (setupCard) setupCard.hidden = !!state.record;
    if (unlockCard) unlockCard.hidden = !state.record;
    setError('wallet-create-error', '');
    setError('wallet-unlock-error', message || '');
    setError('wallet-add-error', '');
    if (lookupToggle) lookupToggle.checked = false;
    state.lookup = false;
    clearInputs();
    resetSend();
  }

  function showUnlocked() {
    state.unlocked = true;
    state.lastActivity = Date.now();
    state.mainnetArmed = false;
    if (sendArmedCheckbox) sendArmedCheckbox.checked = false;
    if (setupCard) setupCard.hidden = true;
    if (unlockCard) unlockCard.hidden = true;
    if (panel) panel.hidden = false;
    renderSend();
    if (stateEl) stateEl.textContent = 'unlocked · auto-locks after 10 minutes idle';
    setError('wallet-unlock-error', '');
    refreshSeedStrength().catch(function () {});
  }

  /* ------------------------------------------------------------------- lock */

  function lock(message) {
    var wasUnlocked = state.unlocked;
    state.generation += 1;
    state.passphrase = '';
    state.entries = [];
    state.derived = {};
    if (entriesEl) entriesEl.textContent = '';
    showLocked(message || (wasUnlocked ? 'Vault locked.' : ''));
  }

  function markActivity() {
    if (state.unlocked) state.lastActivity = Date.now();
  }

  document.addEventListener('pointerdown', markActivity, true);
  document.addEventListener('keydown', markActivity, true);
  document.addEventListener('focusin', markActivity, true);
  window.setInterval(function () {
    if (state.unlocked && Date.now() - state.lastActivity > IDLE_MS) {
      lock('Auto-locked after 10 minutes without activity.');
    }
  }, IDLE_CHECK_MS);
  window.addEventListener('pagehide', function () {
    if (state.unlocked) lock();
  });

  byId('wallet-lock').addEventListener('click', function () { lock('Vault locked.'); });

  /* ---------------------------------------------------------- create/unlock */

  createForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    setError('wallet-create-error', '');
    var pass = byId('wallet-create-pass').value;
    var again = byId('wallet-create-pass2').value;
    if (pass.length < 8) {
      setError('wallet-create-error', 'Use a passphrase of at least 8 characters.');
      return;
    }
    if (pass !== again) {
      setError('wallet-create-error', 'The two passphrases do not match.');
      return;
    }
    try {
      var record = await vault.createVaultRecord([], pass, { crypto: window.crypto });
      await writeRecord(record);
      state.record = record;
      state.passphrase = pass;
      state.derived = {};
      state.entries = [];
      showUnlocked();
      renderEntries();
      clearInputs();
    } catch (err) {
      setError('wallet-create-error', 'Cannot create the vault: ' + errorText(err));
    }
  });

  unlockForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    setError('wallet-unlock-error', '');
    var pass = byId('wallet-unlock-pass').value;
    if (!pass) {
      setError('wallet-unlock-error', 'Enter the vault passphrase.');
      return;
    }
    try {
      var record = await readRecord();
      if (!record) {
        state.record = null;
        showLocked('There is no vault in this browser. Create one or import an encrypted backup.');
        return;
      }
      var opened = await vault.decryptVaultRecord(record, pass, { crypto: window.crypto });
      state.record = record;
      state.passphrase = pass;
      state.entries = opened.entries;
      state.derived = {};
      state.generation += 1;
      showUnlocked();
      byId('wallet-unlock-pass').value = '';
      renderEntries();
    } catch (err) {
      setError('wallet-unlock-error', errorText(err));
    }
  });

  /* ------------------------------------------------------------ save entries */

  async function saveEntries(nextEntries, derivedCache) {
    var record = await vault.createVaultRecord(nextEntries, state.passphrase, { crypto: window.crypto });
    await writeRecord(record);
    state.record = record;
    state.entries = nextEntries;
    state.derived = derivedCache;
    return record;
  }

  /* One path for every key that enters the vault, whether it was pasted or
   * derived from a phrase. Returns the new entry; throws a tagged error for a
   * duplicate and a plain error when the vault cannot be saved. */
  async function addParsedEntry(parsed, derived, labelText) {
    var duplicate = state.entries.some(function (entry) {
      if (entry.chain !== parsed.chain) return false;
      if (entry.secret === parsed.secret) return true;
      var cached = state.derived[entry.id];
      return cached && cached.address === derived.address;
    });
    if (duplicate) {
      var duplicateError = new Error('That key is already in the vault.');
      duplicateError.duplicate = true;
      throw duplicateError;
    }
    var label = String(labelText || '').trim().slice(0, MAX_LABEL);
    var entry = {
      id: randomId(),
      chain: parsed.chain,
      label: label || chainLabel(parsed.chain) + ' key',
      secret_type: parsed.secret_type,
      secret: parsed.secret
    };
    var nextEntries = state.entries.concat([entry]);
    var nextDerived = {};
    Object.keys(state.derived).forEach(function (id) { nextDerived[id] = state.derived[id]; });
    nextDerived[entry.id] = derived;
    await saveEntries(nextEntries, nextDerived);
    return entry;
  }

  importForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    setError('wallet-add-error', '');
    if (!state.unlocked) {
      setError('wallet-add-error', 'Unlock the vault first.');
      return;
    }
    var text = importSecret.value;
    var chainSlug = importChain.value;
    var label = importLabel.value.trim().slice(0, MAX_LABEL);
    var parsed;
    try {
      parsed = await parseSecret(text, chainSlug);
    } catch (err) {
      setError('wallet-add-error', errorText(err));
      return;
    }
    var derived;
    try {
      derived = await deriveAddress(parsed);
    } catch (err) {
      setError('wallet-add-error', 'Address derivation failed, so the key was not stored: ' + errorText(err));
      return;
    }
    try {
      await addParsedEntry(parsed, derived, label);
    } catch (err) {
      setError('wallet-add-error', err.duplicate ? err.message : 'Cannot save the vault: ' + errorText(err));
      return;
    }
    importSecret.value = '';
    importLabel.value = '';
    importChain.value = '';
    renderEntries();
  });

  /* ------------------------------------------------------- seed phrase actions */

  if (seedWordButtons && seedWordButtons.length) {
    Array.prototype.forEach.call(seedWordButtons, function (button) {
      button.addEventListener('click', function () {
        var count = Number(button.getAttribute('data-seed-words'));
        state.seedWordCount = count;
        Array.prototype.forEach.call(seedWordButtons, function (item) {
          item.setAttribute('aria-pressed', item === button ? 'true' : 'false');
        });
        var current = normalizeSeedPhrase();
        var currentWords = current ? current.split(' ').length : 0;
        if (currentWords && currentWords !== count) seedPhrase.value = '';
        refreshSeedStrength().catch(function () {});
      });
    });
  }

  if (seedGenerate) {
    seedGenerate.addEventListener('click', async function () {
      setError('wallet-add-error', '');
      seedGenerate.disabled = true;
      try {
        await ensureSeedLibraries();
        seedPhrase.value = window.RotorSeedCrypto.generateBip39(state.seedWordCount);
        await refreshSeedStrength();
        seedPhrase.focus();
      } catch (err) {
        setError('wallet-add-error', 'Cannot generate a phrase: ' + errorText(err));
      } finally {
        seedGenerate.disabled = false;
      }
    });
  }

  if (seedPhrase) {
    seedPhrase.addEventListener('input', function () {
      refreshSeedStrength().catch(function () {});
    });
  }

  if (seedAdd) {
    seedAdd.addEventListener('click', function () { addSeedKey(); });
  }

  /* ---------------------------------------------------------------- removal */

  async function removeEntry(entry) {
    if (!state.unlocked) return;
    if (!window.confirm('Remove "' + entry.label + '" from this vault? The key will be deleted from this browser.')) {
      return;
    }
    var nextEntries = state.entries.filter(function (item) { return item.id !== entry.id; });
    var nextDerived = {};
    Object.keys(state.derived).forEach(function (id) {
      if (id !== entry.id) nextDerived[id] = state.derived[id];
    });
    try {
      await saveEntries(nextEntries, nextDerived);
      renderEntries();
    } catch (err) {
      setError('wallet-add-error', 'Cannot save the vault: ' + errorText(err));
    }
  }

  async function renameEntry(entry, value) {
    if (!state.unlocked) return;
    var label = value.trim().slice(0, MAX_LABEL);
    if (!label) {
      setError('wallet-add-error', 'A label cannot be empty.');
      return;
    }
    setError('wallet-add-error', '');
    var nextEntries = state.entries.map(function (item) {
      if (item.id !== entry.id) return item;
      return { id: item.id, chain: item.chain, label: label, secret_type: item.secret_type, secret: item.secret };
    });
    try {
      await saveEntries(nextEntries, state.derived);
      renderEntries();
    } catch (err) {
      setError('wallet-add-error', 'Cannot save the vault: ' + errorText(err));
    }
  }

  /* ---------------------------------------------------------------- render */

  function orderedChains(entries) {
    var present = {};
    entries.forEach(function (entry) { present[entry.chain] = true; });
    var ordered = [];
    CHAINS.forEach(function (chain) {
      if (present[chain.slug]) { ordered.push(chain.slug); delete present[chain.slug]; }
    });
    Object.keys(present).forEach(function (slug) { ordered.push(slug); });
    return ordered;
  }

  function buildRow(entry) {
    var row = document.createElement('div');
    row.className = 'wallet-row';
    row.setAttribute('data-entry-id', entry.id);

    var head = document.createElement('div');
    head.className = 'wallet-row-head';
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'wallet-label-input';
    labelInput.maxLength = MAX_LABEL;
    labelInput.value = entry.label;
    labelInput.setAttribute('aria-label', 'Label for ' + chainLabel(entry.chain) + ' address');
    var saveLabel = document.createElement('button');
    saveLabel.type = 'button';
    saveLabel.textContent = 'Save label';
    saveLabel.addEventListener('click', function () { renameEntry(entry, labelInput.value); });
    var remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', function () { removeEntry(entry); });
    head.appendChild(labelInput);
    head.appendChild(saveLabel);
    head.appendChild(remove);
    row.appendChild(head);

    var line = document.createElement('div');
    line.className = 'wallet-address-line';
    var code = document.createElement('code');
    code.className = 'mono';
    code.textContent = 'deriving…';
    line.appendChild(code);

    var explorer = document.createElement('a');
    explorer.className = 'icon-button icon-button--quiet';
    explorer.target = '_blank';
    explorer.rel = 'noopener noreferrer';
    explorer.setAttribute('data-tooltip', 'Open in explorer');
    explorer.setAttribute('aria-label', 'Open the address in the chain explorer');
    explorer.appendChild(iconUse('ui-external'));
    explorer.hidden = true;
    line.appendChild(explorer);

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy address';
    copy.disabled = true;
    copy.addEventListener('click', function () {
      var derived = state.derived[entry.id];
      if (!derived || !derived.address) return;
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(derived.address).then(function () {
          copy.textContent = 'Copied';
          window.setTimeout(function () { copy.textContent = 'Copy address'; }, 1500);
        }, function () { copy.textContent = 'Copy failed'; });
      } else {
        copy.textContent = 'Clipboard unavailable';
      }
    });
    line.appendChild(copy);
    row.appendChild(line);

    var actions = document.createElement('div');
    actions.className = 'wallet-row-actions';
    var balance = document.createElement('button');
    balance.type = 'button';
    balance.className = 'wallet-balance-button';
    balance.textContent = 'Balance';
    balance.disabled = !state.lookup;
    var badge = document.createElement('span');
    badge.className = 'wallet-balance';
    badge.hidden = true;
    balance.addEventListener('click', function () { checkBalance(entry, badge); });
    actions.appendChild(balance);
    actions.appendChild(badge);
    row.appendChild(actions);

    row._refs = {
      code: code,
      explorer: explorer,
      copy: copy,
      balance: balance,
      badge: badge
    };
    return row;
  }

  function applyDerived(entry, row) {
    var derived = state.derived[entry.id];
    var refs = row._refs;
    var spec = chainSpec(entry.chain);
    if (!derived) return;
    if (derived.error) {
      refs.code.textContent = 'address unavailable: ' + derived.error;
      refs.explorer.hidden = true;
      refs.copy.disabled = true;
      return;
    }
    refs.code.textContent = derived.address;
    if (spec && spec.explorer) {
      refs.explorer.href = spec.explorer + encodeURIComponent(derived.address);
      refs.explorer.hidden = false;
      refs.explorer.setAttribute('aria-label', 'Open ' + chainLabel(entry.chain) + ' address in explorer');
    }
    refs.copy.disabled = false;
  }

  function renderEntries() {
    if (!entriesEl) return;
    entriesEl.textContent = '';
    state.rows = {};
    var generation = state.generation;
    if (!state.entries.length) {
      emptyEl.hidden = false;
      if (state.unlocked) renderSend();
      return;
    }
    emptyEl.hidden = true;
    orderedChains(state.entries).forEach(function (slug) {
      var group = document.createElement('section');
      group.className = 'wallet-group';
      var title = document.createElement('h3');
      title.textContent = chainLabel(slug);
      group.appendChild(title);
      state.entries.forEach(function (entry) {
        if (entry.chain !== slug) return;
        var row = buildRow(entry);
        state.rows[entry.id] = row;
        applyDerived(entry, row);
        group.appendChild(row);
      });
      entriesEl.appendChild(group);
    });

    /* Explicitly avoid stale async writes: each derive captures the generation
     * that rendered the row. Cached results (and cached errors) are re-applied
     * above; only entries without any result are derived again. */
    state.entries.forEach(function (entry) {
      if (!state.derived[entry.id]) deriveEntry(entry, generation);
    });
    if (state.unlocked) renderSend();
  }

  async function deriveEntry(entry, generation) {
    if (state.derived[entry.id] || state.deriving[entry.id]) return;
    state.deriving[entry.id] = true;
    var outcome;
    try {
      var parsed = await parseEntry(entry);
      outcome = await deriveAddress(parsed);
    } catch (err) {
      outcome = { error: errorText(err) };
    } finally {
      delete state.deriving[entry.id];
    }
    if (generation !== state.generation || !state.unlocked) return;
    state.derived[entry.id] = outcome;
    var row = state.rows[entry.id];
    if (row) applyDerived(entry, row);
    if (state.unlocked && sendEntrySelect && sendEntrySelect.value === entry.id) {
      updateSendFrom();
    }
    if (state.unlocked && btcEntrySelect && btcEntrySelect.value === entry.id) {
      updateBtcFrom();
    }
  }

  /* ----------------------------------------------------------------- balances */

  function fetchWithTimeout(url, options) {
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    var settings = options || {};
    settings.signal = controller.signal;
    return fetch(url, settings).finally(function () { window.clearTimeout(timer); });
  }

  function formatUnits(value, decimals, symbol) {
    var unit = 10n ** BigInt(decimals);
    var whole = value / unit;
    var fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
    return (fraction ? whole.toString() + '.' + fraction : whole.toString()) + ' ' + symbol;
  }

  async function fetchBtcBalance(address, apiBase) {
    var base = apiBase || 'https://mempool.space/api';
    var response = await fetchWithTimeout(base + '/address/' + encodeURIComponent(address));
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var data = await response.json();
    var chain = data.chain_stats || {};
    var mempool = data.mempool_stats || {};
    var funded = BigInt(Math.trunc(Number(chain.funded_txo_sum) || 0)) +
      BigInt(Math.trunc(Number(mempool.funded_txo_sum) || 0));
    var spent = BigInt(Math.trunc(Number(chain.spent_txo_sum) || 0)) +
      BigInt(Math.trunc(Number(mempool.spent_txo_sum) || 0));
    var sats = funded - spent;
    if (sats < 0n) sats = 0n;
    var txs = (Number(chain.tx_count) || 0) + (Number(mempool.tx_count) || 0);
    return sats.toLocaleString('en-US') + ' sats · ' + txs + ' tx';
  }

  async function fetchEvmBalance(spec, address) {
    var lastError = null;
    for (var i = 0; i < spec.rpc.length; i += 1) {
      try {
        var response = await fetchWithTimeout(spec.rpc[i], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getBalance',
            params: [address, 'latest']
          })
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var data = await response.json();
        if (!data || typeof data.result !== 'string') {
          throw new Error(data && data.error && data.error.message ? data.error.message : 'unexpected response');
        }
        return formatUnits(BigInt(data.result), 18, spec.symbol || 'ETH');
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error('no endpoint answered' + (lastError ? ': ' + errorText(lastError) : ''));
  }

  async function fetchTronBalance(address) {
    var response = await fetchWithTimeout('https://apilist.tronscanapi.com/api/account?address=' + encodeURIComponent(address));
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
    var match = /"balance"\s*:\s*"?(\d+)"?/.exec(raw);
    var sun = match ? BigInt(match[1]) : 0n;
    var text = formatUnits(sun, 6, 'TRX');
    if (typeof data.totalTransactionCount === 'number') text += ' · ' + data.totalTransactionCount + ' tx';
    return text;
  }

  async function fetchBalance(chain, address) {
    var spec = chainSpec(chain);
    if (chain === 'bitcoin') return fetchBtcBalance(address);
    if (chain === 'bitcoin-testnet') return fetchBtcBalance(address, spec.btcApi);
    if (chain === 'tron') return fetchTronBalance(address);
    if (spec && spec.rpc) return fetchEvmBalance(spec, address);
    throw new Error('no public balance provider in this phase');
  }

  async function checkBalance(entry, badge) {
    if (!state.lookup) return;
    var derived = state.derived[entry.id];
    badge.hidden = false;
    badge.className = 'wallet-balance';
    if (!derived || derived.error || !derived.address) {
      badge.textContent = 'address not derived yet';
      return;
    }
    badge.textContent = 'checking…';
    try {
      var text = await fetchBalance(entry.chain, derived.address);
      badge.textContent = text;
      badge.classList.add('ok');
    } catch (err) {
      badge.textContent = 'lookup failed: ' + errorText(err);
      badge.classList.add('err');
    }
  }

  lookupToggle.addEventListener('change', function () {
    state.lookup = lookupToggle.checked;
    Array.prototype.forEach.call(entriesEl.querySelectorAll('.wallet-balance-button'), function (button) {
      button.disabled = !state.lookup;
    });
  });

  /* ------------------------------------------------------------- EVM send */

  /* Every function below treats the private key as something that exists only
   * inside signTxWithEntry's parsed entry. The review object carries public
   * transaction fields and the unsigned hex; it never carries a secret. */

  var SEND_ERROR_IDS = {
    to: 'wallet-send-to-error',
    value: 'wallet-send-value-error',
    data: 'wallet-send-data-error',
    gasLimit: 'wallet-send-gas-error',
    maxFee: 'wallet-send-max-fee-error',
    priorityFee: 'wallet-send-priority-error'
  };

  function entryById(id) {
    for (var i = 0; i < state.entries.length; i += 1) {
      if (state.entries[i].id === id) return state.entries[i];
    }
    return null;
  }

  function sendEntries() {
    if (!evmSend) return [];
    return state.entries.filter(function (entry) {
      return evmSend.EVM_CHAIN_SLUGS.indexOf(entry.chain) >= 0;
    });
  }

  function selectedSendEntry() {
    if (!sendEntrySelect) return null;
    return entryById(sendEntrySelect.value);
  }

  function showSendFieldErrors(errors) {
    Object.keys(SEND_ERROR_IDS).forEach(function (key) {
      setError(SEND_ERROR_IDS[key], errors[key] || '');
    });
  }

  function clearSendFieldErrors() {
    showSendFieldErrors({});
  }

  function selectedNetwork() {
    if (!evmSend) return null;
    if (!sendNetworkSelect) return evmSend.SEPOLIA;
    return evmSend.networkById(Number(sendNetworkSelect.value)) || evmSend.SEPOLIA;
  }

  function isMainnetArmed() {
    return state.mainnetArmed === true && !!sendArmedCheckbox && sendArmedCheckbox.checked;
  }

  function updateSendArmedRow() {
    if (!sendArmedRow) return;
    var network = selectedNetwork();
    sendArmedRow.hidden = !network || network.testnet;
  }

  function renderSendNetworks() {
    if (!evmSend || !sendNetworkSelect) return;
    var previous = sendNetworkSelect.value;
    sendNetworkSelect.textContent = '';
    evmSend.walletNetworks().forEach(function (network) {
      var option = document.createElement('option');
      option.value = String(network.chainId);
      option.textContent = network.name + ' — ' +
        (network.testnet ? 'testnet' : 'mainnet') +
        ' (chain id ' + network.chainId + ')';
      sendNetworkSelect.appendChild(option);
    });
    var known = previous && evmSend.networkById(Number(previous));
    sendNetworkSelect.value = known ? previous : String(evmSend.SEPOLIA.chainId);
    renderProviders();
    updateSendArmedRow();
  }

  function renderProviders() {
    if (!evmSend || !sendProviderSelect) return;
    var network = selectedNetwork();
    var previous = sendProviderSelect.value;
    sendProviderSelect.textContent = '';
    var auto = document.createElement('option');
    auto.value = '';
    auto.textContent = network.providers.length
      ? 'Auto (try ' + network.providers.map(function (provider) {
        return provider.label;
      }).join(' → ') + ')'
      : 'Auto (no provider configured)';
    sendProviderSelect.appendChild(auto);
    network.providers.forEach(function (provider) {
      var option = document.createElement('option');
      option.value = provider.url;
      option.textContent = provider.label;
      sendProviderSelect.appendChild(option);
    });
    if (previous && network.providers.some(function (provider) {
      return provider.url === previous;
    })) {
      sendProviderSelect.value = previous;
    }
  }

  function updateSendFrom() {
    if (!sendFromLine) return;
    var entry = selectedSendEntry();
    if (!entry) {
      sendFromLine.textContent = 'Select a key to see its EVM address.';
      return;
    }
    var derived = state.derived[entry.id];
    if (derived && derived.address) {
      sendFromLine.textContent = 'From: ' + derived.address;
      return;
    }
    if (derived && derived.error) {
      sendFromLine.textContent = 'Address unavailable: ' + derived.error;
      return;
    }
    sendFromLine.textContent = 'Deriving address…';
    deriveEntry(entry, state.generation);
  }

  function renderSend() {
    renderBtcSend();
    if (!sendCard || !evmSend) return;
    var entries = sendEntries();
    if (state.review && !entries.some(function (entry) { return entry.id === state.reviewEntryId; })) {
      invalidateSendReview();
    }
    if (!state.unlocked || !entries.length) {
      sendCard.hidden = true;
      return;
    }
    sendCard.hidden = false;
    renderSendNetworks();
    var previous = sendEntrySelect.value;
    sendEntrySelect.textContent = '';
    entries.forEach(function (entry) {
      var option = document.createElement('option');
      option.value = entry.id;
      option.textContent = (entry.label || chainLabel(entry.chain)) + ' · ' + chainLabel(entry.chain);
      sendEntrySelect.appendChild(option);
    });
    if (previous && entries.some(function (entry) { return entry.id === previous; })) {
      sendEntrySelect.value = previous;
    }
    if (!sendEntrySelect.value) sendEntrySelect.value = entries[0].id;
    updateSendFrom();
  }

  async function ensureDerivedAddress(entry) {
    var cached = state.derived[entry.id];
    if (cached && cached.address) return cached.address;
    if (cached && cached.error) throw new Error(cached.error);
    var parsed = await parseEntry(entry);
    try {
      var result = await deriveAddress(parsed);
      if (!result.address) throw new Error('The local core returned no address.');
      state.derived[entry.id] = result;
      return result.address;
    } finally {
      parsed.key.fill(0);
    }
  }

  function readSendForm() {
    return {
      to: sendToInput.value,
      value: sendValueInput.value,
      data: sendDataInput.value,
      gasLimit: sendGasInput.value,
      maxFee: sendMaxFeeInput.value,
      priorityFee: sendPriorityInput.value
    };
  }

  function invalidateSendReview() {
    if (!state.review) return;
    state.review = null;
    state.reviewEntryId = null;
    if (sendReviewBox) sendReviewBox.hidden = true;
    setError('wallet-send-confirm-error', '');
    if (sendStatus) sendStatus.textContent = 'Form changed: run "Fetch fees and review" again.';
  }

  function setSendBusy(busy, message) {
    var blocked = !!busy || state.sending;
    if (sendPrepareButton) sendPrepareButton.disabled = blocked;
    if (sendConfirmButton) sendConfirmButton.disabled = blocked;
    if (sendStatus && message !== undefined) sendStatus.textContent = message;
  }

  function fillSendDefaults(review) {
    if (!sendValueInput.value.trim()) {
      sendValueInput.value = evmSend.formatUnits(review.valueWei, 18);
    }
    if (!sendGasInput.value.trim()) sendGasInput.value = review.gasLimit.toString();
    if (!sendPriorityInput.value.trim()) {
      sendPriorityInput.value = evmSend.formatUnits(review.priorityWei, 9);
    }
    if (!sendMaxFeeInput.value.trim()) {
      sendMaxFeeInput.value = evmSend.formatUnits(review.maxFeeWei, 9);
    }
  }

  function addReviewRow(label, value, asCode) {
    var term = document.createElement('dt');
    term.textContent = label;
    var detail = document.createElement('dd');
    if (asCode) {
      var code = document.createElement('code');
      code.className = 'mono';
      code.textContent = value;
      detail.appendChild(code);
    } else {
      detail.textContent = value;
    }
    sendReviewList.appendChild(term);
    sendReviewList.appendChild(detail);
  }

  function renderReview(review) {
    var symbol = review.symbol || 'ETH';
    var feeWei = review.gasLimit * review.maxFeeWei;
    sendReviewList.textContent = '';
    addReviewRow('Network', review.chainName + ' · chain id ' + review.chainId +
      (review.testnet ? ' · testnet' : ' · MAINNET'));
    addReviewRow('From', review.from, true);
    addReviewRow('To', review.to, true);
    addReviewRow('Amount', evmSend.formatUnits(review.valueWei, 18) + ' ' + symbol +
      ' (' + review.valueWei + ' wei)');
    addReviewRow('Data', review.dataHex, true);
    addReviewRow('Gas limit', review.gasLimit.toString() + (review.gasLimitIsManual
      ? (review.gasEstimate === null || review.gasEstimate === undefined
        ? ' (manual; node estimate unavailable)'
        : ' (manual; node estimate ' + review.gasEstimate + ')')
      : (review.testnet
        ? ' (eth_estimateGas)'
        : ' (eth_estimateGas + 20% buffer)')));
    addReviewRow('Nonce', review.nonce.toString());
    addReviewRow('Max fee (per gas)', evmSend.formatUnits(review.maxFeeWei, 9) + ' gwei (' +
      review.maxFeeWei + ' wei)');
    addReviewRow('Priority fee', evmSend.formatUnits(review.priorityWei, 9) + ' gwei');
    addReviewRow('Base fee', evmSend.formatUnits(review.baseFeeWei, 9) + ' gwei');
    addReviewRow('Maximum network fee', evmSend.formatUnits(feeWei, 18) + ' ' + symbol);
    addReviewRow('Total max cost', evmSend.formatUnits(review.totalMaxCostWei, 18) + ' ' +
      symbol + ' (' + review.totalMaxCostWei + ' wei)');
    addReviewRow('Balance', evmSend.formatUnits(review.balanceWei, 18) + ' ' + symbol);
    if (review.feeCapWei !== null && review.feeCapWei !== undefined) {
      addReviewRow('Fee cap', evmSend.formatUnits(review.feeCapWei, 18) + ' ' + symbol +
        ' · within cap');
    }
    addReviewRow('RPC', review.providerLabel + ' · ' + review.providerUrl);
    addReviewRow('Fee source', review.feesSource + ' / priority: ' + review.prioritySource);

    sendReviewWarnings.textContent = '';
    if (review.warnings.length) {
      review.warnings.forEach(function (warning) {
        var item = document.createElement('li');
        item.textContent = warning;
        sendReviewWarnings.appendChild(item);
      });
      sendReviewWarnings.hidden = false;
    } else {
      sendReviewWarnings.hidden = true;
    }

    sendReviewUnsigned.textContent = review.unsignedHex;
    sendReviewBox.hidden = false;
    if (sendStatus) sendStatus.textContent = 'Review ready. Check every field, then sign.';
    if (sendConfirmButton) sendConfirmButton.focus();
  }

  function renderSendResult(result) {
    sendProviderNote.textContent = 'Sent to ' + result.providerLabel + ' · ' +
      result.providerUrl + '. Crypto did not proxy or store the transaction.';
    sendHashEl.textContent = result.txHash;
    sendExplorerLink.href = result.explorerUrl;
    sendExplorerLink.textContent = 'Open on the ' + (result.chainName || 'chain') + ' explorer';
    sendSignedEl.textContent = result.signedHex;
    sendResultBox.hidden = false;
    if (sendStatus) sendStatus.textContent = 'The RPC accepted the signed transaction.';
    sendExplorerLink.focus();
  }

  function resetSend() {
    state.preparing = false;
    state.review = null;
    state.reviewEntryId = null;
    state.mainnetArmed = false;
    if (sendArmedCheckbox) sendArmedCheckbox.checked = false;
    if (sendArmedRow) sendArmedRow.hidden = true;
    if (sendForm) sendForm.reset();
    clearSendFieldErrors();
    setError('wallet-send-error', '');
    setError('wallet-send-confirm-error', '');
    if (sendReviewBox) sendReviewBox.hidden = true;
    if (sendResultBox) sendResultBox.hidden = true;
    if (sendReviewList) sendReviewList.textContent = '';
    if (sendReviewWarnings) sendReviewWarnings.textContent = '';
    if (sendReviewUnsigned) sendReviewUnsigned.textContent = '';
    if (sendProviderNote) sendProviderNote.textContent = '';
    if (sendHashEl) sendHashEl.textContent = '';
    if (sendSignedEl) sendSignedEl.textContent = '';
    if (sendExplorerLink) sendExplorerLink.removeAttribute('href');
    if (sendStatus) sendStatus.textContent = '';
    if (sendEntrySelect) sendEntrySelect.textContent = '';
    if (sendCard) sendCard.hidden = true;
    resetBtcSend();
    setSendBusy(false);
  }

  /* Direct browser request with the honest Origin. The timeout comes from
   * fetchWithTimeout; JSON-RPC errors are returned to rpcCall to report. */
  function rpcFetchJson(url, init) {
    return fetchWithTimeout(url, init).then(function (response) {
      return response.text().then(function (text) {
        var data;
        try {
          data = JSON.parse(text);
        } catch (err) {
          throw new Error('non-JSON response from ' + url);
        }
        if (!response.ok && !(data && data.error)) {
          throw new Error('HTTP ' + response.status + ' from ' + url);
        }
        return data;
      });
    });
  }

  sendForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!state.unlocked) {
      setError('wallet-send-error', 'Unlock the vault first.');
      return;
    }
    if (!evmSend) {
      setError('wallet-send-error', 'The EVM send module did not load. Reload the page.');
      return;
    }
    if (state.preparing || state.sending) return;
    var entry = selectedSendEntry();
    if (!entry) {
      setError('wallet-send-error', 'Import an EVM key and select it first.');
      return;
    }
    clearSendFieldErrors();
    setError('wallet-send-error', '');
    setError('wallet-send-confirm-error', '');
    invalidateSendReview();
    if (sendReviewBox) sendReviewBox.hidden = true;

    var local = evmSend.validateForm(readSendForm());
    if (Object.keys(local.errors).length) {
      showSendFieldErrors(local.errors);
      setError('wallet-send-error', 'Fix the highlighted fields before review.');
      return;
    }

    state.preparing = true;
    var generation = state.generation;
    setSendBusy(true, 'Reading the chain id, nonce, balance, fees and gas estimate…');
    try {
      var from = await ensureDerivedAddress(entry);
      var review = await evmSend.prepareTransaction({
        form: readSendForm(),
        from: from,
        fetchJson: rpcFetchJson,
        providerUrl: sendProviderSelect.value || null,
        expectedChainId: Number(sendNetworkSelect.value),
        mainnetArmed: isMainnetArmed(),
        unsigned: unsignedTx
      });
      if (generation !== state.generation || !state.unlocked) return;
      state.review = review;
      state.reviewEntryId = entry.id;
      fillSendDefaults(review);
      renderReview(review);
    } catch (err) {
      if (generation !== state.generation || !state.unlocked) return;
      if (err.fieldErrors) showSendFieldErrors(err.fieldErrors);
      setError('wallet-send-error', errorText(err));
      if (sendReviewBox) sendReviewBox.hidden = true;
      if (sendStatus) sendStatus.textContent = '';
    } finally {
      state.preparing = false;
      setSendBusy(false);
      /* The confirm button was disabled while fetching, so the focus set in
       * renderReview was ignored; move it there once the button is usable. */
      if (state.review && sendConfirmButton && !sendConfirmButton.disabled) {
        sendConfirmButton.focus();
      }
    }
  });

  sendForm.addEventListener('input', invalidateSendReview);
  sendEntrySelect.addEventListener('change', function () {
    updateSendFrom();
    invalidateSendReview();
  });
  sendNetworkSelect.addEventListener('change', function () {
    renderProviders();
    updateSendArmedRow();
    invalidateSendReview();
  });
  sendProviderSelect.addEventListener('change', invalidateSendReview);
  if (sendArmedCheckbox) {
    sendArmedCheckbox.addEventListener('change', function () {
      state.mainnetArmed = sendArmedCheckbox.checked;
      invalidateSendReview();
    });
  }

  sendCancelButton.addEventListener('click', function () {
    invalidateSendReview();
    if (sendReviewBox) sendReviewBox.hidden = true;
    if (sendStatus) sendStatus.textContent = '';
    sendToInput.focus();
  });

  sendConfirmButton.addEventListener('click', async function () {
    if (!state.unlocked) {
      setError('wallet-send-confirm-error', 'Unlock the vault first.');
      return;
    }
    if (state.sending || state.preparing) {
      setError('wallet-send-confirm-error', 'A send is already in flight.');
      return;
    }
    var review = state.review;
    var entry = entryById(state.reviewEntryId);
    var selected = selectedSendEntry();
    if (!review || !entry) {
      setError('wallet-send-confirm-error', 'Prepare a new review first.');
      return;
    }
    if (!selected || selected.id !== entry.id) {
      setError('wallet-send-confirm-error', 'The selected key changed; prepare a new review.');
      return;
    }

    state.sending = true;
    var generation = state.generation;
    setError('wallet-send-confirm-error', '');
    setSendBusy(true, 'Checking the chain id, signing locally and broadcasting…');
    try {
      var result = await evmSend.confirmTransaction({
        review: review,
        fetchJson: rpcFetchJson,
        mainnetArmed: isMainnetArmed(),
        sign: function (fields) { return signTxWithEntry(entry, fields); }
      });
      if (generation !== state.generation || !state.unlocked) return;
      state.review = null;
      state.reviewEntryId = null;
      if (sendReviewBox) sendReviewBox.hidden = true;
      renderSendResult(result);
    } catch (err) {
      if (generation === state.generation && state.unlocked) {
        setError('wallet-send-confirm-error', errorText(err));
        if (sendStatus) sendStatus.textContent = 'Signing or broadcast failed.';
      }
    } finally {
      state.sending = false;
      setSendBusy(false);
    }
  });

  /* --------------------------------------------------------- BTC send */

  /* Bitcoin testnet only. The private key exists only inside
   * signBtcWithEntry; the review carries public fields and unsigned hex. */

  var BTC_ERROR_IDS = {
    to: 'wallet-btc-to-error',
    amount: 'wallet-btc-amount-error',
    feeRate: 'wallet-btc-fee-rate-error'
  };

  function btcEntries() {
    if (!btcSend) return [];
    return state.entries.filter(function (entry) {
      return entry.chain === btcSend.CHAIN_SLUG;
    });
  }

  function selectedBtcEntry() {
    if (!btcEntrySelect) return null;
    return entryById(btcEntrySelect.value);
  }

  function showBtcFieldErrors(errors) {
    Object.keys(BTC_ERROR_IDS).forEach(function (key) {
      setError(BTC_ERROR_IDS[key], errors[key] || '');
    });
  }

  function updateBtcFrom() {
    if (!btcFromLine) return;
    var entry = selectedBtcEntry();
    if (!entry) {
      btcFromLine.textContent = 'Select a Bitcoin testnet key to see its tb1 address.';
      return;
    }
    var derived = state.derived[entry.id];
    if (derived && derived.address) {
      btcFromLine.textContent = 'From: ' + derived.address + ' (P2WPKH)';
      return;
    }
    if (derived && derived.error) {
      btcFromLine.textContent = 'Address unavailable: ' + derived.error;
      return;
    }
    btcFromLine.textContent = 'Deriving address…';
    deriveEntry(entry, state.generation);
  }

  function renderBtcSend() {
    if (!btcCard || !btcSend) return;
    var entries = btcEntries();
    if (state.btcReview && !entries.some(function (entry) {
      return entry.id === state.btcReviewEntryId;
    })) {
      invalidateBtcReview();
    }
    if (!state.unlocked || !entries.length) {
      btcCard.hidden = true;
      return;
    }
    btcCard.hidden = false;
    var previous = btcEntrySelect.value;
    btcEntrySelect.textContent = '';
    entries.forEach(function (entry) {
      var option = document.createElement('option');
      option.value = entry.id;
      option.textContent = (entry.label || chainLabel(entry.chain)) + ' · ' + chainLabel(entry.chain);
      btcEntrySelect.appendChild(option);
    });
    if (previous && entries.some(function (entry) { return entry.id === previous; })) {
      btcEntrySelect.value = previous;
    }
    if (!btcEntrySelect.value) btcEntrySelect.value = entries[0].id;
    updateBtcFrom();
  }

  function invalidateBtcReview() {
    if (!state.btcReview) return;
    state.btcReview = null;
    state.btcReviewEntryId = null;
    if (btcReviewBox) btcReviewBox.hidden = true;
    setError('wallet-btc-confirm-error', '');
    if (btcStatus) btcStatus.textContent = 'Form changed: fetch UTXOs and review again.';
  }

  function setBtcBusy(busy, message) {
    var blocked = !!busy || state.btcSending;
    if (btcPrepareButton) btcPrepareButton.disabled = blocked;
    if (btcConfirmButton) btcConfirmButton.disabled = blocked;
    if (btcStatus && message !== undefined) btcStatus.textContent = message;
  }

  function addBtcReviewRow(label, value, asCode) {
    var term = document.createElement('dt');
    term.textContent = label;
    var detail = document.createElement('dd');
    if (asCode) {
      var code = document.createElement('code');
      code.className = 'mono';
      code.textContent = value;
      detail.appendChild(code);
    } else {
      detail.textContent = value;
    }
    btcReviewList.appendChild(term);
    btcReviewList.appendChild(detail);
  }

  function renderBtcReview(review) {
    btcReviewList.textContent = '';
    addBtcReviewRow('Network', 'Bitcoin testnet · ' + review.networkName);
    addBtcReviewRow('From', review.from, true);
    addBtcReviewRow('To', review.to, true);
    addBtcReviewRow('Amount', btcSend.formatBtc(review.amountSats) + ' BTC (' +
      review.amountSats.toString() + ' sats)');
    review.inputs.forEach(function (input, index) {
      addBtcReviewRow('Input ' + (index + 1),
        input.txid + ':' + input.vout + ' · ' + input.value + ' sats', true);
    });
    review.outputs.forEach(function (output, index) {
      addBtcReviewRow('Output ' + (index + 1), output.address + ' · ' +
        output.value + ' sats', true);
    });
    addBtcReviewRow('Fee', review.feeSats.toString() + ' sats (' +
      btcSend.formatBtc(review.feeSats) + ' BTC)');
    addBtcReviewRow('Fee rate', btcSend.formatFeeRate(review.feeRateHundredths) +
      ' sat/vB · ' + review.feeRateSource);
    addBtcReviewRow('Estimated vsize', review.vsize + ' vB');
    addBtcReviewRow('Change', review.changeSats > 0n
      ? review.changeSats.toString() + ' sats back to ' + review.from
      : 'no change output' + (review.dustToFeeSats > 0n
        ? ' (dust ' + review.dustToFeeSats.toString() + ' sats added to the fee)'
        : ''));
    addBtcReviewRow('Total input', review.totalInputSats.toString() + ' sats (' +
      btcSend.formatBtc(review.totalInputSats) + ' BTC)');
    addBtcReviewRow('Total spent', review.totalSpentSats.toString() + ' sats (' +
      btcSend.formatBtc(review.totalSpentSats) + ' BTC including fee)');
    addBtcReviewRow('UTXO source', review.apiBase + '/address/' + review.from + '/utxo', true);

    btcReviewWarnings.textContent = '';
    if (review.warnings.length) {
      review.warnings.forEach(function (warning) {
        var item = document.createElement('li');
        item.textContent = warning;
        btcReviewWarnings.appendChild(item);
      });
      btcReviewWarnings.hidden = false;
    } else {
      btcReviewWarnings.hidden = true;
    }

    btcReviewUnsigned.textContent = review.unsignedHex;
    btcReviewBox.hidden = false;
    if (btcStatus) btcStatus.textContent = 'Review ready. Check every field, then sign.';
    if (btcConfirmButton) btcConfirmButton.focus();
  }

  function renderBtcResult(result) {
    btcProviderNote.textContent = 'Sent to mempool.space testnet (' +
      result.apiBase + '). Crypto did not proxy or store the transaction.';
    btcTxidEl.textContent = result.txid;
    btcExplorerLink.href = result.explorerUrl;
    btcSignedEl.textContent = result.signedHex;
    btcResultBox.hidden = false;
    if (btcStatus) btcStatus.textContent = 'mempool.space accepted the signed transaction.';
    btcExplorerLink.focus();
  }

  function resetBtcSend() {
    state.btcPreparing = false;
    state.btcReview = null;
    state.btcReviewEntryId = null;
    if (btcForm) btcForm.reset();
    showBtcFieldErrors({});
    setError('wallet-btc-error', '');
    setError('wallet-btc-confirm-error', '');
    if (btcReviewBox) btcReviewBox.hidden = true;
    if (btcResultBox) btcResultBox.hidden = true;
    if (btcReviewList) btcReviewList.textContent = '';
    if (btcReviewWarnings) btcReviewWarnings.textContent = '';
    if (btcReviewUnsigned) btcReviewUnsigned.textContent = '';
    if (btcProviderNote) btcProviderNote.textContent = '';
    if (btcTxidEl) btcTxidEl.textContent = '';
    if (btcSignedEl) btcSignedEl.textContent = '';
    if (btcExplorerLink) btcExplorerLink.removeAttribute('href');
    if (btcStatus) btcStatus.textContent = '';
    if (btcEntrySelect) btcEntrySelect.textContent = '';
    if (btcCard) btcCard.hidden = true;
    setBtcBusy(false);
  }

  /* Public GET with the honest Origin, bounded by the shared timeout. */
  function getJson(url) {
    return fetchWithTimeout(url).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ' from ' + url);
      return response.json();
    });
  }

  /* Broadcast the signed raw transaction as text. text/plain is a CORS
   * safelisted content type, so the browser sends no preflight; mempool.space
   * answers with Access-Control-Allow-Origin: * (verified 2026-11-19). */
  function postTxText(url, rawHex) {
    return fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: rawHex
    }).then(function (response) {
      return response.text().then(function (body) {
        var text = body.trim();
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + (text ? ': ' + text : ''));
        }
        return text;
      });
    });
  }

  btcForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!state.unlocked) {
      setError('wallet-btc-error', 'Unlock the vault first.');
      return;
    }
    if (!btcSend) {
      setError('wallet-btc-error', 'The Bitcoin send module did not load. Reload the page.');
      return;
    }
    if (state.btcPreparing || state.btcSending) return;
    var entry = selectedBtcEntry();
    if (!entry) {
      setError('wallet-btc-error', 'Import a Bitcoin testnet key and select it first.');
      return;
    }
    showBtcFieldErrors({});
    setError('wallet-btc-error', '');
    setError('wallet-btc-confirm-error', '');
    invalidateBtcReview();
    if (btcReviewBox) btcReviewBox.hidden = true;

    var form = {
      to: btcToInput.value,
      amount: btcAmountInput.value,
      feeRate: btcRateInput.value
    };
    var local = btcSend.validateForm(form);
    if (Object.keys(local.errors).length) {
      showBtcFieldErrors(local.errors);
      setError('wallet-btc-error', 'Fix the highlighted fields before review.');
      return;
    }

    state.btcPreparing = true;
    var generation = state.generation;
    setBtcBusy(true, 'Fetching UTXOs and the recommended fee from mempool.space testnet…');
    try {
      var from = await ensureDerivedAddress(entry);
      var review = await btcSend.prepareTransaction({
        form: form,
        from: from,
        chain: entry.chain,
        getJson: getJson,
        unsigned: unsignedBtcTx
      });
      if (generation !== state.generation || !state.unlocked) return;
      state.btcReview = review;
      state.btcReviewEntryId = entry.id;
      renderBtcReview(review);
    } catch (err) {
      if (generation !== state.generation || !state.unlocked) return;
      if (err.fieldErrors) showBtcFieldErrors(err.fieldErrors);
      setError('wallet-btc-error', errorText(err));
      if (btcReviewBox) btcReviewBox.hidden = true;
      if (btcStatus) btcStatus.textContent = '';
    } finally {
      state.btcPreparing = false;
      setBtcBusy(false);
      if (state.btcReview && btcConfirmButton && !btcConfirmButton.disabled) {
        btcConfirmButton.focus();
      }
    }
  });

  btcForm.addEventListener('input', invalidateBtcReview);
  btcEntrySelect.addEventListener('change', function () {
    updateBtcFrom();
    invalidateBtcReview();
  });

  btcCancelButton.addEventListener('click', function () {
    invalidateBtcReview();
    if (btcReviewBox) btcReviewBox.hidden = true;
    if (btcStatus) btcStatus.textContent = '';
    btcToInput.focus();
  });

  btcConfirmButton.addEventListener('click', async function () {
    if (!state.unlocked) {
      setError('wallet-btc-confirm-error', 'Unlock the vault first.');
      return;
    }
    if (state.btcSending || state.btcPreparing) {
      setError('wallet-btc-confirm-error', 'A send is already in flight.');
      return;
    }
    var review = state.btcReview;
    var entry = entryById(state.btcReviewEntryId);
    var selected = selectedBtcEntry();
    if (!review || !entry) {
      setError('wallet-btc-confirm-error', 'Prepare a new review first.');
      return;
    }
    if (!selected || selected.id !== entry.id) {
      setError('wallet-btc-confirm-error', 'The selected key changed; prepare a new review.');
      return;
    }

    state.btcSending = true;
    var generation = state.generation;
    setError('wallet-btc-confirm-error', '');
    setBtcBusy(true, 'Signing locally and broadcasting to mempool.space testnet…');
    try {
      var result = await btcSend.confirmTransaction({
        review: review,
        sign: function (request) { return signBtcWithEntry(entry, request); },
        onSigned: function (signedHex) {
          /* Show the signed bytes before the POST leaves the tab. */
          btcProviderNote.textContent = 'Signed locally. Broadcasting the signed raw transaction to mempool.space testnet…';
          btcTxidEl.textContent = '';
          btcExplorerLink.removeAttribute('href');
          btcSignedEl.textContent = signedHex;
          btcResultBox.hidden = false;
          if (btcStatus) btcStatus.textContent = 'Signed. Posting the signed raw transaction…';
        },
        broadcast: postTxText
      });
      if (generation !== state.generation || !state.unlocked) return;
      state.btcReview = null;
      state.btcReviewEntryId = null;
      if (btcReviewBox) btcReviewBox.hidden = true;
      renderBtcResult(result);
    } catch (err) {
      if (generation === state.generation && state.unlocked) {
        setError('wallet-btc-confirm-error', errorText(err));
        if (btcStatus) btcStatus.textContent = 'Signing or broadcast failed.';
      }
    } finally {
      state.btcSending = false;
      setBtcBusy(false);
    }
  });

  /* ------------------------------------------------------------------ backup */

  byId('wallet-export').addEventListener('click', function () {
    var status = byId('wallet-export-status');
    if (!state.record) {
      status.textContent = 'Create or unlock a vault first.';
      return;
    }
    try {
      var blob = vault.exportVaultBlob(state.record);
      var file = new Blob([blob], { type: 'text/plain' });
      var link = document.createElement('a');
      link.href = URL.createObjectURL(file);
      link.download = 'rotor-wallet-backup.txt';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
      status.textContent = 'Encrypted backup downloaded. It contains only ciphertext.';
    } catch (err) {
      status.textContent = 'Cannot export the vault: ' + errorText(err);
    }
  });

  byId('wallet-backup-import').addEventListener('click', async function () {
    var status = byId('wallet-backup-status');
    var fileInput = byId('wallet-backup-file');
    var textBox = byId('wallet-backup-text');
    status.textContent = '';
    try {
      var text = textBox.value.trim();
      if (!text && fileInput.files && fileInput.files[0]) {
        text = (await fileInput.files[0].text()).trim();
      }
      if (!text) throw new Error('Choose a backup file or paste the blob.');
      var record = vault.importVaultBlob(text);
      await writeRecord(record);
      state.record = record;
      state.generation += 1;
      lock('Encrypted backup imported. Unlock it with its passphrase.');
      status.textContent = 'Backup imported. The vault is locked.';
      textBox.value = '';
      fileInput.value = '';
    } catch (err) {
      status.textContent = 'Cannot import the backup: ' + errorText(err);
    }
  });

  /* -------------------------------------------------------------------- boot */

  function boot() {
    if (typeof window.crypto === 'undefined' || !window.crypto.subtle) {
      showUnavailable('This page needs WebCrypto. Open it over https or on localhost.');
      return;
    }
    if (!indexedDbAvailable()) {
      showUnavailable('IndexedDB is unavailable in this browser, so the encrypted vault cannot be stored. There is no plaintext fallback: open the page in a normal tab or a browser that supports IndexedDB.');
      return;
    }
    readRecord().then(function (record) {
      state.record = record;
      renderProviders();
      if (record) showLocked('');
      else {
        setupCard.hidden = false;
        unlockCard.hidden = true;
        panel.hidden = true;
      }
    }).catch(function (err) {
      showUnavailable('Cannot read the vault database: ' + errorText(err) +
        '. IndexedDB may be disabled or blocked; there is no plaintext fallback.');
    });
  }

  boot();
})();
