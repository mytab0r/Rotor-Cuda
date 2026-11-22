/* Brainwallet directory: enumerate deterministic two-word passphrases, hash
 * each one locally, derive the chain address with the shared wasm report and
 * (optionally) check public balances. This page never stores keys and sends
 * nothing but public addresses, and it puts no key in its own URL. Its key
 * cell follows the donor, though: a HEX/WIF link opens /key/<key>, which does
 * place that key in the browser URL and history. */
(function () {
  'use strict';

  /* Public providers come from data/providers.json through the generated
   * globals in chains.generated.js (loaded before this script). */
  var SSOT_ROOT = typeof window !== 'undefined' ? window : globalThis;
  var SSOT_PROVIDERS = SSOT_ROOT.RotorProviders;
  var AMOUNT = SSOT_ROOT.RotorAmount;

  var engine = window.RotorBrainwallet;
  var WASM_URL = typeof window !== 'undefined' && window.RotorAssets
    ? window.RotorAssets.url('/rotor_wasm.wasm')
    : '/rotor_wasm.wasm';
  var root = document.querySelector('.brainwallet-directory');
  if (!root || !engine) return;

  var byId = function (id) { return document.getElementById(id); };
  var slug = root.getAttribute('data-chain') || '';
  var chain = engine.chainConfig(slug);
  if (!chain) return;

  var rowsEl = byId('brainwallet-rows');
  var errorBox = byId('brainwallet-error');
  var noteText = byId('brainwallet-note-text');
  var balanceToggle = byId('brainwallet-balance-toggle');
  var deriveText = byId('brainwallet-derive-text');
  var deriveBar = byId('brainwallet-derive-bar');
  var deriveProgress = byId('brainwallet-derive-progress');
  var pageNumberEl = byId('brainwallet-page-number');
  var totalPagesEl = byId('brainwallet-total-pages');
  var totalCountEl = byId('brainwallet-total-count');
  var pagePercentEl = byId('brainwallet-page-percent');
  var pageBar = byId('brainwallet-page-bar');
  var pageProgress = byId('brainwallet-page-progress');
  var pageInput = byId('brainwallet-page-input');
  var typeButtons = Array.prototype.slice.call(document.querySelectorAll('.bw-type-btn'));

  var state = {
    disposed: false,
    wasmPromise: null,
    tonPromise: null,
    entries: [],
    run: 0,
    balanceRun: 0,
    type: root.getAttribute('data-type') || 'legacy',
    page: engine.clampPage(root.getAttribute('data-page') || '1')
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

  function formatCount(value) {
    var text = String(value);
    if (text.length <= 3) return text;
    return Number(value).toLocaleString('en-US');
  }

  /* --------------------------------------------------------------- wasm */

  function loadWasm() {
    if (state.wasmPromise) return state.wasmPromise;
    state.wasmPromise = (async function () {
      if (typeof WebAssembly === 'undefined') {
        throw new Error('WebAssembly is unavailable in this browser.');
      }
      var response = await fetch(WASM_URL);
      if (!response.ok) throw new Error('Cannot load ' + WASM_URL + ': HTTP ' + response.status);
      var module;
      try {
        module = await WebAssembly.instantiateStreaming(response.clone(), {});
      } catch (err) {
        module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      }
      var wasm = module.instance ? module.instance.exports : module.exports;
      if (typeof wasm.derive_report !== 'function' || typeof wasm.alloc !== 'function') {
        throw new Error('This build of ' + WASM_URL + ' has no derivation exports.');
      }
      return wasm;
    })();
    state.wasmPromise.catch(function () { state.wasmPromise = null; });
    return state.wasmPromise;
  }

  /* TON addresses are built from the ed25519 public key by the existing
   * RotorTon bundle. It is fetched only when a TON page needs it. */
  function ensureTon() {
    if (window.RotorTon) return Promise.resolve(window.RotorTon);
    if (state.tonPromise) return state.tonPromise;
    state.tonPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = window.RotorAssets.url('/ton.js');
      script.async = true;
      script.onload = function () {
        if (window.RotorTon) resolve(window.RotorTon);
        else reject(new Error('The TON bundle did not load.'));
      };
      script.onerror = function () { reject(new Error('Cannot load /ton.js.')); };
      document.head.appendChild(script);
    });
    state.tonPromise.catch(function () { state.tonPromise = null; });
    return state.tonPromise;
  }

  /* ----------------------------------------------------------- rendering */

  function pageHref(value) {
    return engine.pagePath(slug, value);
  }

  function renderPageInfo() {
    var total = engine.totalPages();
    var page = state.page;
    if (pageNumberEl) pageNumberEl.textContent = '#' + page.toString();
    if (totalPagesEl) totalPagesEl.textContent = '#' + total.toString();
    if (totalCountEl) totalCountEl.textContent = formatCount(engine.corpusSize());
    var percent = Number(page) / Number(total) * 100;
    var text = percent.toFixed(4) + '%';
    if (pagePercentEl) pagePercentEl.textContent = text;
    if (pageBar) pageBar.style.width = text;
    if (pageProgress) pageProgress.setAttribute('aria-valuenow', percent.toFixed(2));
    if (pageInput) pageInput.value = page.toString();
  }

  function setPager(link, href, disabled) {
    if (!link) return;
    link.setAttribute('href', href);
    link.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  function renderPagers() {
    var page = state.page;
    var total = engine.totalPages();
    var previousPage = page > 1n ? page - 1n : 1n;
    var nextPage = page < total ? page + 1n : page;
    Array.prototype.forEach.call(document.querySelectorAll('[data-bw-first]'), function (link) {
      setPager(link, pageHref(1n), page <= 1n);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-bw-prev]'), function (link) {
      setPager(link, pageHref(previousPage), page <= 1n);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-bw-next]'), function (link) {
      setPager(link, pageHref(nextPage), page >= total);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-bw-last]'), function (link) {
      setPager(link, pageHref(total), page >= total);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-bw-random]'), function (link) {
      var target = randomPage(total);
      setPager(link, pageHref(target), false);
    });
  }

  function randomPage(total) {
    var sample = new Uint8Array(32);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(sample);
      var value = BigInt('0x' + engine.bytesToHex(sample)) % total + 1n;
      return value;
    }
    return 1n;
  }

  function icon(name, className) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className || 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/icons.svg#' + name);
    svg.appendChild(use);
    return svg;
  }

  function copyText(text, button) {
    function flash() {
      button.classList.add('is-copied');
      button.setAttribute('aria-live', 'polite');
      window.setTimeout(function () { button.classList.remove('is-copied'); }, 1200);
    }
    function fallback() {
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
      flash();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash, fallback);
    } else {
      fallback();
    }
  }

  function copyButton(value, label) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button icon-button--quiet icon-button--lg bw-copy';
    button.setAttribute('data-tooltip', 'Copy ' + label);
    button.setAttribute('aria-label', 'Copy ' + label);
    button.dataset.copy = value || '';
    button.appendChild(icon('ui-copy'));
    button.addEventListener('click', function () {
      var text = button.dataset.copy || '';
      if (text) copyText(text, button);
    });
    return button;
  }

  function cell(className) {
    var div = document.createElement('div');
    div.className = 'bw-cell ' + className;
    return div;
  }

  function createRow(entry) {
    var row = document.createElement('div');
    row.className = 'bw-row';
    row.setAttribute('data-index', String(entry.index));

    var keyCell = cell('bw-key');
    var keyLine = document.createElement('div');
    keyLine.className = 'bw-line bw-key-line';
    var keyLink = document.createElement('a');
    keyLink.className = 'mono bw-key-value bw-key-link';
    keyLink.textContent = 'Hashing…';
    keyLine.appendChild(keyLink);
    keyLine.appendChild(copyButton('', 'private key'));
    keyCell.appendChild(keyLine);

    var keyWifLine = document.createElement('div');
    keyWifLine.className = 'bw-line bw-key-wif-line';
    keyCell.appendChild(keyWifLine);

    var phraseLine = document.createElement('div');
    phraseLine.className = 'bw-line bw-phrase-line';
    var phraseCode = document.createElement('code');
    phraseCode.className = 'mono bw-phrase-value';
    phraseCode.textContent = entry.phrase;
    phraseLine.appendChild(phraseCode);
    phraseLine.appendChild(copyButton(entry.phrase, 'passphrase'));
    keyCell.appendChild(phraseLine);

    var addressCell = cell('bw-address');
    var addressLine = document.createElement('div');
    addressLine.className = 'bw-line bw-address-line';
    var pending = document.createElement('span');
    pending.className = 'cell-skeleton';
    pending.textContent = 'Calculating…';
    addressLine.appendChild(pending);
    addressCell.appendChild(addressLine);

    var balanceCell = cell('bw-balance');
    var badge = document.createElement('span');
    badge.className = 'bw-badge';
    badge.dataset.state = 'pending';
    badge.textContent = 'pending';
    var value = document.createElement('span');
    value.className = 'bw-balance-value';
    value.textContent = '—';
    balanceCell.appendChild(badge);
    balanceCell.appendChild(value);

    row.appendChild(keyCell);
    row.appendChild(addressCell);
    row.appendChild(balanceCell);

    rowsEl.appendChild(row);

    entry.row = row;
    entry.keyLink = keyLink;
    entry.keyWifLine = keyWifLine;
    entry.keyButton = keyLine.querySelector('.bw-copy');
    entry.phraseButton = phraseLine.querySelector('.bw-copy');
    entry.addressLine = addressLine;
    entry.addressCell = addressCell;
    entry.balanceCell = balanceCell;
    entry.balanceBadge = badge;
    entry.balanceValue = value;
  }

  function setBadge(entry, state, label) {
    entry.balanceBadge.dataset.state = state;
    entry.balanceBadge.textContent = label;
  }

  /* The derivation report encodes every WIF with the Bitcoin version (0x80),
   * correct for BTC/BCH. Litecoin (0xb0) and Dogecoin (0x9e) need their own
   * encoding, so the page re-encodes the same 32-byte key via key-tools.js. */
  var WIF_NETWORKS = { litecoin: 'litecoin', dogecoin: 'dogecoin' };

  async function doubleSha256(bytes) {
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle) throw new Error('The WIF checksum needs a secure context (https or localhost).');
    var first = new Uint8Array(await subtle.digest('SHA-256', bytes));
    return new Uint8Array(await subtle.digest('SHA-256', first));
  }

  async function wifsFor(report) {
    if (!chain.wif || !report) return null;
    var network = WIF_NETWORKS[slug];
    if (!network) {
      return {
        compressed: report.wif_compressed || '',
        uncompressed: report.wif_uncompressed || ''
      };
    }
    var tools = window.RotorKeyTools;
    if (!tools || typeof tools.wifEncode !== 'function' || typeof tools.hexToBytes !== 'function') {
      return null;
    }
    try {
      var keyBytes = tools.hexToBytes(report.priv_hex);
      return {
        compressed: await tools.wifEncode(keyBytes, network, doubleSha256, true),
        uncompressed: await tools.wifEncode(keyBytes, network, doubleSha256, false)
      };
    } catch (err) {
      return null;
    }
  }

  /* The chain page never stores keys, but the donor's key cell links the hex
   * key and (on UTXO chains) both network-correct WIFs to /key/<key>, so a
   * click does put the key in the browser URL bar and history. */
  async function fillKey(entry) {
    var links = engine.keyLinksFor(entry.keyHex, await wifsFor(entry.report));
    entry.keyLink.textContent = entry.keyHex;
    entry.keyLink.href = links[0].href;
    entry.keyWifLine.textContent = '';
    links.slice(1).forEach(function (item) {
      var link = document.createElement('a');
      link.className = 'mono bw-key-wif';
      link.href = item.href;
      link.textContent = item.label;
      entry.keyWifLine.appendChild(link);
    });
    entry.keyButton.setAttribute('data-tooltip', 'Copy SHA-256 private key');
    entry.keyButton.setAttribute('aria-label', 'Copy SHA-256 private key');
    entry.keyButton.dataset.copy = entry.keyHex;
  }

  /* Error/placeholder state: drop the link and any WIF links so a stale
   * /key/<key> target is never left behind. */
  function clearKeyLinks(entry) {
    entry.keyLink.textContent = '—';
    entry.keyLink.removeAttribute('href');
    entry.keyWifLine.textContent = '';
  }

  function fillAddress(entry) {
    entry.addressLine.textContent = '';
    if (!entry.address) {
      var missing = document.createElement('span');
      missing.className = 'bw-missing';
      missing.textContent = entry.ton
        ? 'TON address needs the wallet bundle; reload the page.'
        : 'Address unavailable for this chain.';
      entry.addressLine.appendChild(missing);
      return;
    }
    var link = document.createElement('a');
    link.className = 'mono address-link bw-address-link';
    link.href = engine.explorerFor(slug, entry.address) || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = entry.address;
    link.title = entry.address;
    entry.addressLine.appendChild(link);

    var explorer = document.createElement('a');
    explorer.className = 'icon-button icon-button--quiet icon-button--lg';
    explorer.href = link.href;
    explorer.target = '_blank';
    explorer.rel = 'noopener noreferrer';
    explorer.setAttribute('data-tooltip', 'Open in explorer');
    explorer.setAttribute('aria-label', 'Open ' + entry.address + ' in an external explorer');
    explorer.appendChild(icon('ui-external', 'icon'));
    entry.addressLine.appendChild(explorer);

    entry.addressLine.appendChild(copyButton(entry.address, 'address'));
    setBadge(entry, 'derived', 'derived');
  }

  function fillRowError(entry, err) {
    clearKeyLinks(entry);
    entry.addressLine.textContent = err && err.message ? err.message : 'Derivation failed.';
    entry.addressLine.classList.add('bw-row-error');
    setBadge(entry, 'error', 'error');
  }

  function setDeriveProgress(done, total, phase) {
    var percent = total ? Math.round((done / total) * 100) : 0;
    if (deriveBar) deriveBar.style.width = percent + '%';
    if (deriveProgress) deriveProgress.setAttribute('aria-valuenow', String(percent));
    if (deriveText) deriveText.textContent = phase + ' ' + done + ' of ' + total + '…';
  }

  /* ------------------------------------------------------------ balances */

  function setBalance(entry, text, raw, state) {
    entry.balanceValue.textContent = text;
    if (raw !== undefined) entry.balanceValue.title = raw;
    entry.balanceValue.classList.toggle(
      'has-balance',
      text !== '—' && text !== '0' && text !== '0 ' + chain.symbol
    );
    if (state) setBadge(entry, state, state === 'active' ? 'funded' : state);
  }

  function setSummary(balance, active, received, tx) {
    var balanceEl = byId('brainwallet-total-balance');
    var activeEl = byId('brainwallet-total-active');
    var receivedEl = byId('brainwallet-total-received');
    var txEl = byId('brainwallet-total-tx');
    if (balanceEl) balanceEl.textContent = balance;
    if (activeEl) activeEl.textContent = active;
    if (receivedEl) receivedEl.textContent = received;
    if (txEl) txEl.textContent = tx;
  }

  function clearBalances() {
    state.entries.forEach(function (entry) {
      entry.balanceValue.textContent = '—';
      entry.balanceValue.classList.remove('has-balance');
      entry.balanceValue.removeAttribute('title');
      setBadge(entry, 'pending', 'pending');
    });
    setSummary('—', '—', '—', '—');
  }

  async function fetchJson(url, options) {
    var response = await fetch(url, options);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }

  async function btcBalances(run) {
    var addresses = state.entries.map(function (entry) { return entry.address; }).filter(Boolean);
    if (!addresses.length) return;
    var url = SSOT_PROVIDERS.find('bitcoin', 'blockchain-info').url +
      addresses.map(encodeURIComponent).join('|');
    var data = await fetchJson(url);
    if (run !== state.balanceRun || state.disposed) return;
    var sum = 0;
    var received = 0;
    var tx = 0;
    var active = 0;
    state.entries.forEach(function (entry) {
      var info = data[entry.address];
      if (!info) return;
      var balance = Number(info.final_balance || 0);
      sum += balance;
      received += Number(info.total_received || 0);
      tx += Number(info.n_tx || 0);
      if (balance > 0) active += 1;
      setBalance(entry, AMOUNT.coin(balance, 8) + ' BTC', Number(info.n_tx || 0) + ' tx', balance > 0 ? 'active' : 'empty');
    });
    setSummary(AMOUNT.coin(sum, 8) + ' BTC', String(active), AMOUNT.coin(received, 8) + ' BTC', String(tx));
  }

  async function evmBatch(addresses) {
    var payload = [];
    addresses.forEach(function (address, index) {
      payload.push({ jsonrpc: '2.0', id: index * 2 + 1, method: 'eth_getBalance', params: [address, 'latest'] });
      payload.push({ jsonrpc: '2.0', id: index * 2 + 2, method: 'eth_getTransactionCount', params: [address, 'latest'] });
    });
    var list = await fetchJson(chain.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var result = {};
    addresses.forEach(function (address) {
      result[address] = { balance: 0n, tx: 0n };
    });
    (Array.isArray(list) ? list : []).forEach(function (item) {
      var position = Math.floor((item.id - 1) / 2);
      var address = addresses[position];
      if (!address || !item || item.result === undefined) return;
      if (item.id % 2 === 1) {
        result[address].balance = BigInt(item.result || '0x0');
      } else {
        result[address].tx = BigInt(item.result || '0x0');
      }
    });
    return result;
  }

  async function evmBalances(run) {
    var unique = Array.from(new Set(
      state.entries.map(function (entry) { return entry.address; }).filter(Boolean)
    ));
    if (!unique.length) return;
    var byAddress = {};
    for (var i = 0; i < unique.length; i += 20) {
      var chunk = unique.slice(i, i + 20);
      var result = await evmBatch(chunk);
      if (run !== state.balanceRun || state.disposed) return;
      Object.keys(result).forEach(function (address) { byAddress[address] = result[address]; });
    }
    var sum = 0n;
    var tx = 0n;
    var active = 0;
    state.entries.forEach(function (entry) {
      var info = byAddress[entry.address];
      if (!info) return;
      sum += info.balance;
      tx += info.tx;
      if (info.balance > 0n) active += 1;
      setBalance(entry, AMOUNT.coin(info.balance, 18) + ' ' + chain.symbol, info.balance.toString() + ' wei', info.balance > 0n ? 'active' : 'empty');
    });
    setSummary(AMOUNT.coin(sum, 18) + ' ' + chain.symbol, String(active), '—', tx.toString());
  }

  function setBalanceMode(mode) {
    var badge = byId('brainwallet-balance-badge');
    if (!badge) return;
    badge.dataset.state = mode;
    badge.textContent = mode === 'on' ? 'auto' : mode;
  }

  async function loadBalances() {
    if (!balanceToggle || !balanceToggle.checked) {
      setBalanceMode('off');
      state.entries.forEach(function (entry) { setBadge(entry, 'off', 'off'); });
      setNote('Balance lookup is off. No balance request was made; addresses still link to their explorers.');
      return;
    }
    setBalanceMode('on');
    if (!chain.balance) {
      clearBalances();
      state.entries.forEach(function (entry) { setBadge(entry, 'local', 'local'); });
      setNote('Live balance lookup is not available for this chain here; each address links to its explorer.');
      return;
    }
    var run = ++state.balanceRun;
    state.entries.forEach(function (entry) {
      if (entry.address) setBadge(entry, 'checking', 'checking');
    });
    setNote('Checking public balances in your browser…');
    try {
      if (chain.balance === 'btc') await btcBalances(run);
      else await evmBalances(run);
      if (run !== state.balanceRun || state.disposed) return;
      setNote('Balances loaded from public providers in your browser. They can lag the chain; only public addresses were sent.');
    } catch (err) {
      if (run !== state.balanceRun || state.disposed) return;
      clearBalances();
      state.entries.forEach(function (entry) { setBadge(entry, 'error', 'unavailable'); });
      setNote('Balance lookup is unavailable right now. The addresses are still derived locally.', true);
    }
  }

  /* ------------------------------------------------------------- deriving */

  function deriveEntry(entry, wasm, ton) {
    return engine.phraseKey(entry.phrase, window.crypto && window.crypto.subtle).then(async function (key) {
      entry.keyHex = engine.bytesToHex(key);
      var report = engine.deriveReport(wasm, key, chain.curve);
      entry.report = report;
      await fillKey(entry);
      if (chain.ton) {
        return ton.address(report.ed_pubkey).then(function (address) {
          entry.address = address || '';
          fillAddress(entry);
        });
      }
      entry.address = engine.addressOf(report, slug, state.type);
      fillAddress(entry);
      return null;
    }).catch(function (err) {
      fillRowError(entry, err);
    });
  }

  async function deriveAll(wasm) {
    var token = ++state.run;
    var total = state.entries.length;
    var ton = chain.ton ? await ensureTon().catch(function (err) {
      fail(err && err.message ? err.message : 'The TON bundle did not load.');
      return null;
    }) : null;
    if (chain.ton && !ton) {
      state.entries.forEach(function (entry) {
        clearKeyLinks(entry);
        entry.addressLine.textContent = 'TON address derivation is unavailable.';
      });
      return;
    }
    for (var i = 0; i < total; i += 4) {
      if (state.disposed || token !== state.run) return;
      var end = Math.min(i + 4, total);
      await Promise.all(state.entries.slice(i, end).map(function (entry) {
        return deriveEntry(entry, wasm, ton);
      }));
      setDeriveProgress(end, total, 'Deriving passphrase');
      await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
    }
    if (state.disposed || token !== state.run) return;
    if (deriveText) deriveText.textContent = 'Derived ' + total + ' passphrases in this browser.';
    if (deriveBar) deriveBar.style.width = '100%';
    if (deriveProgress) deriveProgress.setAttribute('aria-valuenow', '100');
    await loadBalances();
  }

  function refreshAddresses() {
    if (!state.entries.length) return;
    state.entries.forEach(function (entry) {
      if (!entry.report) return;
      entry.address = engine.addressOf(entry.report, slug, state.type);
      fillAddress(entry);
    });
    clearBalances();
    loadBalances();
  }

  function bindControls() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-bw-first], [data-bw-prev], [data-bw-next], [data-bw-last]'), function (link) {
      link.addEventListener('click', function (event) {
        if (link.getAttribute('aria-disabled') === 'true') event.preventDefault();
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.bw-jump'), function (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var input = form.querySelector('input');
        var digits = (input.value || '').replace(/[^0-9]/g, '');
        var target = engine.clampPage(digits || '1');
        window.location.assign(pageHref(target));
      });
    });

    typeButtons.forEach(function (button) {
      var value = button.getAttribute('data-type');
      button.classList.toggle('active', value === state.type);
      button.setAttribute('aria-pressed', value === state.type ? 'true' : 'false');
      button.addEventListener('click', function () {
        if (state.type === value) return;
        state.type = value;
        typeButtons.forEach(function (other) {
          var active = other.getAttribute('data-type') === value;
          other.classList.toggle('active', active);
          other.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        refreshAddresses();
      });
    });

    if (balanceToggle) {
      balanceToggle.addEventListener('change', function () {
        if (balanceToggle.checked) {
          loadBalances();
        } else {
          state.balanceRun += 1;
          clearBalances();
          setBalanceMode('off');
          state.entries.forEach(function (entry) { setBadge(entry, 'off', 'off'); });
          setNote('Balance lookup is off. No balance request will be made.');
        }
      });
    }
  }

  async function boot() {
    renderPageInfo();
    renderPagers();
    bindControls();

    var total = engine.totalPages();
    if (state.page > total) state.page = total;

    rowsEl.textContent = '';
    engine.pageRows(state.page).forEach(function (item) {
      var entry = { index: item.index, phrase: item.phrase };
      state.entries.push(entry);
      createRow(entry);
    });
    setDeriveProgress(0, state.entries.length, 'Preparing');

    var wasm;
    try {
      wasm = await loadWasm();
    } catch (err) {
      fail(err && err.message ? err.message : 'The derivation core did not load.');
      state.entries.forEach(function (entry) {
        clearKeyLinks(entry);
        entry.addressLine.textContent = 'Derivation core unavailable.';
      });
      return;
    }
    await deriveAll(wasm);
  }

  window.addEventListener('pagehide', function () {
    state.disposed = true;
    state.run += 1;
    state.balanceRun += 1;
    state.entries = [];
    if (rowsEl) rowsEl.textContent = '';
  });

  boot();
})();
