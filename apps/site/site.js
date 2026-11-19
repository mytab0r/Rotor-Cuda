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


  /* Global search: Ctrl/Cmd+K from any page, parsed entirely in the browser. */
  var SEARCH_CHAINS = [
    ['bitcoin', 'Bitcoin'], ['ethereum', 'Ethereum'], ['bnb', 'BNB'],
    ['arbitrum', 'Arbitrum'], ['optimism', 'Optimism'], ['base', 'Base'],
    ['polygon', 'Polygon'], ['avalanche', 'Avalanche'], ['zksync', 'zkSync'],
    ['solana', 'Solana'], ['tron', 'TRON'], ['xrp', 'XRP'],
    ['litecoin', 'Litecoin'], ['bitcoin-cash', 'Bitcoin Cash'], ['dogecoin', 'Dogecoin'],
    ['zcash', 'Zcash'], ['sui', 'Sui'], ['ton', 'TON']
  ];

  function searchChainButtons() {
    return SEARCH_CHAINS.map(function (item) {
      return '<button type="button" class="search-chain" data-chain="' + item[0] + '" ' +
        'aria-pressed="false" aria-label="Search ' + item[1] + ' only" title="' + item[1] + '">' +
        '<svg class="crypto" aria-hidden="true"><use href="/icons.svg#chain-' + item[0] + '"></use></svg>' +
        '</button>';
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
      '<div class="global-search-chains" role="group" aria-label="Supported chains">' + searchChainButtons() + '</div>' +
      '<p class="global-search-scope" id="global-search-scope">Searching all chains</p>' +
      '<button type="submit" class="primary global-search-submit">Search all chains</button>' +
      '<p class="global-search-error" id="global-search-error" role="alert" hidden></p>' +
      '</form>';
    document.body.appendChild(dialog);

    var input = dialog.querySelector('#global-search-input');
    var form = dialog.querySelector('#global-search-form');
    var error = dialog.querySelector('#global-search-error');
    var scope = dialog.querySelector('#global-search-scope');
    var submit = dialog.querySelector('.global-search-submit');
    var chainButtons = Array.prototype.slice.call(dialog.querySelectorAll('.search-chain'));
    var selectedChain = '';

    function chainLabel(slug) {
      var entry = SEARCH_CHAINS.filter(function (item) { return item[0] === slug; })[0];
      return entry ? entry[1] : slug;
    }

    function updateScope() {
      var label = selectedChain ? chainLabel(selectedChain) : '';
      if (scope) scope.textContent = selectedChain ? 'Searching ' + label + ' only' : 'Searching all chains';
      if (submit) submit.textContent = selectedChain ? 'Search ' + label : 'Search all chains';
    }

    chainButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        var slug = button.getAttribute('data-chain');
        selectedChain = slug === selectedChain ? '' : slug;
        chainButtons.forEach(function (other) {
          other.setAttribute('aria-pressed', String(other.getAttribute('data-chain') === selectedChain));
        });
        updateScope();
      });
    });

    function ensureParser() {
      if (window.RotorSearch) return Promise.resolve(window.RotorSearch);
      return new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/search.js?v=20261122a';
        script.onload = function () {
          if (window.RotorSearch) resolve(window.RotorSearch);
          else reject(new Error('Search did not load.'));
        };
        script.onerror = function () { reject(new Error('Search did not load.')); };
        document.head.appendChild(script);
      });
    }

    function open() {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', 'open');
      window.setTimeout(function () { if (input) input.focus(); }, 30);
    }

    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dialog.close();
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      error.hidden = true;
      var value = input.value.trim();
      if (!value) {
        error.textContent = 'Paste a key, WIF, mnemonic or brainwallet text first.';
        error.hidden = false;
        input.focus();
        return;
      }
      ensureParser().then(function (parser) {
        return parser.detect(value);
      }).then(function (result) {
        if (result.kind === 'mnemonic') {
          /* Never drop the phrase: /seed restores it from sessionStorage,
           * fills the field and derives immediately. The phrase stays out of
           * the URL. The chain strip does not change seed derivation, so the
           * selected chain is intentionally not forwarded. */
          try { sessionStorage.setItem('rotor-seed-phrase', result.phrase); } catch (err) { /* private mode */ }
          window.location.href = '/seed';
          return;
        }
        var chain = result.chain || selectedChain;
        var query = [];
        if (result.curve === 'ed25519') query.push('curve=ed25519');
        if (chain) query.push('chain=' + encodeURIComponent(chain));
        window.location.href = '/key/' + result.hex + (query.length ? '?' + query.join('&') : '');
      }).catch(function (err) {
        error.textContent = err && err.message ? err.message : 'Cannot read that value.';
        error.hidden = false;
        input.focus();
      });
    });

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
