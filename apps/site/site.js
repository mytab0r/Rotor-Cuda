/* Shared helpers for the static coordinator pages. No build step, no deps. */
(function () {
  'use strict';

  /* Narrow-header split: four primary links stay inline and the rest move into
   * a "More" disclosure. These helpers are pure and exported before the DOM
   * guard so the node test can exercise them without a browser. */
  var NAV_INLINE_COUNT = 4;
  var NAV_BREAKPOINT = 860;

  function splitLinks(links, keep) {
    var list = links || [];
    var count = typeof keep === 'number' && keep > 0 ? Math.floor(keep) : 0;
    if (count > list.length) count = list.length;
    return {
      inline: Array.prototype.slice.call(list, 0, count),
      tail: Array.prototype.slice.call(list, count)
    };
  }

  function activeInTail(tail, isActive) {
    if (!tail || !tail.length || typeof isActive !== 'function') return false;
    for (var index = 0; index < tail.length; index += 1) {
      if (isActive(tail[index], index)) return true;
    }
    return false;
  }

  (typeof globalThis !== 'undefined' ? globalThis : window).RotorSiteNav = {
    splitLinks: splitLinks,
    activeInTail: activeInTail,
    INLINE_COUNT: NAV_INLINE_COUNT
  };

  /* Breadcrumb trail shared by server-rendered shells that fill their trail
   * in the browser. `trail` is pure so the node test can cover the separator
   * and current-page contract without a DOM. */
  function breadcrumbTrail(items) {
    var out = [];
    var list = items || [];
    for (var index = 0; index < list.length; index += 1) {
      var item = list[index] || {};
      if (index > 0) out.push({ separator: true });
      out.push({
        label: String(item.label === undefined || item.label === null ? '' : item.label),
        href: item.href ? String(item.href) : '',
        current: index === list.length - 1
      });
    }
    return out;
  }

  function renderBreadcrumbs(nav, items) {
    if (!nav || !items || !items.length || typeof document === 'undefined') return;
    var trail = breadcrumbTrail(items);
    while (nav.firstChild) nav.removeChild(nav.firstChild);
    for (var index = 0; index < trail.length; index += 1) {
      var entry = trail[index];
      if (entry.separator) {
        var separator = document.createElement('span');
        separator.className = 'breadcrumbs__sep';
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '/';
        nav.appendChild(separator);
        continue;
      }
      var node = entry.href ? document.createElement('a') : document.createElement('span');
      if (entry.href) node.setAttribute('href', entry.href);
      else if (entry.current) node.setAttribute('aria-current', 'page');
      node.textContent = entry.label;
      nav.appendChild(node);
    }
  }

  var breadcrumbs = { trail: breadcrumbTrail, render: renderBreadcrumbs };
  (typeof globalThis !== 'undefined' ? globalThis : window).RotorBreadcrumbs = breadcrumbs;

  if (typeof document === 'undefined') return;

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
    else if (path === '/mnemonic-seeds' || path.indexOf('/mnemonic-seeds/') === 0) section = 'seeds';
    else if (path.indexOf('/bitcoin-puzzle') === 0) section = 'puzzle';
    else if (path.indexOf('/vanity') === 0) section = 'vanity';
    else if (path.indexOf('/milk-sad') === 0) section = 'milk-sad';
    else if (path.indexOf('/tools') === 0 || path.indexOf('/brainwallet') === 0 || path.indexOf('/faq') === 0 || path.indexOf('/disclaimer') === 0 || path.indexOf('/donate') === 0 || path === '/seed' || path === '/mnemonic-converter') section = 'tools';
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

  /* Below 860px keep the first four primary links inline and disclose the rest
   * behind a More button. Rebuilds idempotently on `matchMedia` changes: every
   * original link is put back in order before splitting again, so no link or
   * panel is ever duplicated. Without JS nothing is split and every link stays
   * visible. */
  function setupNav() {
    var header = document.querySelector('.site-nav');
    if (!header) return;
    var nav = header.querySelector('nav[aria-label="Main"]') || header.querySelector('nav');
    if (!nav) return;

    var links = Array.prototype.filter.call(nav.children, function (node) {
      return node.tagName === 'A' && node.hasAttribute('data-nav');
    });
    if (!links.length) return;
    /* Narrow screens can show the primary links icon-only; keep a hover title
     * and an explicit accessible name. */
    Array.prototype.forEach.call(links, function (link) {
      var label = (link.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label) return;
      if (!link.getAttribute('title')) link.setAttribute('title', label);
      if (!link.getAttribute('aria-label')) link.setAttribute('aria-label', label);
    });

    var media = window.matchMedia ? window.matchMedia('(max-width: ' + NAV_BREAKPOINT + 'px)') : null;
    var moreBtn = null;
    var drawer = null;

    function narrow() {
      return media ? media.matches : window.innerWidth <= NAV_BREAKPOINT;
    }

    function isActiveLink(link) {
      return link.classList.contains('active') || link.getAttribute('aria-current') === 'page';
    }

    function setOpen(open) {
      if (!moreBtn || !drawer) return;
      drawer.hidden = !open;
      moreBtn.setAttribute('aria-expanded', String(open));
    }

    function teardown() {
      if (drawer) {
        drawer.hidden = true;
        if (drawer.parentNode) drawer.parentNode.removeChild(drawer);
      }
      if (moreBtn && moreBtn.parentNode) moreBtn.parentNode.removeChild(moreBtn);
      drawer = null;
      moreBtn = null;
      header.classList.remove('nav-split');
    }

    function rebuild() {
      teardown();
      for (var index = 0; index < links.length; index += 1) nav.appendChild(links[index]);
      if (!narrow()) return;

      var parts = splitLinks(links, NAV_INLINE_COUNT);
      if (!parts.tail.length) return;

      drawer = document.createElement('div');
      drawer.id = 'site-nav-more';
      drawer.className = 'nav-drawer';
      drawer.hidden = true;
      for (var tail = 0; tail < parts.tail.length; tail += 1) drawer.appendChild(parts.tail[tail]);
      drawer.addEventListener('click', function (event) {
        if (event.target && event.target.closest && event.target.closest('a')) setOpen(false);
      });

      moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'chip nav-more-btn';
      moreBtn.textContent = 'More';
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.setAttribute('aria-controls', 'site-nav-more');
      if (activeInTail(parts.tail, isActiveLink)) {
        moreBtn.classList.add('active');
        moreBtn.setAttribute('data-active', 'true');
      }
      moreBtn.addEventListener('click', function () {
        setOpen(drawer.hidden);
      });

      nav.parentNode.insertBefore(moreBtn, nav.nextSibling);
      header.insertBefore(drawer, moreBtn.nextSibling);
      header.classList.add('nav-split');
    }

    document.addEventListener('click', function (event) {
      if (!moreBtn || !drawer || drawer.hidden) return;
      if (!header.contains(event.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if (!moreBtn || !drawer || drawer.hidden) return;
      if (event.key !== 'Escape' && event.key !== 'Esc') return;
      event.preventDefault();
      setOpen(false);
      moreBtn.focus();
    });

    if (media) {
      if (media.addEventListener) media.addEventListener('change', rebuild);
      else if (media.addListener) media.addListener(rebuild);
    }

    rebuild();
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


  /* Global search: Ctrl/Cmd+K or the header search control opens one modal on
   * every page. Detection and routing mirror the donor: hex/WIF/keypair/XRP
   * secret -> /key/<value>, a mnemonic -> /mnemonic-converter, and any other
   * text -> /brainwallet. Key-like input also derives public addresses in
   * place with the same wasm core as /key; balances come from the local
   * RotorBalanceCache TTL store. No key or derived private row enters the URL
   * or storage. */
  var SEARCH_CHIPS = [
    ['hex', 'Private Key (HEX)'],
    ['wif', 'WIF Format'],
    ['keypair', 'Keypair'],
    ['xrp', 'XRP Secret'],
    ['mnemonic', 'Mnemonic'],
    ['brainwallet', 'Brainwallet']
  ];
  var SEARCH_MNEMONIC_COUNTS = [1, 3, 5, 10];
  var SEARCH_TIMEOUT_MS = 8000;
  var EVM_RPC = {
    ethereum: 'https://ethereum-rpc.publicnode.com',
    bnb: 'https://bsc-rpc.publicnode.com',
    arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
    optimism: 'https://optimism-rpc.publicnode.com',
    base: 'https://base-rpc.publicnode.com',
    polygon: 'https://polygon-bor-rpc.publicnode.com',
    avalanche: 'https://avalanche-c-chain-rpc.publicnode.com',
    zksync: 'https://mainnet.era.zksync.io'
  };
  var EVM_NATIVE = {
    ethereum: 'ETH', bnb: 'BNB', arbitrum: 'ETH', optimism: 'ETH',
    base: 'ETH', polygon: 'POL', avalanche: 'AVAX', zksync: 'ETH'
  };

  function chipLabel(mode) {
    for (var index = 0; index < SEARCH_CHIPS.length; index += 1) {
      if (SEARCH_CHIPS[index][0] === mode) return SEARCH_CHIPS[index][1];
    }
    return 'that format';
  }

  function formatUnits(amount, decimals) {
    var value = BigInt(amount);
    var places = Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
    var unit = 1n;
    for (var index = 0; index < places; index += 1) unit *= 10n;
    var whole = value / unit;
    var fraction = value % unit;
    var text = fraction ? whole.toString() + '.' + fraction.toString().padStart(places, '0').replace(/0+$/, '') : whole.toString();
    return text;
  }

  function installGlobalSearch() {
    if (document.getElementById('global-search')) return;
    var dialog = document.createElement('dialog');
    dialog.className = 'global-search';
    dialog.id = 'global-search';
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'global-search-title');
    dialog.innerHTML =
      '<form class="global-search-form" id="global-search-form" novalidate>' +
      '<div class="global-search-title"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-search"></use></svg>' +
      '<h2 id="global-search-title">Search wallet</h2><kbd>Esc</kbd></div>' +
      '<label class="visually-hidden" for="global-search-input">Search a private key, WIF, keypair, XRP secret, mnemonic or brainwallet text</label>' +
      '<textarea id="global-search-input" rows="4" autocomplete="off" spellcheck="false" ' +
      'placeholder="Enter private key, mnemonic, or any text (brainwallet)…"></textarea>' +
      '<p class="global-search-detect" id="global-search-detect" role="status" aria-live="polite">' +
      'Auto-detect: HEX, WIF, keypair, XRP secret, mnemonic or brainwallet</p>' +
      '<p id="global-search-counter" class="muted" aria-live="polite" hidden></p>' +
      '<a class="global-search-view" id="global-search-view" href="/key" hidden>Key Details →</a>' +
      '<div class="global-search-section" role="group" aria-labelledby="global-search-interpret-label">' +
      '<span class="global-search-section-label" id="global-search-interpret-label">Interpret as</span>' +
      '<div class="global-search-chips" id="global-search-chips">' +
      SEARCH_CHIPS.map(function (chip) {
        return '<button type="button" class="global-search-chip" data-mode="' + chip[0] + '" aria-pressed="false">' + chip[1] + '</button>';
      }).join('') +
      '</div></div>' +
      '<div class="global-search-mnemonic" id="global-search-mnemonic" hidden>' +
      '<label class="global-search-passphrase">BIP39 passphrase ' +
      '<input id="global-search-passphrase" type="password" autocomplete="new-password" placeholder="leave empty if none"></label>' +
      '<label class="global-search-count-field">Addresses ' +
      '<select id="global-search-count">' +
      SEARCH_MNEMONIC_COUNTS.map(function (value) {
        return '<option value="' + value + '">' + value + '</option>';
      }).join('') +
      '</select></label></div>' +
      '<button type="submit" class="primary global-search-submit">Search all chains</button>' +
      '<p class="global-search-error" id="global-search-error" role="alert" hidden></p>' +
      '<section class="global-search-results" id="global-search-results" aria-labelledby="global-search-results-title" hidden>' +
      '<div class="global-search-results-head">' +
      '<h2 class="global-search-results-title" id="global-search-results-title">Public addresses</h2>' +
      '<span class="global-search-results-meta" id="global-search-results-meta"></span>' +
      '<div class="global-search-result-actions">' +
      '<button type="button" class="global-search-action" id="global-search-copy-all" disabled>Copy All</button>' +
      '<button type="button" class="global-search-action" id="global-search-csv" disabled>Copy CSV</button>' +
      '</div></div>' +
      '<p class="global-search-summary" id="global-search-summary" aria-live="polite"></p>' +
      '<p class="global-search-note" id="global-search-note"></p>' +
      '<div class="ws-chain-grid" id="global-search-cards"></div>' +
      '</section>' +
      '<p class="visually-hidden" id="global-search-status" role="status" aria-live="polite"></p>' +
      '</form>';
    document.body.appendChild(dialog);

    var input = dialog.querySelector('#global-search-input');
    var form = dialog.querySelector('#global-search-form');
    var detectEl = dialog.querySelector('#global-search-detect');
    var counterEl = dialog.querySelector('#global-search-counter');
    var viewEl = dialog.querySelector('#global-search-view');
    var chips = Array.prototype.slice.call(dialog.querySelectorAll('.global-search-chip'));
    var mnemonicEl = dialog.querySelector('#global-search-mnemonic');
    var passphraseEl = dialog.querySelector('#global-search-passphrase');
    var countEl = dialog.querySelector('#global-search-count');
    var errorEl = dialog.querySelector('#global-search-error');
    var submit = dialog.querySelector('.global-search-submit');
    var resultsEl = dialog.querySelector('#global-search-results');
    var cardsEl = dialog.querySelector('#global-search-cards');
    var metaEl = dialog.querySelector('#global-search-results-meta');
    var summaryEl = dialog.querySelector('#global-search-summary');
    var noteEl = dialog.querySelector('#global-search-note');
    var copyAllBtn = dialog.querySelector('#global-search-copy-all');
    var csvBtn = dialog.querySelector('#global-search-csv');
    var statusEl = dialog.querySelector('#global-search-status');

    var selectedMode = '';
    var currentRoute = null;
    var currentCards = [];
    var searchSeq = 0;
    var balanceRun = 0;
    var balanceController = null;
    var lastFocus = null;
    var loaders = {};
    var wasmState = { wasm: null, promise: null };

    function ensureScript(globalName, src) {
      if (window[globalName]) return Promise.resolve(window[globalName]);
      if (loaders[globalName]) return loaders[globalName];
      loaders[globalName] = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = src;
        script.onload = function () {
          if (window[globalName]) resolve(window[globalName]);
          else reject(new Error(globalName + ' did not load.'));
        };
        script.onerror = function () { reject(new Error('Cannot load ' + src + '.')); };
        document.head.appendChild(script);
      });
      loaders[globalName].catch(function () { loaders[globalName] = null; });
      return loaders[globalName];
    }

    function ensureKeyTools() { return ensureScript('RotorKeyTools', assetUrl('/key-tools.js')); }
    function ensureSearch() { return ensureScript('RotorSearch', assetUrl('/search.js')); }
    function ensureBalanceCache() { return ensureScript('RotorBalanceCache', assetUrl('/balance-cache.js')); }
    function ensureAddressCodecs() { return ensureScript('RotorAddressCodecs', assetUrl('/address-codecs.js')); }

    function loadWasm() {
      if (wasmState.wasm) return Promise.resolve(wasmState.wasm);
      if (wasmState.promise) return wasmState.promise;
      wasmState.promise = (async function () {
        var response;
        try {
          response = await fetch(assetUrl('/rotor_wasm.wasm'));
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

    function sha256(bytes) {
      if (!(window.crypto && window.crypto.subtle)) {
        return Promise.reject(new Error('This search needs a secure context (https or localhost).'));
      }
      return window.crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
        return new Uint8Array(digest);
      });
    }

    function sha512(bytes) {
      if (!(window.crypto && window.crypto.subtle)) {
        return Promise.reject(new Error('This search needs a secure context (https or localhost).'));
      }
      return window.crypto.subtle.digest('SHA-512', bytes).then(function (digest) {
        return new Uint8Array(digest);
      });
    }

    function doubleSha256(bytes) {
      return sha256(bytes).then(sha256);
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
        button.setAttribute('data-tooltip', 'Copied');
        if (use) use.setAttribute('href', '/icons.svg#ui-check');
        button.disabled = true;
        window.setTimeout(function () {
          button.classList.remove('is-copied');
          button.setAttribute('aria-label', label);
          button.setAttribute('data-tooltip', 'Copy address');
          if (use) use.setAttribute('href', '/icons.svg#ui-copy');
          button.disabled = false;
        }, 1200);
      });
    }

    function fetchWithTimeout(url, options, signal, timeoutMs) {
      var controller = new AbortController();
      var timer = window.setTimeout(function () { controller.abort(); }, timeoutMs || SEARCH_TIMEOUT_MS);
      var onAbort = null;
      if (signal) {
        if (signal.aborted) {
          window.clearTimeout(timer);
          return Promise.reject(new Error('aborted'));
        }
        onAbort = function () { controller.abort(); };
        signal.addEventListener('abort', onAbort);
      }
      var settings = Object.assign({}, options || {});
      settings.signal = controller.signal;
      return fetch(url, settings).finally(function () {
        window.clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      });
    }

    function fetchJson(url, options, signal) {
      return fetchWithTimeout(url, options, signal).then(function (response) {
        if (!response.ok) {
          var err = new Error('HTTP ' + response.status);
          err.status = response.status;
          throw err;
        }
        return response.json();
      });
    }

    function balanceProvider(slug) {
      if (slug === 'bitcoin') {
        return {
          name: 'mempool',
          chain: 'bitcoin',
          fetch: function (address, signal) {
            return fetchJson('https://mempool.space/api/address/' + encodeURIComponent(address), null, signal).then(function (data) {
              var chain = data.chain_stats || {};
              var mempool = data.mempool_stats || {};
              var funded = BigInt(Math.trunc(chain.funded_txo_sum || 0)) + BigInt(Math.trunc(mempool.funded_txo_sum || 0));
              var spent = BigInt(Math.trunc(chain.spent_txo_sum || 0)) + BigInt(Math.trunc(mempool.spent_txo_sum || 0));
              var amount = funded - spent;
              if (amount < 0n) amount = 0n;
              var txs = Number(chain.tx_count || 0) + Number(mempool.tx_count || 0);
              return { amount: amount, decimals: 8, symbol: 'BTC', active: txs > 0 };
            });
          }
        };
      }
      if (EVM_RPC[slug]) {
        var rpc = EVM_RPC[slug];
        var symbol = EVM_NATIVE[slug] || 'ETH';
        return {
          name: 'evm',
          chain: slug,
          fetch: function (address, signal) {
            return fetchJson(rpc, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] })
            }, signal).then(function (data) {
              if (!data || typeof data.result !== 'string') throw new Error('unexpected response');
              var amount = BigInt(data.result);
              return { amount: amount, decimals: 18, symbol: symbol, active: amount > 0n };
            });
          }
        };
      }
      if (slug === 'tron') {
        return {
          name: 'tronscan',
          chain: 'tron',
          fetch: function (address, signal) {
            return fetchJson('/api/v1/chain/tron/address?address=' + encodeURIComponent(address), null, signal)
              .then(function (data) {
                if (!data || data.chain !== 'tron') throw new Error('unexpected response');
                var amount = data.balance_sun === null || data.balance_sun === undefined
                  ? 0n
                  : BigInt(String(data.balance_sun));
                return {
                  amount: amount,
                  decimals: 6,
                  symbol: 'TRX',
                  active: typeof data.tx_count === 'number' && data.tx_count > 0
                };
              })
              .catch(function (err) {
                if (err && (err.status === 404 || err.status === 501)) {
                  return fetchJson('https://apilist.tronscanapi.com/api/account?address=' + encodeURIComponent(address), null, signal)
                    .then(function (data) {
                      var amount = BigInt(String(data && data.balance ? data.balance : 0));
                      var txs = data && (data.totalTransactionCount || data.transactionCount || 0);
                      return { amount: amount, decimals: 6, symbol: 'TRX', active: Number(txs) > 0 };
                    });
                }
                throw err;
              });
          }
        };
      }
      if (slug === 'solana') {
        return {
          name: 'solana',
          chain: 'solana',
          fetch: function (address, signal) {
            return fetchJson('https://solana-rpc.publicnode.com', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] })
            }, signal).then(function (data) {
              var amount = data && data.result && data.result.value !== undefined ? BigInt(data.result.value) : 0n;
              return { amount: amount, decimals: 9, symbol: 'SOL', active: amount > 0n };
            });
          }
        };
      }
      if (slug === 'xrp') {
        return {
          name: 'xrpscan',
          chain: 'xrp',
          fetch: function (address, signal) {
            return fetchWithTimeout('https://api.xrpscan.com/api/v1/account/' + encodeURIComponent(address), null, signal)
              .then(function (response) {
                if (response.status === 404) {
                  return { amount: 0n, decimals: 6, symbol: 'XRP', active: false };
                }
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json().then(function (data) {
                  var amount = BigInt(String(data && data.Balance !== undefined ? data.Balance : 0));
                  return { amount: amount, decimals: 6, symbol: 'XRP', active: amount > 0n };
                });
              });
          }
        };
      }
      if (slug === 'litecoin') {
        return {
          name: 'litecoinspace',
          chain: 'litecoin',
          fetch: function (address, signal) {
            return fetchJson('https://litecoinspace.org/api/address/' + encodeURIComponent(address), null, signal).then(function (data) {
              var chain = data.chain_stats || {};
              var mempool = data.mempool_stats || {};
              var funded = Number(chain.funded_txo_sum || 0) + Number(mempool.funded_txo_sum || 0);
              var spent = Number(chain.spent_txo_sum || 0) + Number(mempool.spent_txo_sum || 0);
              var txs = Number(chain.tx_count || 0) + Number(mempool.tx_count || 0);
              return { amount: BigInt(Math.trunc(funded - spent)), decimals: 8, symbol: 'LTC', active: txs > 0 };
            });
          }
        };
      }
      if (slug === 'bitcoin-cash') {
        return {
          name: 'haskoin',
          chain: 'bitcoin-cash',
          fetch: function (address, signal) {
            return fetchJson('https://api.haskoin.com/bch/address/balances?addresses=' + encodeURIComponent(address), null, signal).then(function (rows) {
              var info = Array.isArray(rows) ? rows[0] : null;
              var amount = info ? BigInt(Math.trunc(Number(info.confirmed || 0) + Number(info.unconfirmed || 0))) : 0n;
              return {
                amount: amount,
                decimals: 8,
                symbol: 'BCH',
                active: amount > 0n || Number(info && info.txs || 0) > 0
              };
            });
          }
        };
      }
      if (slug === 'dogecoin' || slug === 'zcash') {
        var network = slug === 'dogecoin' ? 'dogecoin' : 'zcash';
        var ticker = slug === 'dogecoin' ? 'DOGE' : 'ZEC';
        return {
          name: 'blockchair',
          chain: slug,
          fetch: function (address, signal) {
            return fetchJson('https://api.blockchair.com/' + network + '/dashboards/addresses/' + encodeURIComponent(address), null, signal).then(function (data) {
              var info = data && data.data && data.data[address] && data.data[address].address;
              var amount = info ? BigInt(Math.trunc(Number(info.balance || 0))) : 0n;
              return {
                amount: amount,
                decimals: 8,
                symbol: ticker,
                active: amount > 0n || Number(info && info.transaction_count || 0) > 0
              };
            });
          }
        };
      }
      if (slug === 'sui') {
        return {
          name: 'sui',
          chain: 'sui',
          fetch: function (address, signal) {
            function request(method) {
              return fetchJson('https://fullnode.mainnet.sui.io', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: [address] })
              }, signal).then(function (data) {
                var amount = data && data.result && data.result.totalBalance !== undefined
                  ? BigInt(String(data.result.totalBalance))
                  : 0n;
                return { amount: amount, decimals: 9, symbol: 'SUI', active: amount > 0n };
              });
            }
            return request('suix_getBalance').catch(function (err) {
              if (signal && signal.aborted) throw err;
              return request('sui_getBalance');
            });
          }
        };
      }
      if (slug === 'ton') {
        return {
          name: 'toncenter',
          chain: 'ton',
          fetch: function (address, signal) {
            return fetchJson('https://toncenter.com/api/v2/getAddressBalance?address=' + encodeURIComponent(address), null, signal).then(function (data) {
              var amount = data && data.result !== undefined ? BigInt(String(data.result)) : 0n;
              return { amount: amount, decimals: 9, symbol: 'TON', active: amount > 0n };
            });
          }
        };
      }
      return null;
    }

    function syncChips() {
      chips.forEach(function (chip) {
        chip.setAttribute('aria-pressed', String(chip.getAttribute('data-mode') === selectedMode));
      });
    }

    function hideError() {
      errorEl.textContent = '';
      errorEl.hidden = true;
    }

    function showError(message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }

    function setBusy(busy) {
      if (submit) {
        submit.disabled = busy;
        submit.textContent = busy ? 'Deriving…' : 'Search all chains';
      }
      chips.forEach(function (chip) { chip.disabled = busy; });
    }

    function hideCounter() {
      counterEl.textContent = '';
      counterEl.hidden = true;
    }

    function renderCount() {
      var parser = window.RotorSearch;
      if (!parser || typeof parser.countLabel !== 'function') return false;
      var count = parser.countLabel(input.value.trim());
      counterEl.textContent = count.value + ' ' + count.unit;
      counterEl.hidden = false;
      return true;
    }

    function updateCounter() {
      if (!input.value.trim()) {
        hideCounter();
        return;
      }
      if (renderCount()) return;
      ensureSearch().then(function () {
        if (!input.value.trim()) return;
        if (!renderCount()) hideCounter();
      }, hideCounter);
    }

    /* Label a detected mnemonic with its Electrum seed-version sub-type. The
     * lookup is lazy and best-effort: a load or crypto failure leaves the
     * plain "Detected: Mnemonic" label and never interrupts routing. */
    function applyMnemonicSubtype(phrase) {
      Promise.all([ensureSearch(), ensureScript('RotorSeedCrypto', assetUrl('/seed-crypto.js'))])
        .then(function (modules) {
          var parser = modules[0];
          var seedCrypto = modules[1];
          if (!parser || typeof parser.mnemonicSubtype !== 'function' ||
              !seedCrypto || typeof seedCrypto.electrumSeedType !== 'function') return;
          return seedCrypto.electrumSeedType(phrase).then(function (type) {
            var current = input.value.trim().split(/\s+/).join(' ');
            if (selectedMode || current !== phrase) return;
            detectEl.textContent = 'Detected: ' + parser.mnemonicSubtype(type);
          });
        })
        .catch(function () { /* keep the plain "Detected: Mnemonic" label */ });
    }

    function refreshDetection() {
      updateCounter();
      hideError();
      var value = input.value.trim();
      var tools = window.RotorKeyTools;
      currentRoute = null;
      if (!tools || typeof tools.routeKeyInput !== 'function') {
        ensureKeyTools().then(refreshDetection, function () {
          detectEl.textContent = 'Auto-detect is unavailable. Search still opens /key.';
        });
      }
      if (!value) {
        detectEl.textContent = 'Auto-detect: HEX, WIF, keypair, XRP secret, mnemonic or brainwallet';
        viewEl.hidden = true;
        mnemonicEl.hidden = selectedMode !== 'mnemonic';
        input.removeAttribute('aria-invalid');
        return;
      }
      if (!tools || typeof tools.routeKeyInput !== 'function') {
        detectEl.textContent = 'Loading the search detector…';
        viewEl.hidden = true;
        return;
      }
      try {
        currentRoute = tools.routeKeyInput(value, selectedMode);
      } catch (err) {
        detectEl.textContent = selectedMode
          ? 'Not a valid ' + chipLabel(selectedMode)
          : 'Auto-detect: HEX, WIF, keypair, XRP secret, mnemonic or brainwallet';
        viewEl.hidden = true;
        mnemonicEl.hidden = selectedMode !== 'mnemonic';
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      input.removeAttribute('aria-invalid');
      detectEl.textContent = (selectedMode ? 'Interpreting as ' : 'Detected: ') + currentRoute.label;
      viewEl.hidden = false;
      viewEl.href = currentRoute.href;
      viewEl.textContent = currentRoute.viewLabel + ' →';
      mnemonicEl.hidden = currentRoute.kind !== 'mnemonic';
      if (!selectedMode && currentRoute.kind === 'mnemonic') applyMnemonicSubtype(currentRoute.phrase);
    }

    function clearResults() {
      currentCards = [];
      resultsEl.hidden = true;
      cardsEl.textContent = '';
      metaEl.textContent = '';
      summaryEl.textContent = '';
      noteEl.textContent = '';
      if (copyAllBtn) copyAllBtn.disabled = true;
      if (csvBtn) csvBtn.disabled = true;
      statusEl.textContent = '';
    }

    function cancelBalances() {
      balanceRun += 1;
      if (balanceController) {
        try { balanceController.abort(); } catch (err) { /* already aborted */ }
        balanceController = null;
      }
    }

    function cancelSearch() {
      searchSeq += 1;
      cancelBalances();
      currentRoute = null;
      setBusy(false);
      clearResults();
    }

    function updateSummary() {
      var parser = window.RotorSearch;
      if (!parser || typeof parser.summaryCounts !== 'function') return;
      var pending = currentCards.some(function (card) { return card.balanceState === 'loading'; });
      if (pending) {
        summaryEl.textContent = 'Checking balances…';
        return;
      }
      var counts = parser.summaryCounts(currentCards);
      summaryEl.textContent = counts.chains + ' active chain' + (counts.chains === 1 ? '' : 's') +
        ' • ' + counts.addresses + ' active address' + (counts.addresses === 1 ? '' : 'es');
    }

    function setCardBalance(view, value) {
      if (!value) {
        view.balance.textContent = '—';
        view.balance.title = 'No balance provider answered; this is not a zero balance.';
        view.status.hidden = true;
        view.article.classList.remove('has-balance');
        view.card.rows.forEach(function (row) { row.active = false; });
        return;
      }
      var amount;
      try {
        amount = BigInt(String(value.amount));
      } catch (err) {
        amount = 0n;
      }
      var text = formatUnits(amount, Number.isInteger(value.decimals) ? value.decimals : 0) +
        (value.symbol ? ' ' + value.symbol : '');
      view.balance.textContent = text;
      view.balance.title = text;
      var active = value.active === true || amount > 0n;
      view.status.hidden = !active;
      view.article.classList.toggle('has-balance', amount > 0n);
      view.card.rows.forEach(function (row, index) {
        row.active = index === 0 ? active : false;
      });
    }

    function loadCardBalance(api, store, view, run, signal) {
      var card = view.card;
      var primary = card.rows[0];
      var provider = balanceProvider(card.slug);
      if (!provider || !primary) {
        card.balanceState = 'none';
        setCardBalance(view, null);
        return Promise.resolve(null);
      }
      var key = api && store ? api.cacheKey(provider.name, provider.chain, primary.address) : null;
      card.balanceState = 'loading';
      view.balance.textContent = '…';
      view.balance.title = 'Checking balance…';

      function apply(value) {
        if (run !== balanceRun) return;
        card.balance = value || null;
        card.balanceState = value ? 'ok' : 'none';
        setCardBalance(view, value);
        updateSummary();
      }

      function fetchValue() {
        return provider.fetch(primary.address, signal).then(function (value) {
          if (api && store && key) {
            try {
              var pending = store.put(key, api.makeEntry(value, provider.name));
              if (pending && pending.catch) pending.catch(function () { /* memory fallback */ });
            } catch (err) { /* memory fallback */ }
          }
          return value;
        });
      }

      var read = store && key
        ? store.get(key).catch(function () { return null; })
        : Promise.resolve(null);
      return read.then(function (entry) {
        if (run !== balanceRun) return null;
        if (api && entry && api.isFresh(entry, provider.name)) {
          apply(entry.value);
          return null;
        }
        return fetchValue().then(function (value) {
          apply(value);
          return null;
        }).catch(function () {
          if (signal && signal.aborted) return null;
          if (api && entry && api.isSuccess(entry)) {
            apply(entry.value);
            return null;
          }
          apply(null);
          return null;
        });
      });
    }

    function startBalances(views) {
      cancelBalances();
      var run = balanceRun;
      var controller = new AbortController();
      balanceController = controller;
      ensureBalanceCache().then(function (api) {
        if (run !== balanceRun || controller.signal.aborted) return null;
        var storePromise = api && typeof api.createStore === 'function' ? api.createStore() : Promise.resolve(null);
        return storePromise.then(function (store) {
          var limit = api && typeof api.createLimiter === 'function'
            ? api.createLimiter(18)
            : function (task) { return task(); };
          return Promise.all(views.map(function (view) {
            return limit(function () {
              if (run !== balanceRun) return null;
              return loadCardBalance(api, store, view, run, controller.signal);
            });
          }));
        });
      }).then(function () {
        if (run === balanceRun) updateSummary();
      }).catch(function () {
        if (run !== balanceRun) return;
        views.forEach(function (view) {
          if (view.card.balanceState === 'loading') {
            view.card.balanceState = 'none';
            setCardBalance(view, null);
          }
        });
        updateSummary();
      });
    }

    function buildAddressRow(card, row, index) {
      var item = document.createElement('li');
      item.className = 'ws-address-item';

      var idx = document.createElement('span');
      idx.className = 'ws-address-index';
      idx.textContent = '#' + index;
      item.appendChild(idx);

      var type = document.createElement('span');
      type.className = 'ws-address-type';
      type.textContent = row.type;
      item.appendChild(type);

      var code = document.createElement('code');
      code.className = 'ws-address-value mono';
      code.textContent = row.address;
      code.title = row.address;
      item.appendChild(code);

      var actions = document.createElement('span');
      actions.className = 'ws-address-actions';
      if (row.explorer) {
        var link = document.createElement('a');
        link.className = 'icon-button icon-button--outline icon-button--lg';
        link.href = row.explorer;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', 'Open ' + card.label + ' ' + row.type + ' address in explorer');
        link.setAttribute('data-tooltip', 'Open in explorer');
        link.appendChild(icon('ui-external'));
        actions.appendChild(link);
      }
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'icon-button icon-button--outline icon-button--lg';
      copy.setAttribute('aria-label', 'Copy ' + card.label + ' ' + row.type + ' address');
      copy.setAttribute('data-tooltip', 'Copy address');
      copy.appendChild(icon('ui-copy'));
      copy.addEventListener('click', function () {
        copyWithFeedback(row.address, copy, 'Copy ' + card.label + ' ' + row.type + ' address');
      });
      actions.appendChild(copy);
      item.appendChild(actions);
      return item;
    }

    function buildCard(card) {
      var article = document.createElement('article');
      article.className = 'ws-chain-card';
      article.setAttribute('data-chain', card.slug);

      var head = document.createElement('div');
      head.className = 'ws-chain-head';
      var chainIcon = icon(card.icon);
      chainIcon.classList.add('ws-chain-icon');
      head.appendChild(chainIcon);

      var name = document.createElement('span');
      name.className = 'ws-chain-name';
      name.textContent = card.label;
      var ticker = document.createElement('span');
      ticker.className = 'ws-chain-ticker';
      ticker.textContent = card.symbol;
      name.appendChild(ticker);
      head.appendChild(name);

      var balance = document.createElement('span');
      balance.className = 'ws-chain-balance';
      balance.textContent = '—';
      balance.title = 'Balance not checked yet';
      head.appendChild(balance);

      var status = document.createElement('span');
      status.className = 'ws-chain-status';
      status.textContent = 'Active';
      status.hidden = true;
      head.appendChild(status);

      article.appendChild(head);

      var list = document.createElement('ul');
      list.className = 'ws-address-list';
      card.rows.forEach(function (row, index) {
        list.appendChild(buildAddressRow(card, row, index));
      });
      article.appendChild(list);
      return { card: card, article: article, balance: balance, status: status };
    }

    function renderCards(cards, format) {
      currentCards = Array.isArray(cards) ? cards : [];
      var rows = 0;
      currentCards.forEach(function (card) { rows += card.rows.length; });
      resultsEl.hidden = false;
      cardsEl.textContent = '';
      var kind = currentRoute && currentRoute.label ? currentRoute.label + ' · ' : format + ' · ';
      metaEl.textContent = kind + currentCards.length + ' chain' + (currentCards.length === 1 ? '' : 's') +
        ' · ' + rows + ' address' + (rows === 1 ? '' : 'es');
      noteEl.textContent = currentCards.length
        ? 'Balances load in this browser through the local TTL cache. A dash means no provider answered; it is not a zero balance.'
        : 'No public address rows were derived for this input.';
      summaryEl.textContent = currentCards.length ? 'Checking balances…' : '0 active chains • 0 active addresses';
      if (copyAllBtn) copyAllBtn.disabled = !currentCards.length;
      if (csvBtn) csvBtn.disabled = !currentCards.length;
      if (!currentCards.length) {
        statusEl.textContent = noteEl.textContent;
        return;
      }
      var views = currentCards.map(function (card) {
        var view = buildCard(card);
        cardsEl.appendChild(view.article);
        return view;
      });
      statusEl.textContent = 'Derived ' + rows + ' public address' + (rows === 1 ? '' : 'es') +
        ' on ' + currentCards.length + ' chains.';
      startBalances(views);
    }

    function resolveInputBytes(route, parser, wasm) {
      if (route.kind === 'hex' && route.hex) {
        return Promise.resolve({ bytes: parser.hexToBytes(route.hex), format: 'hex' });
      }
      if (route.kind === 'brainwallet') {
        return sha256(new TextEncoder().encode(input.value.trim())).then(function (bytes) {
          return { bytes: bytes, format: 'brainwallet' };
        });
      }
      return ensureKeyTools().then(function (tools) {
        var hashes = {
          sha256: sha256,
          doubleSha256: doubleSha256,
          sha512: sha512,
          secpPublicKey: function (bytes) {
            var report = parser.deriveReport(wasm, bytes, 0);
            return parser.hexToBytes(report.pubkey_compressed);
          }
        };
        return tools.resolveKeyInput(input.value.trim(), hashes);
      });
    }

    function deriveCards(route, seq) {
      return ensureSearch().then(function (parser) {
        return loadWasm().then(function (wasm) {
          return resolveInputBytes(route, parser, wasm).then(function (parsed) {
            if (seq !== searchSeq) return null;
            var bytes = parsed.bytes instanceof Uint8Array ? parsed.bytes : new Uint8Array(parsed.bytes);
            var secpReport = null;
            var edReport = null;
            try { secpReport = parser.deriveReport(wasm, bytes, 0); } catch (err) { secpReport = null; }
            try { edReport = parser.deriveReport(wasm, bytes, 1); } catch (err) { edReport = null; }
            bytes.fill(0);
            if (seq !== searchSeq) return null;
            return ensureAddressCodecs().then(function (codecs) {
              if (seq !== searchSeq) return null;
              var extras = [];
              if (codecs && typeof codecs.derive === 'function' && secpReport) {
                var derived = codecs.derive(secpReport);
                Object.keys(derived).forEach(function (id) {
                  if (derived[id]) extras.push(derived[id]);
                });
              }
              renderCards(parser.buildCards(secpReport, edReport, extras), parsed.format);
              return null;
            });
          });
        });
      });
    }

    function startSearch() {
      hideError();
      var value = input.value.trim();
      if (!value) {
        showError('Paste a key, WIF, mnemonic or brainwallet text first.');
        input.focus();
        return;
      }
      var seq = ++searchSeq;
      cancelBalances();
      clearResults();
      setBusy(true);
      ensureKeyTools().then(function (tools) {
        var route;
        try {
          route = tools.routeKeyInput(value, selectedMode);
        } catch (err) {
          throw err;
        }
        if (!route) throw new Error('Enter a key, WIF, mnemonic or brainwallet text.');
        currentRoute = route;
        if (route.kind === 'mnemonic') {
          try {
            sessionStorage.setItem('rotor-seed-phrase', route.phrase);
            sessionStorage.setItem('rotor-seed-passphrase', passphraseEl ? passphraseEl.value : '');
            sessionStorage.setItem('rotor-seed-count', countEl ? countEl.value : '1');
          } catch (err) { /* private mode: the converter still opens without the phrase */ }
          window.location.href = '/mnemonic-converter';
          return null;
        }
        return deriveCards(route, seq);
      }).catch(function (err) {
        if (seq !== searchSeq) return;
        showError(err && err.message ? err.message : 'Cannot read that value.');
        input.focus();
      }).finally(function () {
        if (seq === searchSeq) setBusy(false);
      });
    }

    function cardBalanceTexts() {
      var out = {};
      currentCards.forEach(function (card) {
        if (card.balance) {
          var amount;
          try { amount = BigInt(String(card.balance.amount)); } catch (err) { amount = 0n; }
          out[card.slug] = formatUnits(amount, Number.isInteger(card.balance.decimals) ? card.balance.decimals : 0) +
            (card.balance.symbol ? ' ' + card.balance.symbol : '');
        } else {
          out[card.slug] = '—';
        }
      });
      return out;
    }

    function resetDialog() {
      cancelSearch();
      if (input) input.value = '';
      selectedMode = '';
      syncChips();
      refreshDetection();
      hideError();
    }

    function focusables() {
      return Array.prototype.filter.call(
        dialog.querySelectorAll('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'),
        function (element) {
          return !element.hidden && element.offsetParent !== null;
        }
      );
    }

    function open() {
      lastFocus = document.activeElement;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', 'open');
      refreshDetection();
      window.setTimeout(function () { if (input) input.focus(); }, 30);
    }

    function closeDialog() {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else {
        dialog.removeAttribute('open');
        resetDialog();
        restoreFocus();
      }
    }

    function restoreFocus() {
      if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === 'function') {
        lastFocus.focus();
      }
      lastFocus = null;
    }

    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) closeDialog();
    });
    dialog.addEventListener('close', function () {
      resetDialog();
      restoreFocus();
    });
    dialog.addEventListener('cancel', function (event) {
      event.preventDefault();
      closeDialog();
    });
    dialog.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (event.key !== 'Tab') return;
      var list = focusables();
      if (!list.length) {
        event.preventDefault();
        return;
      }
      var first = list[0];
      var last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    input.addEventListener('input', function () {
      refreshDetection();
      cancelSearch();
    });

    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        var mode = chip.getAttribute('data-mode');
        selectedMode = selectedMode === mode ? '' : mode;
        syncChips();
        refreshDetection();
        if (input.value.trim() && !resultsEl.hidden) startSearch();
      });
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      startSearch();
    });

    if (copyAllBtn) {
      copyAllBtn.addEventListener('click', function () {
        if (!currentCards.length || !window.RotorSearch) return;
        var text = window.RotorSearch.cardsToTsv(currentCards, cardBalanceTexts());
        writeClipboard(text, function done() {
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
        if (!currentCards.length || !window.RotorSearch) return;
        var text = window.RotorSearch.cardsToCsv(currentCards, cardBalanceTexts());
        var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
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
      if (link.tagName === 'A') {
        link.setAttribute('data-tooltip', 'Search (Ctrl+K)');
        if (!link.getAttribute('aria-label')) link.setAttribute('aria-label', 'Search');
      }
      link.addEventListener('click', function (event) {
        event.preventDefault();
        open();
      });
    });

    window.addEventListener('pagehide', function () {
      if (input) input.value = '';
      cancelSearch();
    });
  }

  /* Shared tooltip for any element with data-tooltip. Delegated, so rows and
   * menus rendered later get it without setup. Hover waits ~150ms; keyboard
   * focus shows it at once; a pointer press keeps it out of the way. The node
   * is fixed-position and lives on <body>, so it never shifts layout. */
  function setupTooltips() {
    var HOVER_DELAY = 150;
    var CLICK_GRACE = 500;
    var shownFor = null;
    var pendingFor = null;
    var originalDescribedBy = null;
    var timer = null;
    var tip = null;
    var pointerDownAt = 0;

    function node() {
      if (tip && tip.isConnected) return tip;
      tip = document.createElement('div');
      tip.id = 'ui-tooltip';
      tip.className = 'ui-tooltip';
      tip.setAttribute('role', 'tooltip');
      tip.hidden = true;
      document.body.appendChild(tip);
      return tip;
    }

    function targetOf(event) {
      var from = event.target;
      if (!from || typeof from.closest !== 'function') return null;
      return from.closest('[data-tooltip]');
    }

    function clearTimer() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      pendingFor = null;
    }

    function withoutTooltipId(target) {
      var value = (target.getAttribute('aria-describedby') || '').trim();
      if (!value) return '';
      return value.split(/\s+/).filter(function (part) {
        return part && part !== 'ui-tooltip';
      }).join(' ');
    }

    function place(target) {
      var el = node();
      el.style.visibility = 'hidden';
      var tipBox = el.getBoundingClientRect();
      var targetBox = target.getBoundingClientRect();
      var gap = 8;
      var edge = 8;
      var top = targetBox.top - tipBox.height - gap;
      if (top < edge) top = targetBox.bottom + gap;
      var left = targetBox.left + (targetBox.width - tipBox.width) / 2;
      var maxLeft = window.innerWidth - tipBox.width - edge;
      if (left < edge) left = edge;
      if (left > maxLeft) left = Math.max(edge, maxLeft);
      el.style.top = Math.round(top) + 'px';
      el.style.left = Math.round(left) + 'px';
      el.style.visibility = '';
    }

    function show(target) {
      if (!target || !target.isConnected) return;
      var text = target.getAttribute('data-tooltip') || '';
      if (!text) return;
      if (shownFor === target) return;
      hide();
      var el = node();
      el.textContent = text;
      el.hidden = false;
      place(target);
      shownFor = target;
      originalDescribedBy = target.getAttribute('aria-describedby');
      var ids = withoutTooltipId(target);
      target.setAttribute('aria-describedby', ids ? ids + ' ui-tooltip' : 'ui-tooltip');
    }

    function hide() {
      clearTimer();
      if (!shownFor) {
        if (tip) tip.hidden = true;
        return;
      }
      if (originalDescribedBy === null) shownFor.removeAttribute('aria-describedby');
      else shownFor.setAttribute('aria-describedby', originalDescribedBy);
      shownFor = null;
      originalDescribedBy = null;
      if (tip) tip.hidden = true;
    }

    document.addEventListener('pointerover', function (event) {
      if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      var target = targetOf(event);
      if (!target || target === shownFor || target === pendingFor) return;
      clearTimer();
      pendingFor = target;
      timer = window.setTimeout(function () {
        timer = null;
        pendingFor = null;
        show(target);
      }, HOVER_DELAY);
    });

    document.addEventListener('pointerout', function (event) {
      var target = targetOf(event);
      if (!target) return;
      var next = event.relatedTarget;
      if (next && typeof next.closest === 'function' && next.closest('[data-tooltip]') === target) return;
      clearTimer();
      if (shownFor === target) hide();
    });

    document.addEventListener('focusin', function (event) {
      var target = targetOf(event);
      if (!target) return;
      if (Date.now() - pointerDownAt < CLICK_GRACE) return;
      show(target);
    });

    document.addEventListener('focusout', function (event) {
      var target = targetOf(event);
      if (target && shownFor === target) hide();
    });

    document.addEventListener('pointerdown', function () {
      pointerDownAt = Date.now();
      hide();
    }, true);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' || event.key === 'Esc') hide();
    });

    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);

    window.RotorTooltip = { show: show, hide: hide };
  }

  installGlobalSearch();
  markNavigation();
  setupNav();
  bindKeySearches();
  setupTooltips();

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
