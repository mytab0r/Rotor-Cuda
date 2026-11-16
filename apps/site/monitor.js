/* Address monitor page. Runs in the browser; no build step, no deps.
 * The session token lives in localStorage and is never rendered. */
(function () {
  'use strict';

  var TOKEN_KEY = 'rotor-monitor-token';
  var API = '/api/v1/monitor';
  var POLL_MS = 15000;
  var SIWE_NOTE = 'No EVM wallet was detected in this browser. Rotor Monitor signs you in with a ' +
    'Sign-In with Ethereum (EIP-4361) message: your wallet signs a one-time challenge, and the ' +
    'signature proves the address is yours. No private key, WIF or seed phrase is ever requested. ' +
    'Install or open a browser wallet (MetaMask, Rabby, Frame) and reload this page.';

  var state = {
    token: '',
    user: null,
    settings: { recovery_opt_in: false, alerts_enabled: false },
    watches: [],
    events: [],
    settingsDirty: false,
    busy: false,
    refreshing: false,
    pollTimer: null
  };

  function byId(id) { return document.getElementById(id); }

  var els = {
    connect: byId('monitor-connect'),
    logout: byId('monitor-logout'),
    walletState: byId('monitor-wallet-state'),
    walletError: byId('monitor-wallet-error'),
    accountLine: byId('monitor-account-line'),
    account: byId('monitor-account'),
    copyAccount: byId('monitor-copy-account'),
    noWallet: byId('monitor-no-wallet'),
    siweNote: byId('monitor-siwe-note'),
    copySiwe: byId('monitor-copy-siwe'),
    sessionError: byId('monitor-session-error'),
    watches: byId('monitor-watches'),
    watchlistState: byId('monitor-watchlist-state'),
    watchlistError: byId('monitor-watchlist-error'),
    addForm: byId('monitor-add-form'),
    addChain: byId('monitor-add-chain'),
    addAddress: byId('monitor-add-address'),
    addLabel: byId('monitor-add-label'),
    addSubmit: byId('monitor-add-submit'),
    addError: byId('monitor-add-error'),
    addStatus: byId('monitor-add-status'),
    events: byId('monitor-events'),
    eventsState: byId('monitor-events-state'),
    settingsForm: byId('monitor-settings-form'),
    recovery: byId('monitor-recovery-opt-in'),
    alerts: byId('monitor-alerts-enabled'),
    settingsSave: byId('monitor-settings-save'),
    settingsError: byId('monitor-settings-error'),
    settingsStatus: byId('monitor-settings-status')
  };

  /* ------------------------------------------------------------------- api */

  async function request(path, options) {
    var settings = options || {};
    var headers = {};
    if (settings.body !== undefined) headers['Content-Type'] = 'application/json';
    var bearer = settings.token !== undefined ? settings.token : state.token;
    if (bearer) headers.Authorization = 'Bearer ' + bearer;

    var response;
    try {
      response = await fetch(path, {
        method: settings.method || 'GET',
        headers: headers,
        body: settings.body !== undefined ? JSON.stringify(settings.body) : undefined
      });
    } catch (err) {
      var network = new Error('network error: ' + (err && err.message ? err.message : String(err)));
      network.status = 0;
      throw network;
    }

    var text = await response.text();
    var data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (err) { data = null; }
    }
    if (!response.ok) {
      var message = data && data.error ? data.error : 'HTTP ' + response.status;
      var failure = new Error(message);
      failure.status = response.status;
      throw failure;
    }
    return data;
  }

  function api(path, options) { return request(API + path, options); }

  /* ---------------------------------------------------------------- storage */

  function storedToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (err) { return ''; }
  }

  function saveToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (err) {
      /* private mode: the session stays in memory only */
    }
  }

  /* ---------------------------------------------------------------- widgets */

  function setWalletState(message, kind) {
    els.walletState.textContent = message;
    els.walletState.className = kind === 'ok' ? 'ok' : (kind === 'err' ? 'err' : 'muted');
  }

  function hideWalletError() {
    els.walletError.textContent = '';
    els.walletError.hidden = true;
  }

  function showWalletError(message) {
    els.walletError.textContent = message;
    els.walletError.hidden = false;
  }

  function hideSessionError() {
    els.sessionError.textContent = '';
    els.sessionError.hidden = true;
  }

  function showSessionError(message) {
    els.sessionError.textContent = message;
    els.sessionError.hidden = false;
  }

  function hideWatchlistError() {
    els.watchlistError.textContent = '';
    els.watchlistError.hidden = true;
  }

  function showWatchlistError(message) {
    els.watchlistError.textContent = message;
    els.watchlistError.hidden = false;
  }

  function setAddError(message) {
    els.addError.textContent = message || '';
    els.addError.hidden = !message;
  }

  function setSettingsError(message) {
    els.settingsError.textContent = message || '';
    els.settingsError.hidden = !message;
  }

  function setStatus(el, message, kind) {
    el.textContent = message || '';
    el.hidden = !message;
    el.classList.toggle('ok', kind === 'ok');
    el.classList.toggle('err', kind === 'err');
  }

  function setAuthenticated(active) {
    els.logout.disabled = !active;
    els.addChain.disabled = !active;
    els.addAddress.disabled = !active;
    els.addLabel.disabled = !active;
    els.addSubmit.disabled = !active;
    els.addSubmit.textContent = 'Add address';
    els.recovery.disabled = !active;
    els.alerts.disabled = !active;
    els.settingsSave.disabled = !active;
    els.settingsSave.textContent = 'Save settings';
  }

  /* --------------------------------------------------------------- rendering */

  function renderAccount() {
    var address = state.user && state.user.address ? String(state.user.address) : '';
    if (!address) {
      els.accountLine.hidden = true;
      els.account.textContent = '';
      els.copyAccount.hidden = true;
      return;
    }
    els.account.textContent = address;
    els.accountLine.hidden = false;
    els.copyAccount.hidden = false;
  }

  function formatValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    return String(value);
  }

  function formatTime(value) {
    if (value === null || value === undefined || value === '') return 'never';
    var numeric = typeof value === 'number' || /^\d+$/.test(String(value));
    var ms = numeric ? Number(value) : Date.parse(String(value));
    if (!isFinite(ms)) return String(value);
    if (numeric && ms < 1e12) ms *= 1000;
    var date = new Date(ms);
    return isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function metaField(label, value) {
    var wrap = document.createElement('span');
    wrap.className = 'monitor-meta-field';
    var name = document.createElement('span');
    name.className = 'monitor-meta-label';
    name.textContent = label;
    var val = document.createElement('span');
    val.className = 'monitor-meta-value mono';
    val.textContent = value;
    wrap.appendChild(name);
    wrap.appendChild(val);
    return wrap;
  }

  function chainToken(chain) {
    var text = typeof chain === 'string' ? chain.toLowerCase() : '';
    return /^[a-z]+$/.test(text) ? text : '';
  }

  function watchItem(watch) {
    var li = document.createElement('li');
    li.className = 'monitor-watch';

    var head = document.createElement('div');
    head.className = 'monitor-watch-head';

    var chain = document.createElement('span');
    var chainClass = chainToken(watch.chain);
    chain.className = 'monitor-chain' + (chainClass ? ' monitor-chain-' + chainClass : '');
    chain.textContent = watch.chain ? String(watch.chain).toUpperCase() : 'CHAIN';
    head.appendChild(chain);

    var address = document.createElement('code');
    address.className = 'mono monitor-watch-address';
    address.textContent = watch.address || '';
    head.appendChild(address);

    if (watch.label) {
      var label = document.createElement('span');
      label.className = 'monitor-watch-label';
      label.textContent = String(watch.label);
      head.appendChild(label);
    }

    var verified = document.createElement('span');
    verified.className = watch.verified ? 'monitor-verified' : 'monitor-unverified';
    verified.textContent = watch.verified ? 'verified' : 'unverified';
    head.appendChild(verified);

    li.appendChild(head);

    var meta = document.createElement('div');
    meta.className = 'monitor-watch-meta';
    meta.appendChild(metaField('Balance', formatValue(watch.last_balance)));
    meta.appendChild(metaField('Nonce', formatValue(watch.last_nonce)));
    meta.appendChild(metaField('Last seen', formatTime(watch.last_seen_at)));
    li.appendChild(meta);

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'monitor-remove';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + (watch.address || 'address') + ' from the watchlist');
    remove.addEventListener('click', function () { removeWatch(watch, remove); });
    li.appendChild(remove);

    return li;
  }

  function renderWatches(watches) {
    els.watches.textContent = '';
    var items = Array.isArray(watches) ? watches : [];
    var shown = 0;
    items.forEach(function (watch) {
      if (!watch || !watch.address) return;
      els.watches.appendChild(watchItem(watch));
      shown += 1;
    });
    if (!shown) {
      els.watchlistState.textContent = 'No addresses are watched yet. Connect a wallet or add an address below.';
      els.watchlistState.hidden = false;
      return;
    }
    els.watchlistState.hidden = true;
  }

  function severityToken(value) {
    var text = typeof value === 'string' ? value.toLowerCase() : '';
    return ['critical', 'high', 'medium', 'low', 'info'].indexOf(text) >= 0 ? text : 'info';
  }

  function eventItem(event) {
    var li = document.createElement('li');
    li.className = 'monitor-event monitor-severity-' + severityToken(event.severity);

    var head = document.createElement('div');
    head.className = 'monitor-event-head';

    var kind = document.createElement('span');
    kind.className = 'monitor-event-kind';
    kind.textContent = event.kind ? String(event.kind) : 'event';
    head.appendChild(kind);

    var severity = document.createElement('span');
    severity.className = 'monitor-event-severity';
    severity.textContent = event.severity ? String(event.severity) : 'info';
    head.appendChild(severity);

    var time = document.createElement('span');
    time.className = 'monitor-event-time';
    time.textContent = formatTime(event.at);
    head.appendChild(time);

    li.appendChild(head);

    if (event.detail !== null && event.detail !== undefined && event.detail !== '') {
      var detail = document.createElement('p');
      detail.className = 'monitor-event-detail';
      detail.textContent = typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail);
      li.appendChild(detail);
    }

    var who = document.createElement('p');
    who.className = 'monitor-event-who mono';
    who.textContent = (event.chain ? String(event.chain) : '') + ' · ' + (event.address ? String(event.address) : '');
    li.appendChild(who);

    return li;
  }

  function renderEvents(events) {
    els.events.textContent = '';
    var items = Array.isArray(events) ? events : [];
    if (!items.length) {
      els.eventsState.textContent = 'No events yet. Activity on a watched address will appear here.';
      els.eventsState.hidden = false;
      return;
    }
    els.eventsState.hidden = true;
    items.slice(0, 50).forEach(function (event) {
      if (event) els.events.appendChild(eventItem(event));
    });
  }

  function settingsFrom(source) {
    var s = source && typeof source === 'object' ? source : {};
    return {
      recovery_opt_in: s.recovery_opt_in === true,
      alerts_enabled: s.alerts_enabled === true
    };
  }

  function renderSettings(settings) {
    var s = settingsFrom(settings);
    els.recovery.checked = s.recovery_opt_in;
    els.alerts.checked = s.alerts_enabled;
  }

  /* ------------------------------------------------------------------ flow */

  function provider() {
    var eth = window.ethereum;
    return eth && typeof eth.request === 'function' ? eth : null;
  }

  function showNoWallet() {
    els.noWallet.hidden = false;
  }

  function walletErrorMessage(err) {
    if (!err) return 'Wallet request failed.';
    var message = err.message ? String(err.message) : '';
    if (err.code === 4001 || /reject|denied|cancel/i.test(message)) {
      return 'Wallet request was rejected. Nothing was sent to Rotor.';
    }
    if (err.code === -32002) {
      return 'A wallet request is already pending. Open your wallet and approve or reject it.';
    }
    return 'Wallet error: ' + (message || 'unknown error');
  }

  function watchPayload(addresses) {
    var seen = {};
    var out = [];
    (Array.isArray(addresses) ? addresses : []).forEach(function (address) {
      if (typeof address !== 'string' || !address) return;
      var key = address.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push({ chain: 'evm', address: address });
    });
    return out;
  }

  function setConnectBusy(busy) {
    els.connect.disabled = busy;
    els.connect.textContent = busy ? 'Connecting…' : 'Connect wallet';
  }

  function stopPolling() {
    if (state.pollTimer !== null) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = window.setInterval(refresh, POLL_MS);
  }

  function resetSession(message) {
    stopPolling();
    saveToken('');
    state.token = '';
    state.user = null;
    state.settings = settingsFrom({});
    state.watches = [];
    state.events = [];
    state.settingsDirty = false;
    setAuthenticated(false);
    hideWalletError();
    hideSessionError();
    hideWatchlistError();
    els.accountLine.hidden = true;
    els.account.textContent = '';
    els.copyAccount.hidden = true;
    els.watches.textContent = '';
    els.watchlistState.textContent = 'Sign in to load your watchlist.';
    els.watchlistState.hidden = false;
    els.events.textContent = '';
    els.eventsState.textContent = 'Sign in to load the event feed.';
    els.eventsState.hidden = false;
    renderSettings(state.settings);
    setWalletState('No session.', 'muted');
    if (message) showWalletError(message);
  }

  async function logout() {
    var token = state.token;
    stopPolling();
    if (token) {
      try {
        await api('/logout', { method: 'POST', token: token });
      } catch (err) {
        /* Signing out locally must work even when the server is unreachable. */
      }
    }
    resetSession('');
    setWalletState('Signed out. Connect the wallet to sign in again.', 'muted');
  }

  async function refresh() {
    if (!state.token || state.refreshing) return;
    var token = state.token;
    state.refreshing = true;
    try {
      var me = await api('/me');
      if (state.token !== token) return;
      if (!me || typeof me !== 'object') throw new Error('unexpected response');
      state.user = me.user || state.user;
      var settings = me.settings || (me.user && me.user.settings) || state.settings;
      state.settings = settingsFrom(settings);
      state.watches = Array.isArray(me.watches) ? me.watches : [];
      state.events = Array.isArray(me.events) ? me.events : [];
      hideSessionError();
      renderAccount();
      renderWatches(state.watches);
      renderEvents(state.events);
      if (!state.settingsDirty) renderSettings(state.settings);
      setWalletState('Session active. Refreshing every 15 s.', 'ok');
    } catch (err) {
      if (state.token !== token) return;
      if (err && err.status === 401) {
        resetSession('Your session expired or was rejected. Connect the wallet again.');
        return;
      }
      showSessionError('Could not refresh the monitor: ' + (err && err.message ? err.message : 'unknown error'));
    } finally {
      state.refreshing = false;
    }
  }

  async function connectWallet() {
    hideWalletError();
    var eth = provider();
    if (!eth) {
      showNoWallet();
      setWalletState('No wallet detected.', 'muted');
      return;
    }
    if (state.busy) return;
    state.busy = true;
    setConnectBusy(true);
    setWalletState('Connecting…', 'muted');
    try {
      var accounts = await eth.request({ method: 'eth_requestAccounts' });
      if (!Array.isArray(accounts) || !accounts.length) throw new Error('The wallet returned no account.');
      var primary = accounts[0];

      setWalletState('Requesting a sign-in challenge…', 'muted');
      var challenge = await api('/challenge', { method: 'POST', body: { address: primary }, token: '' });
      if (!challenge || typeof challenge.message !== 'string' || !challenge.message) {
        throw new Error('The coordinator returned no challenge message.');
      }

      setWalletState('Waiting for your signature…', 'muted');
      var signature = await eth.request({ method: 'personal_sign', params: [challenge.message, primary] });
      if (typeof signature !== 'string' || !signature) throw new Error('The wallet returned no signature.');

      setWalletState('Signing in…', 'muted');
      var login = await api('/login', {
        method: 'POST',
        body: { message: challenge.message, signature: signature },
        token: ''
      });
      if (!login || typeof login.token !== 'string' || !login.token) {
        throw new Error('The coordinator returned no session token.');
      }

      /* Store the token; never render it. */
      saveToken(login.token);
      state.token = login.token;
      state.user = login.user || { address: primary };
      state.settings = settingsFrom(login.user && login.user.settings);
      state.settingsDirty = false;
      setAuthenticated(true);
      hideSessionError();
      renderAccount();
      renderSettings(state.settings);
      els.watchlistState.textContent = 'Loading watchlist…';
      els.watchlistState.hidden = false;
      els.eventsState.textContent = 'Loading events…';
      els.eventsState.hidden = false;
      setWalletState('Signed in.', 'ok');

      /* Import every EVM account the wallet exposes as a watch. */
      var all = [primary];
      try {
        var listed = await eth.request({ method: 'eth_accounts' });
        if (Array.isArray(listed) && listed.length) all = listed;
      } catch (err) {
        /* Keep the account that just signed in. */
      }
      var payload = watchPayload(all);
      if (payload.length) {
        try {
          await api('/addresses', { method: 'POST', body: { addresses: payload } });
        } catch (err) {
          showWalletError('Signed in, but the wallet addresses could not all be imported: ' +
            (err && err.message ? err.message : 'unknown error'));
        }
      }

      await refresh();
      startPolling();
    } catch (err) {
      if (err && err.status !== undefined) {
        showWalletError('Sign-in failed: ' + (err.message || 'request failed') + '. Nothing was saved.');
      } else {
        showWalletError(walletErrorMessage(err));
      }
      setWalletState('No session.', 'muted');
    } finally {
      state.busy = false;
      setConnectBusy(false);
    }
  }

  async function addAddress(event) {
    event.preventDefault();
    setAddError('');
    setStatus(els.addStatus, '', '');
    if (!state.token) {
      setAddError('Connect the wallet before adding an address.');
      return;
    }
    var chain = els.addChain.value;
    var address = els.addAddress.value.trim();
    var label = els.addLabel.value.trim();
    if (!address) {
      setAddError('Enter an address.');
      return;
    }
    if (chain !== 'evm' && chain !== 'btc') {
      setAddError('Choose EVM or Bitcoin.');
      return;
    }
    els.addSubmit.disabled = true;
    els.addSubmit.textContent = 'Adding…';
    try {
      var body = { addresses: [{ chain: chain, address: address }] };
      if (label) body.addresses[0].label = label;
      await api('/addresses', { method: 'POST', body: body });
      els.addAddress.value = '';
      els.addLabel.value = '';
      setStatus(els.addStatus, 'Added ' + chain.toUpperCase() + ' address ' + address +
        '. It stays unverified; only your sign-in address is marked verified.', 'ok');
      await refresh();
    } catch (err) {
      setAddError('Could not add the address: ' + (err && err.message ? err.message : 'unknown error'));
    } finally {
      els.addSubmit.disabled = !state.token;
      els.addSubmit.textContent = 'Add address';
    }
  }

  async function removeWatch(watch, button) {
    if (!state.token) return;
    hideWatchlistError();
    button.disabled = true;
    button.textContent = 'Removing…';
    try {
      await api('/addresses/' + encodeURIComponent(String(watch.chain || '')) + '/' +
        encodeURIComponent(String(watch.address || '')), { method: 'DELETE' });
      await refresh();
    } catch (err) {
      showWatchlistError('Could not remove that address: ' +
        (err && err.message ? err.message : 'unknown error'));
      button.disabled = false;
      button.textContent = 'Remove';
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    setSettingsError('');
    setStatus(els.settingsStatus, '', '');
    if (!state.token) {
      setSettingsError('Connect the wallet before changing settings.');
      return;
    }
    els.settingsSave.disabled = true;
    els.settingsSave.textContent = 'Saving…';
    try {
      var body = { recovery_opt_in: els.recovery.checked, alerts_enabled: els.alerts.checked };
      var data = await api('/settings', { method: 'PATCH', body: body });
      var updated;
      if (data && data.settings) updated = data.settings;
      else if (data && (data.recovery_opt_in !== undefined || data.alerts_enabled !== undefined)) updated = data;
      else updated = body;
      state.settings = settingsFrom(updated);
      state.settingsDirty = false;
      renderSettings(state.settings);
      setStatus(els.settingsStatus, 'Settings saved.', 'ok');
    } catch (err) {
      setSettingsError('Could not save settings: ' + (err && err.message ? err.message : 'unknown error'));
    } finally {
      els.settingsSave.textContent = 'Save settings';
      els.settingsSave.disabled = !state.token;
    }
  }

  /* ------------------------------------------------------------- clipboard */

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

  function copyText(text, button) {
    var original = button.textContent;
    function done() {
      button.textContent = 'Copied';
      button.disabled = true;
      window.setTimeout(function () {
        button.textContent = original;
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

  /* ---------------------------------------------------------------- events */

  els.connect.addEventListener('click', connectWallet);
  els.logout.addEventListener('click', logout);
  els.addForm.addEventListener('submit', addAddress);
  els.settingsForm.addEventListener('submit', saveSettings);
  els.recovery.addEventListener('change', function () { state.settingsDirty = true; });
  els.alerts.addEventListener('change', function () { state.settingsDirty = true; });
  els.copyAccount.addEventListener('click', function () {
    copyText(els.account.textContent, els.copyAccount);
  });
  els.copySiwe.addEventListener('click', function () {
    copyText(SIWE_NOTE, els.copySiwe);
  });
  window.addEventListener('pagehide', stopPolling);

  els.siweNote.textContent = SIWE_NOTE;
  setAuthenticated(false);
  renderWatches([]);
  renderEvents([]);
  renderSettings(state.settings);
  els.eventsState.textContent = 'Sign in to load the event feed.';
  els.eventsState.hidden = false;

  if (!provider()) showNoWallet();

  var saved = storedToken();
  if (saved) {
    state.token = saved;
    setAuthenticated(true);
    setWalletState('Restoring session…', 'muted');
    els.watchlistState.textContent = 'Loading watchlist…';
    els.watchlistState.hidden = false;
    els.eventsState.textContent = 'Loading events…';
    els.eventsState.hidden = false;
    startPolling();
    refresh();
  } else {
    setWalletState('No session.', 'muted');
  }
})();
