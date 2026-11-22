/* WalletConnect deep-link builders and mobile detection.
 *
 * Pure functions: no DOM and no network. Loaded before the lazily fetched
 * WalletConnect bundle and before monitor.js. The bundle only produces the
 * connection URI; this file turns it into links a wallet app can open and
 * decides whether the cabinet should show a QR code or navigate on mobile. */
(function () {
  'use strict';

  var WALLETS = [
    { id: 'metamask', name: 'MetaMask', prefix: 'https://metamask.app.link/wc?uri=' },
    { id: 'trust', name: 'Trust Wallet', prefix: 'https://link.trustwallet.com/wc?uri=' },
    { id: 'rainbow', name: 'Rainbow', prefix: 'https://rainbow.me/wc?uri=' },
    { id: 'coinbase', name: 'Coinbase Wallet', prefix: 'https://go.cb-w.com/wc?uri=' }
  ];

  function walletById(id) {
    for (var i = 0; i < WALLETS.length; i += 1) {
      if (WALLETS[i].id === id) return WALLETS[i];
    }
    return null;
  }

  /* One scheme guard for every builder. A WalletConnect URI always starts
   * with `wc:`; accepting any other string would let a caller put
   * `javascript:`, `data:` or an arbitrary URL into an anchor href or a
   * location target. Empty and non-string inputs stay empty. */
  function uriText(uri) {
    return typeof uri === 'string' && uri.indexOf('wc:') === 0 ? uri : '';
  }

  /* A wallet deep link carries the whole `wc:` URI as one encoded query value. */
  function deepLink(id, uri) {
    var wallet = walletById(id);
    var text = uriText(uri);
    if (!wallet || !text) return '';
    return wallet.prefix + encodeURIComponent(text);
  }

  /* The generic link is the bare `wc:` URI; the OS or an installed wallet
   * handles it. Kept as a function so callers never branch on the value. */
  function genericLink(uri) {
    return uriText(uri);
  }

  /* iPhone and iPad user agents do not contain "Android"; the task's set is
   * enough for the two mobile platforms WalletConnect deep links target. */
  function isMobile(userAgent) {
    return /Android|iPhone|iPad/.test(String(userAgent == null ? '' : userAgent));
  }

  var api = {
    wallets: WALLETS.map(function (wallet) {
      return { id: wallet.id, name: wallet.name };
    }),
    deepLink: deepLink,
    genericLink: genericLink,
    isMobile: isMobile
  };

  var root = typeof globalThis !== 'undefined' ? globalThis : window;
  root.RotorWcLinks = api;
})();
