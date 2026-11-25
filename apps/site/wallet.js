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

  /* Chain identity and public providers come from data/*.json through the
   * generated globals in chains.generated.js (loaded before this script). */
  var SSOT_ROOT = typeof window !== 'undefined' ? window : globalThis;
  var SSOT_CHAINS = SSOT_ROOT.RotorChains;
  var SSOT_PROVIDERS = SSOT_ROOT.RotorProviders;
  var AMOUNT = SSOT_ROOT.RotorAmount;

  /* The canonical table holds every public endpoint. `providerId` keeps a
   * chain on the single endpoint this page has always used (the rest of the
   * list is the wallet send path); no id means the full ordered fallback. */
  function rpcUrls(slug, providerId) {
    if (providerId) {
      var found = SSOT_PROVIDERS.find(slug, providerId);
      return found ? [found.url] : [];
    }
    return (SSOT_PROVIDERS.byChain[slug] || []).map(function (provider) {
      return provider.url;
    });
  }

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
  /* One public ticker request per six hours, shared with /key through
   * key-tools.js; only ticker symbols leave the browser. */
  var PRICE_CACHE_KEY = (window.RotorKeyTools && window.RotorKeyTools.PRICE_CACHE_KEY) || 'rotor.prices.v1';
  var PRICE_TTL_MS = (window.RotorKeyTools && window.RotorKeyTools.PRICE_TTL_MS) || 6 * 60 * 60 * 1000;
  /* The monitor page's session token. The same key means signing in here also
   * signs this browser in on /cabinet; the token is never rendered or logged. */
  var MONITOR_TOKEN_KEY = 'rotor-monitor-token';
  var MONITOR_ADDRESS_KEY = 'rotor-wallet-monitor-address';
  var MONITOR_API = '/api/v1/monitor';

  /* Address rows come from the wasm derive_report report; explorer, label,
   * symbol and decimals come from data/chains.json. */
  function chainRow(slug, extra) {
    var meta = SSOT_CHAINS.bySlug[slug];
    return Object.assign({
      slug: slug,
      label: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      explorer: meta.explorerPrefix
    }, extra);
  }

  var CHAINS = [
    chainRow('bitcoin', { curve: 0, addressId: 'btc_p2wpkh' }),
    chainRow('bitcoin-testnet', { curve: 0, addressId: 'btc_p2wpkh', btcApi: SSOT_PROVIDERS.find('bitcoin-testnet', 'mempool').url, network: 1 }),
    chainRow('ethereum', { curve: 0, addressId: 'evm', rpc: rpcUrls('ethereum') }),
    chainRow('bnb', { curve: 0, addressId: 'evm', rpc: rpcUrls('bnb', 'bsc-dataseed') }),
    chainRow('arbitrum', { curve: 0, addressId: 'evm', rpc: rpcUrls('arbitrum', 'arbitrum') }),
    chainRow('optimism', { curve: 0, addressId: 'evm', rpc: rpcUrls('optimism') }),
    chainRow('base', { curve: 0, addressId: 'evm', rpc: rpcUrls('base', 'base') }),
    chainRow('polygon', { curve: 0, addressId: 'evm', rpc: rpcUrls('polygon') }),
    chainRow('avalanche', { curve: 0, addressId: 'evm', rpc: rpcUrls('avalanche', 'avalanche') }),
    chainRow('zksync', { curve: 0, addressId: 'evm', rpc: rpcUrls('zksync', 'zksync') }),
    chainRow('litecoin', { curve: 0, addressId: 'ltc_p2wpkh' }),
    chainRow('bitcoin-cash', { curve: 0, addressId: 'bch_legacy' }),
    chainRow('dogecoin', { curve: 0, addressId: 'doge_p2pkh' }),
    chainRow('zcash', { curve: 0, addressId: 'zcash_p2pkh' }),
    chainRow('xrp', { curve: 0, addressId: 'xrp_classic' }),
    chainRow('tron', { curve: 0, addressId: 'tron' }),
    chainRow('solana', { curve: 1, addressId: 'solana' }),
    chainRow('sui', { curve: 1, addressId: 'sui' }),
    chainRow('ton', { curve: 1, addressId: 'ton' })
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
    balances: {},
    summaryRefreshing: false,
    lastBalanceRefreshAt: 0,
    prices: null,
    priceMeta: null,
    priceStatus: 'idle',
    pricePromise: null,
    deriving: {},
    preparing: false,
    sending: false,
    review: null,
    reviewEntryId: null,
    mainnetArmed: false,
    swapArmed: false,
    swapQuote: null,
    swapReview: null,
    swapReviewEntryId: null,
    swapPreparing: false,
    swapSending: false,
    approvalsScanning: false,
    approvalsScan: null,
    approvalsScanEntryId: null,
    approvalsReview: null,
    approvalsReviewEntryId: null,
    approvalsReviewSpender: null,
    approvalsReviewKind: null,
    approvalsSending: false,
    btcPreparing: false,
    btcSending: false,
    btcReview: null,
    btcReviewEntryId: null,
    historyEntryId: null,
    historySeq: 0,
    seedWordCount: 12,
    onboardChoice: '',
    assets: {},
    assetsRefreshing: false,
    evmAddresses: {},
    signInEntryId: null,
    signInToken: '',
    signInAddress: '',
    signInBusy: false
  };

  var vault = window.RotorWalletVault;
  var evmSend = window.RotorEvmSend;
  var tronWallet = window.RotorTronWallet;
  var swap = window.RotorSwap;
  var btcSend = window.RotorBtcSend;
  var historyApi = window.RotorWalletHistory;
  var signApi = window.RotorWalletSign;
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

  /* Portfolio summary above the address groups. It reads only the balance
   * results the page already fetched and the shared public ticker cache. */
  var summaryBlock = byId('wallet-summary');
  var summaryRefresh = byId('wallet-summary-refresh');
  var summaryTotal = byId('wallet-summary-total');
  var summaryLoaded = byId('wallet-summary-loaded');
  var summaryEntries = byId('wallet-summary-entries');
  var summaryEmpty = byId('wallet-summary-empty');
  var summaryChains = byId('wallet-summary-chains');
  var summaryStatus = byId('wallet-summary-status');
  var summaryRefreshed = byId('wallet-summary-refreshed');
  var summaryHelper = window.RotorWalletSummary;

  /* Top-10 assets above the import form. The list is the generated SSOT from
   * data/assets.json; wallet.js supplies only the per-network balance states
   * and the shared ticker. */
  var assetsData = window.RotorAssetsData;
  var assetsHelper = window.RotorWalletAssets;
  var assetsSection = byId('wallet-assets');
  var assetsRows = byId('wallet-assets-rows');
  var assetsTotal = byId('wallet-assets-total');
  var assetsStatus = byId('wallet-assets-status');
  var assetsError = byId('wallet-assets-error');
  var assetsEmpty = byId('wallet-assets-empty');
  var assetsTableWrap = byId('wallet-assets-table-wrap');

  /* Onboarding choice: seed phrase or a single private key / WIF. The
   * matching form lives in the unlocked vault panel. */
  var onboardSeed = byId('wallet-onboard-seed');
  var onboardKey = byId('wallet-onboard-key');
  var onboardHint = byId('wallet-onboard-hint');

  /* Security status: reviewed advisories that touch a chain in this vault.
   * The card reads only vault entries and local check history. */
  var securityApi = window.RotorWalletSecurity;
  var securityCard = byId('wallet-security');
  var securityCount = byId('wallet-security-count');
  var securityChecks = byId('wallet-security-checks');
  var securityLast = byId('wallet-security-last');
  var securityEmpty = byId('wallet-security-empty');
  var securityList = byId('wallet-security-list');
  var securityStatus = byId('wallet-security-status');
  var securityCatalog = null;
  var securityPromise = null;
  var securityRunning = false;

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
  var sendTokenInput = byId('wallet-send-token');
  var sendValueInput = byId('wallet-send-value');
  var sendDataInput = byId('wallet-send-data');
  var sendGasInput = byId('wallet-send-gas');
  var sendPriorityInput = byId('wallet-send-priority');
  var sendMaxFeeInput = byId('wallet-send-max-fee');
  var sendFeeLimitInput = byId('wallet-send-fee-limit');
  var sendFeeLimitRow = byId('wallet-send-fee-limit-row');
  var sendToLabel = byId('wallet-send-to-label');
  var sendTokenLabel = byId('wallet-send-token-label');
  var sendDataRow = byId('wallet-send-data-row');
  var sendEvmFeeFields = byId('wallet-send-evm-fee-fields');
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

  /* TRON swap card. It reuses the TRON codec and the session arm; nothing in
   * this block holds a private key. */
  var swapCard = byId('wallet-swap');
  var swapForm = byId('wallet-swap-form');
  var swapEntrySelect = byId('wallet-swap-entry');
  var swapFromLine = byId('wallet-swap-from');
  var swapNetworkSelect = byId('wallet-swap-network');
  var swapAmountInput = byId('wallet-swap-amount');
  var swapSlippageInput = byId('wallet-swap-slippage');
  var swapFromTokenSelect = byId('wallet-swap-from-token');
  var swapToTokenSelect = byId('wallet-swap-to-token');
  var swapNileNote = byId('wallet-swap-nile-note');
  var swapArmedRow = byId('wallet-swap-armed-row');
  var swapArmedCheckbox = byId('wallet-swap-armed');
  var swapQuoteButton = byId('wallet-swap-quote');
  var swapStatus = byId('wallet-swap-status');
  var swapQuoteBox = byId('wallet-swap-quote-box');
  var swapQuoteList = byId('wallet-swap-quote-list');
  var swapQuoteAge = byId('wallet-swap-quote-age');
  var swapReviewButton = byId('wallet-swap-review');
  var swapReviewBox = byId('wallet-swap-review-box');
  var swapReviewList = byId('wallet-swap-review-list');
  var swapReviewWarnings = byId('wallet-swap-review-warnings');
  var swapReviewUnsigned = byId('wallet-swap-review-unsigned');
  var swapConfirmButton = byId('wallet-swap-confirm');
  var swapCancelButton = byId('wallet-swap-cancel');
  var swapResultBox = byId('wallet-swap-result');
  var swapProviderNote = byId('wallet-swap-provider-note');
  var swapHashEl = byId('wallet-swap-hash');
  var swapApproveResult = byId('wallet-swap-approve-result');
  var swapApproveHashEl = byId('wallet-swap-approve-hash');
  var swapExplorerLink = byId('wallet-swap-explorer');
  var swapSignedEl = byId('wallet-swap-signed');

  /* ERC-20 approvals panel. It reuses the send entry, network and provider
   * controls; it never holds a private key. */
  var approvalsCard = byId('wallet-approvals');
  var approvalsForm = byId('wallet-approvals-form');
  var approvalsTokenInput = byId('wallet-approvals-token');
  var approvalsWindowInput = byId('wallet-approvals-window');
  var approvalsScanButton = byId('wallet-approvals-scan');
  var approvalsStatus = byId('wallet-approvals-status');
  var approvalsCoverage = byId('wallet-approvals-coverage');
  var approvalsWarnings = byId('wallet-approvals-warnings');
  var approvalsTableWrap = byId('wallet-approvals-table-wrap');
  var approvalsRows = byId('wallet-approvals-rows');
  var approvalsEmpty = byId('wallet-approvals-empty');
  var approvalsGrantForm = byId('wallet-approvals-grant-form');
  var approvalsGrantSpender = byId('wallet-approvals-grant-spender');
  var approvalsGrantAmount = byId('wallet-approvals-grant-amount');
  var approvalsGrantUnlimited = byId('wallet-approvals-grant-unlimited');
  var approvalsGrantWarning = byId('wallet-approvals-grant-unlimited-warning');
  var approvalsGrantPrepareButton = byId('wallet-approvals-grant-prepare');
  var approvalsReviewBox = byId('wallet-approvals-review');
  var approvalsReviewHeading = byId('wallet-approvals-review-heading');
  var approvalsReviewList = byId('wallet-approvals-review-list');
  var approvalsReviewWarnings = byId('wallet-approvals-review-warnings');
  var approvalsReviewNote = byId('wallet-approvals-review-note');
  var approvalsReviewUnsigned = byId('wallet-approvals-review-unsigned');
  var approvalsConfirmButton = byId('wallet-approvals-confirm');
  var approvalsCancelButton = byId('wallet-approvals-cancel');
  var approvalsResultBox = byId('wallet-approvals-result');
  var approvalsProviderNote = byId('wallet-approvals-provider-note');
  var approvalsHashEl = byId('wallet-approvals-hash');
  var approvalsExplorerLink = byId('wallet-approvals-explorer');
  var approvalsRereadEl = byId('wallet-approvals-reread');
  var approvalsSignedEl = byId('wallet-approvals-signed');

  /* Transaction history panel. One panel serves the entry the user opened;
   * lock and any entry change reset it. */
  var historyPanel = byId('wallet-history');
  var historyClose = byId('wallet-history-close');
  var historySubject = byId('wallet-history-subject');
  var historyStatus = byId('wallet-history-status');
  var historyError = byId('wallet-history-error');
  var historyEmpty = byId('wallet-history-empty');
  var historyUnavailable = byId('wallet-history-unavailable');
  var historyTableWrap = byId('wallet-history-table-wrap');
  var historyRows = byId('wallet-history-rows');

  /* Monitor account sign-in (EVM address derived from a vault key). */
  var signCard = byId('wallet-signin');
  var signEntrySelect = byId('wallet-signin-entry');
  var signAccountLine = byId('wallet-signin-account');
  var signAuto = byId('wallet-signin-auto');
  var signStart = byId('wallet-signin-start');
  var signOut = byId('wallet-signin-out');
  var signSettings = byId('wallet-signin-settings');
  var signChip = byId('wallet-signin-chip');
  var signStatus = byId('wallet-signin-status');

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
    if (approvalsCard) approvalsCard.hidden = true;
  }
  if (!btcSend) {
    if (btcCard) btcCard.hidden = true;
  }
  if (!swap) {
    if (swapCard) swapCard.hidden = true;
  }
  if (!summaryHelper && summaryBlock) {
    /* The vault still works without the portfolio math; the summary says so
     * instead of rendering a number it cannot prove. */
    summaryBlock.hidden = true;
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
    if (approvalsCard) approvalsCard.hidden = true;
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
        'evm_unsigned_tx', 'evm_sign_tx', 'evm_sign_message', 'btc_unsigned_tx', 'btc_sign_tx'];
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
   * the body of the info popover (see #wallet-seed-estimate). */
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
    var addedEntry = null;
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
      addedEntry = await addParsedEntry(parsed, derived, importLabel.value);
    } catch (err) {
      setError('wallet-add-error', err.duplicate ? err.message : 'Cannot save the vault: ' + errorText(err));
      seedAdd.disabled = false;
      return;
    }
    importLabel.value = '';
    resetSeedPhrase();
    renderEntries();
    if (addedEntry) offerSignInForEntry(addedEntry);
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
      compressed: wif.compressed,
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
    return {
      address: row.address,
      chain: parsed.chain,
      id: parsed.addressId,
      label: row.label || parsed.addressId,
      evmAddress: findEvmRow(rows),
      compressed: typeof parsed.compressed === 'boolean' ? parsed.compressed : null
    };
  }

  function findEvmRow(rows) {
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].id === 'evm' &&
        typeof rows[i].address === 'string' &&
        /^0x[0-9a-fA-F]{40}$/.test(rows[i].address)) {
        return rows[i].address;
      }
    }
    return '';
  }

  /* ------------------------------------------------- monitor account sign-in */

  var monitorRequest = signApi
    ? signApi.createRequest(MONITOR_API, function (url, init) { return window.fetch(url, init); })
    : null;

  function readStored(key) {
    try { return window.localStorage.getItem(key) || ''; } catch (err) { return ''; }
  }

  function writeStored(key, value) {
    try {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    } catch (err) {
      /* private mode: the session stays in memory only */
    }
  }

  function evmCapableEntries() {
    return state.entries.filter(function (entry) {
      var spec = chainSpec(entry.chain);
      return spec && spec.curve === 0;
    });
  }

  function selectedSignEntry() {
    var entries = evmCapableEntries();
    for (var i = 0; i < entries.length; i += 1) {
      if (entries[i].id === state.signInEntryId) return entries[i];
    }
    return entries.length ? entries[0] : null;
  }

  /* The EVM address of a vault key. The same wasm report that derived the
   * entry's address carries the `evm` row, so imports usually find it cached;
   * older entries derive it once and only the public address is kept. */
  async function evmAddressForEntry(entry) {
    if (state.evmAddresses[entry.id]) return state.evmAddresses[entry.id];
    var spec = chainSpec(entry.chain);
    if (!spec || spec.curve !== 0) return '';
    var parsed = await parseEntry(entry);
    try {
      var wasm = await loadWasm();
      var report = deriveReport(wasm, parsed.key, 0, 0);
      var address = findEvmRow(Array.isArray(report.addresses) ? report.addresses : []);
      if (address) state.evmAddresses[entry.id] = address;
      return address;
    } finally {
      parsed.key.fill(0);
    }
  }

  function signSessionMessage(entry, message) {
    return parseEntry(entry).then(function (parsed) {
      return loadWasm().then(function (wasm) {
        try {
          return signApi.signMessage(wasm, parsed.key, message);
        } finally {
          parsed.key.fill(0);
        }
      }, function (err) {
        parsed.key.fill(0);
        throw err;
      });
    });
  }

  function clearSession() {
    state.signInToken = '';
    state.signInAddress = '';
    writeStored(MONITOR_TOKEN_KEY, '');
    writeStored(MONITOR_ADDRESS_KEY, '');
  }

  function renderSignIn() {
    if (!signCard) return;
    var available = !!signApi && !!monitorRequest;
    signCard.hidden = !state.unlocked || !available;
    if (!available || !state.unlocked) return;

    var entries = evmCapableEntries();
    var selected = selectedSignEntry();
    if (selected) state.signInEntryId = selected.id;

    signEntrySelect.textContent = '';
    entries.forEach(function (entry) {
      var option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      if (selected && entry.id === selected.id) option.selected = true;
      signEntrySelect.appendChild(option);
    });
    signEntrySelect.hidden = !entries.length;

    var signedIn = !!state.signInToken;
    signEntrySelect.disabled = signedIn || state.signInBusy;
    signStart.hidden = signedIn;
    signStart.disabled = signedIn || state.signInBusy || !selected;
    signOut.hidden = !signedIn;
    signOut.disabled = state.signInBusy;
    signSettings.hidden = !signedIn;
    if (signChip) {
      signChip.hidden = !signedIn;
      signChip.textContent = signedIn && state.signInAddress
        ? 'Account ' + state.signInAddress.slice(0, 6) + '…' + state.signInAddress.slice(-4)
        : (signedIn ? 'Account signed in' : '');
    }

    if (signedIn) {
      signAccountLine.textContent = state.signInAddress
        ? 'Signed in to the monitor account as ' + state.signInAddress + ' (EVM identity).'
        : 'Signed in to the monitor account.';
      return;
    }
    if (!entries.length) {
      signAccountLine.textContent = state.entries.length
        ? 'No EVM-capable key in this vault. ed25519-only keys (Solana, Sui, TON) cannot sign in with an EVM identity.'
        : 'No EVM-capable key in this vault yet. Add or derive a secp256k1 key first.';
      return;
    }
    updateSignAccount(selected);
  }

  var signAccountSeq = 0;

  function updateSignAccount(entry) {
    if (!entry) return;
    var seq = (signAccountSeq += 1);
    var cached = state.evmAddresses[entry.id];
    if (cached) {
      signAccountLine.textContent = 'Account identity: ' + cached + ' (EVM address derived from this key).';
      return;
    }
    signAccountLine.textContent = 'Deriving the EVM address…';
    evmAddressForEntry(entry).then(function (address) {
      if (seq !== signAccountSeq || !state.unlocked || state.signInToken) return;
      signAccountLine.textContent = address
        ? 'Account identity: ' + address + ' (EVM address derived from this key).'
        : 'This key has no EVM derivation, so it cannot sign in to the monitor account.';
      signStart.disabled = !address || state.signInBusy;
    }, function (err) {
      if (seq !== signAccountSeq || !state.unlocked || state.signInToken) return;
      signAccountLine.textContent = 'Cannot derive the EVM address: ' + errorText(err);
      signStart.disabled = true;
    });
  }

  async function startSignIn() {
    if (!state.unlocked || state.signInBusy || state.signInToken) return;
    var entry = selectedSignEntry();
    setError('wallet-signin-error', '');
    if (!entry) {
      setError('wallet-signin-error', 'There is no EVM-capable key to sign in with.');
      return;
    }
    var generation = state.generation;
    state.signInBusy = true;
    if (signStatus) signStatus.textContent = 'Requesting a sign-in challenge…';
    renderSignIn();
    try {
      var address = await evmAddressForEntry(entry);
      if (!address) {
        throw new Error('This key has no EVM derivation, so it cannot sign in to the monitor account.');
      }
      if (generation !== state.generation || !state.unlocked) return;
      if (signStatus) signStatus.textContent = 'Waiting for the local signature…';
      var login = await signApi.signIn({
        request: monitorRequest,
        address: address,
        sign: function (message) { return signSessionMessage(entry, message); }
      });
      if (generation !== state.generation || !state.unlocked) return;
      /* Store the token; never render it. */
      state.signInToken = login.token;
      state.signInAddress = login.user && login.user.address ? String(login.user.address) : address;
      writeStored(MONITOR_TOKEN_KEY, state.signInToken);
      writeStored(MONITOR_ADDRESS_KEY, state.signInAddress);
      if (signStatus) signStatus.textContent = 'Signed in.';
    } catch (err) {
      if (generation !== state.generation || !state.unlocked) return;
      setError('wallet-signin-error', 'Cannot sign in: ' + errorText(err));
      if (signStatus) signStatus.textContent = 'Not signed in.';
    } finally {
      state.signInBusy = false;
      renderSignIn();
    }
  }

  async function signOutNow() {
    if (state.signInBusy) return;
    var token = state.signInToken;
    state.signInBusy = true;
    setError('wallet-signin-error', '');
    if (signStatus) signStatus.textContent = 'Signing out…';
    renderSignIn();
    try {
      if (token) await monitorRequest('/logout', { method: 'POST', token: token });
    } catch (err) {
      /* Signing out locally must work even when the coordinator is unreachable. */
    } finally {
      clearSession();
      state.signInBusy = false;
      renderSignIn();
      if (signStatus) signStatus.textContent = 'Signed out.';
    }
  }

  /* Offer the explicit action after a key lands in the vault; trigger it
   * automatically only when the user opted in. */
  function offerSignInForEntry(entry) {
    setError('wallet-signin-error', '');
    var spec = chainSpec(entry.chain);
    if (!spec || spec.curve !== 0) {
      if (signStatus) {
        signStatus.textContent = 'Key added. It has no EVM derivation, so it cannot sign in to the monitor account.';
      }
      renderSignIn();
      return;
    }
    state.signInEntryId = entry.id;
    renderSignIn();
    if (state.signInToken) return;
    if (signAuto && signAuto.checked) startSignIn();
    else if (signStatus) {
      signStatus.textContent = 'Key added. Use “Sign in with this wallet” to sign in to the monitor account.';
    }
  }

  function restoreSession() {
    state.signInToken = readStored(MONITOR_TOKEN_KEY);
    state.signInAddress = readStored(MONITOR_ADDRESS_KEY);
    var token = state.signInToken;
    if (!token || !monitorRequest) return;
    var generation = state.generation;
    /* Validate the stored token once on unlock. A rejected token (expired TTL
     * or a logout on /cabinet) drops the local session silently; a network
     * failure keeps the optimistic state so an offline unlock is not a logout. */
    signApi.validateSession({ request: monitorRequest, token: token }).then(function (valid) {
      if (generation !== state.generation || !state.unlocked) return;
      if (state.signInToken !== token) return;
      if (valid) return;
      clearSession();
      renderSignIn();
    }, function () {
      /* Unknown state: no banner, no local sign-out. */
    });
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
    state.balances = {};
    state.summaryRefreshing = false;
    state.lastBalanceRefreshAt = 0;
    state.prices = null;
    state.priceMeta = null;
    state.priceStatus = 'idle';
    state.pricePromise = null;
    state.assets = {};
    state.assetsRefreshing = false;
    state.generation += 1;
    resetHistory();
    /* The vault lock drops the in-memory session and the sign-in UI. The
     * stored token is the monitor page's own session (same localStorage key),
     * so it is restored on unlock and removed only by Sign out. */
    state.evmAddresses = {};
    state.signInEntryId = null;
    state.signInToken = '';
    state.signInAddress = '';
    state.signInBusy = false;
    signAccountSeq += 1;
    if (signCard) signCard.hidden = true;
    if (signAuto) signAuto.checked = false;
    if (signStatus) signStatus.textContent = '';
    setError('wallet-signin-error', '');
    if (entriesEl) entriesEl.textContent = '';
    if (summaryBlock) summaryBlock.hidden = true;
    if (securityCard) securityCard.hidden = true;
    if (securityList) securityList.textContent = '';
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
    state.swapArmed = false;
    if (swapArmedCheckbox) swapArmedCheckbox.checked = false;
    if (setupCard) setupCard.hidden = true;
    if (unlockCard) unlockCard.hidden = true;
    if (panel) panel.hidden = false;
    renderSend();
    renderAssets();
    if (state.onboardChoice) applyOnboardChoice(state.onboardChoice);
    restoreSession();
    renderSignIn();
    refreshSecurity();
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

  /* ------------------------------------------------------------- onboarding */
  /* Two first-class entries: a seed phrase and a single private key / WIF.
   * Both point at an existing form in the unlocked panel; the choice only
   * decides where the user lands. Key parsing stays in parseSecret. */
  function reducedMotion() {
    return typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function applyOnboardChoice(choice) {
    if (onboardSeed) onboardSeed.setAttribute('aria-pressed', choice === 'seed' ? 'true' : 'false');
    if (onboardKey) onboardKey.setAttribute('aria-pressed', choice === 'key' ? 'true' : 'false');
    if (!onboardHint) return;
    var what = choice === 'seed' ? 'a seed phrase' : 'a private key / WIF';
    if (!state.unlocked) {
      onboardHint.textContent = 'Create or unlock the vault to continue with ' + what + '.';
      return;
    }
    var target = choice === 'seed' ? seedPhrase : importSecret;
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    onboardHint.textContent = choice === 'seed'
      ? 'The seed phrase form is open below. The phrase stays in this tab and is never stored, sent or logged.'
      : 'The private key / WIF form is open below. The key is encrypted in this browser vault and never sent to the server, logged or put in the URL.';
  }

  function chooseOnboard(choice) {
    state.onboardChoice = choice;
    applyOnboardChoice(choice);
  }

  if (onboardSeed) onboardSeed.addEventListener('click', function () { chooseOnboard('seed'); });
  if (onboardKey) onboardKey.addEventListener('click', function () { chooseOnboard('key'); });

  if (signStart) signStart.addEventListener('click', function () { startSignIn(); });
  if (signOut) signOut.addEventListener('click', function () { signOutNow(); });
  if (signEntrySelect) {
    signEntrySelect.addEventListener('change', function () {
      state.signInEntryId = signEntrySelect.value;
      setError('wallet-signin-error', '');
      renderSignIn();
    });
  }

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
    if (derived.evmAddress) state.evmAddresses[entry.id] = derived.evmAddress;
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
    var addedEntry;
    try {
      addedEntry = await addParsedEntry(parsed, derived, label);
    } catch (err) {
      setError('wallet-add-error', err.duplicate ? err.message : 'Cannot save the vault: ' + errorText(err));
      return;
    }
    importSecret.value = '';
    importLabel.value = '';
    importChain.value = '';
    renderEntries();
    offerSignInForEntry(addedEntry);
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

  /* Seed info popover (§3.14): an absolutely positioned card anchored to the
   * info icon-button, so the long estimate is one click away, not inline. */
  var seedInfoPopover = byId('wallet-seed-info-popover');
  function closeSeedInfo(returnFocus) {
    if (!seedInfoPopover || seedInfoPopover.hidden) return;
    seedInfoPopover.hidden = true;
    seedInfo.setAttribute('aria-expanded', 'false');
    if (returnFocus) seedInfo.focus();
  }
  if (seedInfo && seedInfoPopover) {
    seedInfo.addEventListener('click', function (event) {
      event.stopPropagation();
      if (seedInfoPopover.hidden) {
        if (window.RotorTooltip) window.RotorTooltip.hide();
        seedInfoPopover.hidden = false;
        seedInfo.setAttribute('aria-expanded', 'true');
        seedInfoPopover.focus({ preventScroll: true });
      } else {
        closeSeedInfo(true);
      }
    });
    document.addEventListener('click', function (event) {
      if (seedInfoPopover.hidden) return;
      if (seedInfoPopover.contains(event.target) || seedInfo.contains(event.target)) return;
      closeSeedInfo(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !seedInfoPopover.hidden) {
        event.preventDefault();
        closeSeedInfo(true);
      }
    });
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
    delete state.balances[entry.id];
    delete state.evmAddresses[entry.id];
    if (state.signInEntryId === entry.id) state.signInEntryId = null;
    try {
      await saveEntries(nextEntries, nextDerived);
      renderEntries();
      renderSignIn();
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
    row.setAttribute('data-chain', entry.chain);

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

    var historyButton = document.createElement('button');
    historyButton.type = 'button';
    historyButton.className = 'icon-button icon-button--quiet wallet-history-button';
    historyButton.setAttribute('aria-label', 'Transaction history for this ' + chainLabel(entry.chain) + ' address');
    historyButton.setAttribute('data-tooltip', 'Transaction history');
    historyButton.setAttribute('data-history-button', '');
    historyButton.disabled = !state.lookup;
    historyButton.appendChild(iconUse('ui-history'));
    historyButton.addEventListener('click', function () { openHistory(entry); });
    actions.appendChild(historyButton);
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

  function applyBalance(entry, badge) {
    var current = state.balances[entry.id];
    if (!current) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    badge.className = 'wallet-balance' +
      (current.state === 'ok' ? ' ok' : current.state === 'error' ? ' err' : '');
    if (current.state === 'loading') badge.textContent = 'checking…';
    else if (current.text) badge.textContent = current.text;
    else badge.hidden = true;
  }

  function renderEntries() {
    if (!entriesEl) return;
    resetHistory();
    entriesEl.textContent = '';
    state.rows = {};
    var generation = state.generation;
    if (!state.entries.length) {
      emptyEl.hidden = false;
      renderSummary();
      if (state.unlocked) {
        if (securityCatalog) renderSecurity();
        else refreshSecurity();
        renderSend();
        renderSignIn();
      }
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
        applyBalance(entry, row._refs.badge);
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
    renderSummary();
    if (state.unlocked) {
      if (securityCatalog) renderSecurity();
      else refreshSecurity();
      renderSend();
      renderSignIn();
    }
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
    if (state.unlocked && swapEntrySelect && swapEntrySelect.value === entry.id) {
      updateSwapFrom();
    }
    if (!securityRunning && securityCatalog && state.unlocked) renderSecurity();
  }

  /* ----------------------------------------------------------------- balances */

  function fetchWithTimeout(url, options) {
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    var settings = options || {};
    settings.signal = controller.signal;
    return fetch(url, settings).finally(function () { window.clearTimeout(timer); });
  }

  async function fetchBtcBalance(address, apiBase, symbol) {
    var base = apiBase || SSOT_PROVIDERS.find('bitcoin', 'mempool').url;
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
    return {
      amount: sats,
      decimals: 8,
      symbol: symbol || 'BTC',
      text: sats.toLocaleString('en-US') + ' sats · ' + txs + ' tx'
    };
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
        var units = BigInt(data.result);
        return {
          amount: units,
          decimals: spec.decimals,
          symbol: spec.symbol,
          text: AMOUNT.formatUnits(units, spec.decimals, { symbol: spec.symbol })
        };
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error('no endpoint answered' + (lastError ? ': ' + errorText(lastError) : ''));
  }

  async function fetchTronBalance(address) {
    var unit = SSOT_CHAINS.bySlug.tron;
    var response = await fetchWithTimeout(SSOT_PROVIDERS.find('tron', 'tronscan').url + '/account?address=' + encodeURIComponent(address));
    if (response.status === 404) {
      return {
        amount: 0n,
        decimals: unit.decimals,
        symbol: unit.symbol,
        text: '0 ' + unit.symbol + ' · account not activated'
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
    var match = /"balance"\s*:\s*"?(\d+)"?/.exec(raw);
    var sun = match ? BigInt(match[1]) : 0n;
    var text = AMOUNT.formatUnits(sun, unit.decimals, { symbol: unit.symbol });
    if (typeof data.totalTransactionCount === 'number') text += ' · ' + data.totalTransactionCount + ' tx';
    return { amount: sun, decimals: unit.decimals, symbol: unit.symbol, text: text };
  }

  async function fetchBalance(chain, address) {
    var spec = chainSpec(chain);
    if (chain === 'bitcoin') return fetchBtcBalance(address, null, spec.symbol);
    if (chain === 'bitcoin-testnet') return fetchBtcBalance(address, spec.btcApi, spec.symbol);
    if (chain === 'tron') return fetchTronBalance(address);
    if (spec && spec.rpc) return fetchEvmBalance(spec, address);
    throw new Error('no public balance provider in this phase');
  }

  /* One balance request per row. The badge and the portfolio summary read the
   * same result, so a failed or pending row can never become a zero total. */
  async function loadBalance(entry, badge, generation) {
    var derived = state.derived[entry.id];
    var spec = chainSpec(entry.chain) || {};
    var addressState = summaryHelper && typeof summaryHelper.loadState === 'function'
      ? summaryHelper.loadState(derived)
      : (!derived || derived.error || !derived.address ? 'error' : 'ready');
    if (addressState === 'error') {
      state.balances[entry.id] = { state: 'error', amount: null, text: 'address not derived yet' };
      if (badge) {
        badge.hidden = false;
        badge.className = 'wallet-balance err';
        badge.textContent = 'address not derived yet';
      }
      renderSummary();
      return;
    }
    state.balances[entry.id] = { state: 'loading', amount: null, symbol: spec.symbol };
    if (badge) {
      badge.hidden = false;
      badge.className = 'wallet-balance';
      badge.textContent = 'checking…';
    }
    renderSummary();
    try {
      var result = await fetchBalance(entry.chain, derived.address);
      if (generation !== state.generation || !state.unlocked) return;
      state.balances[entry.id] = {
        state: 'ok',
        amount: result.amount,
        decimals: result.decimals,
        symbol: result.symbol,
        text: result.text
      };
      state.lastBalanceRefreshAt = Date.now();
      if (badge) {
        badge.hidden = false;
        badge.className = 'wallet-balance ok';
        badge.textContent = result.text;
      }
    } catch (err) {
      if (generation !== state.generation || !state.unlocked) return;
      state.balances[entry.id] = { state: 'error', amount: null, text: 'lookup failed: ' + errorText(err) };
      if (badge) {
        badge.hidden = false;
        badge.className = 'wallet-balance err';
        badge.textContent = state.balances[entry.id].text;
      }
    }
    if (generation === state.generation) renderSummary();
  }

  async function checkBalance(entry, badge) {
    if (!state.lookup) return;
    await loadBalance(entry, badge, state.generation);
  }

  /* -------------------------------------------------------- prices + summary */

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

  /* The same Binance ticker and six-hour localStorage entry as /key. A failed
   * refresh keeps the previous entry and marks it stale; a stale cache still
   * never becomes a USD number, only a stated reason. */
  function ensurePrices(force) {
    var helper = window.RotorKeyTools;
    if (!helper || typeof helper.priceRequestUrl !== 'function') {
      state.priceStatus = 'unavailable';
      return Promise.resolve();
    }
    if (state.pricePromise) return state.pricePromise;
    var cached = readPriceCache();
    if (helper.priceCacheState(cached, Date.now(), PRICE_TTL_MS) === 'fresh') {
      state.prices = cached.prices;
      state.priceMeta = { fetchedAt: cached.fetchedAt, stale: false };
      state.priceStatus = 'fresh';
      renderSummary();
      return Promise.resolve();
    }
    if (!force && state.priceStatus !== 'idle') return Promise.resolve();
    state.priceStatus = 'loading';
    renderSummary();
    state.pricePromise = (async function () {
      try {
        var response = await fetchWithTimeout(
          helper.priceRequestUrl(),
          { headers: { Accept: 'application/json' } }
        );
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var data = await response.json();
        var prices = helper.parsePriceResponse(data);
        if (!Object.keys(prices).length) throw new Error('no ticker prices');
        var entry = { prices: prices, fetchedAt: Date.now(), source: 'binance' };
        writePriceCache(entry);
        state.prices = prices;
        state.priceMeta = { fetchedAt: entry.fetchedAt, stale: false };
        state.priceStatus = 'fresh';
      } catch (err) {
        if (cached && cached.prices && Object.keys(cached.prices).length) {
          state.prices = cached.prices;
          state.priceMeta = { fetchedAt: cached.fetchedAt, stale: true };
          state.priceStatus = 'stale';
        } else {
          state.prices = null;
          state.priceMeta = null;
          state.priceStatus = 'unavailable';
        }
      } finally {
        state.pricePromise = null;
        renderSummary();
      }
    })();
    return state.pricePromise;
  }

  function excludedNames(fiat) {
    return (fiat && fiat.excluded ? fiat.excluded : []).map(function (row) {
      return row.label || row.chain;
    });
  }

  function fiatTitle(fiat) {
    if (!fiat) return '';
    if (fiat.state === 'empty') return 'No balance has loaded yet; this is not a zero total.';
    if (fiat.state === 'loading') return 'Waiting for the balance refresh and the public ticker.';
    if (fiat.state === 'stale') {
      return 'The cached public ticker is stale, so no USD value is shown. Per-chain native totals remain.';
    }
    if (fiat.state === 'unavailable') {
      return 'No public ticker is reachable, so no USD value is shown. Per-chain native totals remain.';
    }
    if (fiat.state === 'unpriced') return 'No loaded chain has a public price.';
    if (fiat.cents === null) return 'No USD value.';
    var text = 'Exact total from ' + fiat.included + ' priced chain' + (fiat.included === 1 ? '' : 's');
    var when = summaryHelper.formatTime(state.priceMeta && state.priceMeta.fetchedAt);
    if (when) text += '; prices fetched ' + when;
    if (state.priceMeta && state.priceMeta.stale) text += '; stale cache';
    if (fiat.excluded.length) text += '; excluded: ' + excludedNames(fiat).join(', ');
    return text + '.';
  }

  function summaryStatusText(totals, fiat) {
    var parts = [];
    if (state.summaryRefreshing) parts.push('Refreshing balances…');
    if (!state.lookup) parts.push('Enable “Allow public balance lookups” to refresh all balances.');
    var excluded = excludedNames(fiat);
    var excludedText = excluded.length ? ' Excluded from USD: ' + excluded.join(', ') + '.' : '';
    if (fiat.state === 'stale') {
      var when = summaryHelper.formatTime(state.priceMeta && state.priceMeta.fetchedAt);
      parts.push('Fiat value hidden: the cached public ticker is stale' +
        (when ? ' (fetched ' + when + ')' : '') +
        '. Per-chain native totals are still shown.' + excludedText);
    } else if (fiat.state === 'unavailable') {
      parts.push('Fiat value unavailable: no public ticker is reachable. Per-chain native totals are still shown.' + excludedText);
    } else if (fiat.state === 'unpriced') {
      var unpriced = excludedNames(fiat);
      parts.push('Fiat value unavailable: no loaded chain has a price' +
        (unpriced.length ? ' (excluded: ' + unpriced.join(', ') + ')' : '') +
        '. Per-chain native totals are still shown.');
    } else if (fiat.state === 'loading') {
      if (totals.loaded > 0) parts.push('Waiting for the public ticker.');
    } else if (excluded.length) {
      parts.push('Excluded from USD (no price): ' + excluded.join(', ') + '.');
    }
    return parts.join(' ');
  }

  function renderSummaryChains(totals) {
    if (!summaryChains) return;
    summaryChains.textContent = '';
    totals.perChain.forEach(function (row) {
      var item = document.createElement('li');
      item.className = 'wallet-summary-chain';
      item.setAttribute('data-chain', row.chain);
      var name = document.createElement('span');
      name.className = 'wallet-summary-chain-name';
      name.textContent = row.label;
      var value = document.createElement('strong');
      value.className = 'wallet-summary-chain-value';
      value.textContent = summaryHelper.formatNative(row.amount, row.decimals, row.symbol);
      item.appendChild(name);
      item.appendChild(value);
      summaryChains.appendChild(item);
    });
    summaryChains.hidden = totals.perChain.length === 0;
  }

  function currentPriceState() {
    if (state.priceStatus === 'fresh') return 'fresh';
    if (state.priceStatus === 'stale') return 'stale';
    if (state.priceStatus === 'loading' || state.priceStatus === 'idle') return 'loading';
    return 'unavailable';
  }

  function renderSummary() {
    renderAssets();
    if (!summaryBlock) return;
    var visible = state.unlocked && state.entries.length > 0 && !!summaryHelper;
    summaryBlock.hidden = !visible;
    if (!visible) return;
    var rows = state.entries.map(function (entry) {
      var spec = chainSpec(entry.chain) || {};
      var current = state.balances[entry.id];
      var rowState = current ? current.state : 'missing';
      if (rowState === 'ok') {
        return {
          chain: entry.chain,
          label: chainLabel(entry.chain),
          symbol: current.symbol || spec.symbol,
          decimals: Number.isInteger(current.decimals) ? current.decimals : spec.decimals,
          amount: current.amount,
          state: 'ok'
        };
      }
      return {
        chain: entry.chain,
        label: chainLabel(entry.chain),
        symbol: spec.symbol,
        decimals: spec.decimals,
        amount: null,
        state: rowState
      };
    });
    var totals = summaryHelper.aggregate(rows);
    if (totals.loaded > 0 && state.priceStatus === 'idle') ensurePrices(false);
    var fiat = summaryHelper.fiat(totals, state.prices, currentPriceState());

    if (summaryTotal) {
      summaryTotal.textContent = summaryHelper.totalText(fiat);
      summaryTotal.classList.toggle('empty', fiat.cents === null);
      summaryTotal.title = fiatTitle(fiat);
    }
    if (summaryLoaded) summaryLoaded.textContent = summaryHelper.loadedLine(totals);
    if (summaryEntries) summaryEntries.textContent = String(totals.total);
    if (summaryEmpty) {
      summaryEmpty.hidden = totals.loaded > 0;
      summaryEmpty.textContent = totals.loading > 0
        ? 'Loading ' + totals.loading + ' balance' + (totals.loading === 1 ? '' : 's') + '…'
        : 'No balances loaded yet. Use Refresh to read the public addresses you allowed above.';
    }
    renderSummaryChains(totals);
    if (summaryStatus) summaryStatus.textContent = summaryStatusText(totals, fiat);
    if (summaryRefreshed) {
      summaryRefreshed.textContent = state.lastBalanceRefreshAt
        ? 'Balances last refreshed ' + (summaryHelper.formatTime(state.lastBalanceRefreshAt) || 'just now') + '.'
        : 'Balances have not been refreshed yet.';
    }
    if (summaryRefresh) {
      summaryRefresh.disabled = state.summaryRefreshing;
      summaryRefresh.setAttribute('aria-busy', state.summaryRefreshing ? 'true' : 'false');
    }
    summaryBlock.setAttribute(
      'aria-busy',
      state.summaryRefreshing || fiat.state === 'loading' ? 'true' : 'false'
    );
  }

  async function refreshPortfolio() {
    if (!state.unlocked) return;
    if (!state.lookup) {
      if (summaryStatus) {
        summaryStatus.textContent = 'Enable “Allow public balance lookups” to refresh all balances.';
      }
      return;
    }
    if (state.summaryRefreshing) return;
    state.summaryRefreshing = true;
    renderSummary();
    var generation = state.generation;
    var jobs = [];
    state.entries.forEach(function (entry) {
      var row = state.rows[entry.id];
      jobs.push(loadBalance(entry, row && row._refs ? row._refs.badge : null, generation));
    });
    jobs.push(refreshAssets());
    if (jobs.length) jobs.push(ensurePrices(true));
    try {
      await Promise.all(jobs);
    } finally {
      if (generation === state.generation) {
        state.summaryRefreshing = false;
        renderSummary();
      }
    }
  }

  lookupToggle.addEventListener('change', function () {
    state.lookup = lookupToggle.checked;
    Array.prototype.forEach.call(entriesEl.querySelectorAll('.wallet-balance-button'), function (button) {
      button.disabled = !state.lookup;
    });
    Array.prototype.forEach.call(entriesEl.querySelectorAll('.wallet-history-button'), function (button) {
      button.disabled = !state.lookup;
    });
    renderSummary();
    renderAssets();
  });

  if (summaryRefresh) {
    summaryRefresh.addEventListener('click', function () { refreshPortfolio(); });
  }

  /* ------------------------------------------------------------ top assets */
  /* One row per asset network from data/assets.json. Native rows reuse the
   * shared RotorBalanceProviders path; a token row reads ERC-20 balanceOf
   * through the chain's public RPC or a TRC-20 balance through TronScan. A
   * row never becomes zero because a request failed or has not run. */

  function assetBigInt(value) {
    try {
      return BigInt(value);
    } catch (err) {
      return null;
    }
  }

  function evmAddresses() {
    var seen = {};
    var out = [];
    state.entries.forEach(function (entry) {
      var info = SSOT_CHAINS.bySlug[entry.chain];
      var derived = state.derived[entry.id];
      if (!info || info.family !== 'evm') return;
      if (!derived || derived.error || !derived.address) return;
      if (seen[derived.address]) return;
      seen[derived.address] = true;
      out.push(derived.address);
    });
    return out;
  }

  function addressesForAssetChain(chain) {
    var info = SSOT_CHAINS.bySlug[chain];
    if (info && info.family === 'evm') return evmAddresses();
    var seen = {};
    var out = [];
    state.entries.forEach(function (entry) {
      if (entry.chain !== chain) return;
      var derived = state.derived[entry.id];
      if (!derived || derived.error || !derived.address) return;
      if (seen[derived.address]) return;
      seen[derived.address] = true;
      out.push(derived.address);
    });
    return out;
  }

  async function fetchNativeAsset(chain, addresses) {
    var providerApi = window.RotorBalanceProviders;
    if (!providerApi || typeof providerApi.metaFor !== 'function') {
      throw new Error('balance providers are not loaded');
    }
    var meta = providerApi.metaFor(chain);
    if (!meta) throw new Error('no public balance provider for ' + chainLabel(chain));
    var result = await providerApi.fetchProvider(meta, addresses);
    var total = 0n;
    var loaded = 0;
    var firstError = '';
    addresses.forEach(function (address) {
      var value = result.values[address];
      var amount = value && value.balance !== undefined && value.balance !== null
        ? assetBigInt(value.balance)
        : null;
      if (amount !== null && amount >= 0n) {
        total += amount;
        loaded += 1;
        return;
      }
      if (!firstError) {
        firstError = result.errors[address] || 'Balance row missing from the provider.';
      }
    });
    if (!loaded) throw new Error(firstError || 'no balance returned');
    if (loaded < addresses.length) {
      throw new Error((addresses.length - loaded) + ' of ' + addresses.length +
        ' addresses failed: ' + firstError);
    }
    return total;
  }

  async function fetchEvmToken(chain, contract, addresses) {
    var provider = SSOT_PROVIDERS.first(chain);
    if (!provider) throw new Error('no public RPC for ' + chainLabel(chain));
    var total = 0n;
    for (var index = 0; index < addresses.length; index += 1) {
      var data = '0x70a08231' + addresses[index].slice(2).toLowerCase().padStart(64, '0');
      var response = await fetchWithTimeout(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: contract, data: data }, 'latest']
        })
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var body = await response.json();
      if (!body || body.error || typeof body.result !== 'string') {
        throw new Error(body && body.error && body.error.message
          ? body.error.message
          : 'unexpected eth_call response');
      }
      var amount = assetsHelper.parseEvmBalance(body.result);
      if (amount === null) throw new Error('balanceOf returned no amount');
      total += amount;
    }
    return total;
  }

  async function fetchTronToken(contract, addresses) {
    var provider = SSOT_PROVIDERS.find('tron', 'tronscan');
    if (!provider) throw new Error('no TronScan provider');
    var total = 0n;
    for (var index = 0; index < addresses.length; index += 1) {
      var response = await fetchWithTimeout(
        provider.url + '/account?address=' + encodeURIComponent(addresses[index])
      );
      if (response.status === 404) continue;
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var data = await response.json();
      var amount = assetsHelper.parseTronTokenBalance(data, contract);
      if (amount === null) throw new Error('unexpected TronScan account response');
      total += BigInt(amount);
    }
    return total;
  }

  async function fetchAssetBalance(asset, network, addresses) {
    if (asset.balance === 'unavailable') {
      var unavailable = new Error('no balance read path for this asset yet');
      unavailable.unavailable = true;
      throw unavailable;
    }
    if (!network.contract) return fetchNativeAsset(network.chain, addresses);
    var info = SSOT_CHAINS.bySlug[network.chain];
    if (info && info.family === 'evm') {
      return fetchEvmToken(network.chain, network.contract, addresses);
    }
    if (info && info.family === 'tron') {
      return fetchTronToken(network.contract, addresses);
    }
    throw new Error('no token balance read path for ' + chainLabel(network.chain));
  }

  async function loadAssetRow(asset, network, generation) {
    var key = assetsHelper.balanceKey(asset, network);
    if (asset.balance === 'unavailable') {
      state.assets[key] = {
        state: 'unavailable',
        detail: 'No balance read path is wired for this asset yet.'
      };
      return;
    }
    if (!state.lookup) {
      state.assets[key] = {
        state: 'missing',
        detail: 'Allow public balance lookups to load this balance.'
      };
      return;
    }
    var addresses = addressesForAssetChain(network.chain);
    if (!addresses.length) {
      state.assets[key] = {
        state: 'missing',
        detail: 'No ' + chainLabel(network.chain) + ' key in this vault.'
      };
      return;
    }
    state.assets[key] = { state: 'loading' };
    renderAssets();
    try {
      var amount = await fetchAssetBalance(asset, network, addresses);
      if (generation !== state.generation || !state.unlocked) return;
      state.assets[key] = { state: 'ok', amount: amount };
    } catch (err) {
      if (generation !== state.generation || !state.unlocked) return;
      state.assets[key] = {
        state: err && err.unavailable ? 'unavailable' : 'error',
        detail: errorText(err)
      };
    }
    if (generation === state.generation) renderAssets();
  }

  function refreshAssets() {
    if (!state.unlocked || !assetsData || !assetsHelper) return Promise.resolve();
    if (state.assetsRefreshing) return Promise.resolve();
    state.assetsRefreshing = true;
    state.assets = {};
    var generation = state.generation;
    var cache = window.RotorBalanceCache;
    var limit = cache && typeof cache.createLimiter === 'function'
      ? cache.createLimiter(5)
      : function (task) { return task(); };
    var jobs = [];
    assetsData.assets.forEach(function (asset) {
      assetsHelper.networksFor(asset).forEach(function (network) {
        jobs.push(limit(function () { return loadAssetRow(asset, network, generation); }));
      });
    });
    renderAssets();
    return Promise.all(jobs).then(function () {
      if (generation === state.generation) {
        state.assetsRefreshing = false;
        renderAssets();
      }
    }, function () {
      if (generation === state.generation) {
        state.assetsRefreshing = false;
        renderAssets();
      }
    });
  }

  /* --------------------------------------------------------------- security */

  function securitySelection() {
    if (!securityCatalog || !securityApi) return { applicable: [], uncheckable: [] };
    return securityApi.selectForEntries(securityCatalog, state.entries);
  }

  function securityFetchCatalog() {
    if (securityCatalog) return Promise.resolve(securityCatalog);
    if (securityPromise) return securityPromise;
    securityPromise = fetchWithTimeout(assetUrl('/security-advisories.json'), { cache: 'no-cache' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.advisories) || !Array.isArray(data.checkers)) {
          throw new Error('the advisory feed is malformed');
        }
        securityCatalog = data;
        return data;
      })
      .catch(function (err) {
        securityPromise = null;
        throw err;
      });
    return securityPromise;
  }

  function renderSecurityError(message) {
    if (!securityCard) return;
    securityCard.hidden = false;
    if (securityCount) securityCount.textContent = '—';
    if (securityChecks) securityChecks.textContent = '0';
    if (securityLast) securityLast.textContent = '—';
    if (securityList) securityList.textContent = '';
    if (securityEmpty) {
      securityEmpty.hidden = false;
      securityEmpty.textContent = 'The advisory feed is unavailable (' + message + '). The published list is on the security page.';
    }
    if (securityStatus) securityStatus.textContent = '';
  }

  function renderSecurity() {
    if (!securityCard) return;
    if (!state.unlocked) {
      securityCard.hidden = true;
      return;
    }
    securityCard.hidden = false;
    if (!securityApi) {
      renderSecurityError('the security helper did not load');
      return;
    }
    if (!securityCatalog) {
      if (securityEmpty) {
        securityEmpty.hidden = false;
        securityEmpty.textContent = 'Loading reviewed advisories…';
      }
      return;
    }
    var selection = securitySelection();
    var times = securityApi.readCheckTimes(window.localStorage);
    var all = selection.applicable.concat(selection.uncheckable);
    if (securityCount) securityCount.textContent = String(all.length);
    if (securityChecks) securityChecks.textContent = String(securityApi.countChecks(times, selection.applicable));
    if (securityLast) {
      securityLast.textContent = securityApi.formatTime(securityApi.latestCheck(times, selection.applicable));
    }
    if (securityEmpty) {
      securityEmpty.hidden = all.length > 0;
      securityEmpty.textContent = state.entries.length
        ? 'No reviewed advisory applies to the entries in this vault.'
        : 'No entries in this vault yet. Add a key to see whether a published advisory applies.';
    }
    if (!securityList) return;
    securityList.textContent = '';
    selection.applicable.forEach(function (item) {
      item.entries.forEach(function (entry) {
        securityList.appendChild(securityRow(item, entry, times));
      });
    });
    selection.uncheckable.forEach(function (item) {
      item.entries.forEach(function (entry) {
        securityList.appendChild(securityRow(item, entry, times));
      });
    });
    if (securityStatus) securityStatus.textContent = '';
  }

  async function securityDerive(entropy, profile) {
    await ensureSeedLibraries();
    if (!window.RotorSeed) throw new Error('The seed library did not load.');
    var mnemonic = window.RotorSeed.entropyToMnemonic(entropy);
    var keyHex = window.RotorSeed.derive(mnemonic, '', profile.path);
    var wasm = await loadWasm();
    var report = deriveReport(wasm, hexToBytes(keyHex), 0, 0);
    var rows = Array.isArray(report.addresses) ? report.addresses : [];
    var address = '';
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].id === profile.id) {
        address = rows[i].address || '';
        break;
      }
    }
    if (!address) throw new Error('The derivation core returned no ' + profile.id + ' address.');
    return { address: address, mnemonic: mnemonic, wif: report.wif_compressed || '' };
  }

  function severityTone(value) {
    var tone = String(value || '').toLowerCase();
    return ['critical', 'high', 'medium', 'low', 'info'].indexOf(tone) >= 0 ? tone : 'info';
  }

  function securityRow(item, entry, times) {
    var advisory = item.advisory;
    var maxSeeds = item.checker && item.checker.limits && Number.isInteger(item.checker.limits.max_seeds_per_run)
      ? item.checker.limits.max_seeds_per_run
      : 2000;
    var derived = state.derived[entry.id];
    var uncompressedWif = entry.secret_type === 'wif' && derived && derived.compressed === false;
    var row = document.createElement('div');
    row.className = 'wallet-row';
    row.setAttribute('data-security-advisory', advisory.id);
    row.setAttribute('data-security-entry', entry.id);

    var head = document.createElement('div');
    head.className = 'wallet-row-head';
    var title = document.createElement('strong');
    title.textContent = advisory.title;
    head.appendChild(title);
    var severity = document.createElement('span');
    severity.className = 'status status--' + severityTone(advisory.severity);
    severity.textContent = advisory.severity;
    head.appendChild(severity);
    var subject = document.createElement('span');
    subject.className = 'muted';
    subject.textContent = entry.label || chainLabel(entry.chain);
    head.appendChild(subject);
    row.appendChild(head);

    var summary = document.createElement('p');
    summary.className = 'muted';
    summary.textContent = advisory.summary;
    row.appendChild(summary);

    var actions = document.createElement('ol');
    actions.className = 'muted';
    (advisory.actions || []).forEach(function (action) {
      var line = document.createElement('li');
      line.textContent = action;
      actions.appendChild(line);
    });
    row.appendChild(actions);

    var last = document.createElement('p');
    last.className = 'muted';
    var checkedAt = times[securityApi.checkKey(advisory.id, entry.id)];
    last.textContent = checkedAt
      ? 'Last local check: ' + securityApi.formatTime(checkedAt) + '.'
      : 'Not checked locally yet.';
    row.appendChild(last);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'wallet-row-actions';

    var details = document.createElement('a');
    details.className = 'chip';
    details.href = '/security#' + encodeURIComponent(advisory.id);
    details.textContent = 'Details and sources';
    actionsRow.appendChild(details);

    if (item.checker) {
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'primary';
      toggle.textContent = uncompressedWif ? 'Compressed derivations only' : 'Check locally';
      toggle.disabled = Boolean(uncompressedWif);
      actionsRow.appendChild(toggle);
      row.appendChild(actionsRow);

      if (uncompressedWif) {
        var wifNote = document.createElement('p');
        wifNote.className = 'muted';
        wifNote.textContent = 'This entry is an uncompressed WIF. The Milk Sad scan reproduces compressed BIP44 wallets, so it cannot match this address. Check the seed that created the key or use the Milk Sad page; this panel will not claim a no-match for an uncompressed key.';
        row.appendChild(wifNote);
      }

      var form = document.createElement('form');
      form.className = 'wallet-row-actions';
      form.hidden = true;
      form.autocomplete = 'off';

      var startLabel = document.createElement('label');
      startLabel.textContent = 'Start seed';
      var startInput = document.createElement('input');
      startInput.type = 'number';
      startInput.min = '0';
      startInput.max = '4294967295';
      startInput.step = '1';
      startInput.value = '0';
      startInput.required = true;
      startLabel.appendChild(startInput);
      form.appendChild(startLabel);

      var countLabel = document.createElement('label');
      countLabel.textContent = 'Seeds (max ' + maxSeeds + ')';
      var countInput = document.createElement('input');
      countInput.type = 'number';
      countInput.min = '1';
      countInput.max = String(maxSeeds);
      countInput.step = '1';
      countInput.value = '200';
      countInput.required = true;
      countLabel.appendChild(countInput);
      form.appendChild(countLabel);

      var run = document.createElement('button');
      run.type = 'submit';
      run.className = 'primary';
      run.textContent = 'Run local scan';
      form.appendChild(run);
      row.appendChild(form);

      var status = document.createElement('p');
      status.className = 'muted stat__meta';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      row.appendChild(status);

      toggle.addEventListener('click', function () {
        form.hidden = !form.hidden;
        if (!form.hidden) startInput.focus();
      });

      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (securityRunning) return;
        if (uncompressedWif) {
          status.textContent = 'This entry is an uncompressed WIF; the local Milk Sad scan covers compressed BIP44 derivations only.';
          return;
        }
        var derived = state.derived[entry.id];
        if (entry.secret_type === 'wif' && derived && derived.compressed === false) {
          status.textContent = 'This entry is an uncompressed WIF; the local Milk Sad scan covers compressed BIP44 derivations only.';
          return;
        }
        if (!derived || !derived.address) {
          status.textContent = 'The address is not derived yet. Unlock the vault and wait for the address list to finish.';
          return;
        }
        var start = Number(startInput.value);
        var count = Number(countInput.value);
        if (!Number.isInteger(start) || start < 0 || start > 0xffffffff ||
            !Number.isInteger(count) || count < 1 || count > maxSeeds) {
          status.textContent = 'Use a seed in 0…4294967295 and a count of 1…' + maxSeeds + '.';
          return;
        }
        securityRunning = true;
        run.disabled = true;
        var generation = state.generation;
        try {
          var result = await securityApi.runCheck(item, entry, derived.address, {
            start: start,
            count: count,
            scanRange: window.RotorMilkSad && window.RotorMilkSad.scanRange,
            derive: securityDerive,
            onProgress: function (checked, total) {
              status.textContent = 'Checked ' + checked + ' of ' + total + ' seeds…';
            },
            yieldTo: function () {
              return new Promise(function (resolve) { window.setTimeout(resolve, 0); });
            }
          });
          if (generation !== state.generation || !state.unlocked) return;
          var iso = new Date().toISOString();
          var nextTimes = securityApi.writeCheckTime(window.localStorage, advisory.id, entry.id, iso);
          last.textContent = 'Last local check: ' + securityApi.formatTime(iso) + '.';
          if (result.matched) {
            status.textContent = 'Match: this address is reproduced by seed ' + result.seed +
              '. Treat the key as compromised and move the funds to a new wallet. Open the Milk Sad page for recovery details.';
          } else {
            status.textContent = 'No match in seeds ' + start + '…' + (start + result.checked - 1) +
              '. This covers only that range and compressed BIP44 derivations; the weak set spans 2^32 seeds, so this is not a safety guarantee.';
          }
          var selection = securitySelection();
          if (securityChecks) securityChecks.textContent = String(securityApi.countChecks(nextTimes, selection.applicable));
          if (securityLast) {
            securityLast.textContent = securityApi.formatTime(securityApi.latestCheck(nextTimes, selection.applicable));
          }
        } catch (err) {
          status.textContent = errorText(err);
        } finally {
          securityRunning = false;
          run.disabled = false;
        }
      });
    } else {
      row.appendChild(actionsRow);
      var noCheck = document.createElement('p');
      noCheck.className = 'muted';
      noCheck.textContent = 'No local check: an address alone cannot show which random-number generator or device produced its key.';
      row.appendChild(noCheck);
    }

    return row;
  }

  function refreshSecurity() {
    if (!state.unlocked) {
      renderSecurity();
      return Promise.resolve();
    }
    if (!securityApi) {
      renderSecurity();
      return Promise.resolve();
    }
    var generation = state.generation;
    return securityFetchCatalog().then(function () {
      if (generation === state.generation && state.unlocked) renderSecurity();
    }).catch(function (err) {
      if (generation === state.generation && state.unlocked) {
        renderSecurityError(errorText(err));
      }
    });
  }

  function assetCell(text, className) {
    var cell = document.createElement('td');
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  function renderAssets() {
    if (!assetsSection || !assetsHelper || !assetsData) return;
    var model = assetsHelper.buildRows(
      assetsData.assets,
      state.assets,
      state.prices,
      currentPriceState()
    );
    if (assetsRows) {
      assetsRows.textContent = '';
      model.rows.forEach(function (row) {
        var tr = document.createElement('tr');
        tr.setAttribute('data-rank', String(row.rank));
        tr.setAttribute('data-chain', row.chain);
        tr.setAttribute('data-asset', row.symbol);
        var asset = document.createElement('td');
        var symbol = document.createElement('strong');
        symbol.textContent = row.symbol;
        var name = document.createElement('span');
        name.className = 'muted';
        name.textContent = ' ' + row.name;
        asset.appendChild(symbol);
        asset.appendChild(name);
        tr.appendChild(asset);
        tr.appendChild(assetCell(row.chainLabel));
        var balance = assetCell(row.balanceText);
        if (row.balanceTitle) balance.title = row.balanceTitle;
        tr.appendChild(balance);
        var usd = assetCell(row.usdText);
        usd.className = 'wallet-asset-usd';
        if (row.usdTitle) usd.title = row.usdTitle;
        tr.appendChild(usd);
        assetsRows.appendChild(tr);
      });
    }
    if (assetsTotal) {
      assetsTotal.textContent = model.totalText;
      assetsTotal.title = model.totalCents === null
        ? 'No loaded row could be priced; this is not a $0.00 total.'
        : 'Exact total from ' + model.loaded + ' loaded row' +
          (model.loaded === 1 ? '' : 's') + '.';
    }
    if (assetsStatus) {
      if (!state.lookup) {
        assetsStatus.textContent = 'Allow public balance lookups, then press Refresh to load these rows.';
      } else if (state.assetsRefreshing || model.pending > 0) {
        assetsStatus.textContent = 'Loading top-asset balances from public providers…';
      } else if (model.loaded === 0 && model.failed === 0) {
        assetsStatus.textContent = 'No top-asset balance loaded yet. Press Refresh to read the public addresses you allowed above.';
      } else {
        assetsStatus.textContent = 'Loaded ' + model.loaded + ' of ' + model.rows.length +
          ' rows' + (model.failed ? '; ' + model.failed + ' failed' : '') + '.';
      }
    }
    if (assetsError) {
      if (model.failed > 0) {
        assetsError.hidden = false;
        assetsError.textContent = model.failed + ' of ' + model.rows.length +
          ' top-asset rows could not be loaded; they are not counted in the total.';
      } else {
        assetsError.hidden = true;
        assetsError.textContent = '';
      }
    }
    if (assetsEmpty) {
      var covered = 0;
      assetsData.assets.forEach(function (asset) {
        assetsHelper.networksFor(asset).forEach(function (network) {
          if (addressesForAssetChain(network.chain).length) covered += 1;
        });
      });
      assetsEmpty.hidden = covered > 0;
    }
    if (assetsTableWrap) {
      assetsTableWrap.setAttribute('aria-busy',
        state.assetsRefreshing || model.pending > 0 ? 'true' : 'false');
    }
  }

  /* --------------------------------------------------------------- history */

  function resetHistory() {
    state.historyEntryId = null;
    state.historySeq += 1;
    if (historyPanel) historyPanel.hidden = true;
    if (historyRows) historyRows.textContent = '';
    if (historySubject) historySubject.textContent = '';
    if (historyStatus) historyStatus.textContent = '';
    if (historyError) {
      historyError.textContent = '';
      historyError.hidden = true;
    }
    if (historyEmpty) historyEmpty.hidden = true;
    if (historyUnavailable) {
      historyUnavailable.textContent = '';
      historyUnavailable.hidden = true;
    }
    if (historyTableWrap) {
      historyTableWrap.hidden = true;
      historyTableWrap.removeAttribute('aria-busy');
    }
  }

  if (historyClose) {
    historyClose.addEventListener('click', resetHistory);
  }

  function historyCell(text) {
    var cell = document.createElement('td');
    cell.textContent = text;
    return cell;
  }

  function renderHistoryRows(slug, rows) {
    historyRows.textContent = '';
    historyStatus.textContent = '';
    if (!rows.length) {
      historyEmpty.hidden = false;
      historyTableWrap.hidden = true;
      return;
    }
    rows.forEach(function (tx) {
      var row = document.createElement('tr');
      row.appendChild(historyCell(historyApi.formatTime(tx.timestamp)));
      row.appendChild(historyCell(historyApi.directionLabel(tx.direction)));
      var amount = document.createElement('td');
      amount.textContent = historyApi.formatNative(tx.amountAtomic, slug);
      if (tx.feeAtomic) {
        var fee = document.createElement('span');
        fee.className = 'muted wallet-history-fee';
        fee.textContent = 'fee ' + historyApi.formatNative(tx.feeAtomic, slug);
        amount.appendChild(fee);
      }
      row.appendChild(amount);
      var counterparty = document.createElement('td');
      var code = document.createElement('code');
      code.className = 'mono';
      code.textContent = historyApi.truncateMiddle(tx.counterparty, 10, 8) || '—';
      if (tx.counterparty) code.title = tx.counterparty;
      counterparty.appendChild(code);
      row.appendChild(counterparty);
      var status = document.createElement('td');
      var pill = document.createElement('span');
      pill.className = 'status';
      pill.textContent = historyApi.statusLabel(tx.confirmed);
      status.appendChild(pill);
      row.appendChild(status);
      historyRows.appendChild(row);
    });
    historyEmpty.hidden = true;
    historyTableWrap.hidden = false;
  }

  function showHistoryUnavailable(info) {
    historyUnavailable.textContent = info.message + ' ';
    var link = document.createElement('a');
    link.href = info.docsHref;
    link.textContent = 'Read the wallet documentation';
    historyUnavailable.appendChild(link);
    historyUnavailable.hidden = false;
  }

  async function openHistory(entry) {
    if (!state.lookup) return;
    if (!state.unlocked || !historyPanel) return;
    var info = historyApi.support(entry.chain);
    state.historyEntryId = entry.id;
    state.historySeq += 1;
    var seq = state.historySeq;
    historyRows.textContent = '';
    historyError.hidden = true;
    historyError.textContent = '';
    historyEmpty.hidden = true;
    historyUnavailable.hidden = true;
    historyUnavailable.textContent = '';
    historyTableWrap.hidden = true;
    historyTableWrap.removeAttribute('aria-busy');
    historyStatus.textContent = '';
    historyPanel.hidden = false;
    historySubject.textContent = chainLabel(entry.chain) + ' · ' + (entry.label || 'no label');

    var derived = state.derived[entry.id];
    if (!derived || derived.error || !derived.address) {
      historyError.textContent = derived && derived.error
        ? 'The address is unavailable: ' + derived.error
        : 'The address is still deriving; try again in a moment.';
      historyError.hidden = false;
      return;
    }
    if (info.kind === 'evm' || info.kind === 'other') {
      showHistoryUnavailable(info);
      return;
    }

    var address = derived.address;
    historyStatus.textContent = 'Loading transactions…';
    historyPanel.setAttribute('aria-busy', 'true');
    try {
      var rows;
      if (info.kind === 'btc') {
        var response = await fetchWithTimeout(historyApi.btcTxsUrl(entry.chain, address));
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var data = await response.json();
        rows = historyApi.parseBtcTxs(address, data);
      } else {
        var tronResponse = await fetchWithTimeout(
          '/api/v1/chain/tron/transactions?address=' + encodeURIComponent(address)
        );
        if (!tronResponse.ok) {
          var body = null;
          try { body = await tronResponse.json(); } catch (err) { body = null; }
          var reason = body && body.error ? body.error : 'HTTP ' + tronResponse.status;
          if (reason === 'no_provider') reason = 'the coordinator has no TronScan provider configured';
          throw new Error(reason);
        }
        rows = historyApi.parseTronPayload(address, await tronResponse.json());
      }
      if (seq !== state.historySeq || state.historyEntryId !== entry.id || !state.unlocked) return;
      renderHistoryRows(entry.chain, rows);
    } catch (err) {
      if (seq !== state.historySeq || state.historyEntryId !== entry.id || !state.unlocked) return;
      historyStatus.textContent = '';
      historyTableWrap.hidden = true;
      historyError.textContent = 'Cannot load transactions: ' + errorText(err);
      historyError.hidden = false;
    } finally {
      if (seq === state.historySeq) historyPanel.removeAttribute('aria-busy');
    }
  }

  /* ------------------------------------------------------------- EVM send */

  /* Every function below treats the private key as something that exists only
   * inside signTxWithEntry's parsed entry. The review object carries public
   * transaction fields and the unsigned hex; it never carries a secret. */

  var SEND_ERROR_IDS = {
    to: 'wallet-send-to-error',
    token: 'wallet-send-token-error',
    value: 'wallet-send-value-error',
    data: 'wallet-send-data-error',
    gasLimit: 'wallet-send-gas-error',
    maxFee: 'wallet-send-max-fee-error',
    priorityFee: 'wallet-send-priority-error',
    feeLimit: 'wallet-send-fee-limit-error'
  };

  var SEND_INPUTS = {
    to: sendToInput,
    token: sendTokenInput,
    value: sendValueInput,
    data: sendDataInput,
    gasLimit: sendGasInput,
    maxFee: sendMaxFeeInput,
    priorityFee: sendPriorityInput,
    feeLimit: sendFeeLimitInput
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

  /* Every key the send form can use: the EVM keys plus TRON keys (mainnet and
   * Nile share the same address and the same key entry). */
  function allSendEntries() {
    return state.entries.filter(function (entry) {
      return entry.chain === 'tron' ||
        (evmSend && evmSend.EVM_CHAIN_SLUGS.indexOf(entry.chain) >= 0);
    });
  }

  function sendEntriesFor(network) {
    if (network && network.kind === 'tron') {
      return state.entries.filter(function (entry) { return entry.chain === 'tron'; });
    }
    return sendEntries();
  }

  function selectedSendEntry() {
    if (!sendEntrySelect) return null;
    return entryById(sendEntrySelect.value);
  }

  function showSendFieldErrors(errors) {
    Object.keys(SEND_ERROR_IDS).forEach(function (key) {
      setError(SEND_ERROR_IDS[key], errors[key] || '');
      var input = SEND_INPUTS[key];
      if (input) input.setAttribute('aria-invalid', errors[key] ? 'true' : 'false');
    });
  }

  function clearSendFieldErrors() {
    showSendFieldErrors({});
  }

  /* The picker value carries an explicit family discriminator instead of a
   * fake numeric id for a non-EVM chain: `evm:<chainId>` or `tron:<slug>`. */
  function selectedNetwork() {
    if (!sendNetworkSelect) {
      if (!evmSend) return null;
      return Object.assign({}, evmSend.SEPOLIA, { kind: 'evm' });
    }
    var value = sendNetworkSelect.value;
    if (tronWallet) {
      var tron = tronWallet.tronNetworkFromOption(value);
      if (tron) return Object.assign({}, tron, { kind: 'tron' });
    }
    if (!evmSend) return null;
    var evmValue = value.indexOf('evm:') === 0 ? value.slice(4) : value;
    var network = evmSend.networkById(Number(evmValue)) || evmSend.SEPOLIA;
    return Object.assign({}, network, { kind: 'evm' });
  }

  /* The approvals pipeline needs the numeric EVM chain id; the picker value
   * carries a family discriminator, so it must never be parsed directly. */
  function selectedEvmChainId() {
    var network = selectedNetwork();
    return network && network.kind === 'evm' ? Number(network.chainId) : NaN;
  }

  function isMainnetArmed() {
    return state.mainnetArmed === true && !!sendArmedCheckbox && sendArmedCheckbox.checked;
  }

  function updateSendArmedRow() {
    if (!sendArmedRow) return;
    var network = selectedNetwork();
    sendArmedRow.hidden = !network || network.testnet;
  }

  var TOKEN_DATA_ERROR = evmSend ? evmSend.TOKEN_DATA_ERROR : '';

  /* Swap the recipient/token captions and placeholders, and the field
   * visibility, with the same family switch that selects the fields: a TRON
   * recipient is a base58 T-address, not a 0x address; the free-form Data
   * field and the EVM gas/max-fee/priority-fee rows have no TRON meaning, and
   * the TRX fee limit takes their place. */
  function applySendFieldLabels(isTron) {
    if (!tronWallet) return;
    var labels = tronWallet.sendFieldLabels(isTron);
    if (sendToLabel) sendToLabel.textContent = labels.toLabel;
    if (sendToInput) sendToInput.placeholder = labels.toPlaceholder;
    if (sendTokenLabel) sendTokenLabel.textContent = labels.tokenLabel;
    if (sendTokenInput) sendTokenInput.placeholder = labels.tokenPlaceholder;
    if (sendDataRow) sendDataRow.hidden = labels.dataHidden;
    if (sendEvmFeeFields) sendEvmFeeFields.hidden = labels.evmFeeFieldsHidden;
    if (sendFeeLimitRow) sendFeeLimitRow.hidden = labels.feeLimitHidden;
    if (sendFeeLimitInput) sendFeeLimitInput.disabled = labels.feeLimitHidden;
    if (sendGasInput) sendGasInput.disabled = labels.evmFeeFieldsHidden;
    if (sendPriorityInput) sendPriorityInput.disabled = labels.evmFeeFieldsHidden;
    if (sendMaxFeeInput) sendMaxFeeInput.disabled = labels.evmFeeFieldsHidden;
  }

  /* A token send builds its own calldata, so the free-form data field is
   * disabled while a token contract is set. The typed data is kept: entering
   * a token does not destroy it, and the error says why it must be cleared
   * before review. TRON uses none of the EVM gas/fee/data fields; only the
   * TRX fee limit applies, and only to a TRC-20 transfer. */
  function updateSendTokenState() {
    var network = selectedNetwork();
    var isTron = !!(network && network.kind === 'tron');
    applySendFieldLabels(isTron);
    var hasToken = !!(sendTokenInput && sendTokenInput.value.trim() !== '');
    if (!sendTokenInput || !sendDataInput) return;
    sendDataInput.disabled = isTron || hasToken;
    var box = byId('wallet-send-data-error');
    var showingTokenDataError = !!(box && !box.hidden && box.textContent === TOKEN_DATA_ERROR);
    if (!isTron && hasToken && sendDataInput.value.trim() && TOKEN_DATA_ERROR) {
      setError('wallet-send-data-error', TOKEN_DATA_ERROR);
      sendDataInput.setAttribute('aria-invalid', 'true');
    } else if (!hasToken && showingTokenDataError) {
      setError('wallet-send-data-error', '');
      sendDataInput.setAttribute('aria-invalid', 'false');
    }
  }

  function renderSendNetworks() {
    if (!sendNetworkSelect || (!evmSend && !tronWallet)) return;
    var previous = sendNetworkSelect.value;
    sendNetworkSelect.textContent = '';
    if (evmSend) {
      evmSend.walletNetworks().forEach(function (network) {
        var option = document.createElement('option');
        option.value = 'evm:' + network.chainId;
        option.textContent = network.name + ' — ' +
          (network.testnet ? 'testnet' : 'mainnet') +
          ' (chain id ' + network.chainId + ')';
        sendNetworkSelect.appendChild(option);
      });
    }
    if (tronWallet) {
      tronWallet.tronNetworks().forEach(function (network) {
        var option = document.createElement('option');
        option.value = tronWallet.tronOptionValue(network.slug);
        option.textContent = network.name + ' — ' +
          (network.testnet ? 'testnet' : 'mainnet');
        sendNetworkSelect.appendChild(option);
      });
    }
    var known = false;
    for (var i = 0; i < sendNetworkSelect.options.length; i += 1) {
      if (sendNetworkSelect.options[i].value === previous) {
        known = true;
        break;
      }
    }
    var fallback = evmSend
      ? 'evm:' + evmSend.SEPOLIA.chainId
      : tronWallet.tronOptionValue('tron');
    sendNetworkSelect.value = known ? previous : fallback;
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
    var network = selectedNetwork();
    var isTron = !!(network && network.kind === 'tron');
    var entry = selectedSendEntry();
    if (!entry) {
      sendFromLine.textContent = isTron
        ? 'Import or select a TRON key to see its address.'
        : 'Select a key to see its EVM address.';
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
    renderApprovals();
    renderSwap();
    if (!sendCard || (!evmSend && !tronWallet)) return;
    var available = allSendEntries();
    if (state.review && !available.some(function (entry) {
      return entry.id === state.reviewEntryId;
    })) {
      invalidateSendReview();
    }
    if (!state.unlocked || !available.length) {
      sendCard.hidden = true;
      return;
    }
    sendCard.hidden = false;
    updateSendTokenState();
    renderSendNetworks();
    var entries = sendEntriesFor(selectedNetwork());
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
    if (!sendEntrySelect.value && entries.length) sendEntrySelect.value = entries[0].id;
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
      token: sendTokenInput.value,
      value: sendValueInput.value,
      data: sendDataInput.value,
      gasLimit: sendGasInput.value,
      maxFee: sendMaxFeeInput.value,
      priorityFee: sendPriorityInput.value,
      feeLimit: sendFeeLimitInput ? sendFeeLimitInput.value : ''
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
      sendValueInput.value = review.isToken
        ? AMOUNT.formatUnits(review.tokenAmountWei, review.tokenDecimals)
        : AMOUNT.formatUnits(review.valueWei, 18);
    }
    if (!sendGasInput.value.trim()) sendGasInput.value = review.gasLimit.toString();
    if (!sendPriorityInput.value.trim()) {
      sendPriorityInput.value = AMOUNT.formatUnits(review.priorityWei, 9);
    }
    if (!sendMaxFeeInput.value.trim()) {
      sendMaxFeeInput.value = AMOUNT.formatUnits(review.maxFeeWei, 9);
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
    var symbol = review.symbol || SSOT_CHAINS.bySlug.ethereum.symbol;
    var feeWei = review.gasLimit * review.maxFeeWei;
    sendReviewList.textContent = '';
    addReviewRow('Network', review.chainName + ' · chain id ' + review.chainId +
      (review.testnet ? ' · testnet' : ' · MAINNET'));
    addReviewRow('From', review.from, true);
    if (review.isToken) {
      addReviewRow('Token contract', review.tokenContract, true);
      addReviewRow('Token symbol', review.tokenSymbol);
      addReviewRow('Token decimals', String(review.tokenDecimals));
      addReviewRow('Token balance', AMOUNT.formatUnits(review.tokenBalanceWei, review.tokenDecimals) +
        ' ' + review.tokenSymbol);
      addReviewRow('To (recipient)', review.to, true);
      addReviewRow('Amount', AMOUNT.formatUnits(review.tokenAmountWei, review.tokenDecimals) + ' ' +
        review.tokenSymbol + ' (' + review.tokenAmountWei + ' raw units)');
      addReviewRow('Native value', AMOUNT.formatUnits(review.valueWei, 18) + ' ' + symbol);
      addReviewRow('Data (built locally)', review.dataHex, true);
    } else {
      addReviewRow('To', review.to, true);
      addReviewRow('Amount', AMOUNT.formatUnits(review.valueWei, 18) + ' ' + symbol +
        ' (' + review.valueWei + ' wei)');
      addReviewRow('Data', review.dataHex, true);
    }
    addReviewRow('Gas limit', review.gasLimit.toString() + (review.gasLimitIsManual
      ? (review.gasEstimate === null || review.gasEstimate === undefined
        ? ' (manual; node estimate unavailable)'
        : ' (manual; node estimate ' + review.gasEstimate + ')')
      : (review.testnet
        ? ' (eth_estimateGas)'
        : ' (eth_estimateGas + 20% buffer)')));
    addReviewRow('Nonce', review.nonce.toString());
    addReviewRow('Max fee (per gas)', AMOUNT.formatUnits(review.maxFeeWei, 9) + ' gwei (' +
      review.maxFeeWei + ' wei)');
    addReviewRow('Priority fee', AMOUNT.formatUnits(review.priorityWei, 9) + ' gwei');
    addReviewRow('Base fee', AMOUNT.formatUnits(review.baseFeeWei, 9) + ' gwei');
    addReviewRow('Maximum network fee', AMOUNT.formatUnits(feeWei, 18) + ' ' + symbol);
    addReviewRow('Total max cost', AMOUNT.formatUnits(review.totalMaxCostWei, 18) + ' ' +
      symbol + ' (' + review.totalMaxCostWei + ' wei)');
    addReviewRow('Balance', AMOUNT.formatUnits(review.balanceWei, 18) + ' ' + symbol);
    if (review.feeCapWei !== null && review.feeCapWei !== undefined) {
      addReviewRow('Fee cap', AMOUNT.formatUnits(review.feeCapWei, 18) + ' ' + symbol +
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
    if (result.explorerUrl) {
      sendExplorerLink.hidden = false;
      sendExplorerLink.href = result.explorerUrl;
      sendExplorerLink.textContent = 'Open on the ' + (result.chainName || 'chain') + ' explorer';
    } else {
      sendExplorerLink.hidden = true;
      sendExplorerLink.removeAttribute('href');
      sendExplorerLink.textContent = '';
    }
    sendSignedEl.textContent = result.signedHex;
    sendResultBox.hidden = false;
    if (sendStatus) sendStatus.textContent = 'The RPC accepted the signed transaction.';
    if (result.explorerUrl) sendExplorerLink.focus();
  }

  /* ------------------------------------------------------------- TRON send */

  /* The unsigned and signed TRON calls use the same WASM string entry points
   * as the EVM/Bitcoin flows. The key exists only inside signTronWithEntry. */
  function unsignedTronTx(request) {
    return loadWasm().then(function (wasm) {
      return evmSend.callWasmString(wasm, 'tron_unsigned_tx', JSON.stringify(request));
    });
  }

  async function signTronWithEntry(entry, request) {
    var parsed = await parseEntry(entry);
    var keyHex = bytesToHex(parsed.key);
    var full = {};
    Object.keys(request).forEach(function (key) { full[key] = request[key]; });
    full.private_key = '0x' + keyHex;
    var text = JSON.stringify(full);
    try {
      var wasm = await loadWasm();
      return evmSend.callWasmString(wasm, 'tron_sign_tx', text);
    } finally {
      parsed.key.fill(0);
      keyHex = null;
      full = null;
      text = null;
    }
  }

  function renderTronReview(review) {
    var isToken = review.kind === 'trc20';
    sendReviewList.textContent = '';
    addReviewRow('Network', review.networkName + (review.testnet ? ' · testnet' : ' · MAINNET'));
    addReviewRow('From', review.from, true);
    addReviewRow('To (recipient)', review.to, true);
    addReviewRow('Kind', isToken ? 'TRC-20 token transfer' : 'TRX transfer');
    if (isToken) {
      addReviewRow('Token contract', review.tokenContract, true);
      addReviewRow('Token symbol', review.tokenSymbol || 'unknown (the token did not return a symbol)');
      addReviewRow('Token decimals', String(review.tokenDecimals));
      addReviewRow('Amount', review.amountDisplay + ' ' + (review.tokenSymbol || 'token units') +
        ' (' + review.amountBase + ' base units)');
    } else {
      addReviewRow('Amount', review.amountDisplay + ' TRX (' + review.amountBase + ' sun)');
    }
    addReviewRow('Fee limit', AMOUNT.formatUnits(review.feeLimitSun, 6) + ' TRX' +
      (isToken ? '' : ' (a plain TRX transfer pays bandwidth)'));
    addReviewRow('Reference block', review.block.blockID +
      (review.block.blockNumber ? ' (#' + review.block.blockNumber + ')' : ''));
    addReviewRow('Expiration', review.block.expiration + ' ms since the Unix epoch');
    addReviewRow('Provider', review.providerLabel + ' · ' + review.providerUrl);
    addReviewRow('Transaction ID', review.tx.txID, true);

    var warnings = review.warnings.slice();
    if (isToken) {
      warnings.push('A TRC-20 transfer moves token units, not TRX; the fee limit caps the ' +
        'energy fee in TRX.');
    }
    sendReviewWarnings.textContent = '';
    warnings.forEach(function (warning) {
      var item = document.createElement('li');
      item.textContent = warning;
      sendReviewWarnings.appendChild(item);
    });
    sendReviewWarnings.hidden = warnings.length === 0;

    sendReviewUnsigned.textContent = review.tx.raw_data_hex;
    sendReviewBox.hidden = false;
    if (sendStatus) sendStatus.textContent = 'Review ready. Check every field, then sign.';
    if (sendConfirmButton) sendConfirmButton.focus();
  }

  async function prepareTronSend(entry, network) {
    if (entry.chain !== 'tron') {
      setError('wallet-send-error', 'Select a TRON key for a TRON send.');
      return;
    }
    state.preparing = true;
    var generation = state.generation;
    setSendBusy(true, 'Reading the latest block and token info, then building the transaction…');
    try {
      var from = await ensureDerivedAddress(entry);
      var review = await tronWallet.prepareTronTransfer({
        network: network,
        form: {
          to: sendToInput.value,
          token: sendTokenInput.value,
          amount: sendValueInput.value,
          feeLimit: sendFeeLimitInput ? sendFeeLimitInput.value : ''
        },
        from: from,
        fetchJson: rpcFetchJson,
        providerUrl: sendProviderSelect.value || null,
        mainnetArmed: isMainnetArmed(),
        unsigned: unsignedTronTx
      });
      if (generation !== state.generation || !state.unlocked) return;
      state.review = review;
      state.reviewEntryId = entry.id;
      renderTronReview(review);
    } catch (err) {
      if (generation !== state.generation || !state.unlocked) return;
      if (err.fieldErrors) showSendFieldErrors(err.fieldErrors);
      setError('wallet-send-error', errorText(err));
      if (sendReviewBox) sendReviewBox.hidden = true;
      if (sendStatus) sendStatus.textContent = '';
    } finally {
      state.preparing = false;
      setSendBusy(false);
      if (state.review && state.review.family === 'tron' && sendConfirmButton &&
          !sendConfirmButton.disabled) {
        sendConfirmButton.focus();
      }
    }
  }

  async function confirmTronSend(review, entry) {
    state.sending = true;
    var generation = state.generation;
    setError('wallet-send-confirm-error', '');
    setSendBusy(true, 'Signing locally and broadcasting once…');
    try {
      var result = await tronWallet.confirmTronTransfer({
        review: review,
        fetchJson: rpcFetchJson,
        mainnetArmed: isMainnetArmed(),
        sign: function (request) { return signTronWithEntry(entry, request); }
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
  }

  /* ------------------------------------------------------------- TRON swap */

  /* The swap card quotes and swaps on TRON mainnet only: SunSwap V2 has no
   * Nile deployment, so the card disables itself on the testnet rather than
   * signing a call that would revert. The router and the curated token table
   * come from data/chains.json through chains.generated.js. */
  var SWAP_FEE_LIMIT_SUN = 30000000n;
  var SWAP_APPROVE_FEE_LIMIT_SUN = 10000000n;
  var SWAP_APPROVE_WAIT_MS = 90000;
  var SWAP_APPROVE_POLL_MS = 3000;
  var swapAgeTimer = null;

  function swapConfig() {
    var chain = SSOT_CHAINS && SSOT_CHAINS.bySlug ? SSOT_CHAINS.bySlug.tron : null;
    var config = chain && chain.swap;
    if (!config || typeof config.router !== 'string' || !config.router ||
        !Array.isArray(config.tokens) || config.tokens.length < 2) {
      return null;
    }
    return config;
  }

  function findSwapToken(config, address) {
    for (var i = 0; i < config.tokens.length; i += 1) {
      if (config.tokens[i].address === address) return config.tokens[i];
    }
    return null;
  }

  function tokenByIndex(config, index) {
    var token = config.tokens[Number(index)];
    if (!token) throw new Error('Select a swap token.');
    return token;
  }

  function tokenCaption(token) {
    if (!token.address) return token.symbol + ' · native';
    return token.symbol + ' · ' + token.address.slice(0, 4) + '…' + token.address.slice(-4);
  }

  function selectedSwapEntry() {
    if (!swapEntrySelect) return null;
    return entryById(swapEntrySelect.value);
  }

  function selectedSwapNetwork() {
    if (!tronWallet || !swapNetworkSelect) return null;
    return tronWallet.tronNetworkBySlug(swapNetworkSelect.value) ||
      tronWallet.tronNetworkBySlug('tron');
  }

  function swapIsTestnet() {
    var network = selectedSwapNetwork();
    return !network || network.testnet;
  }

  function swapArmed() {
    return state.swapArmed === true && !!swapArmedCheckbox && swapArmedCheckbox.checked;
  }

  function renderSwapTokens(config) {
    if (!swapFromTokenSelect || !swapToTokenSelect) return;
    var fromPrevious = swapFromTokenSelect.value;
    var toPrevious = swapToTokenSelect.value;
    [swapFromTokenSelect, swapToTokenSelect].forEach(function (select) {
      select.textContent = '';
      config.tokens.forEach(function (token, index) {
        var option = document.createElement('option');
        option.value = String(index);
        option.textContent = tokenCaption(token);
        select.appendChild(option);
      });
    });
    if (fromPrevious !== '' && config.tokens[Number(fromPrevious)]) {
      swapFromTokenSelect.value = fromPrevious;
    }
    if (toPrevious !== '' && config.tokens[Number(toPrevious)]) {
      swapToTokenSelect.value = toPrevious;
    }
    if (swapFromTokenSelect.value === swapToTokenSelect.value &&
        config.tokens.length > 1) {
      swapToTokenSelect.value = swapFromTokenSelect.value === '0' ? '1' : '0';
    }
  }

  function updateSwapFrom() {
    if (!swapFromLine) return;
    var entry = selectedSwapEntry();
    if (!entry) {
      swapFromLine.textContent = 'Select a TRON key to see its address.';
      return;
    }
    var derived = state.derived[entry.id];
    if (derived && derived.address) {
      swapFromLine.textContent = 'From: ' + derived.address;
      return;
    }
    if (derived && derived.error) {
      swapFromLine.textContent = 'Address unavailable: ' + derived.error;
      return;
    }
    swapFromLine.textContent = 'Deriving address…';
    deriveEntry(entry, state.generation);
  }

  function updateSwapNetworkState() {
    if (!swapNetworkSelect) return;
    var nile = swapIsTestnet();
    if (swapNileNote) swapNileNote.hidden = !nile;
    if (swapArmedRow) swapArmedRow.hidden = nile;
    [swapEntrySelect, swapAmountInput, swapSlippageInput, swapFromTokenSelect,
      swapToTokenSelect].forEach(function (control) {
      if (control) control.disabled = nile;
    });
    if (swapQuoteButton) swapQuoteButton.disabled = nile || state.swapPreparing || state.swapSending;
  }

  function renderSwap() {
    if (!swapCard) return;
    var config = swapConfig();
    var tronEntries = state.entries.filter(function (entry) {
      return entry.chain === 'tron';
    });
    if (!swap || !tronWallet || !config || !state.unlocked || !tronEntries.length) {
      swapCard.hidden = true;
      if (state.swapQuote || state.swapReview) invalidateSwapQuote('');
      return;
    }
    swapCard.hidden = false;
    renderSwapTokens(config);
    var previous = swapEntrySelect.value;
    swapEntrySelect.textContent = '';
    tronEntries.forEach(function (entry) {
      var option = document.createElement('option');
      option.value = entry.id;
      option.textContent = (entry.label || 'TRON key') + ' · TRON';
      swapEntrySelect.appendChild(option);
    });
    if (previous && tronEntries.some(function (entry) {
      return entry.id === previous;
    })) {
      swapEntrySelect.value = previous;
    }
    if (!swapEntrySelect.value && tronEntries.length) {
      swapEntrySelect.value = tronEntries[0].id;
    }
    updateSwapFrom();
    updateSwapNetworkState();
  }

  function showSwapFieldErrors(errors) {
    setError('wallet-swap-amount-error', errors.amount || '');
    setError('wallet-swap-slippage-error', errors.slippage || '');
    if (swapAmountInput) {
      swapAmountInput.setAttribute('aria-invalid', errors.amount ? 'true' : 'false');
    }
    if (swapSlippageInput) {
      swapSlippageInput.setAttribute('aria-invalid', errors.slippage ? 'true' : 'false');
    }
  }

  function setSwapBusy(busy, message) {
    var blocked = !!busy || state.swapSending;
    var nile = swapIsTestnet();
    if (swapQuoteButton) swapQuoteButton.disabled = blocked || nile;
    if (swapReviewButton) swapReviewButton.disabled = blocked;
    if (swapConfirmButton) swapConfirmButton.disabled = blocked;
    if (swapStatus && message !== undefined) swapStatus.textContent = message;
  }

  function stopSwapAge() {
    if (swapAgeTimer !== null) {
      clearInterval(swapAgeTimer);
      swapAgeTimer = null;
    }
  }

  function updateSwapQuoteAge() {
    if (!swapQuoteAge || !state.swapQuote) return;
    var age = Math.max(0, Math.floor((Date.now() - state.swapQuote.fetchedAt) / 1000));
    swapQuoteAge.textContent = 'Quote fetched ' + age + 's ago; a quote older than 60s is refused before signing.';
  }

  function startSwapAge() {
    stopSwapAge();
    updateSwapQuoteAge();
    swapAgeTimer = setInterval(updateSwapQuoteAge, 1000);
  }

  function clearSwapBoxes() {
    stopSwapAge();
    if (swapQuoteBox) swapQuoteBox.hidden = true;
    if (swapReviewBox) swapReviewBox.hidden = true;
    if (swapResultBox) swapResultBox.hidden = true;
    if (swapQuoteList) swapQuoteList.textContent = '';
    if (swapReviewList) swapReviewList.textContent = '';
    if (swapReviewWarnings) swapReviewWarnings.textContent = '';
    if (swapReviewUnsigned) swapReviewUnsigned.textContent = '';
    if (swapProviderNote) swapProviderNote.textContent = '';
    if (swapHashEl) swapHashEl.textContent = '';
    if (swapApproveResult) swapApproveResult.hidden = true;
    if (swapApproveHashEl) swapApproveHashEl.textContent = '';
    if (swapSignedEl) swapSignedEl.textContent = '';
    if (swapExplorerLink) swapExplorerLink.removeAttribute('href');
    setError('wallet-swap-confirm-error', '');
  }

  function invalidateSwapReview(message) {
    state.swapReview = null;
    state.swapReviewEntryId = null;
    if (swapReviewBox) swapReviewBox.hidden = true;
    if (swapReviewUnsigned) swapReviewUnsigned.textContent = '';
    setError('wallet-swap-confirm-error', '');
    if (message && swapStatus) swapStatus.textContent = message;
  }

  function invalidateSwapQuote(message) {
    var had = !!state.swapQuote || !!state.swapReview || (swapQuoteBox && !swapQuoteBox.hidden) ||
      (swapReviewBox && !swapReviewBox.hidden);
    state.swapQuote = null;
    state.swapReview = null;
    state.swapReviewEntryId = null;
    stopSwapAge();
    if (swapQuoteBox) swapQuoteBox.hidden = true;
    if (swapReviewBox) swapReviewBox.hidden = true;
    if (swapReviewUnsigned) swapReviewUnsigned.textContent = '';
    setError('wallet-swap-confirm-error', '');
    if (message && swapStatus && had) swapStatus.textContent = message;
  }

  function resetSwap() {
    state.swapArmed = false;
    state.swapPreparing = false;
    state.swapSending = false;
    state.swapQuote = null;
    state.swapReview = null;
    state.swapReviewEntryId = null;
    if (swapArmedCheckbox) swapArmedCheckbox.checked = false;
    if (swapArmedRow) swapArmedRow.hidden = true;
    if (swapForm) swapForm.reset();
    if (swapSlippageInput) swapSlippageInput.value = '0.5';
    showSwapFieldErrors({});
    setError('wallet-swap-error', '');
    clearSwapBoxes();
    if (swapStatus) swapStatus.textContent = '';
    if (swapEntrySelect) swapEntrySelect.textContent = '';
    if (swapCard) swapCard.hidden = true;
    setSwapBusy(false);
  }

  /* ABI words for the two constant calls the quote needs: the router's
   * getAmountsOut(uint256,address[]) and the token's allowance(address,address).
   * TRON ABI addresses are the 20-byte body, left-padded to 32 bytes; the 0x41
   * prefix and the base58 checksum stay out of the parameter. */
  function swapAbiWord(value) {
    return BigInt(value).toString(16).padStart(64, '0');
  }

  function swapAddressWord(address) {
    var raw = base58Decode(String(address));
    if (raw.length !== 25 || raw[0] !== 0x41) {
      throw new Error('Not a TRON base58 address: ' + address);
    }
    return '0'.repeat(24) + bytesToHex(raw.slice(1, 21));
  }

  /* The node's hex address form (`41` + 20-byte body) for a `visible: false`
   * request. A base58 address under `visible: false` is parsed as hex and
   * rejected, so the constant calls send hex explicitly. */
  function swapHexAddress(address) {
    return '41' + swapAddressWord(address).slice(24);
  }

  function encodeGetAmountsOut(amountIn, path) {
    var words = [swapAbiWord(amountIn), swapAbiWord(64), swapAbiWord(path.length)];
    path.forEach(function (address) {
      words.push(swapAddressWord(address));
    });
    return words.join('');
  }

  function encodeAllowance(owner, spender) {
    return swapAddressWord(owner) + swapAddressWord(spender);
  }

  function decodeUint256(hex) {
    var value = String(hex || '').replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}/.test(value)) {
      throw new Error('The call returned no uint256 value.');
    }
    return BigInt('0x' + value.slice(0, 64));
  }

  /* One allowlisted provider call. The provider is refused unless it is a
   * declared node for this network; an error is shown verbatim and never
   * retried. */
  function swapConstantCall(network, providerUrl, owner, contract, selector, parameter) {
    var provider = tronWallet.assertTronProvider(network, providerUrl);
    return Promise.resolve(rpcFetchJson(
      tronWallet.tronEndpoint(provider, '/wallet/triggerconstantcontract'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          owner_address: swapHexAddress(owner),
          contract_address: swapHexAddress(contract),
          function_selector: selector,
          parameter: parameter,
          visible: false
        })
      })).then(function (response) {
      if (response && typeof response.error === 'string' && response.error) {
        throw new Error('The ' + selector + ' call failed: ' + response.error);
      }
      var results = response && response.constant_result;
      if (!Array.isArray(results) || typeof results[0] !== 'string' || !results[0]) {
        var message = response && response.result && response.result.message
          ? ' (' + response.result.message + ')'
          : '';
        throw new Error('The ' + selector + ' call returned no data' + message + '.');
      }
      return results[0];
    });
  }

  async function getSwapQuote(entry) {
    if (state.swapPreparing || state.swapSending) return;
    if (entry.chain !== 'tron') {
      setError('wallet-swap-error', 'Select a TRON key for a TRON swap.');
      return;
    }
    var network = selectedSwapNetwork();
    var config = swapConfig();
    if (!network || !config) {
      setError('wallet-swap-error', 'The TRON swap module did not load. Reload the page.');
      return;
    }
    if (network.testnet) {
      setError('wallet-swap-error', 'SunSwap V2 has no deployment on the TRON Nile testnet. Select TRON mainnet.');
      return;
    }
    showSwapFieldErrors({});
    setError('wallet-swap-error', '');
    invalidateSwapReview('');
    state.swapPreparing = true;
    var generation = state.generation;
    setSwapBusy(true, 'Reading the latest block and quoting the router…');
    try {
      var fromToken = tokenByIndex(config, swapFromTokenSelect.value);
      var toToken = tokenByIndex(config, swapToTokenSelect.value);
      if (fromToken.address === toToken.address) {
        throw new Error('The from token and the to token must differ.');
      }
      var slippageBps;
      try {
        slippageBps = swap.parseSlippage(swapSlippageInput.value);
      } catch (err) {
        var slippageError = new Error('Fix the highlighted fields before quoting.');
        slippageError.fieldErrors = { slippage: errorText(err) };
        throw slippageError;
      }
      var amountIn;
      try {
        amountIn = tronWallet.parseTronAmount(swapAmountInput.value, fromToken.decimals);
      } catch (err) {
        var amountError = new Error('Fix the highlighted fields before quoting.');
        amountError.fieldErrors = {
          amount: 'Enter the amount as a plain decimal with at most ' +
            fromToken.decimals + ' decimal places.'
        };
        throw amountError;
      }
      if (amountIn <= 0n) {
        var zeroError = new Error('Fix the highlighted fields before quoting.');
        zeroError.fieldErrors = { amount: 'The amount must be greater than zero.' };
        throw zeroError;
      }
      var path = swap.buildPath({
        from: fromToken.address,
        to: toToken.address,
        wtrx: swap.WTRX
      });
      var fresh = await tronWallet.fetchNowBlock(network, rpcFetchJson);
      var from = await ensureDerivedAddress(entry);
      var parameter = encodeGetAmountsOut(amountIn, path);
      var resultHex = await swapConstantCall(network, fresh.providerUrl, from,
        config.router, 'getAmountsOut(uint256,address[])', parameter);
      var amounts = swap.parseAmountsOut(resultHex, path.length);
      if (amounts[0] !== amountIn) {
        throw new Error('The router quote does not start with the input amount; refusing a malformed route.');
      }
      var expectedOut = amounts[amounts.length - 1];
      if (expectedOut <= 0n) {
        throw new Error('The router returned no output for this route; there is no liquidity.');
      }
      var allowance = null;
      if (fromToken.address) {
        var allowanceHex = await swapConstantCall(network, fresh.providerUrl, from,
          fromToken.address, 'allowance(address,address)',
          encodeAllowance(from, config.router));
        allowance = decodeUint256(allowanceHex);
      }
      if (generation !== state.generation || !state.unlocked) return;
      var symbols = path.map(function (address, index) {
        if (address === swap.WTRX) {
          if ((index === 0 && !fromToken.address) ||
              (index === path.length - 1 && !toToken.address)) return 'TRX';
          return 'WTRX';
        }
        var token = findSwapToken(config, address);
        return token ? token.symbol : address;
      });
      state.swapQuote = {
        from: from,
        networkSlug: network.slug,
        networkName: network.name,
        testnet: network.testnet,
        providerUrl: fresh.providerUrl,
        providerLabel: fresh.providerLabel,
        block: fresh.block,
        router: config.router,
        fromToken: fromToken,
        toToken: toToken,
        amountIn: amountIn,
        expectedOut: expectedOut,
        path: path,
        routeText: swap.formatRoute(path, symbols),
        slippageBps: slippageBps,
        allowance: allowance,
        fetchedAt: Date.now()
      };
      renderSwapQuote(state.swapQuote);
    } catch (err) {
      if (generation !== state.generation || !state.unlocked) return;
      if (err.fieldErrors) showSwapFieldErrors(err.fieldErrors);
      setError('wallet-swap-error', errorText(err));
      if (swapQuoteBox) swapQuoteBox.hidden = true;
      if (swapStatus) swapStatus.textContent = '';
    } finally {
      state.swapPreparing = false;
      setSwapBusy(false);
      if (state.swapQuote && swapReviewButton && !swapReviewButton.disabled) {
        swapReviewButton.focus();
      }
    }
  }

  function appendSwapRow(list, label, value, asCode) {
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
    list.appendChild(term);
    list.appendChild(detail);
  }

  function swapReviewRow(label, value, asCode) {
    appendSwapRow(swapReviewList, label, value, asCode);
  }

  function swapAmountText(value, token) {
    return AMOUNT.formatUnits(value, token.decimals) + ' ' + token.symbol;
  }

  function renderSwapQuote(quote) {
    if (!swapQuoteList) return;
    if (swapReviewBox) swapReviewBox.hidden = true;
    swapQuoteList.textContent = '';
    var minimum = swap.minReceived(quote.expectedOut, quote.slippageBps);
    appendSwapRow(swapQuoteList, 'Network', quote.networkName + ' · MAINNET');
    appendSwapRow(swapQuoteList, 'Pay', swapAmountText(quote.amountIn, quote.fromToken));
    appendSwapRow(swapQuoteList, 'Route', quote.routeText);
    appendSwapRow(swapQuoteList, 'Expected receive', swapAmountText(quote.expectedOut, quote.toToken));
    appendSwapRow(swapQuoteList, 'Minimum received', swapAmountText(minimum, quote.toToken));
    appendSwapRow(swapQuoteList, 'Slippage', (quote.slippageBps / 100) + '% (' + quote.slippageBps + ' bps)');
    if (!quote.fromToken.address) {
      appendSwapRow(swapQuoteList, 'Approval', 'Not needed — TRX in');
    } else if (swap.approveNeeded(quote.allowance, quote.amountIn)) {
      appendSwapRow(swapQuoteList, 'Approval', 'Needed — the review adds one approve before the swap');
    } else {
      appendSwapRow(swapQuoteList, 'Approval', 'Allowance already covers the amount');
    }
    appendSwapRow(swapQuoteList, 'Provider', quote.providerLabel + ' · ' + quote.providerUrl);
    swapQuoteBox.hidden = false;
    if (swapStatus) swapStatus.textContent = 'Quote ready. Review it, then sign.';
    startSwapAge();
  }

  /* Build both signed steps from the quote: the approve only when the token
   * allowance is below the amount (TRX in never needs one). Nothing is signed
   * here; the review pins the exact unsigned bytes. */
  async function prepareSwapReview(entry) {
    if (state.swapPreparing || state.swapSending) return;
    var quote = state.swapQuote;
    if (!quote) {
      setError('wallet-swap-error', 'Get a fresh quote first.');
      return;
    }
    if (!entry || entry.chain !== 'tron') {
      setError('wallet-swap-error', 'Select a TRON key for a TRON swap.');
      return;
    }
    state.swapPreparing = true;
    var generation = state.generation;
    setError('wallet-swap-error', '');
    setSwapBusy(true, 'Building the swap transaction locally…');
    try {
      var from = await ensureDerivedAddress(entry);
      if (from !== quote.from) {
        throw new Error('The selected key changed; get a fresh quote.');
      }
      swap.assertQuoteFresh(quote);
      var minimum = swap.minReceived(quote.expectedOut, quote.slippageBps);
      if (minimum <= 0n) {
        throw new Error('The slippage leaves a zero minimum received; lower the slippage.');
      }
      var deadline = swap.deadlineFrom(Number(quote.block.timestamp));
      var common = {
        ref_block_bytes: quote.block.ref_block_bytes,
        ref_block_hash: quote.block.ref_block_hash,
        expiration: quote.block.expiration,
        timestamp: quote.block.timestamp
      };
      var approve = null;
      if (quote.fromToken.address &&
          swap.approveNeeded(quote.allowance, quote.amountIn)) {
        var approveRequest = {
          kind: 'approve',
          owner_address: from,
          token_contract_address: quote.fromToken.address,
          spender_address: quote.router,
          amount: quote.amountIn.toString(),
          ref_block_bytes: common.ref_block_bytes,
          ref_block_hash: common.ref_block_hash,
          expiration: common.expiration,
          timestamp: common.timestamp,
          fee_limit: SWAP_APPROVE_FEE_LIMIT_SUN.toString()
        };
        approve = {
          request: approveRequest,
          tx: tronWallet.parseTxResult(await unsignedTronTx(approveRequest)),
          feeLimitSun: SWAP_APPROVE_FEE_LIMIT_SUN
        };
      }
      var swapRequest = {
        kind: 'swap',
        owner_address: from,
        to_address: from,
        token_contract_address: quote.fromToken.address,
        router_address: quote.router,
        path: quote.path.join(','),
        amount_in: quote.amountIn.toString(),
        amount_out_min: minimum.toString(),
        deadline: deadline,
        ref_block_bytes: common.ref_block_bytes,
        ref_block_hash: common.ref_block_hash,
        expiration: common.expiration,
        timestamp: common.timestamp,
        fee_limit: SWAP_FEE_LIMIT_SUN.toString()
      };
      var swapStep = {
        request: swapRequest,
        tx: tronWallet.parseTxResult(await unsignedTronTx(swapRequest)),
        feeLimitSun: SWAP_FEE_LIMIT_SUN
      };
      if (generation !== state.generation || !state.unlocked) return;
      var review = {
        family: 'tron-swap',
        entryId: entry.id,
        networkSlug: quote.networkSlug,
        networkName: quote.networkName,
        testnet: quote.testnet,
        from: from,
        providerUrl: quote.providerUrl,
        providerLabel: quote.providerLabel,
        quote: quote,
        approve: approve,
        swap: swapStep,
        minimum: minimum,
        deadline: deadline,
        builtAt: Date.now()
      };
      state.swapReview = review;
      state.swapReviewEntryId = entry.id;
      renderSwapReview(review);
    } catch (err) {
      if (generation !== state.generation || !state.unlocked) return;
      setError('wallet-swap-error', errorText(err));
      if (swapReviewBox) swapReviewBox.hidden = true;
    } finally {
      state.swapPreparing = false;
      setSwapBusy(false);
      if (state.swapReview && swapConfirmButton && !swapConfirmButton.disabled) {
        swapConfirmButton.focus();
      }
    }
  }

  function renderSwapReview(review) {
    if (!swapReviewList) return;
    var quote = review.quote;
    swapReviewList.textContent = '';
    swapReviewRow('Network', review.networkName + ' · MAINNET');
    swapReviewRow('From', review.from, true);
    swapReviewRow('Pay', swapAmountText(quote.amountIn, quote.fromToken));
    swapReviewRow('Receive (quoted)', swapAmountText(quote.expectedOut, quote.toToken));
    swapReviewRow('Route', quote.routeText);
    swapReviewRow('Minimum received', swapAmountText(review.minimum, quote.toToken));
    swapReviewRow('Slippage', (quote.slippageBps / 100) + '% (' + quote.slippageBps + ' bps)');
    swapReviewRow('Deadline (UTC)', new Date(Number(review.deadline)).toISOString());
    if (review.approve) {
      swapReviewRow('1) Approve', swapAmountText(quote.amountIn, quote.fromToken) +
        ' to the router (fee limit ' + AMOUNT.formatUnits(review.approve.feeLimitSun, 6) + ' TRX)');
    }
    swapReviewRow(review.approve ? '2) Swap' : 'Swap',
      'fee limit ' + AMOUNT.formatUnits(review.swap.feeLimitSun, 6) + ' TRX');
    swapReviewRow('Provider', review.providerLabel + ' · ' + review.providerUrl);
    if (review.approve) swapReviewRow('Approve transaction ID', review.approve.tx.txID, true);
    swapReviewRow('Swap transaction ID', review.swap.tx.txID, true);

    var warnings = [
      'A swap executes at the router price; the minimum received is the on-chain bound ' +
        'and the transaction is irreversible once it is broadcast.'
    ];
    if (review.approve) {
      warnings.push('The approve transaction is signed and broadcast first; the swap is ' +
        'signed only after the approve is confirmed on chain.');
    }
    swapReviewWarnings.textContent = '';
    warnings.forEach(function (warning) {
      var item = document.createElement('li');
      item.textContent = warning;
      swapReviewWarnings.appendChild(item);
    });
    swapReviewWarnings.hidden = warnings.length === 0;

    swapReviewUnsigned.textContent = (review.approve
      ? 'approve: ' + review.approve.tx.raw_data_hex + '\n'
      : '') + 'swap: ' + review.swap.tx.raw_data_hex;
    if (swapQuoteBox) swapQuoteBox.hidden = true;
    swapReviewBox.hidden = false;
    if (swapStatus) swapStatus.textContent = 'Review ready. Check every field, then sign.';
    if (swapConfirmButton) swapConfirmButton.focus();
  }

  function signReviewedTronStep(step, entry) {
    return signTronWithEntry(entry, step.request).then(function (text) {
      var signed = tronWallet.parseTxResult(text);
      if (typeof signed.signature !== 'string' || !/^[0-9a-f]{130}$/.test(signed.signature)) {
        throw new Error('The local core returned no TRON signature.');
      }
      /* What you see is what you sign: the signed bytes must be the reviewed
       * bytes, so a mutated review cannot broadcast a different call. */
      if (!step.tx || signed.raw_data_hex !== step.tx.raw_data_hex) {
        throw new Error('The signed transaction bytes do not match the reviewed bytes. ' +
          'Refusing to broadcast.');
      }
      return signed;
    });
  }

  /* Poll the reviewed provider until the approve appears in a block. A failed
   * receipt stops the flow before the swap is signed; a timeout does the same
   * and names the transaction so the user can check it. */
  async function waitForTronReceipt(network, providerUrl, txID, fetchJson, waitMs) {
    var provider = tronWallet.assertTronProvider(network, providerUrl);
    var url = tronWallet.tronEndpoint(provider, '/wallet/gettransactioninfobyid');
    var deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      var info;
      try {
        info = await rpcFetchJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ value: txID })
        });
      } catch (err) {
        throw new Error('Checking the approve transaction failed: ' + errorText(err));
      }
      var reported = info && (info.Error || info.error);
      if (reported) throw new Error('The node reported: ' + reported);
      var receipt = info && info.receipt;
      if (receipt && receipt.result && receipt.result !== 'SUCCESS') {
        throw new Error('The approve transaction ' + txID + ' failed on chain (' +
          receipt.result + '); the swap was not signed.');
      }
      if (info && (Number(info.blockNumber) > 0 || Number(info.blockTimeStamp) > 0)) {
        return;
      }
      await new Promise(function (resolve) {
        setTimeout(resolve, SWAP_APPROVE_POLL_MS);
      });
    }
    throw new Error('The approve transaction ' + txID + ' was not confirmed within ' +
      Math.round(waitMs / 1000) + 's; the swap was not signed. Check the transaction in the explorer.');
  }

  async function confirmSwap(review, entry) {
    state.swapSending = true;
    var generation = state.generation;
    setError('wallet-swap-confirm-error', '');
    setSwapBusy(true, 'Signing locally and broadcasting once…');
    var approveHash = null;
    var signedParts = [];
    try {
      var network = tronWallet.tronNetworkBySlug(review.networkSlug);
      if (!network) throw new Error('The reviewed TRON network is unknown.');
      tronWallet.assertTronMainnetArmed(network, swapArmed());
      swap.assertQuoteFresh(review.quote);
      tronWallet.assertTronProvider(network, review.providerUrl);
      if (review.approve) {
        var signedApprove = await signReviewedTronStep(review.approve, entry);
        await tronWallet.broadcastTronSigned(network, review.providerUrl,
          signedApprove, rpcFetchJson);
        approveHash = signedApprove.txID;
        signedParts.push(JSON.stringify({
          txID: signedApprove.txID,
          raw_data: signedApprove.raw_data,
          raw_data_hex: signedApprove.raw_data_hex,
          signature: [signedApprove.signature]
        }));
        if (swapStatus) {
          swapStatus.textContent = 'Approve broadcast; waiting for it to be confirmed on chain…';
        }
        await waitForTronReceipt(network, review.providerUrl, signedApprove.txID,
          rpcFetchJson, SWAP_APPROVE_WAIT_MS);
        if (generation !== state.generation || !state.unlocked) return;
      }
      /* The session arm can be cleared while the approve is confirming; the
       * swap must not be signed after a disarm. */
      tronWallet.assertTronMainnetArmed(network, swapArmed());
      var signedSwap = await signReviewedTronStep(review.swap, entry);
      await tronWallet.broadcastTronSigned(network, review.providerUrl,
        signedSwap, rpcFetchJson);
      signedParts.push(JSON.stringify({
        txID: signedSwap.txID,
        raw_data: signedSwap.raw_data,
        raw_data_hex: signedSwap.raw_data_hex,
        signature: [signedSwap.signature]
      }));
      if (generation !== state.generation || !state.unlocked) return;
      state.swapReview = null;
      state.swapReviewEntryId = null;
      state.swapQuote = null;
      stopSwapAge();
      if (swapReviewBox) swapReviewBox.hidden = true;
      renderSwapResult({
        txID: signedSwap.txID,
        approveHash: approveHash,
        networkName: network.name,
        network: network,
        providerUrl: review.providerUrl,
        providerLabel: review.providerLabel,
        signedHex: signedParts.join('\n')
      });
    } catch (err) {
      if (generation === state.generation && state.unlocked) {
        setError('wallet-swap-confirm-error', errorText(err));
        if (swapStatus) swapStatus.textContent = 'Signing or broadcast failed.';
      }
    } finally {
      state.swapSending = false;
      setSwapBusy(false);
    }
  }

  function renderSwapResult(result) {
    if (!swapResultBox) return;
    swapProviderNote.textContent = 'Sent to ' + result.providerLabel + ' · ' +
      result.providerUrl + '. Crypto did not proxy or store the transaction.';
    swapHashEl.textContent = result.txID;
    if (result.approveHash) {
      swapApproveResult.hidden = false;
      swapApproveHashEl.textContent = result.approveHash;
    } else {
      swapApproveResult.hidden = true;
      swapApproveHashEl.textContent = '';
    }
    var explorer = result.network && result.network.explorerTx
      ? result.network.explorerTx + result.txID
      : null;
    if (explorer) {
      swapExplorerLink.hidden = false;
      swapExplorerLink.href = explorer;
      swapExplorerLink.textContent = 'Open the swap on the ' + result.networkName + ' explorer';
    } else {
      swapExplorerLink.hidden = true;
      swapExplorerLink.removeAttribute('href');
      swapExplorerLink.textContent = '';
    }
    swapSignedEl.textContent = result.signedHex;
    swapResultBox.hidden = false;
    if (swapStatus) swapStatus.textContent = 'The provider accepted the signed transactions.';
    if (explorer) swapExplorerLink.focus();
  }

  function resetSend() {
    state.preparing = false;
    state.review = null;
    state.reviewEntryId = null;
    state.mainnetArmed = false;
    if (sendArmedCheckbox) sendArmedCheckbox.checked = false;
    if (sendArmedRow) sendArmedRow.hidden = true;
    if (sendForm) sendForm.reset();
    updateSendTokenState();
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
    resetApprovals();
    resetSwap();
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
    if (state.preparing || state.sending) return;
    var network = selectedNetwork();
    if (!network) {
      setError('wallet-send-error', 'The send modules did not load. Reload the page.');
      return;
    }
    var entry = selectedSendEntry();
    if (!entry) {
      setError('wallet-send-error', network.kind === 'tron'
        ? 'Import a TRON key and select it first.'
        : 'Import an EVM key and select it first.');
      return;
    }
    clearSendFieldErrors();
    setError('wallet-send-error', '');
    setError('wallet-send-confirm-error', '');
    invalidateSendReview();
    if (sendReviewBox) sendReviewBox.hidden = true;

    if (network.kind === 'tron') {
      if (!tronWallet) {
        setError('wallet-send-error', 'The TRON send module did not load. Reload the page.');
        return;
      }
      await prepareTronSend(entry, network);
      return;
    }
    if (!evmSend || typeof evmSend.validateForm !== 'function') {
      setError('wallet-send-error', 'The EVM send module did not load. Reload the page.');
      return;
    }

    var local = evmSend.validateForm(readSendForm());
    if (Object.keys(local.errors).length) {
      showSendFieldErrors(local.errors);
      setError('wallet-send-error', 'Fix the highlighted fields before review.');
      return;
    }

    state.preparing = true;
    var generation = state.generation;
    setSendBusy(true, sendTokenInput.value.trim()
      ? 'Reading the chain id, token decimals, symbol and balance, nonce, fees and gas estimate…'
      : 'Reading the chain id, nonce, balance, fees and gas estimate…');
    try {
      var from = await ensureDerivedAddress(entry);
      var review = await evmSend.prepareTransaction({
        form: readSendForm(),
        from: from,
        fetchJson: rpcFetchJson,
        providerUrl: sendProviderSelect.value || null,
        expectedChainId: network.chainId,
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
  if (sendTokenInput) {
    sendTokenInput.addEventListener('input', updateSendTokenState);
  }
  if (sendDataInput) {
    sendDataInput.addEventListener('input', updateSendTokenState);
  }
  sendEntrySelect.addEventListener('change', function () {
    updateSendFrom();
    invalidateSendReview();
    invalidateApprovalsScan('The selected key changed; run "Find approvals" again.');
  });
  sendNetworkSelect.addEventListener('change', function () {
    /* The key list is family-specific (EVM vs TRON), so a network change
     * rebuilds the picker as well as the provider list. */
    renderSend();
    updateSendArmedRow();
    invalidateSendReview();
    invalidateApprovalsScan('The network changed; run "Find approvals" again.');
  });
  sendProviderSelect.addEventListener('change', function () {
    invalidateSendReview();
    invalidateApprovalsScan('The RPC provider changed; run "Find approvals" again.');
  });
  if (sendArmedCheckbox) {
    sendArmedCheckbox.addEventListener('change', function () {
      state.mainnetArmed = sendArmedCheckbox.checked;
      invalidateSendReview();
      invalidateApprovalsReview();
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

    if (review.family === 'tron') {
      if (!tronWallet) {
        setError('wallet-send-confirm-error', 'The TRON send module did not load. Reload the page.');
        return;
      }
      await confirmTronSend(review, entry);
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
        unsigned: unsignedTx,
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

  /* ------------------------------------------------------------- swap events */

  if (swapForm) {
    swapForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!state.unlocked) {
        setError('wallet-swap-error', 'Unlock the vault first.');
        return;
      }
      if (state.swapPreparing || state.swapSending) return;
      if (!swap || !tronWallet) {
        setError('wallet-swap-error', 'The TRON swap module did not load. Reload the page.');
        return;
      }
      var entry = selectedSwapEntry();
      if (!entry) {
        setError('wallet-swap-error', 'Import a TRON key and select it first.');
        return;
      }
      await getSwapQuote(entry);
    });
  }
  if (swapEntrySelect) {
    swapEntrySelect.addEventListener('change', function () {
      updateSwapFrom();
      invalidateSwapQuote('The selected key changed; get a fresh quote.');
    });
  }
  if (swapNetworkSelect) {
    swapNetworkSelect.addEventListener('change', function () {
      updateSwapNetworkState();
      invalidateSwapQuote('The network changed; get a fresh quote.');
    });
  }
  [swapAmountInput, swapSlippageInput, swapFromTokenSelect, swapToTokenSelect]
    .forEach(function (control) {
      if (!control) return;
      control.addEventListener('input', function () {
        showSwapFieldErrors({});
        setError('wallet-swap-error', '');
        invalidateSwapQuote('The form changed; get a fresh quote.');
      });
      control.addEventListener('change', function () {
        showSwapFieldErrors({});
        setError('wallet-swap-error', '');
        invalidateSwapQuote('The form changed; get a fresh quote.');
      });
    });
  if (swapArmedCheckbox) {
    swapArmedCheckbox.addEventListener('change', function () {
      state.swapArmed = swapArmedCheckbox.checked;
      invalidateSwapReview('The session arm changed; review the swap again.');
    });
  }
  if (swapReviewButton) {
    swapReviewButton.addEventListener('click', function () {
      if (state.swapPreparing || state.swapSending) return;
      var entry = selectedSwapEntry();
      if (!entry) {
        setError('wallet-swap-error', 'Select a TRON key first.');
        return;
      }
      prepareSwapReview(entry);
    });
  }
  if (swapCancelButton) {
    swapCancelButton.addEventListener('click', function () {
      invalidateSwapReview('');
      if (swapStatus) swapStatus.textContent = '';
      if (state.swapQuote) renderSwapQuote(state.swapQuote);
      if (swapQuoteButton) swapQuoteButton.focus();
    });
  }
  if (swapConfirmButton) {
    swapConfirmButton.addEventListener('click', async function () {
      if (!state.unlocked) {
        setError('wallet-swap-confirm-error', 'Unlock the vault first.');
        return;
      }
      if (state.swapSending || state.swapPreparing) {
        setError('wallet-swap-confirm-error', 'A swap is already in flight.');
        return;
      }
      var review = state.swapReview;
      var entry = entryById(state.swapReviewEntryId);
      var selected = selectedSwapEntry();
      if (!review || !entry) {
        setError('wallet-swap-confirm-error', 'Build a new review first.');
        return;
      }
      if (!selected || selected.id !== entry.id) {
        setError('wallet-swap-confirm-error', 'The selected key changed; build a new review.');
        return;
      }
      await confirmSwap(review, entry);
    });
  }

  /* ------------------------------------------------------ ERC-20 approvals */

  /* The approvals panel reuses the send entry, network and provider controls.
   * It reads Approval logs from the public RPC, then reads the current
   * allowance and code of each spender. A revoke is prepared and confirmed by
   * the same EVM codec path as a transfer; the key exists only inside
   * signTxWithEntry. */

  function blockText(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function showApprovalsFieldErrors(errors) {
    var tokenError = errors.token || '';
    var windowError = errors.window || '';
    var spenderError = errors.spender || '';
    var amountError = errors.amount || '';
    setError('wallet-approvals-token-error', tokenError);
    setError('wallet-approvals-window-error', windowError);
    setError('wallet-approvals-grant-spender-error', spenderError);
    setError('wallet-approvals-grant-amount-error', amountError);
    if (approvalsTokenInput) {
      approvalsTokenInput.setAttribute('aria-invalid', tokenError ? 'true' : 'false');
    }
    if (approvalsWindowInput) {
      approvalsWindowInput.setAttribute('aria-invalid', windowError ? 'true' : 'false');
    }
    if (approvalsGrantSpender) {
      approvalsGrantSpender.setAttribute('aria-invalid', spenderError ? 'true' : 'false');
    }
    if (approvalsGrantAmount) {
      approvalsGrantAmount.setAttribute('aria-invalid', amountError ? 'true' : 'false');
    }
  }

  function setApprovalsBusy(busy, message) {
    var blocked = !!busy || state.approvalsScanning || state.approvalsSending;
    if (approvalsScanButton) approvalsScanButton.disabled = blocked;
    if (approvalsGrantPrepareButton) approvalsGrantPrepareButton.disabled = blocked;
    if (approvalsConfirmButton) approvalsConfirmButton.disabled = blocked;
    if (approvalsStatus && message !== undefined) approvalsStatus.textContent = message;
  }

  function invalidateApprovalsReview() {
    if (!state.approvalsReview) return;
    state.approvalsReview = null;
    state.approvalsReviewEntryId = null;
    state.approvalsReviewSpender = null;
    state.approvalsReviewKind = null;
    if (approvalsReviewBox) approvalsReviewBox.hidden = true;
    if (approvalsReviewWarnings) {
      approvalsReviewWarnings.textContent = '';
      approvalsReviewWarnings.hidden = true;
    }
    setError('wallet-approvals-confirm-error', '');
  }

  function invalidateApprovalsScan(message) {
    /* Any scan-affecting change (key, network, provider, token, window) also
     * invalidates whatever approval review is open, including a grant review
     * that does not depend on a scan. */
    invalidateApprovalsReview();
    if (!state.approvalsScan && !state.approvalsScanEntryId) return;
    state.approvalsScan = null;
    state.approvalsScanEntryId = null;
    renderApprovalsTable();
    if (message && approvalsStatus) approvalsStatus.textContent = message;
  }

  function spenderTypeText(isContract) {
    if (isContract === true) return 'Contract';
    if (isContract === false) return 'EOA';
    return 'Unknown (code read failed)';
  }

  function allowanceText(spender, scan) {
    if (spender.allowance === null) return 'Unknown (read failed)';
    var text = evmSend.formatAllowance(spender.allowance, scan.decimals);
    return text === 'Unlimited' ? text : text + ' ' + scan.symbol;
  }

  function renderApprovalsWarnings(warnings) {
    if (!approvalsWarnings) return;
    approvalsWarnings.textContent = '';
    if (!warnings || !warnings.length) {
      approvalsWarnings.hidden = true;
      return;
    }
    warnings.forEach(function (warning) {
      var item = document.createElement('li');
      item.textContent = warning;
      approvalsWarnings.appendChild(item);
    });
    approvalsWarnings.hidden = false;
  }

  function renderApprovalsTable() {
    if (!approvalsRows) return;
    var scan = state.approvalsScan;
    approvalsRows.textContent = '';
    if (!scan) {
      if (approvalsTableWrap) approvalsTableWrap.hidden = true;
      if (approvalsEmpty) approvalsEmpty.hidden = true;
      if (approvalsCoverage) { approvalsCoverage.hidden = true; approvalsCoverage.textContent = ''; }
      renderApprovalsWarnings([]);
      return;
    }

    var coverage;
    if (scan.scannedFromBlock > scan.scannedToBlock) {
      coverage = 'The provider refused every Approval log request in the requested window; ' +
        'no blocks were scanned. Another RPC or an indexer is needed.';
    } else {
      coverage = 'Scanned blocks ' + blockText(scan.scannedFromBlock) + '–' +
        blockText(scan.scannedToBlock) + ' of the requested ' + blockText(scan.requestedWindow) +
        ' on ' + scan.providerLabel + ' · ' + scan.logCount + ' Approval log' +
        (scan.logCount === 1 ? '' : 's') + ' · ' + scan.uniqueSpenders + ' unique spender' +
        (scan.uniqueSpenders === 1 ? '' : 's') + '.';
      if (scan.truncated) {
        coverage += ' The provider could not serve the whole window; older approvals need a larger window on an archive RPC or an indexer.';
      }
    }
    if (approvalsCoverage) {
      approvalsCoverage.textContent = coverage;
      approvalsCoverage.hidden = false;
    }
    renderApprovalsWarnings(scan.warnings);

    if (!scan.spenders.length) {
      if (approvalsTableWrap) approvalsTableWrap.hidden = true;
      if (approvalsEmpty) {
        approvalsEmpty.textContent = scan.truncated
          ? 'No approvals were found in the blocks the provider could serve; older approvals need an archive RPC or an indexer.'
          : 'No Approval logs for this owner were found in the scanned window.';
        approvalsEmpty.hidden = false;
      }
      return;
    }
    if (approvalsEmpty) approvalsEmpty.hidden = true;
    scan.spenders.forEach(function (spender) {
      var row = document.createElement('tr');

      var addressCell = document.createElement('td');
      var addressCode = document.createElement('code');
      addressCode.className = 'mono';
      addressCode.textContent = spender.address;
      addressCell.appendChild(addressCode);
      var explorer = document.createElement('a');
      explorer.className = 'icon-button icon-button--quiet';
      explorer.target = '_blank';
      explorer.rel = 'noopener noreferrer';
      explorer.href = scan.explorerAddress + spender.address;
      explorer.setAttribute('aria-label', 'Open ' + spender.address + ' in the chain explorer');
      explorer.setAttribute('data-tooltip', 'Open spender in explorer');
      explorer.appendChild(iconUse('ui-external'));
      addressCell.appendChild(explorer);
      row.appendChild(addressCell);

      var typeCell = document.createElement('td');
      typeCell.textContent = spenderTypeText(spender.isContract);
      row.appendChild(typeCell);

      var allowanceCell = document.createElement('td');
      allowanceCell.textContent = allowanceText(spender, scan);
      row.appendChild(allowanceCell);

      var actionCell = document.createElement('td');
      var revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'icon-button';
      revoke.setAttribute('aria-label', 'Revoke the ' + scan.symbol + ' allowance for ' + spender.address);
      if (spender.allowance === 0n) {
        revoke.disabled = true;
        revoke.setAttribute('data-tooltip', 'Allowance is already zero');
      } else {
        revoke.setAttribute('data-tooltip', spender.allowance === null
          ? 'Current allowance unknown; the revoke re-reads it'
          : 'Revoke this approval (approve 0)');
        revoke.addEventListener('click', function () {
          startApprovalsRevoke(spender.address);
        });
      }
      revoke.appendChild(iconUse('ui-close'));
      actionCell.appendChild(revoke);
      row.appendChild(actionCell);

      approvalsRows.appendChild(row);
    });
    if (approvalsTableWrap) approvalsTableWrap.hidden = false;
  }

  function addApprovalsReviewRow(label, value, asCode) {
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
    approvalsReviewList.appendChild(term);
    approvalsReviewList.appendChild(detail);
  }

  function reviewAllowanceText(value, decimals, symbol) {
    var text = evmSend.formatAllowance(value, decimals);
    return text === 'Unlimited' ? text : text + ' ' + symbol;
  }

  function renderApprovalsReviewWarnings(warnings) {
    if (!approvalsReviewWarnings) return;
    approvalsReviewWarnings.textContent = '';
    if (!warnings || !warnings.length) {
      approvalsReviewWarnings.hidden = true;
      return;
    }
    warnings.forEach(function (warning) {
      var item = document.createElement('li');
      item.textContent = warning;
      approvalsReviewWarnings.appendChild(item);
    });
    approvalsReviewWarnings.hidden = false;
  }

  function renderApprovalsReview(review) {
    var isGrant = review.isGrant === true;
    var nativeSymbol = review.symbol || SSOT_CHAINS.bySlug.ethereum.symbol;
    var feeWei = review.gasLimit * review.maxFeeWei;
    if (approvalsReviewHeading) {
      approvalsReviewHeading.textContent = isGrant
        ? 'Review the allowance grant before signing'
        : 'Review revoke before signing';
    }
    if (approvalsReviewNote) {
      approvalsReviewNote.textContent = isGrant
        ? 'Confirm signs these exact reviewed values in the same local WASM core and sends only the signed raw transaction to the selected RPC. The transaction calls approve(spender, amount); the calldata is built locally and the signature covers the reviewed spender and allowance.'
        : 'Confirm signs these exact reviewed values in the same local WASM core and sends only the signed raw transaction to the selected RPC. The transaction calls approve(spender, 0); the calldata is built locally and the signature covers the reviewed spender.';
    }
    approvalsReviewList.textContent = '';
    addApprovalsReviewRow('Network', review.chainName + ' · chain id ' + review.chainId +
      (review.testnet ? ' · testnet' : ' · MAINNET'));
    addApprovalsReviewRow('From', review.from, true);
    addApprovalsReviewRow('Token contract', review.tokenContract, true);
    addApprovalsReviewRow('Token symbol', review.tokenSymbol);
    addApprovalsReviewRow('Token decimals', String(review.tokenDecimals));
    addApprovalsReviewRow('Spender', review.spender, true);
    if (isGrant) {
      addApprovalsReviewRow('Spender type', spenderTypeText(review.spenderIsContract));
    }
    addApprovalsReviewRow('Current allowance',
      review.currentAllowanceWei === null || review.currentAllowanceWei === undefined
        ? 'Unknown (read failed)'
        : reviewAllowanceText(review.currentAllowanceWei, review.tokenDecimals, review.tokenSymbol));
    addApprovalsReviewRow('New allowance', isGrant
      ? reviewAllowanceText(review.approvalAmountWei, review.tokenDecimals, review.tokenSymbol)
      : '0 ' + review.tokenSymbol);
    addApprovalsReviewRow('Data (built locally)', review.dataHex, true);
    addApprovalsReviewRow('Gas limit', review.gasLimit.toString() + (review.gasLimitIsManual
      ? ' (manual)'
      : (review.testnet ? ' (eth_estimateGas)' : ' (eth_estimateGas + 20% buffer)')));
    addApprovalsReviewRow('Nonce', review.nonce.toString());
    addApprovalsReviewRow('Max fee (per gas)', AMOUNT.formatUnits(review.maxFeeWei, 9) + ' gwei (' +
      review.maxFeeWei + ' wei)');
    addApprovalsReviewRow('Priority fee', AMOUNT.formatUnits(review.priorityWei, 9) + ' gwei');
    addApprovalsReviewRow('Maximum network fee', AMOUNT.formatUnits(feeWei, 18) + ' ' + nativeSymbol);
    addApprovalsReviewRow('Balance', AMOUNT.formatUnits(review.balanceWei, 18) + ' ' + nativeSymbol);
    if (review.feeCapWei !== null && review.feeCapWei !== undefined) {
      addApprovalsReviewRow('Fee cap', AMOUNT.formatUnits(review.feeCapWei, 18) + ' ' +
        nativeSymbol + ' · within cap');
    }
    addApprovalsReviewRow('RPC', review.providerLabel + ' · ' + review.providerUrl);
    addApprovalsReviewRow('Fee source', review.feesSource + ' / priority: ' + review.prioritySource);
    renderApprovalsReviewWarnings(review.warnings);
    approvalsReviewUnsigned.textContent = review.unsignedHex;
    approvalsReviewBox.hidden = false;
    if (approvalsStatus) {
      approvalsStatus.textContent = isGrant
        ? 'Grant review ready. Check the spender, the allowance and the warning, then sign.'
        : 'Revoke review ready. Check every field, then sign.';
    }
    if (approvalsConfirmButton) approvalsConfirmButton.focus();
  }

  function renderApprovalsResult(result, kind) {
    approvalsProviderNote.textContent = 'Sent to ' + result.providerLabel + ' · ' +
      result.providerUrl + '. Crypto did not proxy or store the transaction.';
    approvalsHashEl.textContent = result.txHash;
    approvalsExplorerLink.href = result.explorerUrl;
    approvalsExplorerLink.textContent = 'Open on the ' + (result.chainName || 'chain') + ' explorer';
    approvalsSignedEl.textContent = result.signedHex;
    approvalsResultBox.hidden = false;
    if (approvalsStatus) {
      approvalsStatus.textContent = kind === 'grant'
        ? 'The RPC accepted the signed allowance grant.'
        : 'The RPC accepted the signed revoke.';
    }
    approvalsExplorerLink.focus();
  }

  function clearApprovalsResult() {
    if (approvalsResultBox) approvalsResultBox.hidden = true;
    if (approvalsProviderNote) approvalsProviderNote.textContent = '';
    if (approvalsHashEl) approvalsHashEl.textContent = '';
    if (approvalsSignedEl) approvalsSignedEl.textContent = '';
    if (approvalsRereadEl) approvalsRereadEl.textContent = '';
    if (approvalsExplorerLink) approvalsExplorerLink.removeAttribute('href');
  }

  /* The Unlimited checkbox owns the amount field: checking it disables the
   * amount input (the codec pins 2^256-1) and reveals its own warning line. */
  function updateGrantUnlimitedState() {
    var unlimited = Boolean(approvalsGrantUnlimited && approvalsGrantUnlimited.checked);
    if (approvalsGrantAmount) {
      approvalsGrantAmount.disabled = unlimited;
      if (unlimited) approvalsGrantAmount.value = '';
    }
    if (approvalsGrantWarning) approvalsGrantWarning.hidden = !unlimited;
  }

  function resetApprovals() {
    state.approvalsScanning = false;
    state.approvalsSending = false;
    state.approvalsScan = null;
    state.approvalsScanEntryId = null;
    state.approvalsReview = null;
    state.approvalsReviewEntryId = null;
    state.approvalsReviewSpender = null;
    state.approvalsReviewKind = null;
    if (approvalsForm) approvalsForm.reset();
    if (approvalsGrantForm) approvalsGrantForm.reset();
    updateGrantUnlimitedState();
    showApprovalsFieldErrors({});
    setError('wallet-approvals-error', '');
    setError('wallet-approvals-confirm-error', '');
    if (approvalsCoverage) { approvalsCoverage.hidden = true; approvalsCoverage.textContent = ''; }
    renderApprovalsWarnings([]);
    renderApprovalsTable();
    if (approvalsReviewBox) approvalsReviewBox.hidden = true;
    if (approvalsReviewList) approvalsReviewList.textContent = '';
    if (approvalsReviewWarnings) {
      approvalsReviewWarnings.textContent = '';
      approvalsReviewWarnings.hidden = true;
    }
    if (approvalsReviewUnsigned) approvalsReviewUnsigned.textContent = '';
    clearApprovalsResult();
    if (approvalsStatus) approvalsStatus.textContent = '';
    setApprovalsBusy(false);
  }

  function renderApprovals() {
    if (!approvalsCard || !evmSend) return;
    /* Approvals are an EVM token surface; hide the panel while a TRON network
     * is selected in the send form. */
    var selected = selectedNetwork();
    if (!selected || selected.kind !== 'evm') {
      approvalsCard.hidden = true;
      return;
    }
    var entries = sendEntries();
    if (!state.unlocked || !entries.length) {
      approvalsCard.hidden = true;
      return;
    }
    approvalsCard.hidden = false;
    if (state.approvalsReview && !entries.some(function (entry) {
      return entry.id === state.approvalsReviewEntryId;
    })) {
      invalidateApprovalsReview();
    }
    if (state.approvalsScan && !entries.some(function (entry) {
      return entry.id === state.approvalsScanEntryId;
    })) {
      invalidateApprovalsScan('The selected key changed; run "Find approvals" again.');
    }
  }

  async function startApprovalsRevoke(spender) {
    if (!state.unlocked) {
      setError('wallet-approvals-error', 'Unlock the vault first.');
      return;
    }
    if (!evmSend || !state.approvalsScan) {
      setError('wallet-approvals-error', 'Run "Find approvals" first.');
      return;
    }
    if (state.approvalsScanning || state.approvalsSending) return;
    var scan = state.approvalsScan;
    var entry = entryById(state.approvalsScanEntryId);
    if (!entry) {
      setError('wallet-approvals-error', 'Select the vault key and scan again.');
      return;
    }
    showApprovalsFieldErrors({});
    setError('wallet-approvals-error', '');
    setError('wallet-approvals-confirm-error', '');
    invalidateApprovalsReview();
    clearApprovalsResult();
    state.approvalsSending = true;
    var generation = state.generation;
    setApprovalsBusy(true, 'Reading the current allowance, nonce, fees and gas estimate…');
    try {
      var owner = await ensureDerivedAddress(entry);
      var review = await evmSend.prepareRevoke({
        token: scan.contract,
        spender: spender,
        from: owner,
        fetchJson: rpcFetchJson,
        providerUrl: scan.providerUrl,
        expectedChainId: scan.chainId,
        networkName: scan.chainName,
        mainnetArmed: isMainnetArmed(),
        unsigned: unsignedTx
      });
      if (generation !== state.generation || !state.unlocked) return;
      /* The review is only valid for the scan and the key it was prepared
       * from; a change during the RPC reads must not leave a stale review. */
      var stillSelected = selectedSendEntry();
      if (state.approvalsScan !== scan || state.approvalsScanEntryId !== entry.id) return;
      if (!stillSelected || stillSelected.id !== entry.id) return;
      state.approvalsReview = review;
      state.approvalsReviewEntryId = entry.id;
      state.approvalsReviewSpender = spender;
      state.approvalsReviewKind = 'revoke';
      renderApprovalsReview(review);
    } catch (err) {
      if (generation !== state.generation || !state.unlocked) return;
      if (err.fieldErrors) showApprovalsFieldErrors(err.fieldErrors);
      setError('wallet-approvals-error', errorText(err));
      if (approvalsReviewBox) approvalsReviewBox.hidden = true;
      if (approvalsStatus) approvalsStatus.textContent = '';
    } finally {
      state.approvalsSending = false;
      setApprovalsBusy(false);
      if (state.approvalsReview && approvalsConfirmButton && !approvalsConfirmButton.disabled) {
        approvalsConfirmButton.focus();
      }
    }
  }

  /* Re-read the allowance after a grant or revoke and show the result. `source`
   * is the scan (with its spender rows) or a plain {contract, providerUrl,
   * owner, symbol, decimals} built from a grant review. `expected` is the new
   * allowance for a grant; omit it for a revoke limited to zero. The provider
   * may still report the old value until the transaction is mined, so the
   * message never claims the change already happened. */
  async function rereadApprovalsAllowance(source, spender, expected) {
    if (!source || !spender) return;
    if (approvalsRereadEl) approvalsRereadEl.textContent = 'Re-reading the current allowance…';
    try {
      var value = await evmSend.readAllowance(rpcFetchJson, source.providerUrl, source.contract,
        source.owner, spender);
      if (source.spenders) {
        for (var i = 0; i < source.spenders.length; i += 1) {
          if (source.spenders[i].address === spender) {
            source.spenders[i].allowance = value;
            break;
          }
        }
        renderApprovalsTable();
      }
      if (approvalsRereadEl) {
        if (expected !== undefined && expected !== null) {
          approvalsRereadEl.textContent = value === expected
            ? 'The current allowance is now ' +
              reviewAllowanceText(value, source.decimals, source.symbol) + '.'
            : 'The grant was broadcast, but the provider still reports ' +
              reviewAllowanceText(value, source.decimals, source.symbol) +
              '; it may update after the transaction is mined.';
        } else {
          approvalsRereadEl.textContent = value === 0n
            ? 'The current allowance is now 0 ' + source.symbol + '.'
            : 'The revoke was broadcast, but the provider still reports ' +
              reviewAllowanceText(value, source.decimals, source.symbol) +
              '; it may update after the transaction is mined.';
        }
      }
    } catch (err) {
      if (approvalsRereadEl) {
        approvalsRereadEl.textContent = 'The transaction was broadcast, but re-reading the allowance failed: ' +
          errorText(err);
      }
    }
  }

  approvalsForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!state.unlocked) {
      setError('wallet-approvals-error', 'Unlock the vault first.');
      return;
    }
    if (!evmSend) {
      setError('wallet-approvals-error', 'The EVM module did not load. Reload the page.');
      return;
    }
    if (state.approvalsScanning || state.approvalsSending) return;
    var entry = selectedSendEntry();
    if (!entry) {
      setError('wallet-approvals-error', 'Import an EVM key and select it first.');
      return;
    }
    showApprovalsFieldErrors({});
    setError('wallet-approvals-error', '');
    setError('wallet-approvals-confirm-error', '');
    invalidateApprovalsReview();
    invalidateApprovalsScan('');
    clearApprovalsResult();
    var tokenText = approvalsTokenInput.value;
    var windowText = approvalsWindowInput.value;
    var localErrors = {};
    try {
      evmSend.normalizeAddress(tokenText, 'token contract');
    } catch (err) {
      localErrors.token = errorText(err);
    }
    try {
      evmSend.parseWindowBlocks(windowText);
    } catch (err) {
      localErrors.window = errorText(err);
    }
    if (Object.keys(localErrors).length) {
      showApprovalsFieldErrors(localErrors);
      setError('wallet-approvals-error', 'Fix the highlighted fields before scanning.');
      return;
    }

    state.approvalsScanning = true;
    var generation = state.generation;
    setApprovalsBusy(true, 'Checking the token contract and scanning Approval logs…');
    try {
      var owner = await ensureDerivedAddress(entry);
      var scan = await evmSend.scanApprovals({
        token: tokenText,
        owner: owner,
        windowBlocks: windowText,
        fetchJson: rpcFetchJson,
        providerUrl: sendProviderSelect.value || null,
        expectedChainId: selectedEvmChainId(),
        networkName: selectedNetwork().name
      });
      if (generation !== state.generation || !state.unlocked) return;
      /* A selection, network, provider or form change while the scan was in
       * flight makes this result stale: do not show it over the new selection. */
      var stillSelected = selectedSendEntry();
      if (!stillSelected || stillSelected.id !== entry.id) return;
      if (selectedEvmChainId() !== Number(scan.chainId)) return;
      var chosenProvider = sendProviderSelect.value;
      if (chosenProvider && chosenProvider !== scan.providerUrl) return;
      if (approvalsTokenInput.value !== tokenText || approvalsWindowInput.value !== windowText) return;
      state.approvalsScan = scan;
      state.approvalsScanEntryId = entry.id;
      renderApprovalsTable();
      if (approvalsStatus) {
        approvalsStatus.textContent = 'Scan finished: ' + scan.uniqueSpenders + ' unique spender' +
          (scan.uniqueSpenders === 1 ? '' : 's') + ' shown (cap ' + scan.cap + ').';
      }
    } catch (err) {
      if (generation !== state.generation || !state.unlocked) return;
      if (err.fieldErrors) showApprovalsFieldErrors(err.fieldErrors);
      setError('wallet-approvals-error', errorText(err));
      if (approvalsStatus) approvalsStatus.textContent = '';
    } finally {
      state.approvalsScanning = false;
      setApprovalsBusy(false);
    }
  });

  approvalsForm.addEventListener('input', function () {
    invalidateApprovalsReview();
    invalidateApprovalsScan('The form changed; run "Find approvals" again.');
  });

  /* Grant a new allowance. The token contract comes from the scan form above;
   * the spender, the finite amount or the Unlimited option are the only new
   * inputs. The codec rebuilds approve(spender, amount) locally and runs the
   * same chain-id, arm, fee-cap, estimateGas, review and unsigned-pin gates. */
  approvalsGrantForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!state.unlocked) {
      setError('wallet-approvals-error', 'Unlock the vault first.');
      return;
    }
    if (!evmSend) {
      setError('wallet-approvals-error', 'The EVM module did not load. Reload the page.');
      return;
    }
    if (state.approvalsScanning || state.approvalsSending) return;
    var entry = selectedSendEntry();
    if (!entry) {
      setError('wallet-approvals-error', 'Import an EVM key and select it first.');
      return;
    }
    showApprovalsFieldErrors({});
    setError('wallet-approvals-error', '');
    setError('wallet-approvals-confirm-error', '');
    invalidateApprovalsReview();
    clearApprovalsResult();

    var tokenText = approvalsTokenInput.value.trim();
    var spenderText = approvalsGrantSpender.value.trim();
    var unlimited = approvalsGrantUnlimited.checked;
    var amountText = approvalsGrantAmount.value.trim();
    var localErrors = {};
    try {
      evmSend.normalizeAddress(tokenText, 'token contract');
    } catch (err) {
      localErrors.token = errorText(err);
    }
    try {
      evmSend.normalizeAddress(spenderText, 'spender');
    } catch (err) {
      localErrors.spender = errorText(err);
    }
    if (!unlimited) {
      if (!amountText) {
        localErrors.amount = 'Enter the allowance amount in token units, or choose Unlimited.';
      } else if (!/^\d+(?:\.\d+)?$/.test(amountText)) {
        localErrors.amount = 'Use a plain decimal token amount like 1.5 (no exponent, sign or comma).';
      } else if (!/[1-9]/.test(amountText)) {
        localErrors.amount = 'The allowance amount must be greater than zero; use revoke to set zero.';
      }
    }
    if (Object.keys(localErrors).length) {
      showApprovalsFieldErrors(localErrors);
      setError('wallet-approvals-error', 'Fix the highlighted fields before review.');
      return;
    }

    state.approvalsSending = true;
    var generation = state.generation;
    setApprovalsBusy(true, 'Checking the token contract and building the allowance grant…');
    try {
      var owner = await ensureDerivedAddress(entry);
      var review = await evmSend.prepareGrant({
        token: tokenText,
        spender: spenderText,
        amountText: unlimited ? undefined : amountText,
        unlimited: unlimited,
        from: owner,
        fetchJson: rpcFetchJson,
        providerUrl: sendProviderSelect.value || null,
        expectedChainId: selectedEvmChainId(),
        networkName: selectedNetwork().name,
        mainnetArmed: isMainnetArmed(),
        unsigned: unsignedTx
      });
      if (generation !== state.generation || !state.unlocked) return;
      /* A selection, network, provider or field change while the RPC reads were
       * in flight makes this review stale: never show it over the new input. */
      var stillSelected = selectedSendEntry();
      if (!stillSelected || stillSelected.id !== entry.id) return;
      if (selectedEvmChainId() !== Number(review.chainId)) return;
      var chosenProvider = sendProviderSelect.value;
      if (chosenProvider && chosenProvider !== review.providerUrl) return;
      if (approvalsTokenInput.value.trim().toLowerCase() !== tokenText.toLowerCase()) return;
      if (approvalsGrantSpender.value.trim().toLowerCase() !== spenderText.toLowerCase()) return;
      if (approvalsGrantUnlimited.checked !== unlimited) return;
      if (!unlimited && approvalsGrantAmount.value.trim() !== amountText) return;
      state.approvalsReview = review;
      state.approvalsReviewEntryId = entry.id;
      state.approvalsReviewSpender = review.spender;
      state.approvalsReviewKind = 'grant';
      renderApprovalsReview(review);
    } catch (err) {
      if (generation !== state.generation || !state.unlocked) return;
      if (err.fieldErrors) showApprovalsFieldErrors(err.fieldErrors);
      setError('wallet-approvals-error', errorText(err));
      if (approvalsReviewBox) approvalsReviewBox.hidden = true;
      if (approvalsStatus) approvalsStatus.textContent = '';
    } finally {
      state.approvalsSending = false;
      setApprovalsBusy(false);
      if (state.approvalsReview && approvalsConfirmButton && !approvalsConfirmButton.disabled) {
        approvalsConfirmButton.focus();
      }
    }
  });

  approvalsGrantForm.addEventListener('input', function () {
    invalidateApprovalsReview();
  });

  if (approvalsGrantUnlimited) {
    approvalsGrantUnlimited.addEventListener('change', function () {
      updateGrantUnlimitedState();
      invalidateApprovalsReview();
    });
  }

  approvalsCancelButton.addEventListener('click', function () {
    invalidateApprovalsReview();
    if (approvalsReviewBox) approvalsReviewBox.hidden = true;
    if (approvalsStatus) approvalsStatus.textContent = '';
    if (approvalsTokenInput) approvalsTokenInput.focus();
  });

  approvalsConfirmButton.addEventListener('click', async function () {
    if (!state.unlocked) {
      setError('wallet-approvals-confirm-error', 'Unlock the vault first.');
      return;
    }
    if (state.approvalsSending || state.approvalsScanning) {
      setError('wallet-approvals-confirm-error', 'An approval transaction is already in flight.');
      return;
    }
    var review = state.approvalsReview;
    var entry = entryById(state.approvalsReviewEntryId);
    if (!review || !entry) {
      setError('wallet-approvals-confirm-error', 'Prepare a new approval review first.');
      return;
    }
    var selected = selectedSendEntry();
    if (!selected || selected.id !== entry.id) {
      setError('wallet-approvals-confirm-error', 'The selected key changed; prepare a new approval review.');
      return;
    }
    var kind = state.approvalsReviewKind || (review.isGrant ? 'grant' : 'revoke');
    var scan = state.approvalsScan;
    var spender = state.approvalsReviewSpender;
    /* A revoke is always tied to a scan result; a grant is not, so it does not
     * need a scan to confirm. */
    if (kind !== 'grant' && (!scan || state.approvalsScanEntryId !== entry.id)) {
      setError('wallet-approvals-confirm-error', 'The scanned key changed; run "Find approvals" and prepare a new review.');
      return;
    }

    state.approvalsSending = true;
    var generation = state.generation;
    setError('wallet-approvals-confirm-error', '');
    setApprovalsBusy(true, 'Checking the chain id, signing locally and broadcasting…');
    try {
      var result = await evmSend.confirmTransaction({
        review: review,
        fetchJson: rpcFetchJson,
        mainnetArmed: isMainnetArmed(),
        unsigned: unsignedTx,
        sign: function (fields) { return signTxWithEntry(entry, fields); }
      });
      if (generation !== state.generation || !state.unlocked) return;
      state.approvalsReview = null;
      state.approvalsReviewEntryId = null;
      state.approvalsReviewKind = null;
      if (approvalsReviewBox) approvalsReviewBox.hidden = true;
      renderApprovalsResult(result, kind);
      if (kind === 'grant') {
        /* Update the matching table row when the scan covers the same token,
         * otherwise show the re-read from the review's own RPC. */
        var source = (scan && scan.contract === review.tokenContract && scan.owner === review.from)
          ? scan
          : {
            contract: review.tokenContract,
            providerUrl: review.providerUrl,
            owner: review.from,
            symbol: review.tokenSymbol,
            decimals: review.tokenDecimals
          };
        await rereadApprovalsAllowance(source, review.spender, review.approvalAmountWei);
      } else {
        await rereadApprovalsAllowance(scan, spender);
      }
    } catch (err) {
      if (generation === state.generation && state.unlocked) {
        setError('wallet-approvals-confirm-error', errorText(err));
        if (approvalsStatus) approvalsStatus.textContent = 'Signing or broadcast failed.';
      }
    } finally {
      state.approvalsSending = false;
      setApprovalsBusy(false);
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
