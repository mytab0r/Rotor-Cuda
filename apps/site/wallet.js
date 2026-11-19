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
 * This phase adds an EVM Sepolia send flow: the form and validation live in
 * wallet-evm.js, the review must be confirmed before signing, the signature
 * is produced by evm_sign_tx in the local WASM core and the signed raw
 * transaction is broadcast directly to a public RPC. Mainnet signing is off. */
(function () {
  'use strict';

  var VAULT_DB = 'rotor-wallet';
  var VAULT_STORE = 'vault';
  var VAULT_KEY = 'vault';
  var IDLE_MS = 10 * 60 * 1000;
  var IDLE_CHECK_MS = 15 * 1000;
  var WASM_URL = '/rotor_wasm.wasm';
  var TIMEOUT_MS = 10000;
  var MAX_LABEL = 64;
  var BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var WIF_MIN_LENGTH = 50;
  var WIF_MAX_LENGTH = 53;

  /* Address rows come from the wasm derive_report report; the explorer and
   * provider URLs mirror apps/site/key.js. */
  var CHAINS = [
    { slug: 'bitcoin', label: 'Bitcoin', curve: 0, addressId: 'btc_p2wpkh', explorer: 'https://mempool.space/address/' },
    { slug: 'ethereum', label: 'Ethereum', curve: 0, addressId: 'evm', explorer: 'https://etherscan.io/address/', rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'], symbol: 'ETH' },
    { slug: 'bnb', label: 'BNB Chain', curve: 0, addressId: 'evm', explorer: 'https://bscscan.com/address/', rpc: ['https://bsc-dataseed.binance.org'], symbol: 'BNB' },
    { slug: 'arbitrum', label: 'Arbitrum', curve: 0, addressId: 'evm', explorer: 'https://arbiscan.io/address/', rpc: ['https://arb1.arbitrum.io/rpc'], symbol: 'ETH' },
    { slug: 'optimism', label: 'Optimism', curve: 0, addressId: 'evm', explorer: 'https://optimistic.etherscan.io/address/', rpc: ['https://mainnet.optimism.io'], symbol: 'ETH' },
    { slug: 'base', label: 'Base', curve: 0, addressId: 'evm', explorer: 'https://basescan.org/address/', rpc: ['https://mainnet.base.org'], symbol: 'ETH' },
    { slug: 'polygon', label: 'Polygon', curve: 0, addressId: 'evm', explorer: 'https://polygonscan.com/address/', rpc: ['https://polygon-rpc.com'], symbol: 'POL' },
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
    reviewEntryId: null
  };

  var vault = window.RotorWalletVault;
  var evmSend = window.RotorEvmSend;
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

  /* Send form (EVM Sepolia). Nothing in this block holds a private key. */
  var sendCard = byId('wallet-send');
  var sendForm = byId('wallet-send-form');
  var sendEntrySelect = byId('wallet-send-entry');
  var sendNetworkSelect = byId('wallet-send-network');
  var sendProviderSelect = byId('wallet-send-provider');
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

  if (!vault) {
    showUnavailable('The wallet codec did not load. Reload the page.');
    return;
  }
  if (!evmSend) {
    /* The vault still works watch-only; sending stays unavailable and says so. */
    if (sendCard) sendCard.hidden = true;
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
      var required = ['alloc', 'dealloc', 'derive_report', 'result_ptr', 'result_len',
        'error_ptr', 'error_len', 'clear_result', 'evm_unsigned_tx', 'evm_sign_tx'];
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

  function deriveReport(wasm, bytes, curve) {
    var pointer = wasm.alloc(bytes.length) >>> 0;
    if (!pointer) throw new Error('WASM memory exhausted.');
    try {
      new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
      var status = wasm.derive_report(pointer, curve) >>> 0;
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

  function loadTon() {
    if (window.RotorTon) return Promise.resolve(window.RotorTon);
    if (state.tonPromise) return state.tonPromise;
    state.tonPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = '/ton.js';
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
      throw new Error('This is a Bitcoin testnet WIF (version 0xEF). The local derivation core returns mainnet addresses only in this phase, so the key was not stored.');
    }
    if (wif.version === 0xf1) {
      throw new Error('This is a Dogecoin testnet WIF (version 0xF1). Testnet addresses are not supported in this phase, so the key was not stored.');
    }
    throw new Error('Unsupported WIF version 0x' + wif.version.toString(16).padStart(2, '0') +
      '. Supported: Bitcoin, Litecoin and Dogecoin mainnet.');
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
      key: wif.key
    };
  }

  async function deriveAddress(parsed) {
    var wasm = await loadWasm();
    var report = deriveReport(wasm, parsed.key, parsed.curve);
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
    if (setupCard) setupCard.hidden = true;
    if (unlockCard) unlockCard.hidden = true;
    if (panel) panel.hidden = false;
    renderProviders();
    renderSend();
    if (stateEl) stateEl.textContent = 'unlocked · auto-locks after 10 minutes idle';
    setError('wallet-unlock-error', '');
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
    var duplicate = state.entries.some(function (entry) {
      if (entry.chain !== parsed.chain) return false;
      if (entry.secret === parsed.secret) return true;
      var cached = state.derived[entry.id];
      return cached && cached.address === derived.address;
    });
    if (duplicate) {
      setError('wallet-add-error', 'That key is already in the vault.');
      return;
    }
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
    try {
      await saveEntries(nextEntries, nextDerived);
    } catch (err) {
      setError('wallet-add-error', 'Cannot save the vault: ' + errorText(err));
      return;
    }
    importSecret.value = '';
    importLabel.value = '';
    importChain.value = '';
    renderEntries();
  });

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
    explorer.target = '_blank';
    explorer.rel = 'noopener noreferrer';
    explorer.textContent = 'Explorer';
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

  async function fetchBtcBalance(address) {
    var response = await fetchWithTimeout('https://mempool.space/api/address/' + encodeURIComponent(address));
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
    if (chain === 'bitcoin') return fetchBtcBalance(address);
    if (chain === 'tron') return fetchTronBalance(address);
    var spec = chainSpec(chain);
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

  function renderProviders() {
    if (!evmSend || !sendProviderSelect) return;
    var previous = sendProviderSelect.value;
    sendProviderSelect.textContent = '';
    var auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Auto (try publicnode → 1RPC → Tenderly)';
    sendProviderSelect.appendChild(auto);
    evmSend.PROVIDERS.forEach(function (provider) {
      var option = document.createElement('option');
      option.value = provider.url;
      option.textContent = provider.label;
      sendProviderSelect.appendChild(option);
    });
    if (previous) sendProviderSelect.value = previous;
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
    sendReviewList.textContent = '';
    addReviewRow('Network', review.chainName + ' · chain id ' + review.chainId);
    addReviewRow('From', review.from, true);
    addReviewRow('To', review.to, true);
    addReviewRow('Value', evmSend.formatUnits(review.valueWei, 18) + ' ETH (' + review.valueWei + ' wei)');
    addReviewRow('Data', review.dataHex, true);
    addReviewRow('Gas limit', review.gasLimit.toString() + (review.gasLimitIsManual
      ? (review.gasEstimate === null || review.gasEstimate === undefined
        ? ' (manual; node estimate unavailable)'
        : ' (manual; node estimate ' + review.gasEstimate + ')')
      : ' (eth_estimateGas)'));
    addReviewRow('Nonce', review.nonce.toString());
    addReviewRow('Max fee', evmSend.formatUnits(review.maxFeeWei, 9) + ' gwei (' + review.maxFeeWei + ' wei)');
    addReviewRow('Priority fee', evmSend.formatUnits(review.priorityWei, 9) + ' gwei');
    addReviewRow('Base fee', evmSend.formatUnits(review.baseFeeWei, 9) + ' gwei');
    addReviewRow('Total max cost', evmSend.formatUnits(review.totalMaxCostWei, 18) + ' ETH (' +
      review.totalMaxCostWei + ' wei)');
    addReviewRow('Balance', evmSend.formatUnits(review.balanceWei, 18) + ' ETH');
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
      result.providerUrl + '. Rotor did not proxy or store the transaction.';
    sendHashEl.textContent = result.txHash;
    sendExplorerLink.href = result.explorerUrl;
    sendSignedEl.textContent = result.signedHex;
    sendResultBox.hidden = false;
    if (sendStatus) sendStatus.textContent = 'The RPC accepted the signed transaction.';
    sendExplorerLink.focus();
  }

  function resetSend() {
    state.preparing = false;
    state.review = null;
    state.reviewEntryId = null;
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
        chainName: evmSend.SEPOLIA.name,
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
  sendNetworkSelect.addEventListener('change', invalidateSendReview);
  sendProviderSelect.addEventListener('change', invalidateSendReview);

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
