/* Public key-range page. Derives every key in the URL range locally with the
 * WASM core; only the derived addresses leave the browser, once per range. */
(function () {
  'use strict';

  var WASM_URL = '/rotor_wasm.wasm';
  var TIMEOUT_MS = 8000;
  var MAX_KEYS = 64;
  var EXPOSURE_CAP = 50;
  var SECP_N = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;
  var RANGE_RE = /^\/keys\/(bitcoin|ethereum|tron|solana)\/([0-9a-fA-F]{64})-([0-9a-fA-F]{64})\/?$/;
  var HEX_RE = /^[0-9a-fA-F]{64}$/;
  var DECODER = new TextDecoder('utf-8');

  var CHAINS = {
    bitcoin: { label: 'Bitcoin', curve: 0, primary: 'btc_p2wpkh', secondary: ['btc_p2pkh', 'btc_p2tr'] },
    ethereum: { label: 'Ethereum', curve: 0, primary: 'evm', secondary: [] },
    tron: { label: 'TRON', curve: 0, primary: 'tron', secondary: [] },
    solana: { label: 'Solana', curve: 1, primary: 'solana', secondary: [] }
  };

  var SECONDARY_LABELS = {
    btc_p2pkh: 'legacy',
    btc_p2tr: 'taproot'
  };

  var state = {
    wasm: null,
    wasmPromise: null,
    csv: '',
    postedFor: '',
    controller: null
  };

  var titleEl = byId('range-title');
  var form = byId('range-form');
  var chainSelect = byId('range-chain');
  var startInput = byId('range-start');
  var endInput = byId('range-end');
  var goButton = byId('range-go');
  var copyButton = byId('range-copy');
  var downloadButton = byId('range-download');
  var errorEl = byId('range-error');
  var statusEl = byId('range-status');
  var exposureEl = byId('range-exposure');
  var rowsEl = byId('range-rows');
  var tableEl = byId('range-table');

  function byId(id) {
    return document.getElementById(id);
  }

  /* ------------------------------------------------------------- utilities */

  function clearNode(node) {
    node.textContent = '';
  }

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = !message;
  }

  function setStatus(message) {
    if (statusEl) statusEl.textContent = message;
  }

  function setExposureStatus(message) {
    if (exposureEl) exposureEl.textContent = message;
  }

  function setBusy(busy) {
    if (goButton) goButton.disabled = busy;
    if (tableEl) tableEl.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function setCsv(csv) {
    state.csv = csv;
    if (copyButton) copyButton.disabled = !csv;
    if (downloadButton) downloadButton.disabled = !csv;
  }

  function hex64(value) {
    return value.toString(16).padStart(64, '0');
  }

  function cleanHex(value) {
    return String(value || '').trim().replace(/^0x/i, '');
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  /* --------------------------------------------------------- range parsing */

  function invalidRange(chain, startHex, endHex, message) {
    return { error: message, chain: chain, startHex: startHex, endHex: endHex };
  }

  function normalizeRange(chain, startRaw, endRaw) {
    var rawStart = cleanHex(startRaw).toLowerCase();
    var rawEnd = cleanHex(endRaw).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(CHAINS, chain)) {
      return invalidRange('bitcoin', rawStart, rawEnd, 'Choose a chain: bitcoin, ethereum, tron, or solana.');
    }
    if (!HEX_RE.test(rawStart)) {
      return invalidRange(chain, rawStart, rawEnd, 'Start key must be 64 hexadecimal characters.');
    }
    if (!HEX_RE.test(rawEnd)) {
      return invalidRange(chain, rawStart, rawEnd, 'End key must be 64 hexadecimal characters.');
    }

    var startHex = rawStart;
    var endHex = rawEnd;
    var start = BigInt('0x' + startHex);
    var end = BigInt('0x' + endHex);
    if (start > end) {
      return invalidRange(chain, startHex, endHex, 'Start key must not be greater than the end key.');
    }

    var count = end - start + 1n;
    if (count > BigInt(MAX_KEYS)) {
      return invalidRange(chain, startHex, endHex,
        'Ranges are limited to ' + MAX_KEYS + ' keys; this range has ' + count.toString() + '.');
    }
    if (CHAINS[chain].curve === 0) {
      if (start < 1n || end >= SECP_N) {
        return invalidRange(chain, startHex, endHex, 'secp256k1 keys must be between 1 and n-1.');
      }
    }
    return {
      chain: chain,
      start: start,
      end: end,
      count: Number(count),
      startHex: startHex,
      endHex: endHex
    };
  }

  function rangeFromUrl() {
    var match = RANGE_RE.exec(window.location.pathname);
    if (!match) return null;
    return normalizeRange(match[1], match[2], match[3]);
  }

  function rangeFromGlobal() {
    var injected = window.__ROTOR_RANGE__;
    if (!injected || !injected.chain) return null;
    return normalizeRange(String(injected.chain), injected.start, injected.end);
  }

  function rangeKey(range) {
    return range.chain + ':' + range.startHex + ':' + range.endHex;
  }

  function rangeUrl(range) {
    return '/keys/' + range.chain + '/' + range.startHex + '-' + range.endHex;
  }

  /* ------------------------------------------------------------ wasm core */

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
          throw new Error('This build of ' + WASM_URL + ' has no "' + required[i] + '" export yet.');
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

  /* -------------------------------------------------------------- rendering */

  function addSkeletonRow(widths) {
    var row = document.createElement('tr');
    row.className = 'range-skeleton-row';
    for (var i = 0; i < widths.length; i++) {
      var cell = document.createElement('td');
      var bar = document.createElement('span');
      bar.className = 'range-skeleton ' + widths[i];
      cell.appendChild(bar);
      row.appendChild(cell);
    }
    rowsEl.appendChild(row);
  }

  function renderSkeleton() {
    if (!rowsEl) return;
    clearNode(rowsEl);
    for (var i = 0; i < 4; i++) addSkeletonRow(['w1', 'w3', 'w2', 'w2']);
  }

  function renderEmpty(message) {
    if (!rowsEl) return;
    clearNode(rowsEl);
    var row = document.createElement('tr');
    var cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'range-empty muted';
    cell.textContent = message;
    row.appendChild(cell);
    rowsEl.appendChild(row);
  }

  function findAddress(report, id) {
    var list = report && Array.isArray(report.addresses) ? report.addresses : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i].address || '';
    }
    return '';
  }

  function keyHref(range, keyHex) {
    return '/key/' + keyHex + (range.chain === 'solana' ? '?curve=ed25519' : '');
  }

  function appendAddressCell(cell, range, report) {
    var primary = findAddress(report, CHAINS[range.chain].primary);
    if (primary) {
      var span = document.createElement('span');
      span.className = 'mono range-addr';
      span.textContent = primary;
      cell.appendChild(span);
    } else {
      var dash = document.createElement('span');
      dash.className = 'range-dash';
      dash.textContent = '—';
      cell.appendChild(dash);
    }
  }

  function appendSecondaryCell(cell, range, report) {
    var ids = CHAINS[range.chain].secondary;
    if (!ids.length) {
      var dash = document.createElement('span');
      dash.className = 'range-dash';
      dash.textContent = '—';
      cell.appendChild(dash);
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'range-secondary';
    ids.forEach(function (id) {
      var address = findAddress(report, id);
      if (!address) return;
      var line = document.createElement('div');
      var label = document.createElement('span');
      label.className = 'range-secondary-label';
      label.textContent = (SECONDARY_LABELS[id] || id) + ' ';
      var value = document.createElement('span');
      value.className = 'mono range-addr';
      value.textContent = address;
      line.appendChild(label);
      line.appendChild(value);
      wrap.appendChild(line);
    });
    if (!wrap.firstChild) {
      var none = document.createElement('span');
      none.className = 'range-dash';
      none.textContent = '—';
      wrap.appendChild(none);
    }
    cell.appendChild(wrap);
  }

  function renderRows(range, reports) {
    if (!rowsEl) return;
    clearNode(rowsEl);
    reports.forEach(function (entry, index) {
      var row = document.createElement('tr');
      row.className = 'range-row';

      var rank = document.createElement('td');
      rank.className = 'rank';
      rank.textContent = String(index + 1);
      row.appendChild(rank);

      var keyCell = document.createElement('td');
      keyCell.className = 'range-key';
      var link = document.createElement('a');
      link.className = 'mono';
      link.href = keyHref(range, entry.keyHex);
      link.textContent = entry.keyHex;
      link.title = 'Decimal ' + entry.value.toString();
      keyCell.appendChild(link);
      row.appendChild(keyCell);

      var primaryCell = document.createElement('td');
      primaryCell.className = 'range-address';
      appendAddressCell(primaryCell, range, entry.report);
      row.appendChild(primaryCell);

      var secondaryCell = document.createElement('td');
      secondaryCell.className = 'range-secondary-cell';
      appendSecondaryCell(secondaryCell, range, entry.report);
      row.appendChild(secondaryCell);

      rowsEl.appendChild(row);
    });
  }

  function updateHeader(range) {
    if (titleEl) {
      titleEl.textContent = CHAINS[range.chain].label + ' keys 0x' + range.startHex +
        '–' + '0x' + range.endHex;
    }
  }

  /* ------------------------------------------------------------------- CSV */

  function csvCell(value) {
    var text = String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function buildCsv(range, reports) {
    var lines = ['chain,key_hex,address,address_type'];
    reports.forEach(function (entry) {
      var chain = CHAINS[range.chain];
      var ids = [chain.primary].concat(chain.secondary);
      ids.forEach(function (id) {
        var address = findAddress(entry.report, id);
        if (!address) return;
        lines.push([
          csvCell(range.chain),
          csvCell(entry.keyHex),
          csvCell(address),
          csvCell(id)
        ].join(','));
      });
    });
    return lines.join('\n') + '\n';
  }

  function downloadCsv() {
    if (!state.csv) return;
    var range = state.currentRange;
    var name = range
      ? 'rotor-range-' + range.chain + '-' + range.startHex + '-' + range.endHex + '.csv'
      : 'rotor-range.csv';
    var blob = new Blob([state.csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function copyCsv() {
    if (!state.csv) return;
    var rowCount = state.currentReports ? state.currentReports.length : 0;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(state.csv).then(function () {
        setStatus('CSV copied to the clipboard (' + rowCount + ' keys).');
      }, function () {
        downloadCsv();
        setStatus('Clipboard unavailable; the CSV was downloaded instead.');
      });
      return;
    }
    downloadCsv();
    setStatus('Clipboard unavailable; the CSV was downloaded instead.');
  }

  /* ------------------------------------------------------------- exposure */

  function exposureChain(id) {
    if (id === 'evm' || id === 'tron' || id === 'solana') return id;
    if (typeof id === 'string' && id.indexOf('btc_') === 0) return 'btc';
    return null;
  }

  function collectAddresses(reports) {
    var seen = {};
    var out = [];
    reports.forEach(function (entry) {
      var list = entry.report && Array.isArray(entry.report.addresses) ? entry.report.addresses : [];
      list.forEach(function (address) {
        if (!address || typeof address.address !== 'string' || !address.address) return;
        var chain = exposureChain(address.id);
        if (!chain) return;
        var key = chain + ':' + address.address;
        if (seen[key]) return;
        seen[key] = true;
        out.push({ chain: chain, address: address.address });
      });
    });
    return out;
  }

  function cancelExposure() {
    if (state.controller) {
      try { state.controller.abort(); } catch (err) { /* already aborted */ }
      state.controller = null;
    }
  }

  function postExposure(range, addresses) {
    var key = rangeKey(range);
    if (state.postedFor === key) return;
    state.postedFor = key;
    var capped = addresses.slice(0, EXPOSURE_CAP);
    if (!capped.length) {
      setExposureStatus('No derived addresses to check.');
      return;
    }

    cancelExposure();
    var controller = new AbortController();
    state.controller = controller;
    var timer = window.setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    setExposureStatus('Checking ' + capped.length + ' derived address(es) against the Crypto registry…');

    fetch('/api/v1/monitor/exposure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: capped }),
      signal: controller.signal
    }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (data) {
        if (!response.ok) {
          throw new Error(data && data.error ? data.error : 'HTTP ' + response.status);
        }
        return data;
      });
    }).then(function (data) {
      var matched = data && typeof data.matched === 'number' ? data.matched : 0;
      var suffix = addresses.length > capped.length
        ? ' (first ' + capped.length + ' of ' + addresses.length + ' checked)'
        : '';
      setExposureStatus(matched + ' registered address(es) matched; their owners were warned' + suffix + '.');
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        setExposureStatus('Registry check timed out; derivation is unaffected.');
        return;
      }
      setExposureStatus('Registry check unavailable: ' +
        (err && err.message ? err.message : 'unknown error') + '.');
    }).finally(function () {
      window.clearTimeout(timer);
      if (state.controller === controller) state.controller = null;
    });
  }

  /* --------------------------------------------------------------- deriving */

  async function runRange(range) {
    cancelExposure();
    hideErrorAndCsv();
    updateHeader(range);
    state.currentRange = range;
    state.postedFor = '';
    setBusy(true);
    renderSkeleton();
    setStatus('Deriving ' + range.count + ' key' + (range.count === 1 ? '' : 's') + ' locally…');

    try {
      var wasm = await loadWasm();
      var reports = [];
      for (var i = 0; i < range.count; i++) {
        var value = range.start + BigInt(i);
        var keyHex = hex64(value);
        var report = deriveReport(wasm, hexToBytes(keyHex), CHAINS[range.chain].curve);
        reports.push({ keyHex: keyHex, value: value, report: report });
      }
      if (!reports.length) {
        renderEmpty('No keys were derived for this range.');
        setStatus('');
        return;
      }
      state.currentReports = reports;
      renderRows(range, reports);
      setCsv(buildCsv(range, reports));
      setStatus(reports.length + ' key' + (reports.length === 1 ? '' : 's') +
        ' derived locally. No key or seed left this browser.');
      postExposure(range, collectAddresses(reports));
    } catch (err) {
      state.currentReports = null;
      setCsv('');
      renderEmpty('The range could not be derived.');
      showError(err && err.message ? err.message : String(err));
      setStatus('');
      setExposureStatus('');
    } finally {
      setBusy(false);
    }
  }

  function hideErrorAndCsv() {
    showError('');
    setCsv('');
    setExposureStatus('');
  }

  /* ----------------------------------------------------------------- events */

  function goToRange() {
    if (goButton && goButton.disabled) return;
    var range = normalizeRange(
      chainSelect ? chainSelect.value : '',
      startInput ? startInput.value : '',
      endInput ? endInput.value : ''
    );
    if (range.error) {
      showError(range.error);
      if (startInput && /Start key/.test(range.error)) startInput.focus();
      else if (endInput && /End key/.test(range.error)) endInput.focus();
      return;
    }
    showError('');
    var target = rangeUrl(range);
    if (window.location.pathname === target) {
      runRange(range);
      return;
    }
    window.location.assign(target);
  }

  function init() {
    if (!form || !rowsEl) return;

    var urlRange = rangeFromUrl();
    var globalRange = urlRange ? null : rangeFromGlobal();
    var range = urlRange && !urlRange.error ? urlRange : (globalRange && !globalRange.error ? globalRange : null);
    var failure = urlRange && urlRange.error ? urlRange : (globalRange && globalRange.error ? globalRange : null);

    if (range) {
      if (chainSelect) chainSelect.value = range.chain;
      if (startInput) startInput.value = range.startHex;
      if (endInput) endInput.value = range.endHex;
      runRange(range);
      return;
    }

    setBusy(false);
    renderEmpty('Enter a start and end key to derive a range.');
    if (failure) {
      showError(failure.error);
      setStatus('');
      if (chainSelect && failure.chain) chainSelect.value = failure.chain;
      if (startInput && failure.startHex) startInput.value = failure.startHex;
      if (endInput && failure.endHex) endInput.value = failure.endHex;
      if (titleEl) titleEl.textContent = 'Key range';
      return;
    }
    setStatus('');
    if (titleEl) titleEl.textContent = 'Key range';
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    goToRange();
  });

  if (copyButton) copyButton.addEventListener('click', copyCsv);
  if (downloadButton) downloadButton.addEventListener('click', downloadCsv);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
