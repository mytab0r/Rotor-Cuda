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
    else if (path.indexOf('/brainwallet') === 0 || path.indexOf('/faq') === 0 || path.indexOf('/disclaimer') === 0 || path.indexOf('/donate') === 0) section = 'tools';
    else if (path.indexOf('/docs') === 0) section = 'docs';
    else if (path.indexOf('/key') === 0) section = 'search';
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
