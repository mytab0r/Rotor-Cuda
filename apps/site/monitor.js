/* Address monitor page. Runs in the browser; no build step, no deps.
 * The session token lives in localStorage and is never rendered. */
(function () {
  'use strict';

  var TOKEN_KEY = 'rotor-monitor-token';
  var API = '/api/v1/monitor';
  var POLL_MS = 15000;
  var PROVIDER_ORDER = ['evm', 'solana', 'tron', 'btc'];
  var CHAIN_LABELS = { evm: 'EVM', solana: 'Solana', tron: 'TRON', btc: 'Bitcoin' };
  var PROVIDER_HINTS = {
    evm: 'not detected — install MetaMask or Rabby',
    solana: 'not detected — install Phantom',
    tron: 'not detected — install TronLink',
    btc: 'not detected — install Unisat'
  };
  var WALLET_NOTE = 'No browser wallet was detected. Rotor signs you in with a one-time challenge: ' +
    'your wallet signs it, and the signature proves the address is yours. EVM (MetaMask/Rabby), ' +
    'Solana (Phantom) and TRON (TronLink) can sign in, and WalletConnect links a mobile EVM wallet ' +
    'over QR (EVM only in this build). Bitcoin (Unisat) has no signature scheme yet: ' +
    'after signing in with another chain you can import its addresses as unverified. No private key, ' +
    'WIF or seed phrase is ever requested. Install a wallet and reload this page.';

  var state = {
    token: '',
    user: null,
    settings: { recovery_opt_in: false, alerts_enabled: false },
    watches: [],
    events: [],
    settingsDirty: false,
    busy: false,
    busyChain: '',
    refreshing: false,
    pollTimer: null
  };

  function byId(id) { return document.getElementById(id); }

  var els = {
    logout: byId('monitor-logout'),
    walletState: byId('monitor-wallet-state'),
    walletError: byId('monitor-wallet-error'),
    providers: {
      evm: byId('monitor-connect-evm'),
      solana: byId('monitor-connect-solana'),
      tron: byId('monitor-connect-tron'),
      btc: byId('monitor-connect-btc')
    },
    walletconnect: byId('monitor-connect-walletconnect'),
    providerNote: byId('monitor-provider-note'),
    accountLine: byId('monitor-account-line'),
    account: byId('monitor-account'),
    copyAccount: byId('monitor-copy-account'),
    noWallet: byId('monitor-no-wallet'),
    walletNote: byId('monitor-wallet-note'),
    copyWalletNote: byId('monitor-copy-wallet-note'),
    identities: byId('monitor-identities'),
    identitiesState: byId('monitor-identities-state'),
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
    renderProviders();
  }

  /* --------------------------------------------------------------- rendering */

  function renderAccount() {
    var address = state.user && state.user.address ? String(state.user.address) : '';
    if (!address) {
      var ids = identityList(state.user);
      var primary = ids.filter(function (identity) { return identity.verified === true; })[0] || ids[0];
      address = primary ? String(primary.address) : '';
    }
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

  /* Identities are the wallets linked to the account. Fall back to the primary
   * address for backends that do not send an `identities` array yet. */
  function identityList(user) {
    var raw = user && Array.isArray(user.identities) ? user.identities : [];
    var out = [];
    raw.forEach(function (identity) {
      if (identity && identity.address) out.push(identity);
    });
    if (!out.length && user && user.address) {
      out.push({ chain: 'evm', address: String(user.address), verified: true });
    }
    return out;
  }

  function chainLabel(chain) {
    var text = typeof chain === 'string' ? chain.toLowerCase() : '';
    return CHAIN_LABELS[text] || (text ? text.toUpperCase() : 'CHAIN');
  }

  function identityItem(identity) {
    var li = document.createElement('li');
    li.className = 'monitor-identity';

    var chain = document.createElement('span');
    var token = chainToken(identity.chain);
    chain.className = 'monitor-chain' + (token ? ' monitor-chain-' + token : '');
    chain.textContent = chainLabel(identity.chain);
    li.appendChild(chain);

    var address = document.createElement('code');
    address.className = 'mono monitor-watch-address';
    address.textContent = identity.address || '';
    li.appendChild(address);

    var verified = document.createElement('span');
    verified.className = identity.verified === true ? 'monitor-verified' : 'monitor-unverified';
    verified.textContent = identity.verified === true ? 'verified' : 'unverified';
    li.appendChild(verified);

    return li;
  }

  function renderIdentities() {
    els.identities.textContent = '';
    if (!state.token) {
      els.identitiesState.textContent = 'Sign in to see the wallets linked to this cabinet.';
      els.identitiesState.hidden = false;
      return;
    }
    var list = identityList(state.user);
    if (!list.length) {
      els.identitiesState.textContent = 'No identities yet.';
      els.identitiesState.hidden = false;
      return;
    }
    els.identitiesState.hidden = true;
    list.forEach(function (identity) {
      els.identities.appendChild(identityItem(identity));
    });
  }

  function hasVerifiedIdentity(chain, address) {
    var target = String(address).toLowerCase();
    return identityList(state.user).some(function (identity) {
      return identity.verified === true &&
        String(identity.chain || '').toLowerCase() === chain &&
        String(identity.address || '').toLowerCase() === target;
    });
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
    chain.textContent = chainLabel(watch.chain);
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
    }    els.watchlistState.hidden = true;
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

  /* --------------------------------------------------------- wallet adapters */

  function evmProvider() {
    var eth = window.ethereum;
    return eth && typeof eth.request === 'function' ? eth : null;
  }

  function solanaProvider() {
    var phantom = window.phantom && window.phantom.solana;
    if (phantom && typeof phantom.connect === 'function') return phantom;
    var sol = window.solana;
    return sol && typeof sol.connect === 'function' ? sol : null;
  }

  function tronWebInstance() {
    if (window.tronWeb && window.tronWeb.defaultAddress) return window.tronWeb;
    if (window.tronLink && window.tronLink.tronWeb) return window.tronLink.tronWeb;
    return window.tronWeb || null;
  }

  function tronProvider() {
    var link = window.tronLink;
    if (link && typeof link.request === 'function') return link;
    return tronWebInstance() ? window.tronWeb || window.tronLink : null;
  }

  function bitcoinProvider() {
    var unisat = window.unisat;
    return unisat && typeof unisat.requestAccounts === 'function' ? unisat : null;
  }

  function detectProvider(chain) {
    switch (chain) {
      case 'evm': return evmProvider();
      case 'solana': return solanaProvider();
      case 'tron': return tronProvider();
      case 'btc': return bitcoinProvider();
      default: return null;
    }
  }

  /* WalletConnect is lazy: the bundle is fetched only when the card is used. */
  var walletConnectLoader = null;

  function walletConnectMetadata() {
    return {
      name: 'Rotor Cabinet',
      description: 'Watch addresses and get alerts',
      url: location.origin,
      icons: [location.origin + '/favicon.ico']
    };
  }

  function loadWalletConnectBundle() {
    if (window.RotorWC && typeof window.RotorWC.connect === 'function') {
      return Promise.resolve(window.RotorWC);
    }
    if (walletConnectLoader) return walletConnectLoader;
    walletConnectLoader = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = '/walletconnect.js';
      script.async = true;
      script.onload = function () {
        if (window.RotorWC && typeof window.RotorWC.connect === 'function') {
          resolve(window.RotorWC);
        } else {
          walletConnectLoader = null;
          reject(new Error('The WalletConnect bundle did not initialise.'));
        }
      };
      script.onerror = function () {
        walletConnectLoader = null;
        reject(new Error('Could not load the WalletConnect bundle.'));
      };
      document.head.appendChild(script);
    });
    return walletConnectLoader;
  }

  /* The coordinator verifies Solana signatures as hex (or Base64). Phantom
   * returns raw bytes, so encode them as lowercase hex. */
  function hexEncode(bytes) {
    if (typeof bytes === 'string') return bytes;
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var byte = bytes[i] & 0xff;
      out += (byte < 16 ? '0' : '') + byte.toString(16);
    }
    return out;
  }

  var ADAPTERS = {
    evm: {
      connect: function (eth) {
        return eth.request({ method: 'eth_requestAccounts' }).then(function (accounts) {
          if (!Array.isArray(accounts) || !accounts.length) {
            throw new Error('The wallet returned no account.');
          }
          return accounts;
        });
      },
      addresses: function (eth, connected) {
        return eth.request({ method: 'eth_accounts' }).then(function (accounts) {
          return Array.isArray(accounts) && accounts.length ? accounts : connected;
        }).catch(function () { return connected; });
      },
      sign: function (eth, message, address) {
        return eth.request({ method: 'personal_sign', params: [message, address] }).then(function (signature) {
          if (typeof signature !== 'string' || !signature) {
            throw new Error('The wallet returned no signature.');
          }
          return signature;
        });
      }
    },
    solana: {
      connect: function (wallet) {
        return Promise.resolve(wallet.connect()).then(function () {
          var key = wallet.publicKey;
          if (!key) throw new Error('The wallet returned no public key.');
          return [String(key)];
        });
      },
      addresses: function (wallet, connected) { return connected; },
      sign: function (wallet, message) {
        var bytes = new TextEncoder().encode(message);
        return Promise.resolve(wallet.signMessage(bytes, 'utf8')).then(function (result) {
          var signature = result && result.signature ? result.signature : result;
          if (!signature || typeof signature.length !== 'number') {
            throw new Error('The wallet returned no signature.');
          }
          return hexEncode(signature);
        });
      }
    },
    tron: {
      connect: function (link) {
        var request = link && typeof link.request === 'function'
          ? Promise.resolve(link.request({ method: 'tron_requestAccounts' }))
          : Promise.resolve();
        return request.then(function (result) {
          if (result && result.code !== undefined && String(result.code) !== '200') {
            throw new Error('TronLink did not authorize the connection.');
          }
          var tronWeb = tronWebInstance();
          var address = tronWeb && tronWeb.defaultAddress ? tronWeb.defaultAddress.base58 : '';
          if (!address) throw new Error('TronLink returned no address.');
          return [String(address)];
        });
      },
      addresses: function (link, connected) { return connected; },
      sign: function (link, message) {
        var tronWeb = tronWebInstance();
        if (!tronWeb || !tronWeb.trx || typeof tronWeb.trx.signMessageV2 !== 'function') {
          throw new Error('TronLink does not support message signing.');
        }
        return Promise.resolve(tronWeb.trx.signMessageV2(message)).then(function (signature) {
          if (typeof signature !== 'string' || !signature) {
            throw new Error('TronLink returned no signature.');
          }
          return signature;
        });
      }
    },
    btc: {
      connect: function (unisat) {
        return Promise.resolve(unisat.requestAccounts()).then(function (accounts) {
          if (!Array.isArray(accounts) || !accounts.length) {
            throw new Error('Unisat returned no account.');
          }
          return accounts;
        });
      },
      addresses: function (unisat, connected) { return connected; },
      sign: null
    }
  };

  function renderWalletConnectProvider() {
    var button = els.walletconnect;
    if (!button) return;
    var hint = button.querySelector('[data-provider-hint]');
    var busy = state.busy && state.busyChain === 'walletconnect';
    button.disabled = state.busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
    var label;
    if (busy) label = 'connecting…';
    else if (!state.token) label = 'sign in with a mobile wallet';
    else label = 'link or import';
    if (hint) hint.textContent = label;
  }

  function renderProviders() {
    var anyDetected = false;
    PROVIDER_ORDER.forEach(function (chain) {
      var button = els.providers[chain];
      if (!button) return;
      var hint = button.querySelector('[data-provider-hint]');
      var detected = !!detectProvider(chain);
      if (detected) anyDetected = true;
      button.disabled = !detected || state.busy;
      var label;
      if (!detected) {
        label = PROVIDER_HINTS[chain];
      } else if (state.busy && state.busyChain === chain) {
        label = 'connecting…';
      } else if (!state.token) {
        label = chain === 'btc' ? 'sign in with another chain first' : 'sign in';
      } else {
        label = chain === 'btc' ? 'import addresses (unverified)' : 'link or import';
      }
      if (hint) hint.textContent = label;
    });
    renderWalletConnectProvider();
    els.noWallet.hidden = anyDetected;
  }

  function walletConnectErrorMessage(err) {
    if (!err) return 'WalletConnect request failed.';
    var message = err.message ? String(err.message) : '';
    if (err.code === 4001 || /reject|denied|cancel|closed|declin|expired|timeout/i.test(message)) {
      return 'The WalletConnect request was rejected, closed or timed out. Nothing was sent to Rotor.';
    }
    return 'WalletConnect error: ' + (message || 'unknown error');
  }

  function walletErrorMessage(err, chain) {
    if (!err) return 'Wallet request failed.';
    var label = chainLabel(chain);
    var message = err.message ? String(err.message) : '';
    if (err.code === 4001 || /reject|denied|cancel/i.test(message)) {
      return 'The ' + label + ' wallet request was rejected. Nothing was sent to Rotor.';
    }
    if (err.code === -32002) {
      return 'A wallet request is already pending. Open your wallet and approve or reject it.';
    }
    return label + ' wallet error: ' + (message || 'unknown error');
  }

  function setConnectBusy(busy, chain) {
    state.busy = busy;
    state.busyChain = busy ? chain || '' : '';
    renderProviders();
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
    renderAccount();
    renderIdentities();
    renderProviders();
    setWalletState('No session.', 'muted');
    if (message) showWalletError(message);
  }

  function disconnectProviders() {
    var jobs = [];
    function attempt(wallet) {
      if (wallet && typeof wallet.disconnect === 'function') {
        jobs.push(Promise.resolve().then(function () {
          return wallet.disconnect();
        }).catch(function () { /* best effort */ }));
      }
    }
    var eth = evmProvider();
    if (eth) {
      if (typeof eth.disconnect === 'function') {
        attempt(eth);
      } else if (typeof eth.request === 'function') {
        jobs.push(Promise.resolve().then(function () {
          return eth.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
        }).catch(function () { /* best effort */ }));
      }
    }
    attempt(solanaProvider());
    attempt(window.tronLink);
    attempt(bitcoinProvider());
    return Promise.all(jobs);
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
    try {
      await disconnectProviders();
    } catch (err) {
      /* Provider disconnects are best effort. */
    }
    resetSession('');
    setWalletState('Signed out. Connect a wallet to sign in again.', 'muted');
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
      if (Array.isArray(me.identities)) {
        state.user = Object.assign({}, state.user || {}, { identities: me.identities });
      }
      var settings = me.settings || (me.user && me.user.settings) || state.settings;
      state.settings = settingsFrom(settings);
      state.watches = Array.isArray(me.watches) ? me.watches : [];
      state.events = Array.isArray(me.events) ? me.events : [];
      hideSessionError();
      renderAccount();
      renderIdentities();
      renderProviders();
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

  function mergeWatches(returned) {
    if (!Array.isArray(returned) || !returned.length) return;
    var byKey = {};
    state.watches.forEach(function (watch) {
      if (watch && watch.address) byKey[(watch.chain || '') + '|' + watch.address] = watch;
    });
    returned.forEach(function (watch) {
      if (watch && watch.address) byKey[(watch.chain || '') + '|' + watch.address] = watch;
    });
    state.watches = Object.keys(byKey).map(function (key) { return byKey[key]; });
    renderWatches(state.watches);
  }

  async function importAddressList(chain, addresses) {
    var seen = {};
    var payload = [];
    (Array.isArray(addresses) ? addresses : []).forEach(function (address) {
      if (typeof address !== 'string' || !address) return;
      var key = address.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      payload.push({ chain: chain, address: address });
    });
    if (!payload.length) return 0;
    var result = await api('/addresses', { method: 'POST', body: { addresses: payload } });
    if (result && Array.isArray(result.watches)) mergeWatches(result.watches);
    return payload.length;
  }

  async function importProviderAddresses(chain, wallet, connected) {
    var addresses = connected;
    try {
      var listed = await ADAPTERS[chain].addresses(wallet, connected);
      if (Array.isArray(listed) && listed.length) addresses = listed;
    } catch (err) {
      /* Keep the addresses the connect step already returned. */
    }
    return importAddressList(chain, addresses);
  }

  async function connectProvider(chain) {
    hideWalletError();
    hideSessionError();
    var wallet = detectProvider(chain);
    if (!wallet) {
      showWalletError('No ' + chainLabel(chain) + ' wallet was detected in this browser (' +
        PROVIDER_HINTS[chain].replace('not detected — ', '') + ').');
      if (state.token) setWalletState('Session active.', 'ok');
      else setWalletState('No ' + chainLabel(chain) + ' wallet detected.', 'muted');
      return;
    }
    if (chain === 'btc' && !state.token) {
      showWalletError('Bitcoin addresses can only be imported after you sign in with EVM, Solana or TRON. Connect a signing wallet first.');
      setWalletState('No session.', 'muted');
      return;
    }
    if (state.busy) return;

    var linking = !!state.token;
    var loggedIn = false;
    setConnectBusy(true, chain);
    setWalletState('Connecting to ' + chainLabel(chain) + '…', 'muted');
    try {
      var addresses = await ADAPTERS[chain].connect(wallet);
      var primary = addresses[0];
      if (!primary) throw new Error('The wallet returned no address.');

      /* Bitcoin has no server-side signature verification yet: with an
       * existing session its addresses are imported as unverified. */
      if (chain === 'btc') {
        setWalletState('Importing Bitcoin addresses…', 'muted');
        var btcCount = await importProviderAddresses('btc', wallet, addresses);
        await refresh();
        setWalletState('Imported ' + btcCount + ' Bitcoin address(es). They stay unverified until a Bitcoin signature scheme ships.', 'ok');
        return;
      }

      /* A verified identity of this chain is already linked: import any other
       * accounts it exposes instead of creating another session. */
      if (linking && hasVerifiedIdentity(chain, primary)) {
        setWalletState('Importing ' + chainLabel(chain) + ' addresses…', 'muted');
        var importedCount = await importProviderAddresses(chain, wallet, addresses);
        await refresh();
        setWalletState('Imported ' + importedCount + ' ' + chainLabel(chain) + ' address(es).', 'ok');
        return;
      }

      setWalletState('Requesting a sign-in challenge…', 'muted');
      var challenge = await api('/challenge', {
        method: 'POST',
        body: { chain: chain, address: primary },
        token: ''
      });
      if (!challenge || typeof challenge.message !== 'string' || !challenge.message) {
        throw new Error('The coordinator returned no challenge message.');
      }

      setWalletState('Waiting for your signature…', 'muted');
      var signature = await ADAPTERS[chain].sign(wallet, challenge.message, primary);

      setWalletState(linking ? 'Linking this wallet…' : 'Signing in…', 'muted');
      var body = { chain: chain, message: challenge.message, signature: signature };
      if (linking) body.link = true;
      var login = await api('/login', {
        method: 'POST',
        body: body,
        token: linking ? state.token : ''
      });

      if (!linking) {
        if (!login || typeof login.token !== 'string' || !login.token) {
          throw new Error('The coordinator returned no session token.');
        }
        /* Store the token; never render it. */
        saveToken(login.token);
        state.token = login.token;
      } else if (login && typeof login.token === 'string' && login.token) {
        saveToken(login.token);
        state.token = login.token;
      }
      if (!linking || state.token) loggedIn = true;

      if (login && login.user) state.user = login.user;
      else if (!linking) state.user = { address: primary };
      if (login && login.user && login.user.settings) {
        state.settings = settingsFrom(login.user.settings);
      }
      state.settingsDirty = false;
      setAuthenticated(true);
      hideSessionError();
      renderAccount();
      renderIdentities();
      renderSettings(state.settings);
      els.watchlistState.textContent = 'Loading watchlist…';
      els.watchlistState.hidden = false;
      els.eventsState.textContent = 'Loading events…';
      els.eventsState.hidden = false;
      setWalletState(linking ? 'Wallet linked.' : 'Signed in.', 'ok');
      if (!linking) startPolling();

      var imported = 0;
      try {
        imported = await importProviderAddresses(chain, wallet, addresses);
      } catch (err) {
        showWalletError((linking ? 'Wallet linked' : 'Signed in') +
          ', but the addresses could not all be imported: ' +
          (err && err.message ? err.message : 'unknown error'));
      }
      await refresh();
      setWalletState((linking ? 'Wallet linked' : 'Signed in') + '. Imported ' + imported +
        ' ' + chainLabel(chain) + ' address(es).', 'ok');
    } catch (err) {
      if (err && err.status !== undefined) {
        if (err.status === 401 && linking) {
          resetSession('Your session expired or was rejected. Sign in again with a signing wallet.');
          return;
        }
        var prefix = chain === 'btc' ? 'Import failed'
          : (loggedIn ? 'Import failed' : (linking ? 'Linking failed' : 'Sign-in failed'));
        showWalletError(prefix + ': ' + (err.message || 'request failed') + '.');
        if (!state.token) setWalletState('No session.', 'muted');
        else setWalletState('Session active.', 'ok');
      } else {
        showWalletError(walletErrorMessage(err, chain));
        if (!state.token) setWalletState('No session.', 'muted');
        else setWalletState('Session active.', 'ok');
      }
    } finally {
      setConnectBusy(false);
    }
  }

  async function connectWalletConnect() {
    hideWalletError();
    hideSessionError();
    if (state.busy) return;

    var linking = !!state.token;
    var loggedIn = false;
    var provider = null;
    setConnectBusy(true, 'walletconnect');
    setWalletState('Checking WalletConnect configuration…', 'muted');
    try {
      var config = await api('/config', { token: '' });
      var projectId = config && typeof config.walletconnect_project_id === 'string'
        ? config.walletconnect_project_id.trim() : '';
      if (!projectId) {
        showWalletError('WalletConnect is not configured on this server. Use a browser wallet for now, or ask the operator to set a project ID.');
        setWalletState(state.token ? 'Session active.' : 'No session.', state.token ? 'ok' : 'muted');
        return;
      }

      setWalletState('Loading WalletConnect…', 'muted');
      var sdk = await loadWalletConnectBundle();
      setWalletState('Scan the QR code with your mobile wallet…', 'muted');
      provider = await sdk.connect({ projectId: projectId, metadata: walletConnectMetadata() });
      var accounts = provider && Array.isArray(provider.accounts)
        ? provider.accounts.filter(function (address) { return typeof address === 'string' && address; })
        : [];
      if (!accounts.length) throw new Error('WalletConnect returned no EVM account.');
      var primary = accounts[0];

      /* Already linked to this session: import the exposed accounts without a
       * second sign-in, matching the injected wallet adapters. */
      if (linking && hasVerifiedIdentity('evm', primary)) {
        setWalletState('Importing WalletConnect addresses…', 'muted');
        var linkedCount = await importAddressList('evm', accounts);
        await refresh();
        setWalletState('Imported ' + linkedCount + ' WalletConnect address(es).', 'ok');
        return;
      }

      setWalletState('Requesting a sign-in challenge…', 'muted');
      var challenge = await api('/challenge', {
        method: 'POST',
        body: { chain: 'evm', address: primary },
        token: ''
      });
      if (!challenge || typeof challenge.message !== 'string' || !challenge.message) {
        throw new Error('The coordinator returned no challenge message.');
      }

      setWalletState('Waiting for your signature in the mobile wallet…', 'muted');
      var signature = await provider.request({
        method: 'personal_sign',
        params: [challenge.message, primary]
      });
      if (typeof signature !== 'string' || !signature) {
        throw new Error('The wallet returned no signature.');
      }

      setWalletState(linking ? 'Linking this wallet…' : 'Signing in…', 'muted');
      var body = { chain: 'evm', message: challenge.message, signature: signature };
      if (linking) body.link = true;
      var login = await api('/login', {
        method: 'POST',
        body: body,
        token: linking ? state.token : ''
      });

      if (!linking) {
        if (!login || typeof login.token !== 'string' || !login.token) {
          throw new Error('The coordinator returned no session token.');
        }
        /* Store the token; never render or log it. */
        saveToken(login.token);
        state.token = login.token;
      } else if (login && typeof login.token === 'string' && login.token) {
        saveToken(login.token);
        state.token = login.token;
      }
      loggedIn = true;

      if (login && login.user) state.user = login.user;
      else if (!linking) state.user = { address: primary };
      if (login && login.user && login.user.settings) {
        state.settings = settingsFrom(login.user.settings);
      }
      state.settingsDirty = false;
      setAuthenticated(true);
      hideSessionError();
      renderAccount();
      renderIdentities();
      renderSettings(state.settings);
      els.watchlistState.textContent = 'Loading watchlist…';
      els.watchlistState.hidden = false;
      els.eventsState.textContent = 'Loading events…';
      els.eventsState.hidden = false;
      setWalletState(linking ? 'Wallet linked.' : 'Signed in.', 'ok');
      if (!linking) startPolling();

      var imported = 0;
      try {
        imported = await importAddressList('evm', accounts);
      } catch (err) {
        showWalletError((linking ? 'Wallet linked' : 'Signed in') +
          ', but the WalletConnect addresses could not all be imported: ' +
          (err && err.message ? err.message : 'unknown error'));
      }
      await refresh();
      setWalletState((linking ? 'Wallet linked' : 'Signed in') + '. Imported ' + imported +
        ' WalletConnect address(es).', 'ok');
    } catch (err) {
      if (err && err.status !== undefined) {
        if (err.status === 401 && linking) {
          resetSession('Your session expired or was rejected. Sign in again with a signing wallet.');
          return;
        }
        var prefix = loggedIn ? 'Import failed' : (linking ? 'Linking failed' : 'Sign-in failed');
        showWalletError(prefix + ': ' + (err.message || 'request failed') + '.');
        if (!state.token) setWalletState('No session.', 'muted');
        else setWalletState('Session active.', 'ok');
      } else {
        showWalletError(walletConnectErrorMessage(err));
        if (!state.token) setWalletState('No session.', 'muted');
        else setWalletState('Session active.', 'ok');
      }
    } finally {
      /* Closing the WC session is best effort; never block the cabinet on it. */
      if (provider && typeof provider.disconnect === 'function') {
        Promise.resolve().then(function () { return provider.disconnect(); }).catch(function () {});
      }
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
    if (chain !== 'evm' && chain !== 'solana' && chain !== 'tron' && chain !== 'btc') {
      setAddError('Choose EVM, Solana, TRON or Bitcoin.');
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

  PROVIDER_ORDER.forEach(function (chain) {
    var button = els.providers[chain];
    if (button) button.addEventListener('click', function () { connectProvider(chain); });
  });
  if (els.walletconnect) els.walletconnect.addEventListener('click', connectWalletConnect);
  els.logout.addEventListener('click', logout);
  els.addForm.addEventListener('submit', addAddress);
  els.settingsForm.addEventListener('submit', saveSettings);
  els.recovery.addEventListener('change', function () { state.settingsDirty = true; });
  els.alerts.addEventListener('change', function () { state.settingsDirty = true; });
  els.copyAccount.addEventListener('click', function () {
    copyText(els.account.textContent, els.copyAccount);
  });
  els.copyWalletNote.addEventListener('click', function () {
    copyText(WALLET_NOTE, els.copyWalletNote);
  });
  window.addEventListener('pagehide', stopPolling);

  els.walletNote.textContent = WALLET_NOTE;
  setAuthenticated(false);
  renderAccount();
  renderIdentities();
  renderWatches([]);
  renderEvents([]);
  renderSettings(state.settings);
  els.eventsState.textContent = 'Sign in to load the event feed.';
  els.eventsState.hidden = false;

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
