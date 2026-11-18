/* Chain browser: derives every key on the page in the browser, fills the
 * addresses and checks public balances. No key is sent anywhere. */
(function () {
  'use strict';

  var WASM_URL = '/rotor_wasm.wasm';
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
      script: 'ltc_p2sh_p2wpkh'
    }
  };
  var FIELD_LABELS = {
    btc_p2pkh: 'Legacy P2PKH (compressed)',
    btc_p2pkh_uncompressed: 'Legacy P2PKH (uncompressed)',
    btc_p2sh_p2wpkh: 'Nested SegWit P2SH-P2WPKH',
    btc_p2wpkh: 'Native SegWit P2WPKH',
    btc_p2tr: 'Taproot P2TR',
    evm: 'EVM address',
    tron: 'TRON address',
    solana: 'Solana address',
    ltc_p2pkh: 'Litecoin legacy P2PKH',
    ltc_p2sh_p2wpkh: 'Litecoin P2SH-P2WPKH',
    ltc_p2wpkh: 'Litecoin native SegWit',
    doge_p2pkh: 'Dogecoin P2PKH',
    bch_legacy: 'Bitcoin Cash legacy P2PKH',
    xrp_classic: 'XRP classic address',
    zcash_p2pkh: 'Zcash transparent address',
    sui: 'Sui address'
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
  var BLOCKCHAIR = {
    litecoin: 'litecoin',
    dogecoin: 'dogecoin',
    'bitcoin-cash': 'bitcoin-cash',
    zcash: 'zcash'
  };

  var root = document.querySelector('.browse-page');
  if (!root) return;

  var config = {
    chain: root.getAttribute('data-chain') || 'bitcoin',
    symbol: root.getAttribute('data-symbol') || '',
    explorer: root.getAttribute('data-explorer') || '',
    type: root.getAttribute('data-type') || 'legacy',
    field: root.getAttribute('data-field') || '',
    curve: Number(root.getAttribute('data-curve') || '0'),
    pages: root.getAttribute('data-pages') || '1'
  };

  var state = {
    wasm: null,
    wasmPromise: null,
    reports: {},
    addressMaps: {},
    addressSets: {},
    addresses: {},
    balances: {},
    busy: false,
    generation: 0,
    balanceRun: 0
  };

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

  function fillAddressCell(row, entries) {
    var cell = row.querySelector('.col-address');
    if (!cell) return;
    cell.textContent = '';
    var list = Array.isArray(entries) ? entries : (entries ? [{ address: entries }] : []);
    if (!list.length) {
      var empty = document.createElement('span');
      empty.className = 'cell-skeleton';
      empty.textContent = 'Not available';
      cell.appendChild(empty);
      return;
    }
    list.forEach(function (entry) {
      if (!entry || !entry.address) return;
      var line = document.createElement('span');
      line.className = 'addr-line';
      if (entry.prefix) {
        var prefix = document.createElement('span');
        prefix.className = 'addr-prefix';
        prefix.textContent = entry.prefix;
        line.appendChild(prefix);
      }
      var link = document.createElement('a');
      link.className = 'mono address-link';
      link.href = explorerUrl(entry.address) || '#';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = entry.address;
      link.title = 'Open in explorer';
      line.appendChild(link);
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
      var entries = [];
      if (config.chain === 'bitcoin' && type === 'legacy') {
        if (map.btc_p2pkh) entries.push({ prefix: 'c', address: map.btc_p2pkh });
        if (map.btc_p2pkh_uncompressed) entries.push({ prefix: 'u', address: map.btc_p2pkh_uncompressed });
      } else if (map[field]) {
        entries.push({ address: map[field] });
      }
      state.addressSets[hex] = entries;
      state.addresses[hex] = entries.length ? entries[0].address : '';
      fillAddressCell(row, entries);
    });
  }

  function renderDetails(row, report) {
    var box = row.querySelector('.key-details');
    if (!box || !report) return;
    box.textContent = '';
    var map = state.addressMaps[row.getAttribute('data-key')] || addressMap(report);
    var fields = Object.keys(FIELD_LABELS).filter(function (field) {
      return map[field] && map[field] !== '';
    });
    fields.forEach(function (field) {
      var line = document.createElement('div');
      line.className = 'detail-line';
      var label = document.createElement('span');
      label.className = 'detail-label';
      label.textContent = FIELD_LABELS[field];
      var value = document.createElement('code');
      value.className = 'mono detail-value';
      value.textContent = map[field];
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-btn';
      copy.textContent = 'Copy';
      copy.addEventListener('click', function () { copyText(map[field], copy); });
      line.appendChild(label);
      line.appendChild(value);
      line.appendChild(copy);
      box.appendChild(line);
    });
    if (report.wif_compressed) {
      ['wif_compressed', 'wif_uncompressed'].forEach(function (field) {
        if (!report[field]) return;
        var line = document.createElement('div');
        line.className = 'detail-line';
        var label = document.createElement('span');
        label.className = 'detail-label';
        label.textContent = field === 'wif_compressed' ? 'WIF (compressed)' : 'WIF (uncompressed)';
        var value = document.createElement('code');
        value.className = 'mono detail-value';
        value.textContent = report[field];
        var copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'copy-btn';
        copy.textContent = 'Copy';
        copy.addEventListener('click', function () { copyText(report[field], copy); });
        line.appendChild(label);
        line.appendChild(value);
        line.appendChild(copy);
        box.appendChild(line);
      });
    }
  }

  function attachRowEvents() {
    rows.forEach(function (row) {
      var copy = row.querySelector('.copy-btn');
      if (copy) {
        copy.addEventListener('click', function () {
          copyText(row.getAttribute('data-key'), copy);
        });
      }
      var details = row.querySelector('.details-btn');
      if (details) {
        details.addEventListener('click', function () {
          var box = row.querySelector('.key-details');
          var open = details.getAttribute('aria-expanded') !== 'true';
          details.setAttribute('aria-expanded', open ? 'true' : 'false');
          details.classList.toggle('open', open);
          if (box) box.hidden = !open;
          if (open) renderDetails(row, state.reports[row.getAttribute('data-key')]);
        });
      }
    });
  }

  function copyText(text, button) {
    function done() {
      if (!button) return;
      var original = button.textContent;
      button.textContent = 'Copied';
      button.disabled = true;
      window.setTimeout(function () {
        button.textContent = original;
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

  function setSummary(balance, received, tx) {
    if (totalBalance) totalBalance.textContent = balance;
    if (totalReceived) totalReceived.textContent = received;
    if (totalTx) totalTx.textContent = tx;
  }

  function setRowBalance(row, text, raw) {
    var cell = row.querySelector('.col-balance');
    if (!cell) return;
    cell.textContent = text;
    if (raw !== undefined) cell.title = raw;
    cell.classList.toggle('has-balance', text !== '—' && text !== '0');
  }

  async function fetchJson(url, options) {
    var response = await fetch(url, options);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }

  async function btcBalances(run) {
    var unique = [];
    rows.forEach(function (row) {
      var set = state.addressSets[row.getAttribute('data-key')] || [];
      set.forEach(function (entry) {
        if (entry.address && unique.indexOf(entry.address) < 0) unique.push(entry.address);
      });
    });
    if (!unique.length) return;
    var url = 'https://blockchain.info/balance?cors=true&active=' + unique.map(encodeURIComponent).join('|');
    var data = await fetchJson(url);
    if (run !== state.balanceRun) return;
    var sum = 0;
    var received = 0;
    var tx = 0;
    rows.forEach(function (row) {
      var set = state.addressSets[row.getAttribute('data-key')] || [];
      var cell = row.querySelector('.col-balance');
      if (!cell) return;
      cell.textContent = '';
      var rowBalance = 0;
      set.forEach(function (entry) {
        var info = data[entry.address];
        if (!info) return;
        sum += Number(info.final_balance || 0);
        received += Number(info.total_received || 0);
        tx += Number(info.n_tx || 0);
        rowBalance += Number(info.final_balance || 0);
        var line = document.createElement('span');
        line.className = 'bal-line';
        if (entry.prefix) {
          var prefix = document.createElement('span');
          prefix.className = 'addr-prefix';
          prefix.textContent = entry.prefix;
          line.appendChild(prefix);
        }
        var value = document.createElement('span');
        value.textContent = coin(info.final_balance, 8) + ' BTC';
        var sub = document.createElement('small');
        sub.textContent = Number(info.n_tx || 0) + ' tx';
        line.appendChild(value);
        line.appendChild(sub);
        cell.appendChild(line);
      });
      cell.classList.toggle('has-balance', rowBalance > 0);
      cell.title = 'Current balance, transaction count';
    });
    setSummary(coin(sum, 8) + ' BTC', coin(received, 8) + ' BTC', String(tx));
  }

  async function evmBalances(addresses, run) {
    var rpc = RPC[config.chain];
    if (!rpc) throw new Error('No RPC for this chain');
    var unique = Array.from(new Set(addresses.filter(Boolean)));
    var payload = unique.map(function (address, index) {
      return { jsonrpc: '2.0', id: index + 1, method: 'eth_getBalance', params: [address, 'latest'] };
    });
    var response = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var list = await response.json();
    if (run !== state.balanceRun) return;
    var byAddress = {};
    (Array.isArray(list) ? list : []).forEach(function (item) {
      var address = unique[item.id - 1];
      if (!address) return;
      byAddress[address] = BigInt(item.result || '0x0');
    });
    var sum = 0n;
    rows.forEach(function (row) {
      var address = state.addresses[row.getAttribute('data-key')];
      var value = byAddress[address];
      if (value === undefined) return;
      sum += value;
      setRowBalance(row, coin(value, 18) + ' ' + config.symbol, value.toString() + ' wei');
    });
    setSummary(coin(sum, 18) + ' ' + config.symbol, '—', '—');
  }

  async function solBalances(addresses, run) {
    var unique = Array.from(new Set(addresses.filter(Boolean)));
    if (!unique.length) return;
    var body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getMultipleAccounts',
      params: [unique, { encoding: 'base64', commitment: 'confirmed' }]
    };
    var data = await fetchJson('https://solana-rpc.publicnode.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!data.result || !Array.isArray(data.result.value)) throw new Error('bad response');
    if (run !== state.balanceRun) return;
    var byAddress = {};
    data.result.value.forEach(function (item, index) {
      if (item) byAddress[unique[index]] = BigInt(item.lamports || 0);
    });
    var sum = 0n;
    rows.forEach(function (row) {
      var address = state.addresses[row.getAttribute('data-key')];
      var value = byAddress[address];
      if (value === undefined) return;
      sum += value;
      setRowBalance(row, coin(value, 9) + ' SOL', value.toString() + ' lamports');
    });
    setSummary(coin(sum, 9) + ' SOL', '—', '—');
  }

  async function blockchairBalances(addresses, run) {
    var network = BLOCKCHAIR[config.chain];
    if (!network) throw new Error('No provider for this chain');
    var unique = Array.from(new Set(addresses.filter(Boolean)));
    var url = 'https://api.blockchair.com/' + network + '/dashboards/addresses/' +
      unique.map(encodeURIComponent).join(',');
    var data = await fetchJson(url);
    if (run !== state.balanceRun) return;
    var sum = 0;
    var received = 0;
    var tx = 0;
    rows.forEach(function (row) {
      var address = state.addresses[row.getAttribute('data-key')];
      var entry = data.data && data.data[address] ? data.data[address].address : null;
      if (!entry) return;
      sum += Number(entry.balance || 0);
      received += Number(entry.received || 0);
      tx += Number(entry.transaction_count || 0);
      setRowBalance(row, coin(entry.balance, 8) + ' ' + config.symbol, entry.balance + ' sat');
    });
    setSummary(coin(sum, 8) + ' ' + config.symbol, coin(received, 8) + ' ' + config.symbol, String(tx));
  }

  async function ltcBalances(addresses, run) {
    var unique = Array.from(new Set(addresses.filter(Boolean)));
    var byAddress = {};
    var failures = 0;
    for (var i = 0; i < unique.length; i += 5) {
      var slice = unique.slice(i, i + 5);
      await Promise.all(slice.map(async function (address) {
        try {
          byAddress[address] = await fetchJson('https://litecoinspace.org/api/address/' + encodeURIComponent(address));
        } catch (err) {
          failures += 1;
        }
      }));
      if (i + 5 < unique.length) await new Promise(function (resolve) { window.setTimeout(resolve, 100); });
    }
    if (run !== state.balanceRun) return;
    var sum = 0;
    var received = 0;
    var tx = 0;
    rows.forEach(function (row) {
      var address = state.addresses[row.getAttribute('data-key')];
      var info = byAddress[address];
      if (!info) return;
      var chain = info.chain_stats || {};
      var mempool = info.mempool_stats || {};
      var balance = (Number(chain.funded_txo_sum || 0) - Number(chain.spent_txo_sum || 0)) +
        (Number(mempool.funded_txo_sum || 0) - Number(mempool.spent_txo_sum || 0));
      var funded = Number(chain.funded_txo_sum || 0) + Number(mempool.funded_txo_sum || 0);
      var count = Number(chain.tx_count || 0) + Number(mempool.tx_count || 0);
      sum += balance;
      received += funded;
      tx += count;
      setRowBalance(row, coin(balance, 8) + ' LTC', count + ' tx');
    });
    setSummary(coin(sum, 8) + ' LTC', coin(received, 8) + ' LTC', String(tx));
    if (failures) setNote('Balances loaded for ' + (unique.length - failures) + ' of ' + unique.length + ' Litecoin addresses.', 'err');
  }

  async function bchBalances(addresses, run) {
    var unique = Array.from(new Set(addresses.filter(Boolean)));
    if (!unique.length) return;
    var url = 'https://api.haskoin.com/bch/address/balances?addresses=' + unique.map(encodeURIComponent).join(',');
    var data = await fetchJson(url);
    if (run !== state.balanceRun) return;
    var byAddress = {};
    (Array.isArray(data) ? data : []).forEach(function (entry, index) {
      if (entry && unique[index]) byAddress[unique[index]] = entry;
    });
    var sum = 0;
    var received = 0;
    var tx = 0;
    rows.forEach(function (row) {
      var address = state.addresses[row.getAttribute('data-key')];
      var info = byAddress[address];
      if (!info) return;
      var balance = Number(info.confirmed || 0) + Number(info.unconfirmed || 0);
      sum += balance;
      received += Number(info.received || 0);
      tx += Number(info.txs || 0);
      setRowBalance(row, coin(balance, 8) + ' BCH', balance + ' sat');
    });
    setSummary(coin(sum, 8) + ' BCH', coin(received, 8) + ' BCH', String(tx));
  }

  async function perAddressBalances(addresses, fetcher, decimals, run) {
    var unique = Array.from(new Set(addresses.filter(Boolean)));
    var byAddress = {};
    var failures = 0;
    for (var i = 0; i < unique.length; i += 5) {
      var slice = unique.slice(i, i + 5);
      await Promise.all(slice.map(async function (address) {
        try {
          byAddress[address] = await fetcher(address);
        } catch (err) {
          failures += 1;
        }
      }));
      if (i + 5 < unique.length) await new Promise(function (resolve) { window.setTimeout(resolve, 120); });
    }
    if (run !== state.balanceRun) return failures;
    var sum = 0;
    rows.forEach(function (row) {
      var address = state.addresses[row.getAttribute('data-key')];
      var value = byAddress[address];
      if (value === undefined || value === null) return;
      sum += Number(value);
      setRowBalance(row, coin(value, decimals) + ' ' + config.symbol, String(value));
    });
    setSummary(coin(sum, decimals) + ' ' + config.symbol, '—', '—');
    return failures;
  }

  async function accountJson(url) {
    var response = await fetch(url);
    if (response.status === 404) return {};
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var text = await response.text();
    if (!text) return {};
    return JSON.parse(text);
  }

  function tronBalance(address) {
    return accountJson('https://apilist.tronscanapi.com/api/account?address=' + encodeURIComponent(address))
      .then(function (data) { return Number(data.balance || 0); });
  }

  function xrpBalance(address) {
    return accountJson('https://api.xrpscan.com/api/v1/account/' + encodeURIComponent(address))
      .then(function (data) { return Number(data.Balance || 0); });
  }

  async function loadBalances() {
    var run = ++state.balanceRun;
    var addresses = Object.keys(state.addresses).map(function (hex) { return state.addresses[hex]; });
    if (!addresses.length) return;
    setNote('Checking balances in your browser…');
    try {
      if (config.chain === 'bitcoin') await btcBalances(run);
      else if (config.chain === 'solana') await solBalances(addresses, run);
      else if (RPC[config.chain]) await evmBalances(addresses, run);
      else if (config.chain === 'bitcoin-cash') await bchBalances(addresses, run);
      else if (config.chain === 'litecoin') await ltcBalances(addresses, run);
      else if (BLOCKCHAIR[config.chain]) await blockchairBalances(addresses, run);
      else if (config.chain === 'tron') {
        var tronFailures = await perAddressBalances(addresses, tronBalance, 6, run);
        if (tronFailures) throw new Error('some TRON lookups failed');
      } else if (config.chain === 'xrp') {
        var xrpFailures = await perAddressBalances(addresses, xrpBalance, 6, run);
        if (xrpFailures) throw new Error('some XRP lookups failed');
      } else {
        setSummary('—', '—', '—');
        setNote('Live balance lookup is not available for ' + config.chain + ' on this page; each address links to its explorer.');
        return;
      }
      if (run !== state.balanceRun) return;
      setNote('Balances loaded in your browser from public providers. They can lag the chain.');
    } catch (err) {
      if (run !== state.balanceRun) return;
      setNote('Balance lookup is unavailable right now. The addresses are still derived locally.', 'err');
    }
  }

  /* --------------------------------------------------------------- search */

  async function resolveSearch(text) {
    if (!window.RotorSearch) throw new Error('Search is still loading.');
    return window.RotorSearch.resolve(text);
  }

  if (searchForm) {
    searchForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      var button = searchForm.querySelector('button[type=submit]');
      try {
        var type = searchType ? searchType.value : config.type;
        var hex = await resolveSearch(searchInput.value, type);
        var query = [];
        if (config.curve === 1) query.push('curve=ed25519');
        if (type && type !== 'legacy') query.push('type=' + encodeURIComponent(type));
        window.location.href = '/key/' + hex + (query.length ? '?' + query.join('&') : '');
      } catch (err) {
        setNote(err && err.message ? err.message : 'Cannot read that key.', 'err');
        if (searchInput) searchInput.focus();
      } finally {
        if (button) button.disabled = false;
      }
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

  if (typeButtons.length) {
    typeButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        var type = button.getAttribute('data-type');
        if (!type || type === config.type) return;
        config.type = type;
        config.field = fieldFor(type);
        typeButtons.forEach(function (other) {
          other.classList.toggle('active', other === button);
        });
        if (searchType) searchType.value = type;
        try {
          var url = new URL(window.location.href);
          if (type === 'legacy') url.searchParams.delete('type');
          else url.searchParams.set('type', type);
          window.history.replaceState(null, '', url.toString());
        } catch (err) { /* ignore */ }
        document.querySelectorAll('.pager-btn[href]').forEach(function (link) {
          try {
            var pager = new URL(link.href);
            if (type === 'legacy') pager.searchParams.delete('type');
            else pager.searchParams.set('type', type);
            link.href = pager.toString();
          } catch (err) { /* ignore */ }
        });
        state.balances = {};
        renderAddresses(type);
        loadBalances();
      });
    });
  }

  /* ---------------------------------------------------------------- boot */

  (async function boot() {
    Array.prototype.forEach.call(document.querySelectorAll('.pager-btn[aria-disabled="true"]'), function (link) {
      link.addEventListener('click', function (event) { event.preventDefault(); });
    });
    attachRowEvents();
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
    renderAddresses(config.type);
    rows.forEach(function (row) {
      var report = state.reports[row.getAttribute('data-key')];
      if (!report) {
        var cell = row.querySelector('.col-address');
        if (cell) cell.textContent = 'Invalid key for this curve';
      }
    });
    await loadBalances();
  })();
})();
