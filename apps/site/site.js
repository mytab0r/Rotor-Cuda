/* Shared helpers for the static coordinator pages. No build step, no deps. */
(function () {
  'use strict';

  var TOKEN_KEY = 'rotor-coord-token';

  function token() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (err) {
      return '';
    }
  }

  function setToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (err) {
      /* private mode: keep the token in memory only */
    }
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (character) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[character];
    });
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString();
  }

  function relativeTime(expiresAt) {
    var delta = Number(expiresAt) - Math.floor(Date.now() / 1000);
    if (!isFinite(delta)) return '-';
    if (delta <= 0) return 'expired';
    if (delta < 60) return delta + 's';
    return Math.floor(delta / 60) + 'm ' + (delta % 60) + 's';
  }

  /**
   * Fetch JSON. `options.token` overrides the stored token; pass '' for public
   * endpoints so no Authorization header is sent.
   */
  async function request(path, options) {
    var settings = options || {};
    var headers = Object.assign({}, settings.headers || {});
    var bearer = settings.token !== undefined ? settings.token : token();
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    if (settings.body !== undefined) headers['Content-Type'] = 'application/json';

    var response;
    try {
      response = await fetch(path, {
        method: settings.method || 'GET',
        headers: headers,
        body: settings.body
      });
    } catch (err) {
      var network = new Error('network error: ' + err.message);
      network.status = 0;
      throw network;
    }

    var text = await response.text();
    var data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = null;
      }
    }
    if (!response.ok) {
      var message = data && data.error ? data.error : ('HTTP ' + response.status);
      var failure = new Error(message);
      failure.status = response.status;
      throw failure;
    }
    return data;
  }

  /* An inline SVG sparkline of the client's scanned-key history. */
  function sparkline(history, width, height) {
    width = width || 340;
    height = height || 90;
    if (!history || history.length < 2) {
      return '<p class="muted">not enough history yet</p>';
    }
    var values = history.map(function (point) { return Number(point.scanned) || 0; });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = max - min || 1;
    var pad = 6;
    var step = (width - pad * 2) / (values.length - 1);
    var points = values.map(function (value, index) {
      var x = pad + index * step;
      var y = height - pad - ((value - min) / span) * (height - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    var last = points[points.length - 1].split(',');
    return '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" role="img" aria-label="scanned history">' +
      '<line class="gridline" x1="0" y1="' + (height - pad) + '" x2="' + width + '" y2="' + (height - pad) + '"></line>' +
      '<polyline class="line" points="' + points.join(' ') + '"></polyline>' +
      '<circle class="dot" cx="' + last[0] + '" cy="' + last[1] + '" r="3"></circle>' +
      '</svg>';
  }


  /* Highlight the current section in the shared header. */
  function markNavigation() {
    var path = window.location.pathname;
    var section = 'home';
    if (path === '/private-keys' || path.indexOf('/private-keys/') === 0 || path.indexOf('/keys/') === 0) section = 'directory';
    else if (path.indexOf('/bitcoin-puzzle') === 0) section = 'puzzle';
    else if (path.indexOf('/vanity') === 0) section = 'vanity';
    else if (path.indexOf('/tools') === 0 || path.indexOf('/brainwallet') === 0 || path.indexOf('/faq') === 0 || path.indexOf('/disclaimer') === 0 || path.indexOf('/donate') === 0) section = 'tools';
    else if (path.indexOf('/docs') === 0) section = 'docs';
    else if (path.indexOf('/key') === 0) section = 'search';
    else if (path.indexOf('/cabinet/wallet') === 0) section = 'wallet';
    else if (path.indexOf('/cabinet') === 0 || path.indexOf('/monitor') === 0 || path.indexOf('/me') === 0) section = 'cabinet';
    Array.prototype.forEach.call(document.querySelectorAll('.site-nav [data-nav]'), function (link) {
      var active = link.getAttribute('data-nav') === section;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  /* Directory search accepts a hex key; chain pages handle WIF and brainwallets. */
  function bindKeySearches() {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-key-search]'), function (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var input = form.querySelector('input');
        var hint = document.querySelector('.directory-hint');
        var value = input ? input.value.trim() : '';
        if (!value) return;
        if (!window.RotorSearch) {
          if (hint) hint.textContent = 'Search is still loading. Try again.';
          return;
        }
        window.RotorSearch.resolve(value).then(function (hex) {
          window.location.href = '/key/' + hex;
        }, function (err) {
          if (hint) {
            hint.textContent = err && err.message ? err.message : 'Cannot read that key.';
            hint.classList.add('err');
          }
          if (input) input.focus();
        });
      });
    });
  }


  /* Global search: Ctrl/Cmd+K from any page, parsed and derived entirely in
   * the browser. Key-like input renders a public address table in place; a
   * mnemonic still hands off to /seed. No key, phrase or derived CSV column
   * leaves this page or enters the URL. */
  var SEARCH_CHAINS = [
    ['bitcoin', 'Bitcoin'], ['ethereum', 'Ethereum'], ['bnb', 'BNB'],
    ['arbitrum', 'Arbitrum'], ['optimism', 'Optimism'], ['base', 'Base'],
    ['polygon', 'Polygon'], ['avalanche', 'Avalanche'], ['zksync', 'zkSync'],
    ['solana', 'Solana'], ['tron', 'TRON'], ['xrp', 'XRP'],
    ['litecoin', 'Litecoin'], ['bitcoin-cash', 'Bitcoin Cash'], ['dogecoin', 'Dogecoin'],
    ['zcash', 'Zcash'], ['sui', 'Sui'], ['ton', 'TON']
  ];
  var SEARCH_INTERPRET = [
    ['auto', 'Auto-detect'], ['hex', 'HEX'], ['wif', 'WIF'], ['keypair', 'Keypair'],
    ['xrp-secret', 'XRP secret'], ['mnemonic', 'Mnemonic'], ['brainwallet', 'Brainwallet']
  ];
  var SEARCH_COUNTS = [1, 3, 5, 10];
  var SEARCH_DEFAULT_COUNT = 5;

  function searchChainButtons() {
    return SEARCH_CHAINS.map(function (item) {
      return '<button type="button" class="search-chain" data-chain="' + item[0] + '" ' +
        'aria-pressed="false" aria-label="Search ' + item[1] + ' only" title="' + item[1] + '">' +
        '<svg class="crypto" aria-hidden="true"><use href="/icons.svg#chain-' + item[0] + '"></use></svg>' +
        '</button>';
    }).join('');
  }

  function searchInterpretOptions() {
    var types = window.RotorSearch && window.RotorSearch.INTERPRET ? window.RotorSearch.INTERPRET : SEARCH_INTERPRET;
    return types.map(function (item) {
      return '<option value="' + item[0] + '">' + item[1] + '</option>';
    }).join('');
  }

  function searchCountButtons() {
    return SEARCH_COUNTS.map(function (value) {
      var active = value === SEARCH_DEFAULT_COUNT;
      return '<button type="button" class="search-count' + (active ? ' active' : '') + '" ' +
        'data-count="' + value + '" aria-pressed="' + String(active) + '" ' +
        'aria-label="Show ' + value + ' address' + (value === 1 ? '' : 'es') + '">' + value + '</button>';
    }).join('');
  }

  function installGlobalSearch() {
    if (document.getElementById('global-search')) return;
    var dialog = document.createElement('dialog');
    dialog.className = 'global-search';
    dialog.id = 'global-search';
    dialog.innerHTML =
      '<form class="global-search-form" id="global-search-form">' +
      '<div class="global-search-title"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-wallet"></use></svg><span>Wallet search</span><kbd>Esc</kbd></div>' +
      '<textarea id="global-search-input" rows="3" autocomplete="off" spellcheck="false" ' +
      'aria-label="Enter a private key, mnemonic or brainwallet text" placeholder="Enter private key, mnemonic, or any text (brainwallet)…"></textarea>' +
      '<p class="global-search-hint">Auto-detect: HEX, WIF, Keypair, XRP Secret, Mnemonic, Brainwallet</p>' +
      '<div class="global-search-controls">' +
      '<label class="global-search-interpret"><span>Interpret as</span>' +
      '<select id="global-search-mode">' + searchInterpretOptions() + '</select></label>' +
      '<div class="global-search-count" role="group" aria-label="Addresses to show">' +
      '<span class="global-search-count-label" aria-hidden="true">Addresses</span>' +
      searchCountButtons() + '</div>' +
      '</div>' +
      '<div class="global-search-chains" role="group" aria-label="Supported chains">' + searchChainButtons() + '</div>' +
      '<p class="global-search-scope" id="global-search-scope">Searching all chains</p>' +
      '<button type="submit" class="primary global-search-submit">Search all chains</button>' +
      '<p class="global-search-error" id="global-search-error" role="alert" hidden></p>' +
      '<section class="global-search-results" id="global-search-results" aria-labelledby="global-search-results-title" hidden>' +
      '<div class="global-search-results-head">' +
      '<h2 class="global-search-results-title" id="global-search-results-title">Public addresses</h2>' +
      '<span class="global-search-results-meta" id="global-search-results-meta"></span>' +
      '</div>' +
      '<p class="global-search-note" id="global-search-note">Balances are not checked in this panel. Only public addresses are derived; open an explorer to inspect a chain.</p>' +
      '<div class="global-search-table-wrap" id="global-search-table-wrap">' +
      '<table class="global-search-table"><caption class="visually-hidden">Derived public addresses</caption>' +
      '<thead><tr><th scope="col">Chain</th><th scope="col">Address</th><th scope="col">Type</th>' +
      '<th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>' +
      '<tbody id="global-search-rows"></tbody></table>' +
      '</div>' +
      '<div class="global-search-result-actions" id="global-search-actions">' +
      '<button type="button" class="global-search-action" id="global-search-copy-all" disabled>Copy All</button>' +
      '<button type="button" class="global-search-action" id="global-search-csv" disabled>CSV</button>' +
      '</div>' +
      '</section>' +
      '<p class="visually-hidden" id="global-search-status" role="status" aria-live="polite"></p>' +
      '</form>';
    document.body.appendChild(dialog);

    var input = dialog.querySelector('#global-search-input');
    var form = dialog.querySelector('#global-search-form');
    var modeSelect = dialog.querySelector('#global-search-mode');
    var error = dialog.querySelector('#global-search-error');
    var scope = dialog.querySelector('#global-search-scope');
    var submit = dialog.querySelector('.global-search-submit');
    var chainButtons = Array.prototype.slice.call(dialog.querySelectorAll('.search-chain'));
    var countButtons = Array.prototype.slice.call(dialog.querySelectorAll('.search-count'));
    var resultsEl = dialog.querySelector('#global-search-results');
    var rowsEl = dialog.querySelector('#global-search-rows');
    var metaEl = dialog.querySelector('#global-search-results-meta');
    var noteEl = dialog.querySelector('#global-search-note');
    var tableWrap = dialog.querySelector('#global-search-table-wrap');
    var actionsEl = dialog.querySelector('#global-search-actions');
    var copyAllBtn = dialog.querySelector('#global-search-copy-all');
    var csvBtn = dialog.querySelector('#global-search-csv');
    var statusEl = dialog.querySelector('#global-search-status');
    var selectedChain = '';
    var selectedCount = SEARCH_DEFAULT_COUNT;
    var lastReport = null;
    var lastKind = '';
    var activeParser = null;
    var searchSeq = 0;

    var wasmState = { wasm: null, promise: null };

    function chainLabel(slug) {
      var entry = SEARCH_CHAINS.filter(function (item) { return item[0] === slug; })[0];
      return entry ? entry[1] : slug;
    }

    function submitLabel() {
      return selectedChain ? 'Search ' + chainLabel(selectedChain) : 'Search all chains';
    }

    function updateScope() {
      var label = selectedChain ? chainLabel(selectedChain) : '';
      if (scope) scope.textContent = selectedChain ? 'Searching ' + label + ' only' : 'Searching all chains';
      if (submit && !submit.disabled) submit.textContent = submitLabel();
    }

    function setBusy(busy) {
      if (submit) {
        submit.disabled = busy;
        submit.textContent = busy ? 'Deriving…' : submitLabel();
      }
      if (modeSelect) modeSelect.disabled = busy;
    }

    function hideError() {
      if (!error) return;
      error.textContent = '';
      error.hidden = true;
    }

    function showError(message) {
      if (!error) return;
      error.textContent = message;
      error.hidden = false;
    }

    function clearResults() {
      lastReport = null;
      if (resultsEl) resultsEl.hidden = true;
      if (rowsEl) rowsEl.textContent = '';
      if (metaEl) metaEl.textContent = '';
      if (tableWrap) tableWrap.hidden = false;
      if (actionsEl) actionsEl.hidden = false;
      if (copyAllBtn) copyAllBtn.disabled = true;
      if (csvBtn) csvBtn.disabled = true;
      if (statusEl) statusEl.textContent = '';
      lastKind = '';
    }

    function cancelSearch() {
      searchSeq += 1;
      activeParser = null;
      setBusy(false);
      clearResults();
    }

    function loadWasm() {
      if (wasmState.wasm) return Promise.resolve(wasmState.wasm);
      if (wasmState.promise) return wasmState.promise;
      wasmState.promise = (async function () {
        var response;
        try {
          response = await fetch('/rotor_wasm.wasm');
        } catch (err) {
          throw new Error('Cannot load the derivation core: ' + (err && err.message ? err.message : String(err)));
        }
        if (!response.ok) throw new Error('Cannot load the derivation core: HTTP ' + response.status);
        var module;
        try {
          module = await WebAssembly.instantiateStreaming(response.clone(), {});
        } catch (err) {
          module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
        }
        var wasm = module.instance ? module.instance.exports : module.exports;
        wasmState.wasm = wasm;
        return wasm;
      })();
      wasmState.promise.catch(function () { wasmState.promise = null; });
      return wasmState.promise;
    }

    var tonLoader = null;
    function loadTon() {
      if (window.RotorTon) return Promise.resolve(window.RotorTon);
      if (tonLoader) return tonLoader;
      tonLoader = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/ton.js';
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

    function ensureParser() {
      if (window.RotorSearch) return Promise.resolve(window.RotorSearch);
      return new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/search.js?v=20261125a';
        script.onload = function () {
          if (window.RotorSearch) resolve(window.RotorSearch);
          else reject(new Error('Search did not load.'));
        };
        script.onerror = function () { reject(new Error('Search did not load.')); };
        document.head.appendChild(script);
      });
    }

    function writeClipboard(text, done) {
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
        done();
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else {
        fallback();
      }
    }

    function icon(id) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'icon');
      svg.setAttribute('aria-hidden', 'true');
      var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '/icons.svg#' + id);
      svg.appendChild(use);
      return svg;
    }

    function copyWithFeedback(text, button, label) {
      writeClipboard(text, function done() {
        var use = button.querySelector('use');
        button.classList.add('is-copied');
        button.setAttribute('aria-label', 'Copied');
        button.title = 'Copied';
        if (use) use.setAttribute('href', '/icons.svg#ui-check');
        button.disabled = true;
        window.setTimeout(function () {
          button.classList.remove('is-copied');
          button.setAttribute('aria-label', label);
          button.title = label;
          if (use) use.setAttribute('href', '/icons.svg#ui-copy');
          button.disabled = false;
        }, 1200);
      });
    }

    function buildResultRow(row) {
      var tr = document.createElement('tr');

      var chainCell = document.createElement('td');
      chainCell.setAttribute('data-label', 'Chain');
      chainCell.textContent = row.chainLabel;

      var addressCell = document.createElement('td');
      addressCell.setAttribute('data-label', 'Address');
      var code = document.createElement('code');
      code.className = 'global-search-addr mono';
      code.textContent = row.address;
      addressCell.appendChild(code);

      var typeCell = document.createElement('td');
      typeCell.setAttribute('data-label', 'Type');
      typeCell.textContent = row.type;

      var actionCell = document.createElement('td');
      actionCell.setAttribute('data-label', 'Actions');
      actionCell.className = 'global-search-table-actions';

      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'global-search-icon-btn';
      copy.setAttribute('aria-label', 'Copy ' + row.chainLabel + ' address');
      copy.title = 'Copy address';
      copy.appendChild(icon('ui-copy'));
      copy.addEventListener('click', function () {
        copyWithFeedback(row.address, copy, 'Copy ' + row.chainLabel + ' address');
      });
      actionCell.appendChild(copy);

      if (row.explorer) {
        var link = document.createElement('a');
        link.className = 'global-search-icon-btn';
        link.href = row.explorer;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', 'Open ' + row.chainLabel + ' address in explorer');
        link.title = 'Open in explorer';
        link.appendChild(icon('ui-external'));
        actionCell.appendChild(link);
      }

      tr.appendChild(chainCell);
      tr.appendChild(addressCell);
      tr.appendChild(typeCell);
      tr.appendChild(actionCell);
      return tr;
    }

    function kindLabel(kind) {
      var labels = { hex: 'HEX key', wif: 'WIF', brainwallet: 'brainwallet', keypair: 'keypair' };
      return labels[kind] || 'key';
    }

    function emptyText(report) {
      var label = selectedChain ? chainLabel(selectedChain) : '';
      if (report && report.curve === 'ed25519' && selectedChain &&
          ['solana', 'sui', 'ton'].indexOf(selectedChain) < 0) {
        return label + ' addresses come from secp256k1 keys. This keypair is ed25519 — ' +
          'choose Solana, Sui or TON, or clear the chain filter.';
      }
      if (report && report.curve === 'secp256k1' &&
          ['solana', 'sui', 'ton'].indexOf(selectedChain) >= 0) {
        return label + ' addresses need an ed25519 keypair (a 32- or 64-byte JSON array).';
      }
      return 'No public address rows match this chain filter.';
    }

    function currentRows() {
      if (!activeParser || !lastReport) return [];
      return activeParser.shapeReport(lastReport, { chain: selectedChain, count: selectedCount });
    }

    function renderResults(report, kind) {
      lastReport = report;
      lastKind = kind;
      var rows = activeParser.shapeReport(report, { chain: selectedChain, count: selectedCount });
      resultsEl.hidden = false;
      rowsEl.textContent = '';
      if (!rows.length) {
        if (metaEl) metaEl.textContent = '';
        if (tableWrap) tableWrap.hidden = true;
        if (actionsEl) actionsEl.hidden = true;
        if (noteEl) noteEl.textContent = emptyText(report);
        if (copyAllBtn) copyAllBtn.disabled = true;
        if (csvBtn) csvBtn.disabled = true;
        if (statusEl) statusEl.textContent = emptyText(report);
        return;
      }
      if (tableWrap) tableWrap.hidden = false;
      if (actionsEl) actionsEl.hidden = false;
      if (noteEl) {
        noteEl.textContent = 'Balances are not checked in this panel. Only public addresses are derived; ' +
          'open an explorer to inspect a chain.';
      }
      if (metaEl) {
        metaEl.textContent = rows.length + ' public address' + (rows.length === 1 ? '' : 'es') +
          ' · ' + kindLabel(kind);
      }
      rows.forEach(function (row) { rowsEl.appendChild(buildResultRow(row)); });
      if (copyAllBtn) copyAllBtn.disabled = false;
      if (csvBtn) csvBtn.disabled = false;
      if (statusEl) {
        statusEl.textContent = 'Derived ' + rows.length + ' public address' + (rows.length === 1 ? '' : 'es') + '.';
      }
    }

    function selectChain(button) {
      var slug = button.getAttribute('data-chain');
      selectedChain = slug === selectedChain ? '' : slug;
      chainButtons.forEach(function (other) {
        other.setAttribute('aria-pressed', String(other.getAttribute('data-chain') === selectedChain));
      });
      updateScope();
      if (lastReport && activeParser) renderResults(lastReport, lastKind);
    }

    chainButtons.forEach(function (button) {
      button.addEventListener('click', function () { selectChain(button); });
    });

    function selectCount(button) {
      var value = Number(button.getAttribute('data-count'));
      if (SEARCH_COUNTS.indexOf(value) < 0) return;
      selectedCount = value;
      countButtons.forEach(function (other) {
        var active = other === button;
        other.classList.toggle('active', active);
        other.setAttribute('aria-pressed', String(active));
      });
      if (lastReport && activeParser) renderResults(lastReport, lastKind);
    }

    countButtons.forEach(function (button) {
      button.addEventListener('click', function () { selectCount(button); });
    });

    function open() {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', 'open');
      window.setTimeout(function () { if (input) input.focus(); }, 30);
    }

    function closeDialog() {
      if (typeof dialog.close === 'function') dialog.close();
      else {
        dialog.removeAttribute('open');
        resetDialog();
      }
    }

    function resetDialog() {
      cancelSearch();
      if (input) input.value = '';
      hideError();
    }

    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) closeDialog();
    });
    dialog.addEventListener('close', resetDialog);

    input.addEventListener('input', function () {
      hideError();
      cancelSearch();
    });

    if (modeSelect) {
      modeSelect.addEventListener('change', function () {
        hideError();
        cancelSearch();
      });
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      hideError();
      var value = input.value.trim();
      if (!value) {
        showError('Paste a key, WIF, mnemonic or brainwallet text first.');
        input.focus();
        return;
      }
      var seq = ++searchSeq;
      clearResults();
      setBusy(true);
      var parserRef = null;

      ensureParser().then(function (parser) {
        parserRef = parser;
        activeParser = parser;
        return parser.detect(value, modeSelect ? modeSelect.value : 'auto');
      }).then(function (result) {
        if (seq !== searchSeq) return null;
        if (result.kind === 'mnemonic') {
          /* Never drop the phrase: /seed restores it from sessionStorage,
           * fills the field and derives immediately. The phrase stays out of
           * the URL. The chain strip does not change seed derivation, so the
           * selected chain is intentionally not forwarded. */
          try { sessionStorage.setItem('rotor-seed-phrase', result.phrase); } catch (err) { /* private mode */ }
          window.location.href = '/seed';
          return null;
        }
        var curve = result.curve === 'ed25519' ? 1 : 0;
        var bytes = parserRef.hexToBytes(result.hex);
        return loadWasm().then(function (wasm) {
          if (seq !== searchSeq) {
            bytes.fill(0);
            return null;
          }
          var report;
          try {
            report = parserRef.deriveReport(wasm, bytes, curve);
          } finally {
            bytes.fill(0);
          }
          if (seq !== searchSeq) return null;
          if (curve === 1 && selectedChain === 'ton') {
            return loadTon().then(function (ton) {
              return ton.address(report.ed_pubkey);
            }).then(function (address) {
              if (seq !== searchSeq) return null;
              parserRef.appendTonRow(report, address);
              renderResults(report, result.kind);
              return null;
            }).catch(function () {
              if (seq !== searchSeq) return null;
              resultsEl.hidden = false;
              rowsEl.textContent = '';
              if (tableWrap) tableWrap.hidden = true;
              if (actionsEl) actionsEl.hidden = true;
              if (metaEl) metaEl.textContent = '';
              if (noteEl) {
                noteEl.textContent = 'The TON wallet library could not load, so no TON address is shown. Try again or choose another chain.';
              }
              if (statusEl) statusEl.textContent = noteEl ? noteEl.textContent : '';
              return null;
            });
          }
          renderResults(report, result.kind);
          return null;
        });
      }).catch(function (err) {
        if (seq !== searchSeq) return;
        showError(err && err.message ? err.message : 'Cannot read that value.');
        input.focus();
      }).finally(function () {
        if (seq === searchSeq) setBusy(false);
      });
    });

    if (copyAllBtn) {
      copyAllBtn.addEventListener('click', function () {
        var rows = currentRows();
        if (!rows.length) return;
        writeClipboard(activeParser.toCsv(rows), function done() {
          var original = 'Copy All';
          copyAllBtn.textContent = 'Copied';
          copyAllBtn.disabled = true;
          window.setTimeout(function () {
            copyAllBtn.textContent = original;
            copyAllBtn.disabled = false;
          }, 1200);
        });
      });
    }

    if (csvBtn) {
      csvBtn.addEventListener('click', function () {
        var rows = currentRows();
        if (!rows.length) return;
        var blob = new Blob([activeParser.toCsv(rows)], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = 'rotor-wallet-search.csv';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      });
    }

    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') {
        event.preventDefault();
        open();
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-nav="search"]'), function (link) {
      link.addEventListener('click', function (event) {
        event.preventDefault();
        open();
      });
    });
  }

  installGlobalSearch();

  markNavigation();
  bindKeySearches();

  window.Rotor = {
    TOKEN_KEY: TOKEN_KEY,
    token: token,
    setToken: setToken,
    escapeHtml: escapeHtml,
    formatNumber: formatNumber,
    relativeTime: relativeTime,
    request: request,
    sparkline: sparkline
  };
})();
