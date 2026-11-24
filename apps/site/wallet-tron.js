/* TRON mainnet/Nile wallet codec (pure browser/Node code, no DOM).
 *
 * This module owns the parts of the TRON send flow that can be tested without
 * a browser:
 *  - the network descriptors for TRON mainnet and the Nile testnet, built from
 *    data/chains.json and data/providers.json through the generated globals;
 *  - the mainnet arm gate and the pinned provider allowlist (a user-supplied
 *    endpoint is refused);
 *  - the review TTL (a stale review is not signed);
 *  - exact TRX/base-unit parsing and display with the shared RotorAmount.
 *
 * The transaction encoding and signing live in the WASM core
 * (crates/rotor-wasm/src/tron.rs); this module never holds a private key. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorTronWallet = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Chain identity and public providers come from data/*.json through the
   * generated globals in chains.generated.js (loaded before this script). */
  var SSOT_ROOT = typeof globalThis !== 'undefined' ? globalThis : this;
  var SSOT_CHAINS = SSOT_ROOT.RotorChains;
  var SSOT_PROVIDERS = SSOT_ROOT.RotorProviders;
  var AMOUNT = SSOT_ROOT.RotorAmount;

  /* TRX uses six decimals; a TRC-20 amount is parsed with the token's own
   * decimals, which the caller supplies. */
  var TRON_DECIMALS = SSOT_CHAINS.bySlug.tron.decimals;

  /* A review older than the node's expiration window is refused at confirm
   * and rebuilt from fresh node data. 60 seconds matches the TRON expiration
   * window this wallet requests. */
  var TRON_REVIEW_TTL_MS = 60000;

  /* One descriptor per signable TRON network. The provider lists are the
   * declared nodes from data/providers.json, never a page-local copy. The
   * mainnet order is the failover order: TronGrid first, publicnode second.
   * Both are keyless and CORS-enabled (`GET /wallet/getnowblock` returned
   * HTTP 200 with `Access-Control-Allow-Origin: *` on 2026-11-24); the static
   * site ships no API key, so TronGrid's keyless rate limit applies. */
  var TRON_NETWORKS = [
    {
      slug: 'tron',
      name: SSOT_CHAINS.bySlug.tron.name,
      symbol: SSOT_CHAINS.bySlug.tron.symbol,
      decimals: SSOT_CHAINS.bySlug.tron.decimals,
      testnet: false,
      explorerTx: SSOT_CHAINS.bySlug.tron.explorerTxPrefix,
      explorerAddress: SSOT_CHAINS.bySlug.tron.explorerPrefix,
      providers: [
        SSOT_PROVIDERS.find('tron', 'trongrid'),
        SSOT_PROVIDERS.find('tron', 'publicnode')
      ]
    },
    {
      slug: 'tron-nile',
      name: SSOT_CHAINS.bySlug['tron-nile'].name,
      symbol: SSOT_CHAINS.bySlug['tron-nile'].symbol,
      decimals: SSOT_CHAINS.bySlug['tron-nile'].decimals,
      testnet: true,
      explorerTx: SSOT_CHAINS.bySlug['tron-nile'].explorerTxPrefix,
      explorerAddress: SSOT_CHAINS.bySlug['tron-nile'].explorerPrefix,
      providers: SSOT_PROVIDERS.byChain['tron-nile']
    }
  ];

  function tronNetworks() {
    return TRON_NETWORKS.slice();
  }

  function tronNetworkBySlug(slug) {
    for (var i = 0; i < TRON_NETWORKS.length; i += 1) {
      if (TRON_NETWORKS[i].slug === slug) return TRON_NETWORKS[i];
    }
    return null;
  }

  /* A TRON mainnet send is only allowed after the user arms it for the
   * session. This check lives in the codec, not only in the DOM; it runs again
   * at confirm. Nile stays selectable without arming. */
  function assertTronMainnetArmed(network, armed) {
    if (network && network.testnet) return;
    if (armed !== true) {
      throw new Error('Mainnet signing is not armed. Tick "I understand this spends real ' +
        network.symbol + ' on ' + network.name + ' for this session" before signing.');
    }
  }

  /* The network's descriptor table is the allowlist: a URL that is not a
   * declared provider for this exact network is refused, so a user-supplied
   * endpoint (or a provider of another network) can never receive a signed
   * transaction. */
  function assertTronProvider(network, url) {
    var providers = network && network.providers ? network.providers : [];
    for (var i = 0; i < providers.length; i += 1) {
      if (providers[i] && providers[i].url === url) return providers[i];
    }
    throw new Error('The endpoint ' + String(url) + ' is not a declared TRON provider for ' +
      (network ? network.name : 'this network') + '. Refusing to sign.');
  }

  /* Refuse a review that is older than the node's expiration window. `now`
   * defaults to the wall clock and is injected in tests. */
  function assertReviewFresh(review, now) {
    var builtAt = review ? review.builtAt : undefined;
    var at = now === undefined ? Date.now() : now;
    if (typeof builtAt !== 'number' || !isFinite(builtAt) || typeof at !== 'number' || !isFinite(at)) {
      throw new Error('The TRON review has no build time; rebuild it from fresh node data before signing.');
    }
    if (at - builtAt > TRON_REVIEW_TTL_MS) {
      throw new Error('The TRON review is stale (older than 60 seconds); rebuild it from fresh ' +
        'node data before signing.');
    }
  }

  /* Exact decimal to base units (BigInt, no float). The shared RotorAmount
   * rejects a sign, exponent, comma or excess fraction digits. */
  function parseTronAmount(text, decimals) {
    return AMOUNT.parseUnits(text, decimals);
  }

  /* Exact base units to a plain decimal string. */
  function formatTronAmount(value, decimals) {
    return AMOUNT.formatUnits(value, decimals);
  }

  return {
    TRON_NETWORKS: TRON_NETWORKS,
    TRON_DECIMALS: TRON_DECIMALS,
    TRON_REVIEW_TTL_MS: TRON_REVIEW_TTL_MS,
    tronNetworks: tronNetworks,
    tronNetworkBySlug: tronNetworkBySlug,
    assertTronMainnetArmed: assertTronMainnetArmed,
    assertTronProvider: assertTronProvider,
    assertReviewFresh: assertReviewFresh,
    parseTronAmount: parseTronAmount,
    formatTronAmount: formatTronAmount
  };
});
