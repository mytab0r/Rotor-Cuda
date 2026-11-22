/* Brainwallet generator page: one passphrase, SHA-256 key and chain address.
 * Runs entirely in the browser; no build step, no dependencies. The
 * passphrase, its SHA-256 key and the derived keys stay in memory only: no
 * URL, no storage, no logs and no network lookup of results. Address math
 * comes from the shared wasm `derive_report` export, the same engine the /key
 * page uses. A balance check is opt-in and sends only public addresses. */
(function () {
  'use strict';

  /* Public providers come from data/providers.json through the generated
   * globals in chains.generated.js (loaded before this script). */
  var SSOT_ROOT = typeof window !== 'undefined' ? window : globalThis;
  var SSOT_PROVIDERS = SSOT_ROOT.RotorProviders;

  var engine = window.RotorBrainwallet;
  var WASM_URL = typeof window !== 'undefined' && window.RotorAssets
    ? window.RotorAssets.url('/rotor_wasm.wasm')
    : '/rotor_wasm.wasm';
  var DECODER = new TextDecoder('utf-8');

  var state = {
    wasm: null,
    wasmPromise: null,
    tonPromise: null,
    busy: false,
    disposed: false,
    rows: []
  };

  function byId(id) { return document.getElementById(id); }

  var form = byId('brainwallet-form');
  var input = byId('brainwallet-input');
  var network = byId('brainwallet-network');
  var countSelect = byId('brainwallet-count');
  var deriveBtn = byId('brainwallet-derive');
  var errorBox = byId('brainwallet-error');
  var statusBox = byId('brainwallet-status');
  var resultsEl = byId('brainwallet-results');
  var autoBalance = byId('brainwallet-auto-balance');
  var copyAllBtn = byId('brainwallet-copy-all');
  var csvBtn = byId('brainwallet-csv');
  if (!form || !input || !deriveBtn || !resultsEl) return;

  if (!engine) {
    if (errorBox) {
      errorBox.textContent = 'The brainwallet engine did not load. Reload the page.';
      errorBox.hidden = false;
    }
    deriveBtn.disabled = true;
    return;
  }

  var idleLabel = 'Generate';
  if (!errorBox) {
    errorBox = document.createElement('p');
    errorBox.id = 'brainwallet-error';
    errorBox.className = 'error brainwallet-error';
    errorBox.setAttribute('role', 'alert');
    errorBox.hidden = true;
    form.parentNode.insertBefore(errorBox, form.nextSibling);
  }

  /* -------------------------------------------------------------- wasm core */

  function loadWasm() {
    if (state.wasm) return Promise.resolve(state.wasm);
    if (state.wasmPromise) return state.wasmPromise;

    state.wasmPromise = (async function () {
      if (typeof WebAssembly === 'undefined') {
        throw new Error('WebAssembly is unavailable in this browser.');
      }
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
          throw new Error('This build of ' + WASM_URL + ' has no "' + required[i] + '" export. The derivation core is incomplete.');
        }
      }
      if (!wasm.memory) throw new Error(WASM_URL + ' does not export memory.');
      state.wasm = wasm;
      return wasm;
    })();

    state.wasmPromise.catch(function () { state.wasmPromise = null; });
    return state.wasmPromise;
  }

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

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i += 1) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  /* ----------------------------------------------------------------- output */

  function showError(message) {
    errorBox.textContent = message || 'Derivation failed.';
    errorBox.hidden = false;
  }

  function hideError() {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function setStatus(text) {
    if (!statusBox) return;
    statusBox.textContent = text || '';
    statusBox.hidden = !text;
  }

  function setBusy(busy) {
    state.busy = busy;
    deriveBtn.disabled = busy;
    deriveBtn.textContent = busy ? 'Generating…' : buttonLabel();
    resultsEl.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function buttonLabel() {
    return autoBalance && autoBalance.checked ? 'Generate & Check Balance' : idleLabel;
  }

  function note(text) {
    var p = document.createElement('p');
    p.className = 'muted brainwallet-note';
    p.textContent = text;
    return p;
  }

  function copyText(text, button) {
    var original = button.textContent;
    function done() {
      button.classList.add('copied');
      button.disabled = true;
      window.setTimeout(function () {
        button.textContent = original;
        button.classList.remove('copied');
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

  function copyButton(value, label) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'key-copy brainwallet-copy';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy ' + label);
    button.addEventListener('click', function () { copyText(value, button); });
    return button;
  }

  function fieldRow(label, value) {
    var row = document.createElement('div');
    row.className = 'brainwallet-row';

    var body = document.createElement('div');
    body.className = 'brainwallet-row-body';
    var caption = document.createElement('span');
    caption.className = 'brainwallet-row-label';
    caption.textContent = label;
    var code = document.createElement('code');
    code.className = 'mono brainwallet-row-value';
    code.textContent = value;
    body.appendChild(caption);
    body.appendChild(code);

    row.appendChild(body);
    if (value) row.appendChild(copyButton(value, label));
    return row;
  }

  function addressRow(row) {
    var item = document.createElement('div');
    item.className = 'brainwallet-address';
    var caption = document.createElement('span');
    caption.className = 'brainwallet-row-label';
    caption.textContent = row.label;

    var line = document.createElement('div');
    line.className = 'key-addr-line';
    var code = document.createElement('code');
    code.className = 'mono key-addr brainwallet-addr';
    code.textContent = row.address;
    line.appendChild(code);
    line.appendChild(copyButton(row.address, row.label + ' address'));

    if (row.explorer) {
      var link = document.createElement('a');
      link.className = 'brainwallet-explorer';
      link.href = row.explorer;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open in explorer';
      link.setAttribute('aria-label', 'Open ' + row.label + ' in an external explorer');
      line.appendChild(link);
    }

    item.appendChild(caption);
    item.appendChild(line);
    return item;
  }

  function resultBlock(chain, phrase, rows) {
    var fragment = document.createDocumentFragment();
    var heading = document.createElement('h3');
    heading.className = 'brainwallet-group-title';
    heading.textContent = chain.name + ' (' + chain.symbol + ')';
    fragment.appendChild(heading);
    fragment.appendChild(fieldRow('Passphrase', phrase));

    rows.forEach(function (row) {
      var group = document.createElement('section');
      group.className = 'brainwallet-result';
      var title = document.createElement('h4');
      title.className = 'brainwallet-result-title';
      title.textContent = row.offset === 0
        ? 'SHA-256 key'
        : 'Key + ' + row.offset;
      group.appendChild(title);

      group.appendChild(fieldRow('Private key (hex)', row.hex));
      if (row.wifCompressed) group.appendChild(fieldRow('WIF (compressed)', row.wifCompressed));
      if (row.wifUncompressed) group.appendChild(fieldRow('WIF (uncompressed)', row.wifUncompressed));
      if (row.address) {
        group.appendChild(addressRow({
          label: chain.name + ' address',
          address: row.address,
          explorer: engine.explorerFor(chain.slug, row.address)
        }));
      } else {
        group.appendChild(note('This chain has no address row for the derived key.'));
      }
      if (row.balance) {
        group.appendChild(fieldRow('Balance', row.balance));
      }
      fragment.appendChild(group);
    });

    fragment.appendChild(note('No key or passphrase was sent to a server. A balance lookup, when enabled, ' +
      'sends only the public address to a public provider; it can lag the chain.'));
    return fragment;
  }

  function renderResults(chain, phrase, rows) {
    state.rows = rows;
    resultsEl.textContent = '';
    resultsEl.appendChild(resultBlock(chain, phrase, rows));
    if (copyAllBtn) copyAllBtn.disabled = false;
    if (csvBtn) csvBtn.disabled = false;
  }

  function placeholder(text) {
    state.rows = [];
    if (copyAllBtn) copyAllBtn.disabled = true;
    if (csvBtn) csvBtn.disabled = true;
    resultsEl.textContent = '';
    resultsEl.appendChild(note(text));
  }

  /* ------------------------------------------------------------- balances */

  function coin(value, decimals) {
    var number = Number(value) / Math.pow(10, decimals);
    if (!isFinite(number)) return '0';
    if (number === 0) return '0';
    if (number < 0.00000001) return '<0.00000001';
    return number.toLocaleString('en-US', { maximumFractionDigits: decimals > 8 ? 6 : 8 });
  }

  async function fetchJson(url, options) {
    var response = await fetch(url, options);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }

  async function loadBalances(chain, rows) {
    var addresses = rows.map(function (row) { return row.address; }).filter(Boolean);
    if (!addresses.length) return;
    if (chain.balance === 'btc') {
      var url = SSOT_PROVIDERS.find('bitcoin', 'blockchain-info').url +
        addresses.map(encodeURIComponent).join('|');
      var data = await fetchJson(url);
      rows.forEach(function (row) {
        var info = data[row.address];
        if (info) row.balance = coin(info.final_balance, 8) + ' BTC';
      });
    } else if (chain.balance === 'evm') {
      var unique = Array.from(new Set(addresses));
      var byAddress = {};
      for (var i = 0; i < unique.length; i += 20) {
        var chunk = unique.slice(i, i + 20);
        var payload = chunk.map(function (address, index) {
          return { jsonrpc: '2.0', id: index + 1, method: 'eth_getBalance', params: [address, 'latest'] };
        });
        var list = await fetchJson(chain.rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        (Array.isArray(list) ? list : []).forEach(function (item) {
          var address = chunk[item.id - 1];
          if (address) byAddress[address] = BigInt(item.result || '0x0');
        });
      }
      rows.forEach(function (row) {
        var value = byAddress[row.address];
        if (value !== undefined) row.balance = coin(value, chain.decimals) + ' ' + chain.symbol;
      });
    } else {
      rows.forEach(function (row) {
        if (!row.balance) row.balance = 'not available here';
      });
    }
  }

  /* ---------------------------------------------------------------- deriving */

  async function onSubmit(event) {
    if (event) event.preventDefault();
    if (state.busy) return;

    hideError();
    setStatus('');
    var phrase = input.value.trim();
    if (!phrase) {
      showError('Enter a passphrase to test.');
      input.focus();
      return;
    }
    var chain = engine.chainConfig(network ? network.value : '');
    if (!chain) chain = engine.chainConfig('bitcoin');
    var count = countSelect ? Number(countSelect.value) : 1;
    if ([1, 3, 5, 10].indexOf(count) === -1) count = 1;

    var subtle = window.crypto && window.crypto.subtle;
    setBusy(true);
    placeholder('Hashing the phrase and deriving addresses in this browser…');
    var keyBytes = null;
    try {
      keyBytes = await engine.phraseKey(phrase, subtle);
      var baseHex = engine.bytesToHex(keyBytes);
      var wasm = await loadWasm();
      var ton = chain.ton ? await ensureTon() : null;
      var rows = [];
      for (var offset = 0; offset < count; offset += 1) {
        setStatus('Deriving address ' + (offset + 1) + ' of ' + count + '…');
        var hex = engine.addToKey(baseHex, offset, chain.curve);
        var report = engine.deriveReport(wasm, hexToBytes(hex), chain.curve);
        var address = chain.ton
          ? await ton.address(report.ed_pubkey)
          : engine.addressOf(report, chain.slug);
        rows.push({
          offset: offset,
          hex: hex,
          wifCompressed: report.wif_compressed || '',
          wifUncompressed: report.wif_uncompressed || '',
          address: address || '',
          balance: ''
        });
      }
      if (autoBalance && autoBalance.checked) {
        setStatus('Checking the public balance…');
        try {
          await loadBalances(chain, rows);
        } catch (err) {
          setStatus('Balance lookup is unavailable right now; the addresses are still derived locally.');
        }
      }
      if (state.disposed) return;
      renderResults(chain, phrase, rows);
      setStatus('Derived ' + rows.length + ' address' + (rows.length === 1 ? '' : 'es') + ' in this browser.');
    } catch (err) {
      resultsEl.textContent = '';
      placeholder('No result. Nothing was derived.');
      showError(err && err.message ? err.message : String(err));
    } finally {
      if (keyBytes) keyBytes.fill(0);
      setBusy(false);
    }
  }

  function clearAll() {
    input.value = '';
    hideError();
    setStatus('');
    placeholder('Enter a throwaway passphrase and press Generate.');
  }

  function generatePhrase() {
    hideError();
    setStatus('');
    try {
      input.value = engine.randomPhrase(window.crypto);
    } catch (err) {
      showError(err && err.message ? err.message : String(err));
      return;
    }
    placeholder('Random test phrase filled in. Press Generate to calculate — nothing is derived until you do.');
    input.focus();
  }

  function copyAllText() {
    var chain = engine.chainConfig(network ? network.value : '') || engine.chainConfig('bitcoin');
    var lines = ['Network: ' + chain.name + ' (' + chain.symbol + ')', 'Passphrase: ' + input.value.trim()];
    state.rows.forEach(function (row) {
      lines.push('Key + ' + row.offset + ': ' + row.hex);
      if (row.wifCompressed) lines.push('WIF (compressed): ' + row.wifCompressed);
      if (row.wifUncompressed) lines.push('WIF (uncompressed): ' + row.wifUncompressed);
      lines.push('Address: ' + row.address);
      if (row.balance) lines.push('Balance: ' + row.balance);
    });
    return lines.join('\n');
  }

  function copyAll() {
    if (!state.rows.length) return;
    copyText(copyAllText(), copyAllBtn);
  }

  function downloadCsv() {
    if (!state.rows.length) return;
    var chain = engine.chainConfig(network ? network.value : '') || engine.chainConfig('bitcoin');
    var header = ['network', 'passphrase', 'key_offset', 'private_key_hex', 'wif_compressed', 'wif_uncompressed', 'address', 'balance'];
    var rows = state.rows.map(function (row) {
      return [chain.slug, input.value.trim(), row.offset, row.hex, row.wifCompressed, row.wifUncompressed, row.address, row.balance];
    });
    var csv = engine.toCsv(header, rows);
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'brainwallet-' + chain.slug + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  form.addEventListener('submit', onSubmit);
  if (deriveBtn.type !== 'submit') {
    deriveBtn.addEventListener('click', onSubmit);
  }
  var generateBtn = byId('brainwallet-generate');
  if (generateBtn) generateBtn.addEventListener('click', generatePhrase);
  var clearBtn = byId('brainwallet-clear');
  if (clearBtn) clearBtn.addEventListener('click', clearAll);
  if (copyAllBtn) copyAllBtn.addEventListener('click', copyAll);
  if (csvBtn) csvBtn.addEventListener('click', downloadCsv);
  if (autoBalance) {
    autoBalance.addEventListener('change', function () {
      deriveBtn.textContent = buttonLabel();
    });
  }
  if (network) {
    network.addEventListener('change', function () {
      var chain = engine.chainConfig(network.value) || engine.chainConfig('bitcoin');
      placeholder('Network set to ' + chain.name + '. Enter a throwaway passphrase and press Generate.');
    });
  }
  if (countSelect) {
    countSelect.addEventListener('change', function () {
      placeholder('Address count set to ' + countSelect.value + '. Press Generate when ready.');
    });
  }
  deriveBtn.textContent = buttonLabel();
  placeholder('Enter a throwaway passphrase and press Generate.');

  /* The passphrase and every derived value live only while the page is open. */
  window.addEventListener('pagehide', function () {
    state.disposed = true;
    state.rows = [];
    input.value = '';
    hideError();
    setStatus('');
    resultsEl.textContent = '';
  });
})();
