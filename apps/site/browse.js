/* Chain browser: derives every key on the page in the browser, fills the
 * addresses and checks public balances. No key is sent anywhere. */
(function () {
  'use strict';

  var WASM_URL = typeof window !== 'undefined' && window.RotorAssets
    ? window.RotorAssets.url('/rotor_wasm.wasm')
    : '/rotor_wasm.wasm';
  var CHUNK = 6;
  var DECODER = new TextDecoder('utf-8');
  var BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  var TYPE_FIELDS = {
    bitcoin: {
      legacy: 'btc_p2pkh',
      segwit: 'btc_p2wpkh',
      script: 'btc_p2sh_p2wpkh',
      taproot: 'btc_p2tr'
    },
    litecoin: {
      legacy: 'ltc_p2pkh',
      segwit: 'ltc_p2wpkh',
      script: 'ltc_p2sh_p2wpkh',
      taproot: 'ltc_p2tr'
    }
  };
  var RPC = {
    ethereum: 'https://ethereum-rpc.publicnode.com',
    bnb: 'https://bsc-rpc.publicnode.com',
    arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
    optimism: 'https://optimism-rpc.publicnode.com',
    base: 'https://base-rpc.publicnode.com',
    polygon: 'https://polygon-bor-rpc.publicnode.com',
    avalanche: 'https://avalanche-c-chain-rpc.publicnode.com',
    zksync: 'https://mainnet.era.zksync.io'
  };
  /* The official RPC is primary; publicnode serves the same mainnet JSON-RPC
   * when the official host rejects the browser (it answers 403 to some
   * origins). */
  var SOLANA_RPC_URLS = [
    'https://api.mainnet-beta.solana.com',
    'https://solana-rpc.publicnode.com'
  ];
  var SUI_GRAPHQL = 'https://graphql.mainnet.sui.io/graphql';
  var PAGE_SIZE = 60n;

  /* ------------------------------------------------------- pure helpers */
  /* Row shaping is pure so it can be tested under Node without a DOM. */

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

  /* Bitcoin rows show the hex key plus both WIF forms. Other chains have no
   * WIF, so the model carries the hex only. */
  function keyModel(report) {
    var model = { hex: report && report.priv_hex ? report.priv_hex : '', wifs: [] };
    if (!report) return model;
    if (report.wif_compressed) model.wifs.push({ prefix: 'c', value: report.wif_compressed });
    if (report.wif_uncompressed) model.wifs.push({ prefix: 'u', value: report.wif_uncompressed });
    return model;
  }

  function metricFlags(value) {
    return {
      hasTx: Number(value && value.tx) > 0,
      hasRecv: Number(value && value.received) > 0
    };
  }

  /* The page that contains a key: 60 keys per page. Accepts 1..=64 hex
   * digits with an optional 0x prefix (the same forms `search.js` resolves);
   * a short numeric string is hex here, not decimal. Returns a BigInt page
   * clamped to `1..=pages`, or null when the value is not a positive key. */
  function pageForHexKey(hex, pages) {
    var digits = String(hex || '').replace(/^0[xX]/, '');
    if (!/^[0-9a-fA-F]{1,64}$/.test(digits)) return null;
    var value;
    var last;
    try {
      value = BigInt('0x' + digits);
      last = BigInt(String(pages));
    } catch (err) {
      return null;
    }
    if (value <= 0n || last < 1n) return null;
    var page = (value - 1n) / 60n + 1n;
    return page > last ? last : page;
  }

  if (typeof window !== 'undefined') {
    window.RotorBrowse = {
      addressEntriesFor: addressEntriesFor,
      keyModel: keyModel,
      metricFlags: metricFlags,
      tronValue: tronValue,
      pageForHexKey: pageForHexKey
    };
  }

  var root = document.querySelector('.browse-page');
  if (!root) return;

  var config = {
    chain: root.getAttribute('data-chain') || 'bitcoin',
    symbol: root.getAttribute('data-symbol') || '',
    explorer: root.getAttribute('data-explorer') || '',
    type: root.getAttribute('data-type') || 'legacy',
    field: root.getAttribute('data-field') || '',
    curve: Number(root.getAttribute('data-curve') || '0'),
    pages: root.getAttribute('data-pages') || '1',
    page: root.getAttribute('data-page') || '1'
  };

  var state = {
    wasm: null,
    wasmPromise: null,
    reports: {},
    addressMaps: {},
    addressSets: {},
    balances: {},
    cached: {},
    busy: false,
    balanceBusy: false,
    generation: 0,
    balanceRun: 0,
    tonPromise: null
  };

  var cacheApi = window.RotorBalanceCache || null;
  var cacheStore = cacheApi ? cacheApi.createStore() : Promise.resolve(null);
  var BALANCE_LIMIT = 5;
  var BALANCE_JITTER_MS = 400;
  /* Above this many addresses the TRON provider uses one batch request
   * instead of one request per address. The coordinator caps a batch at 60. */
  var TRON_BATCH_THRESHOLD = 5;
  var TRON_BATCH_MAX = 60;

  var rows = Array.prototype.slice.call(document.querySelectorAll('#keys-container .key-row'));
  var typeButtons = Array.prototype.slice.call(document.querySelectorAll('.address-type-card'));
  var searchForm = document.getElementById('browse-search');
  var searchInput = document.getElementById('browse-search-input');
  var searchType = document.getElementById('browse-search-type');
  var jumpForm = document.getElementById('browse-jump');
  var pageInput = document.getElementById('browse-page-input');
  var balanceNote = document.getElementById('balance-note');
  var totalBalance = document.getElementById('total-balance');
  var totalReceived = document.getElementById('total-received');
  var totalTx = document.getElementById('total-tx');
  var totalActive = document.getElementById('total-active');
  var refreshButton = document.getElementById('balance-refresh');
  var refreshCount = document.getElementById('balance-refresh-count');
  var refreshStatus = document.getElementById('balance-refresh-status');

  function fieldFor(type) {
    var table = TYPE_FIELDS[config.chain];
    if (table && table[type]) return table[type];
    return config.field || type;
  }

  function setNote(message, kind) {
    if (!balanceNote) return;
    balanceNote.textContent = message;
    balanceNote.classList.toggle('err', kind === 'err');
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(32);
    for (var i = 0; i < 32; i += 1) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  function bytesToHex(bytes) {
    return Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  /* --------------------------------------------------------------- wasm */

  async function loadWasm() {
    if (state.wasm) return state.wasm;
    if (state.wasmPromise) return state.wasmPromise;
    state.wasmPromise = (async function () {
      var response = await fetch(WASM_URL);
      if (!response.ok) throw new Error('Cannot load ' + WASM_URL + ': HTTP ' + response.status);
      var module;
      try {
        module = await WebAssembly.instantiateStreaming(response.clone(), {});
      } catch (err) {
        module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      }
      var wasm = module.instance ? module.instance.exports : module.exports;
      var required = ['alloc', 'dealloc', 'derive_report', 'result_ptr', 'result_len', 'error_ptr', 'error_len', 'memory'];
      for (var i = 0; i < required.length; i += 1) {
        if (!wasm[required[i]]) throw new Error('The derivation core is missing "' + required[i] + '".');
      }
      state.wasm = wasm;
      return wasm;
    })();
    try {
      return await state.wasmPromise;
    } catch (err) {
      state.wasmPromise = null;
      throw err;
    }
  }

  function readString(wasm, ptr, length) {
    if (!ptr || !length) return '';
    return DECODER.decode(new Uint8Array(wasm.memory.buffer, ptr, length));
  }

  function derive(wasm, hex) {
    var bytes = hexToBytes(hex);
    var ptr = wasm.alloc(bytes.length) >>> 0;
    if (!ptr) throw new Error('WASM memory exhausted.');
    try {
      new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
      var status = wasm.derive_report(ptr, config.curve) >>> 0;
      if (status !== 0) {
        var detail = readString(wasm, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0);
        throw new Error(detail || ('derivation status ' + status));
      }
      return JSON.parse(readString(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0));
    } finally {
      wasm.dealloc(ptr, bytes.length);
    }
  }

  /* ------------------------------------------------------------ rendering */

  function explorerUrl(address) {
    if (!config.explorer) return '';
    return config.explorer + encodeURIComponent(address);
  }

  function iconUse(name, className) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className || 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/icons.svg#' + name);
    svg.appendChild(use);
    return svg;
  }

  function copyButton(text, label) {
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'icon-button icon-button--quiet icon-button--lg';
    copy.setAttribute('data-tooltip', label);
    copy.setAttribute('aria-label', label);
    copy.appendChild(iconUse('ui-copy'));
    copy.addEventListener('click', function () { copyText(text, copy); });
    return copy;
  }

  function fillAddressCell(row, entries) {
    var cell = row.querySelector('.col-address');
    if (!cell) return;
    cell.textContent = '';
    if (!entries.length) {
      var empty = document.createElement('span');
      empty.className = 'cell-skeleton';
      empty.textContent = 'Not available';
      cell.appendChild(empty);
      return;
    }
    entries.forEach(function (entry) {
      var line = document.createElement('div');
      line.className = 'addr-line';
      if (entry.prefix) {
        var prefix = document.createElement('span');
        prefix.className = 'addr-label';
        prefix.textContent = '(' + entry.prefix + ')';
        line.appendChild(prefix);
      }
      var href = explorerUrl(entry.address);
      var link = document.createElement('a');
      link.className = 'mono address-link';
      link.href = href || '#';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = entry.address;
      link.title = entry.address;
      line.appendChild(link);
      line.appendChild(copyButton(entry.address, 'Copy address'));
      cell.appendChild(line);
    });
  }

  /* The key cell keeps the server-rendered hex link and appends the two WIF
   * forms once the derivation report arrives (Bitcoin only). */
  function renderKeyCell(row, report) {
    var cell = row.querySelector('.col-key');
    if (!cell || !report || cell.querySelector('.key-wif')) return;
    keyModel(report).wifs.forEach(function (wif) {
      var line = document.createElement('span');
      line.className = 'key-wif';
      var prefix = document.createElement('span');
      prefix.className = 'key-wif-prefix';
      prefix.textContent = '(' + wif.prefix + ')';
      line.appendChild(prefix);
      var link = document.createElement('a');
      link.className = 'mono key-link';
      link.href = '/key/' + encodeURIComponent(wif.value);
      link.title = wif.value;
      link.textContent = wif.value;
      line.appendChild(link);
      line.appendChild(copyButton(wif.value, 'Copy WIF'));
      cell.appendChild(line);
    });
  }

  function addressMap(report) {
    var map = {};
    if (!report || !Array.isArray(report.addresses)) return map;
    report.addresses.forEach(function (entry) {
      if (entry && entry.id) map[entry.id] = entry.address || '';
    });
    return map;
  }

  function renderAddresses(type) {
    var field = fieldFor(type);
    rows.forEach(function (row) {
      var hex = row.getAttribute('data-key');
      var report = state.reports[hex];
      if (!report) return;
      var map = state.addressMaps[hex] || (state.addressMaps[hex] = addressMap(report));
      var entries = addressEntriesFor(config.chain, type, map, field);
      state.addressSets[hex] = entries;
      fillAddressCell(row, entries);
      renderKeyCell(row, report);
    });
  }

  function attachRowEvents() {
    rows.forEach(function (row) {
      var copy = row.querySelector('.copy-btn');
      if (copy) {
        copy.addEventListener('click', function () {
          copyText(row.getAttribute('data-key'), copy);
        });
      }
    });
  }

  function copyText(text, button) {
    function done() {
      if (!button) return;
      var use = button.querySelector('use');
      if (!button.getAttribute('data-icon')) {
        button.setAttribute('data-icon', use ? use.getAttribute('href') : '');
        button.setAttribute('data-label', button.getAttribute('aria-label') || 'Copy');
      }
      if (use) use.setAttribute('href', '/icons.svg#ui-check');
      button.classList.add('is-copied');
      button.setAttribute('aria-label', 'Copied');
      button.disabled = true;
      window.setTimeout(function () {
        if (use) use.setAttribute('href', button.getAttribute('data-icon') || '/icons.svg#ui-copy');
        button.classList.remove('is-copied');
        button.setAttribute('aria-label', button.getAttribute('data-label') || 'Copy');
        button.disabled = false;
      }, 1100);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else {
      fallback();
    }
    function fallback() {
      var area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch (err) { /* ignore */ }
      document.body.removeChild(area);
      done();
    }
  }

  /* -------------------------------------------------------------- balances */

  function coin(value, decimals) {
    var number = Number(value) / Math.pow(10, decimals);
    if (!isFinite(number)) return '0';
    if (number === 0) return '0';
    if (number < 0.00000001) return '<0.00000001';
    return number.toLocaleString('en-US', { maximumFractionDigits: decimals > 8 ? 6 : 8 });
  }

  function timeAgo(ms) {
    return cacheApi && typeof cacheApi.relativeTime === 'function'
      ? cacheApi.relativeTime(ms, Date.now())
      : '';
  }

  function setSummary(balance, received, tx, active) {
    if (totalBalance) totalBalance.textContent = balance;
    if (totalReceived) totalReceived.textContent = received;
    if (totalTx) totalTx.textContent = tx;
    if (totalActive) totalActive.textContent = active;
  }

  function providerMeta() {
    if (config.chain === 'bitcoin') return { provider: 'blockchain.info', chain: 'bitcoin', decimals: 8, symbol: 'BTC' };
    if (RPC[config.chain]) return { provider: 'evm', chain: config.chain, decimals: 18, symbol: config.symbol };
    if (config.chain === 'solana') return { provider: 'solana', chain: 'solana', decimals: 9, symbol: 'SOL' };
    if (config.chain === 'sui') return { provider: 'sui', chain: 'sui', decimals: 9, symbol: 'SUI' };
    if (config.chain === 'tron') return { provider: 'tronscan', chain: 'tron', decimals: 6, symbol: config.symbol || 'TRX' };
    if (config.chain === 'xrp') return { provider: 'xrpscan', chain: 'xrp', decimals: 6, symbol: 'XRP' };
    if (config.chain === 'ton') return { provider: 'toncenter', chain: 'ton', decimals: 9, symbol: 'TON' };
    /* LTC, DOGE, BCH and ZEC stay without a balance provider: Blockchair now
     * answers 430 without a key and litecoinspace 525, so the cells show "—"
     * (and each address keeps its explorer link) instead of a fake zero. */
    return null;
  }

  function uniqueAddresses(addresses) {
    var out = [];
    addresses.forEach(function (address) {
      if (!address) return;
      if (out.indexOf(address) < 0) out.push(address);
    });
    return out;
  }

  function balanceModel() {
    var meta = providerMeta();
    if (!meta) return { meta: null, records: [], groups: [] };
    var records = [];
    var groups = [];
    rows.forEach(function (row) {
      var set = state.addressSets[row.getAttribute('data-key')] || [];
      var group = { row: row, entries: [] };
      set.forEach(function (entry, index) {
        if (!entry.address) return;
        var record = {
          row: row,
          address: entry.address,
          primary: index === 0,
          key: cacheApi ? cacheApi.cacheKey(meta.provider, meta.chain, entry.address) : entry.address
        };
        group.entries.push(record);
        records.push(record);
      });
      if (group.entries.length) groups.push(group);
    });
    return { meta: meta, records: records, groups: groups };
  }

  async function cacheGet(key) {
    if (!cacheApi) return null;
    var store = await cacheStore;
    if (!store) return null;
    try { return await store.get(key); } catch (err) { return null; }
  }

  async function readCached(records) {
    var out = {};
    if (!cacheApi) return out;
    await Promise.all(records.map(async function (record) {
      if (!record.key) return;
      out[record.key] = await cacheGet(record.key);
    }));
    return out;
  }

  async function cachePut(key, entry) {
    if (!cacheApi) return;
    var store = await cacheStore;
    if (!store) return;
    try { await store.put(key, entry); } catch (err) { /* memory store fallback */ }
  }

  function retryForRow(row) {
    return function () { loadBalances({ manual: true, onlyRows: [row], force: true }); };
  }

  function retryButton(row) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button icon-button--quiet icon-button--lg';
    button.setAttribute('data-tooltip', 'Retry this balance');
    button.setAttribute('aria-label', 'Retry balance check for this address');
    button.appendChild(iconUse('ui-retry', 'icon'));
    button.addEventListener('click', retryForRow(row));
    return button;
  }

  async function fetchJson(url, options) {
    var response = await fetch(url, options);
    if (!response.ok) {
      var err = new Error('HTTP ' + response.status);
      err.status = response.status;
      throw err;
    }
    return response.json();
  }

  function retryOptions() {
    return { attempts: 2, baseDelay: 500, maxDelay: 4000 };
  }

  function requestJson(url, options) {
    if (!cacheApi) return fetchJson(url, options);
    return cacheApi.withRetry(function () { return fetchJson(url, options); }, retryOptions());
  }

  function errorMessage(err) {
    return err && err.message ? err.message : 'unavailable';
  }

  async function btcProvider(addresses) {
    var values = {};
    var errors = {};
    var unique = uniqueAddresses(addresses);
    if (!unique.length) return { values: values, errors: errors };
    var url = 'https://blockchain.info/balance?cors=true&active=' + unique.map(encodeURIComponent).join('|');
    var data = await requestJson(url);
    unique.forEach(function (address) {
      var info = data[address];
      if (!info) {
        errors[address] = 'Balance row missing from the provider.';
        return;
      }
      values[address] = {
        balance: String(info.final_balance || 0),
        received: String(info.total_received || 0),
        tx: Number(info.n_tx || 0)
      };
    });
    return { values: values, errors: errors };
  }

  async function evmProvider(addresses) {
    var values = {};
    var errors = {};
    var rpc = RPC[config.chain];
    if (!rpc) throw new Error('No RPC for this chain');
    var unique = uniqueAddresses(addresses);
    if (!unique.length) return { values: values, errors: errors };
    var payload = unique.map(function (address, index) {
      return { jsonrpc: '2.0', id: index + 1, method: 'eth_getBalance', params: [address, 'latest'] };
    });
    var list = await requestJson(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var byId = {};
    (Array.isArray(list) ? list : [list]).forEach(function (item) {
      if (item && item.id !== undefined) byId[item.id] = item;
    });
    unique.forEach(function (address, index) {
      var item = byId[index + 1];
      if (!item || typeof item.result !== 'string') {
        errors[address] = item && item.error && item.error.message
          ? item.error.message
          : 'unexpected response';
        return;
      }
      values[address] = { balance: BigInt(item.result).toString() };
    });
    /* Optional second batch: one eth_getTransactionCount per unique address.
     * It only feeds the "Active" summary counter, so any failure (network,
     * shape, non-string result) is ignored and never fails the balance load.
     * The nonce is not stored as `tx`: the donor does not render per-row tx
     * counts on EVM chains. */
    try {
      var noncePayload = unique.map(function (address, index) {
        return { jsonrpc: '2.0', id: index + 1, method: 'eth_getTransactionCount', params: [address, 'latest'] };
      });
      var nonceList = await requestJson(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(noncePayload)
      });
      var nonceById = {};
      (Array.isArray(nonceList) ? nonceList : [nonceList]).forEach(function (item) {
        if (item && item.id !== undefined) nonceById[item.id] = item;
      });
      unique.forEach(function (address, index) {
        var item = nonceById[index + 1];
        if (!item || typeof item.result !== 'string' || !values[address]) return;
        if (parseInt(item.result, 16) > 0) values[address].active = true;
      });
    } catch (err) {
      /* best effort: the Active counter simply stays without these marks */
    }
    return { values: values, errors: errors };
  }

  async function solanaProvider(addresses) {
    var values = {};
    var unique = uniqueAddresses(addresses);
    if (!unique.length) return { values: values, errors: {} };
    var body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getMultipleAccounts',
      params: [unique, { encoding: 'base64', commitment: 'confirmed' }]
    };
    var amounts = null;
    var lastError = null;
    for (var i = 0; i < SOLANA_RPC_URLS.length; i += 1) {
      try {
        var data = await requestJson(SOLANA_RPC_URLS[i], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        amounts = cacheApi && typeof cacheApi.parseSolanaAccounts === 'function'
          ? cacheApi.parseSolanaAccounts(data)
          : null;
        if (amounts) break;
        lastError = new Error('bad response');
      } catch (err) {
        lastError = err;
      }
    }
    if (!amounts) throw lastError || new Error('bad response');
    unique.forEach(function (address, index) {
      values[address] = { balance: amounts[index] || '0' };
    });
    return { values: values, errors: {} };
  }

  async function suiBalance(address) {
    /* Sui's public JSON-RPC fullnodes are deprecated; GraphQL serves the same
     * MIST total with CORS enabled. */
    var data = await fetchJson(SUI_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($a: SuiAddress!){address(address:$a){balance(coinType:"0x2::sui::SUI"){totalBalance}}}',
        variables: { a: address }
      })
    });
    var parsed = cacheApi && typeof cacheApi.parseSuiBalance === 'function'
      ? cacheApi.parseSuiBalance(data)
      : null;
    if (!parsed) throw new Error('unexpected response');
    return { balance: parsed.amount };
  }

  async function accountJson(url) {
    var response = await fetch(url);
    if (response.status === 404) return {};
    if (!response.ok) {
      var err = new Error('HTTP ' + response.status);
      err.status = response.status;
      throw err;
    }
    var text = await response.text();
    if (!text) return {};
    return JSON.parse(text);
  }

  async function perAddressProvider(addresses, fetcher) {
    var values = {};
    var errors = {};
    var unique = uniqueAddresses(addresses);
    var limit = cacheApi ? cacheApi.createLimiter(BALANCE_LIMIT) : function (task) { return task(); };
    await Promise.all(unique.map(function (address) {
      return limit(async function () {
        try {
          var task = function () { return fetcher(address); };
          var value = cacheApi ? await cacheApi.withRetry(task, retryOptions()) : await task();
          /* TRON returns balance + tx metadata; the other per-address
           * providers return a bare balance. */
          values[address] = value && typeof value === 'object'
            ? value
            : { balance: String(value) };
        } catch (err) {
          errors[address] = errorMessage(err);
        }
      });
    }));
    return { values: values, errors: errors };
  }

  function tonCenterBalance(address) {
    return fetchJson('https://toncenter.com/api/v2/getAddressBalance?address=' + encodeURIComponent(address))
      .then(function (data) {
        var parsed = cacheApi && typeof cacheApi.parseTonBalance === 'function'
          ? cacheApi.parseTonBalance(data)
          : null;
        if (!parsed) throw new Error('unexpected response');
        return parsed.amount;
      });
  }

  function tronBalanceDirect(address) {
    return accountJson('https://apilist.tronscanapi.com/api/account?address=' + encodeURIComponent(address))
      .then(function (data) { return { balance: String(Number(data.balance || 0)) }; });
  }

  /* The coordinator's TRON response, mapped to the per-address value shape
   * the cache and the balance cell already use. */
  function tronValue(data) {
    if (!data || typeof data !== 'object' || data.chain !== 'tron') return null;
    var balance = data.balance_sun === null || data.balance_sun === undefined
      ? null
      : String(data.balance_sun);
    return {
      balance: balance,
      tx: typeof data.tx_count === 'number' && isFinite(data.tx_count) ? data.tx_count : undefined,
      lastTxAt: typeof data.last_tx_at === 'number' && isFinite(data.last_tx_at) ? data.last_tx_at : undefined
    };
  }

  async function tronBalance(address) {
    /* Same-origin first; only a static host (404) or a coordinator without
     * the key (501) falls back to the previous direct TronScan request. */
    var response = await fetch('/api/v1/chain/tron/address?address=' + encodeURIComponent(address));
    if (response.status === 404 || response.status === 501) return tronBalanceDirect(address);
    if (!response.ok) {
      var err = new Error('HTTP ' + response.status);
      err.status = response.status;
      throw err;
    }
    var data = await response.json();
    var value = tronValue(data);
    if (!value) throw new Error('unexpected response');
    return value;
  }

  function tronChunks(addresses) {
    var chunks = [];
    for (var i = 0; i < addresses.length; i += TRON_BATCH_MAX) {
      chunks.push(addresses.slice(i, i + TRON_BATCH_MAX));
    }
    return chunks;
  }

  /* One batch request per 60 addresses. Returns null when the batch route is
   * absent (static host 404 / coordinator without a key 501) so the caller
   * can use the per-address path; per-address provider failures stay in the
   * results map. */
  async function tronBatchProvider(addresses) {
    var values = {};
    var errors = {};
    var unique = uniqueAddresses(addresses);
    if (!unique.length) return { values: values, errors: errors };
    var chunks = tronChunks(unique);
    for (var i = 0; i < chunks.length; i += 1) {
      var chunk = chunks[i];
      var response = await fetch('/api/v1/chain/tron/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: chunk })
      });
      if (response.status === 404 || response.status === 501) return null;
      if (!response.ok) {
        var message = 'HTTP ' + response.status;
        chunk.forEach(function (address) { errors[address] = message; });
        continue;
      }
      var data = null;
      try { data = await response.json(); } catch (err) { data = null; }
      var results = data && data.results ? data.results : null;
      if (!results) {
        chunk.forEach(function (address) { errors[address] = 'unexpected response'; });
        continue;
      }
      chunk.forEach(function (address) {
        var item = results[address];
        if (!item) {
          errors[address] = 'Balance row missing from the provider.';
          return;
        }
        if (item.error) {
          errors[address] = String(item.error);
          return;
        }
        var value = tronValue(item);
        if (!value) {
          errors[address] = 'unexpected response';
          return;
        }
        values[address] = value;
      });
    }
    return { values: values, errors: errors };
  }

  function xrpBalance(address) {
    return accountJson('https://api.xrpscan.com/api/v1/account/' + encodeURIComponent(address))
      .then(function (data) {
        /* 404 (unactivated account) comes back as {}: a real zero balance. */
        if (!data || typeof data !== 'object' || !Object.keys(data).length) return '0';
        var parsed = cacheApi && typeof cacheApi.parseXrpAccount === 'function'
          ? cacheApi.parseXrpAccount(data)
          : null;
        if (!parsed) throw new Error('unexpected response');
        return { balance: parsed.amount, tx: parsed.tx === null ? undefined : parsed.tx };
      });
  }

  function fetchProvider(meta, addresses) {
    if (meta.provider === 'blockchain.info') return btcProvider(addresses);
    if (meta.provider === 'evm') return evmProvider(addresses);
    if (meta.provider === 'solana') return solanaProvider(addresses);
    if (meta.provider === 'tronscan') {
      if (addresses.length > TRON_BATCH_THRESHOLD) {
        return tronBatchProvider(addresses).then(function (batch) {
          return batch || perAddressProvider(addresses, tronBalance);
        });
      }
      return perAddressProvider(addresses, tronBalance);
    }
    if (meta.provider === 'xrpscan') return perAddressProvider(addresses, xrpBalance);
    if (meta.provider === 'sui') return perAddressProvider(addresses, suiBalance);
    if (meta.provider === 'toncenter') return perAddressProvider(addresses, tonCenterBalance);
    return Promise.resolve({ values: {}, errors: {} });
  }

  /* One `.balance-info` line per address, each with the balance, TX count and
   * received amount, matching the donor's packed balance cell. */
  function balanceLine(group, entry, cached, errors, meta, now) {
    var line = document.createElement('div');
    line.className = 'balance-info';
    if (errors && errors[entry.address]) {
      line.classList.add('err');
      line.textContent = 'unavailable ';
      line.appendChild(retryButton(group.row));
      return { line: line, ok: false, failed: true };
    }
    var picked = cached[entry.key];
    if (!cacheApi || !cacheApi.isSuccess(picked)) {
      line.textContent = '-';
      return { line: line, ok: false, failed: false };
    }
    var value = picked.value || {};
    var balance = document.createElement('span');
    balance.className = 'bal';
    balance.textContent = coin(value.balance, meta.decimals) + ' ' + meta.symbol;
    line.appendChild(balance);
    if (value.tx !== undefined && value.tx !== null) {
      var flags = metricFlags(value);
      var tx = document.createElement('span');
      tx.className = 'tx' + (flags.hasTx ? ' has-tx' : '');
      tx.textContent = value.tx + ' tx';
      line.appendChild(tx);
    }
    if (value.received !== undefined && value.received !== null) {
      var recv = document.createElement('span');
      var recvFlags = metricFlags(value);
      recv.className = 'recv' + (recvFlags.hasRecv ? ' has-recv' : '');
      recv.textContent = '↓ ' + coin(value.received, meta.decimals) + ' ' + meta.symbol;
      line.appendChild(recv);
    }
    var lastAgo = value.lastTxAt !== undefined && value.lastTxAt !== null ? timeAgo(value.lastTxAt) : '';
    if (lastAgo) {
      var last = document.createElement('span');
      last.className = 'age';
      last.textContent = 'last ' + lastAgo;
      line.appendChild(last);
    }
    var age = document.createElement('span');
    age.className = 'balance-age';
    age.textContent = cacheApi ? cacheApi.ageLabel(picked, now) : '';
    if (age.textContent) line.appendChild(age);
    line.title = value.balance + ' ' + meta.symbol;
    return { line: line, ok: true, failed: false, positive: Number(value.balance) > 0 };
  }

  function renderGroup(group, cached, errors, meta, now) {
    var cell = group.row.querySelector('.col-balance');
    if (!cell) return;
    cell.textContent = '';
    var ok = false;
    var positive = false;
    var failed = false;
    var fresh = true;
    group.entries.forEach(function (entry) {
      var result = balanceLine(group, entry, cached, errors, meta, now);
      if (result.ok) ok = true;
      if (result.positive) positive = true;
      if (result.failed) failed = true;
      var picked = cached[entry.key];
      if (!cacheApi || !cacheApi.isFresh(picked, meta.provider, now)) fresh = false;
      cell.appendChild(result.line);
    });
    cell.classList.toggle('has-balance', positive);
    cell.title = '';
    group.row.dataset.balanceState = failed ? 'err' : ok ? (fresh ? 'ok' : 'stale') : 'missing';
    var first = group.entries.length ? cached[group.entries[0].key] : null;
    group.row.dataset.balanceAt = String(first && first.fetchedAt ? first.fetchedAt : '');
  }

  function renderSummary(model, cached, now) {
    if (!model.meta) return;
    var meta = model.meta;
    var big = meta.provider === 'evm' || meta.provider === 'solana';
    var sumBig = 0n;
    var sumNum = 0;
    var received = 0;
    var tx = 0;
    var active = 0;
    var any = false;
    var hasReceived = false;
    var hasTx = false;
    model.records.forEach(function (record) {
      var entry = cached[record.key];
      if (!cacheApi || !cacheApi.isSuccess(entry)) return;
      var value = entry.value || {};
      any = true;
      if (big) sumBig += BigInt(value.balance || 0);
      else sumNum += Number(value.balance || 0);
      if (value.received !== undefined) {
        received += Number(value.received);
        hasReceived = true;
      }
      if (value.tx !== undefined) {
        tx += Number(value.tx);
        hasTx = true;
      }
      /* The donor's "Active" counts addresses with any on-chain footprint. */
      active += (Number(value.balance) > 0 || value.active === true || Number(value.tx) > 0) ? 1 : 0;
    });
    if (!any) {
      setSummary('—', '—', '—', '—');
      return;
    }
    setSummary(
      coin(big ? sumBig : sumNum, meta.decimals) + ' ' + meta.symbol,
      hasReceived ? coin(received, meta.decimals) + ' ' + meta.symbol : '—',
      hasTx ? String(tx) : '—',
      String(active)
    );
  }

  function refreshPendingCount(model) {
    if (!model || !model.meta) return 0;
    var now = Date.now();
    var count = 0;
    model.groups.forEach(function (group) {
      if (group.row.dataset.balanceState === 'err') {
        count += 1;
        return;
      }
      var needs = group.entries.some(function (record) {
        if (!cacheApi) return true;
        return cacheApi.shouldRefresh(state.cached[record.key], model.meta.provider, now);
      });
      if (needs) count += 1;
    });
    return count;
  }

  function updateRefreshButton(model) {
    var count = refreshPendingCount(model);
    if (refreshCount) refreshCount.textContent = String(count);
    if (refreshButton) {
      refreshButton.disabled = !model || !model.meta || count === 0 || state.balanceBusy;
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

  function applyView(model, cached, errors) {
    var now = Date.now();
    model.groups.forEach(function (group) {
      renderGroup(group, cached, errors, model.meta, now);
    });
    renderSummary(model, cached, now);
    updateRefreshButton(model);
  }

  async function fetchAndApply(model, pending, run) {
    var addresses = [];
    pending.forEach(function (record) {
      if (addresses.indexOf(record.address) < 0) addresses.push(record.address);
    });
    if (!addresses.length) return;
    state.balanceBusy = true;
    pending.forEach(function (record) { record.row.dataset.balanceState = 'loading'; });
    updateRefreshButton(model);
    var result;
    try {
      result = await fetchProvider(model.meta, addresses);
    } catch (err) {
      result = { values: {}, errors: {} };
      addresses.forEach(function (address) { result.errors[address] = errorMessage(err); });
    }
    if (run !== state.balanceRun) {
      state.balanceBusy = false;
      return;
    }
    var now = Date.now();
    var entries = {};
    model.records.forEach(function (record) {
      if (!cacheApi || result.values[record.address] === undefined) return;
      var entry = cacheApi.makeEntry(result.values[record.address], model.meta.provider, now);
      state.cached[record.key] = entry;
      entries[record.key] = entry;
    });
    await Promise.all(Object.keys(entries).map(function (key) {
      return cachePut(key, entries[key]);
    }));
    state.balanceBusy = false;
    applyView(model, state.cached, result.errors);
    var failed = Object.keys(result.errors).length;
    setNote(
      failed
        ? 'Some balances could not be refreshed (' + failed + '); cached values stay visible.'
        : 'Balances loaded in your browser. Cached values can lag the chain.',
      failed ? 'err' : ''
    );
  }

  async function loadBalances(options) {
    var opts = options || {};
    var run = ++state.balanceRun;
    var model = balanceModel();
    if (!model.meta) {
      setSummary('—', '—', '—', '—');
      setNote('Live balance lookup is not available for ' + config.chain + ' on this page; each address links to its explorer.');
      updateRefreshButton(model);
      return;
    }
    if (!model.records.length) {
      setSummary('—', '—', '—', '—');
      setNote('No derived public address to send; nothing was sent.');
      updateRefreshButton(model);
      return;
    }
    var only = opts.onlyRows && opts.onlyRows.length ? opts.onlyRows : null;
    var ttl = cacheApi ? cacheApi.ttlFor(model.meta.provider) : 0;
    var cached = await readCached(model.records);
    if (run !== state.balanceRun) return;
    state.cached = cached;
    applyView(model, cached, null);
    var pending = model.records.filter(function (record) {
      if (only && only.indexOf(record.row) < 0) return false;
      if (opts.force) return true;
      if (!cacheApi) return true;
      return cacheApi.shouldRefresh(cached[record.key], ttl, Date.now());
    });
    updateRefreshButton(model);
    if (!pending.length) {
      setNote(opts.manual
        ? 'All selected balances are fresh; no request was sent.'
        : 'Balances loaded from the local cache; nothing was sent.');
      return;
    }
    if (!opts.manual) {
      var wait = cacheApi ? cacheApi.jitterDelay(BALANCE_JITTER_MS) : 0;
      await new Promise(function (resolve) { window.setTimeout(resolve, wait); });
      if (run !== state.balanceRun) return;
    }
    await fetchAndApply(model, pending, run);
  }

  function loadTon() {
    if (window.RotorTon) return Promise.resolve(window.RotorTon);
    if (state.tonPromise) return state.tonPromise;
    state.tonPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = window.RotorAssets.url('/ton.js');
      script.onload = function () {
        if (window.RotorTon) resolve(window.RotorTon);
        else reject(new Error('TON library did not load.'));
      };
      script.onerror = function () { reject(new Error('TON library did not load.')); };
      document.head.appendChild(script);
    });
    return state.tonPromise;
  }

  async function attachTonAddresses() {
    setNote('Building TON wallet addresses in your browser…');
    var ton = await loadTon();
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var hex = row.getAttribute('data-key');
      var report = state.reports[hex];
      if (!report || !report.ed_pubkey) continue;
      var map = state.addressMaps[hex] || (state.addressMaps[hex] = addressMap(report));
      try {
        map.ton = await ton.address(report.ed_pubkey);
      } catch (err) {
        map.ton = '';
      }
      if (i % 8 === 0) setNote('Building TON wallet addresses… ' + i + ' of ' + rows.length);
    }
  }

  /* --------------------------------------------------------------- search */

  /* `?key=` pre-fills the input and highlights a matching row; when the key
   * lives on another page it navigates to the page that contains it, as the
   * donor does. The donor normalises hex/WIF client-side, so the same
   * resolution runs here before the row lookup. */
  function highlightRow(hex) {
    var wanted = String(hex || '').toLowerCase();
    if (!wanted) return false;
    var found = false;
    rows.forEach(function (row) {
      if (String(row.getAttribute('data-key')).toLowerCase() !== wanted) return;
      found = true;
      row.classList.add('highlighted');
      if (row.scrollIntoView) {
        try { row.scrollIntoView({ block: 'center' }); } catch (err) { /* ignore */ }
      }
    });
    return found;
  }

  /* Navigate to the page holding `hex`, keeping the query so the destination
   * highlights the matching row. `replace` keeps the transient page-1 URL out
   * of history (Back does not bounce into the jump again); navigating only
   * when the target differs from the current page keeps the jump loop-free. */
  function jumpToKeyPage(hex) {
    if (!config.chain) return;
    var page = pageForHexKey(hex, config.pages);
    if (page === null) return;
    var current;
    try { current = BigInt(String(config.page)); } catch (err) { current = 1n; }
    if (page === current) return;
    var params = new URLSearchParams(window.location.search);
    if ((params.get('type') || 'legacy') === 'legacy') params.delete('type');
    var query = params.toString();
    var path = '/private-keys/' + encodeURIComponent(config.chain);
    if (page !== 1n) path += '/' + page.toString();
    window.location.replace(path + (query ? '?' + query : ''));
  }

  function prefillSearch() {
    var raw = new URLSearchParams(window.location.search).get('key');
    if (!raw || !searchInput) return;
    searchInput.value = raw;
    var direct = function () {
      if (highlightRow(raw)) return;
      jumpToKeyPage(raw);
    };
    if (!window.RotorSearch) {
      direct();
      return;
    }
    window.RotorSearch.resolve(raw, 'auto').then(function (hex) {
      if (highlightRow(hex)) return;
      jumpToKeyPage(hex);
    }, direct);
  }

  if (searchForm) {
    searchForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var raw = searchInput ? searchInput.value.trim() : '';
      if (!raw) return;
      var type = searchType ? searchType.value : config.type;
      var params = new URLSearchParams();
      params.set('key', raw);
      if (type && type !== 'legacy') params.set('type', type);
      window.location.assign('/private-keys/' + config.chain + '?' + params.toString());
    });
  }

  if (refreshButton) {
    refreshButton.addEventListener('click', function () {
      loadBalances({ manual: true });
    });
  }

  if (jumpForm) {
    jumpForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var digits = (pageInput.value || '').replace(/[^0-9]/g, '');
      if (!digits) return;
      var target = BigInt(digits);
      if (target < 1n) target = 1n;
      var total = BigInt(config.pages);
      if (target > total) target = total;
      var suffix = config.type && config.type !== 'legacy' ? '?type=' + encodeURIComponent(config.type) : '';
      window.location.href = (target === 1n
        ? '/private-keys/' + config.chain
        : '/private-keys/' + config.chain + '/' + target.toString()) + suffix;
    });
  }

  /* Address-type cards are full navigations, as in the donor: the page and
   * every other parameter are kept, only `type` changes. */
  function typeHref(type) {
    var params = new URLSearchParams(window.location.search);
    params.delete('key');
    if (type === 'legacy') params.delete('type');
    else params.set('type', type);
    var query = params.toString();
    return window.location.pathname + (query ? '?' + query : '');
  }

  if (typeButtons.length) {
    typeButtons.forEach(function (button) {
      if (button.getAttribute('data-type') === config.type) return;
      button.addEventListener('click', function () {
        var type = button.getAttribute('data-type');
        if (!type) return;
        window.location.assign(typeHref(type));
      });
    });
  }

  /* ---------------------------------------------------------------- boot */

  (async function boot() {
    Array.prototype.forEach.call(document.querySelectorAll('.pager-btn[aria-disabled="true"]'), function (link) {
      link.addEventListener('click', function (event) { event.preventDefault(); });
    });
    attachRowEvents();
    prefillSearch();
    setNote('Deriving ' + rows.length + ' addresses in your browser…');
    var wasm;
    try {
      wasm = await loadWasm();
    } catch (err) {
      setNote(err.message || 'The derivation core did not load.', 'err');
      rows.forEach(function (row) {
        var cell = row.querySelector('.col-address');
        if (cell) cell.textContent = 'Unavailable';
      });
      return;
    }
    var done = 0;
    for (var i = 0; i < rows.length; i += CHUNK) {
      var slice = rows.slice(i, i + CHUNK);
      slice.forEach(function (row) {
        var hex = row.getAttribute('data-key');
        try {
          state.reports[hex] = derive(wasm, hex);
        } catch (err) {
          state.reports[hex] = null;
        }
      });
      done += slice.length;
      setNote('Deriving ' + done + ' of ' + rows.length + ' addresses in your browser…');
      renderAddresses(config.type);
      if (i + CHUNK < rows.length) {
        await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
      }
    }
    if (config.chain === 'ton') {
      try {
        await attachTonAddresses();
      } catch (err) {
        setNote(err && err.message ? err.message : 'TON addresses are unavailable.', 'err');
      }
    }
    renderAddresses(config.type);
    rows.forEach(function (row) {
      var report = state.reports[row.getAttribute('data-key')];
      if (!report) {
        var cell = row.querySelector('.col-address');
        if (cell) cell.textContent = 'Invalid key for this curve';
      }
    });
    loadBalances();
  })();
})();
