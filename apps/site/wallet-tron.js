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

  /* A review older than this is refused at confirm and rebuilt from fresh
   * node data. The on-chain expiration is deliberately longer (see
   * TRON_EXPIRATION_MS) so a confirm near the end of the review window still
   * produces a transaction the node accepts. */
  var TRON_REVIEW_TTL_MS = 60000;

  /* The transaction's on-chain expiration window. It must be strictly longer
   * than the review window: otherwise a review confirmed at second 59 would
   * build a transaction that is already expired. */
  var TRON_EXPIRATION_MS = 90000;

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

  /* --------------------------------------------------- network discrimination */

  /* The cabinet picker uses explicit `evm:<id>` / `tron:<slug>` values so a
   * TRON network is never forced into a fake numeric chain id. */
  var TRON_OPTION_PREFIX = 'tron:';

  function tronOptionValue(slug) {
    return TRON_OPTION_PREFIX + slug;
  }

  function tronNetworkFromOption(value) {
    if (typeof value !== 'string' || value.indexOf(TRON_OPTION_PREFIX) !== 0) return null;
    return tronNetworkBySlug(value.slice(TRON_OPTION_PREFIX.length));
  }

  /* The send form caption/placeholder set for each family. The cabinet swaps
   * these with the same isTron switch that selects the fields; a TRON
   * recipient is a base58 T-address, not a 0x address. */
  function sendFieldLabels(isTron) {
    if (isTron) {
      return {
        toLabel: 'To (TRON address, T...)',
        toPlaceholder: 'T...',
        tokenLabel: 'Token contract (optional; TRC-20, T address)',
        tokenPlaceholder: 'Leave empty for TRX',
        dataHidden: true
      };
    }
    return {
      toLabel: 'To (0x address; EIP-55 mixed case or all-lowercase)',
      toPlaceholder: '0x...',
      tokenLabel: 'Token contract (optional ERC-20, 0x address)',
      tokenPlaceholder: 'Leave empty for the native coin',
      dataHidden: false
    };
  }

  function errorText(err) {
    return err && err.message ? err.message : String(err);
  }

  function fieldError(field, message) {
    var err = new Error(message);
    err.fieldErrors = {};
    err.fieldErrors[field] = message;
    return err;
  }

  /* ------------------------------------------------------------ provider order */

  /* The selected provider is tried first, then the declared failover order.
   * A user-supplied URL is refused before anything is fetched. */
  function tronProviderOrder(network, preferredUrl) {
    if (!preferredUrl) return network.providers.slice();
    var chosen = assertTronProvider(network, preferredUrl);
    var ordered = [chosen];
    network.providers.forEach(function (provider) {
      if (provider.url !== chosen.url) ordered.push(provider);
    });
    return ordered;
  }

  function tronEndpoint(provider, path) {
    return String(provider.url).replace(/\/+$/, '') + path;
  }

  function fetchJsonGet(fetchJson, url) {
    return Promise.resolve(fetchJson(url, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    }));
  }

  function fetchJsonPost(fetchJson, url, body) {
    return Promise.resolve(fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }));
  }

  /* Derive the TAPOS reference fields from a `getnowblock` response:
   * ref_block_bytes = blockID bytes 6-7, ref_block_hash = bytes 8-15, and a
   * 90-second expiration from the block timestamp (longer than the 60-second
   * review window, so a late confirm is still valid on chain). */
  function parseNowBlock(block) {
    var blockId = block && block.blockID;
    if (typeof blockId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(blockId)) {
      throw new Error('The TRON getnowblock response has no 64-hex blockID.');
    }
    var id = blockId.toLowerCase();
    var header = block.block_header && block.block_header.raw_data;
    var timestamp = header && header.timestamp;
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new Error('The TRON getnowblock response has no safe timestamp.');
    }
    var number = header && header.number;
    return {
      blockID: id,
      blockNumber: typeof number === 'number' && Number.isSafeInteger(number)
        ? String(number)
        : '',
      ref_block_bytes: id.slice(12, 16),
      ref_block_hash: id.slice(16, 32),
      timestamp: String(timestamp),
      expiration: String(BigInt(timestamp) + BigInt(TRON_EXPIRATION_MS))
    };
  }

  /* Fetch the latest block, trying the preferred provider first and then the
   * declared order. The first valid response wins; there is no retry of a
   * successful response and no host outside the allowlist. */
  async function fetchNowBlock(network, fetchJson, preferredUrl) {
    if (typeof fetchJson !== 'function') {
      throw new Error('TRON reads need a fetch function.');
    }
    var providers = tronProviderOrder(network, preferredUrl || null);
    var failures = [];
    for (var i = 0; i < providers.length; i += 1) {
      var provider = providers[i];
      try {
        var block = await fetchJsonGet(fetchJson,
          tronEndpoint(provider, '/wallet/getnowblock'));
        return {
          provider: provider,
          providerUrl: provider.url,
          providerLabel: provider.label || provider.url,
          block: parseNowBlock(block)
        };
      } catch (err) {
        failures.push((provider.label || provider.url) + ': ' + errorText(err));
      }
    }
    throw new Error('No declared ' + network.name + ' provider answered getnowblock' +
      (failures.length > 1 ? ' (tried ' + failures.length + ' endpoints)' : '') +
      '. ' + failures.join(' | '));
  }

  /* ------------------------------------------------------- TRC-20 token reads */

  function tokenConstant(fetchJson, network, providerUrl, owner, contract, selector) {
    var provider = assertTronProvider(network, providerUrl);
    return fetchJsonPost(fetchJson,
      tronEndpoint(provider, '/wallet/triggerconstantcontract'), {
        owner_address: owner,
        contract_address: contract,
        function_selector: selector,
        parameter: '',
        visible: true
      }).then(function (response) {
        var results = response && response.constant_result;
        if (!Array.isArray(results) || typeof results[0] !== 'string' || !results[0]) {
          throw new Error('The token ' + selector + ' call returned no data.');
        }
        var hex = results[0].toLowerCase();
        if (!/^[0-9a-f]+$/.test(hex)) {
          throw new Error('The token ' + selector + ' call returned non-hex data.');
        }
        return hex;
      });
  }

  function decodeTokenDecimals(hex) {
    if (hex.length < 64) throw new Error('The token decimals call returned no uint256 value.');
    var value = BigInt('0x' + hex.slice(0, 64));
    if (value > 24n) {
      throw new Error('The token reports ' + value.toString() +
        ' decimals; this wallet signs token amounts with 0 to 24 decimals only.');
    }
    return Number(value);
  }

  /* ABI string: [offset=32][length][data]. Returns null when the token does
   * not answer with a readable symbol; the review then says "unknown". */
  function decodeTokenSymbol(hex) {
    try {
      if (hex.length < 128 || !/^0{62}20$/.test(hex.slice(0, 64))) return null;
      var length = Number(BigInt('0x' + hex.slice(64, 128)));
      if (!Number.isSafeInteger(length) || length < 1 || length > 32) return null;
      var dataHex = hex.slice(128, 128 + length * 2);
      if (dataHex.length !== length * 2) return null;
      var bytes = new Uint8Array(length);
      for (var i = 0; i < length; i += 1) {
        bytes[i] = parseInt(dataHex.slice(i * 2, i * 2 + 2), 16);
      }
      var text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return /^[\x20-\x7e]+$/.test(text) ? text : null;
    } catch (err) {
      return null;
    }
  }

  /* ------------------------------------------------------------- validation */

  function parseFeeLimit(text) {
    var value = typeof text === 'string' ? text.trim() : '';
    if (!value) return 0n;
    var sun = parseTronAmount(value, TRON_DECIMALS);
    if (sun > 100000000n) {
      throw new Error('The fee limit exceeds 100 TRX (100000000 sun).');
    }
    return sun;
  }

  /* Validate the synchronous part of the form: recipient, token (which picks
   * the kind) and fee limit. The amount is parsed later with the token's own
   * decimals, once they are read from the node. */
  function validateTronSend(form) {
    var input = form || {};
    var errors = {};
    var values = { to: null, token: null, kind: 'trx', feeLimitSun: 0n };

    var to = typeof input.to === 'string' ? input.to.trim() : '';
    if (!to) errors.to = 'Enter the TRON recipient address (T...).';
    else values.to = to;

    var token = typeof input.token === 'string' ? input.token.trim() : '';
    if (token) {
      values.token = token;
      values.kind = 'trc20';
    }

    var fee;
    try {
      fee = parseFeeLimit(input.feeLimit);
    } catch (err) {
      errors.feeLimit = errorText(err);
    }
    if (fee !== undefined) values.feeLimitSun = fee;
    if (values.kind === 'trx' && fee !== undefined && fee !== 0n) {
      errors.feeLimit = 'A fee limit applies to TRC-20 token transfers only; ' +
        'leave it empty for a plain TRX transfer.';
    }

    return { errors: errors, values: values };
  }

  /* The strict WASM request. A TRX request omits `token_contract_address`;
   * a TRC-20 request carries it. The amount is always raw base units. */
  function buildTransferRequest(fields) {
    var request = {
      kind: fields.kind,
      owner_address: fields.from,
      to_address: fields.to,
      amount: fields.amountBase.toString(),
      ref_block_bytes: fields.block.ref_block_bytes,
      ref_block_hash: fields.block.ref_block_hash,
      expiration: fields.block.expiration,
      timestamp: fields.block.timestamp,
      fee_limit: fields.feeLimitSun.toString()
    };
    if (fields.kind === 'trc20') {
      if (!fields.tokenContract) {
        throw new Error('A TRC-20 transfer needs a token contract address.');
      }
      request.token_contract_address = fields.tokenContract;
    }
    return request;
  }

  function parseTxResult(text) {
    var value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw new Error('The local core returned a non-JSON TRON transaction.');
    }
    if (!value || typeof value !== 'object' ||
        typeof value.txID !== 'string' || !/^[0-9a-f]{64}$/.test(value.txID) ||
        typeof value.raw_data_hex !== 'string' || !/^[0-9a-f]+$/.test(value.raw_data_hex)) {
      throw new Error('The local core returned an unexpected TRON transaction.');
    }
    return value;
  }

  /* Pin the request at confirm: rebuild it from the reviewed display fields
   * and compare every value, so a review mutated after preparation cannot
   * sign a different recipient, amount, token, fee or block. */
  function assertReviewedTron(review) {
    var expected = buildTransferRequest({
      kind: review.kind,
      from: review.from,
      to: review.to,
      amountBase: review.amountBase,
      tokenContract: review.tokenContract,
      feeLimitSun: review.feeLimitSun,
      block: review.block
    });
    var request = review.request;
    if (!request || typeof request !== 'object') {
      throw new Error('The reviewed TRON request is missing. Refusing to sign.');
    }
    var expectedKeys = Object.keys(expected);
    var requestKeys = Object.keys(request);
    var same = expectedKeys.length === requestKeys.length;
    if (same) {
      for (var i = 0; i < expectedKeys.length; i += 1) {
        var key = expectedKeys[i];
        if (!Object.prototype.hasOwnProperty.call(request, key) ||
            String(request[key]) !== String(expected[key])) {
          same = false;
          break;
        }
      }
    }
    if (!same) {
      throw new Error('The reviewed TRON transaction fields do not match the request ' +
        'that would be signed. Refusing to sign.');
    }
  }

  function explorerTxUrl(network, txid) {
    if (network.explorerTx) return network.explorerTx + txid;
    var chain = SSOT_CHAINS.bySlug[network.slug];
    var template = chain && chain.explorer;
    if (typeof template !== 'string') return null;
    var base = template.replace(/#\/address\/\{address\}$/, '#/transaction/');
    return base === template ? null : base + txid;
  }

  /* --------------------------------------------------------- prepare/confirm */

  /* Build a review from fresh node data. Nothing is signed here. options:
   * { network, form, from, fetchJson, providerUrl?, mainnetArmed?,
   *   unsigned(request) -> JSON text, now? } */
  async function prepareTronTransfer(options) {
    var settings = options || {};
    var network = settings.network;
    if (!network) throw new Error('Select a TRON network first.');
    assertTronMainnetArmed(network, settings.mainnetArmed);
    var validation = validateTronSend(settings.form);
    if (Object.keys(validation.errors).length) {
      var invalid = new Error('Fix the highlighted fields before review.');
      invalid.fieldErrors = validation.errors;
      throw invalid;
    }
    if (typeof settings.unsigned !== 'function') {
      throw new Error('The local unsigned-transaction builder is unavailable.');
    }

    var fresh = await fetchNowBlock(network, settings.fetchJson, settings.providerUrl || null);
    var values = validation.values;
    var decimals = TRON_DECIMALS;
    var symbol = null;
    if (values.kind === 'trc20') {
      var decimalsHex = await tokenConstant(settings.fetchJson, network, fresh.providerUrl,
        settings.from, values.token, 'decimals()');
      decimals = decodeTokenDecimals(decimalsHex);
      try {
        symbol = decodeTokenSymbol(await tokenConstant(settings.fetchJson, network,
          fresh.providerUrl, settings.from, values.token, 'symbol()'));
      } catch (err) {
        symbol = null;
      }
    }

    var amountText = settings.form && typeof settings.form.amount === 'string'
      ? settings.form.amount
      : '';
    var amountBase;
    try {
      amountBase = parseTronAmount(amountText, decimals);
    } catch (err) {
      throw fieldError('value', values.kind === 'trc20'
        ? 'Enter the token amount as a plain decimal with at most ' + decimals + ' decimal places.'
        : 'Enter the TRX amount as a plain decimal with at most 6 decimal places.');
    }
    if (amountBase <= 0n) throw fieldError('value', 'The amount must be greater than zero.');

    var request = buildTransferRequest({
      kind: values.kind,
      from: settings.from,
      to: values.to,
      amountBase: amountBase,
      tokenContract: values.token,
      feeLimitSun: values.feeLimitSun,
      block: fresh.block
    });
    var tx = parseTxResult(await Promise.resolve(settings.unsigned(request)));

    return {
      family: 'tron',
      kind: values.kind,
      networkSlug: network.slug,
      networkName: network.name,
      testnet: network.testnet,
      symbol: network.symbol,
      from: settings.from,
      to: values.to,
      tokenContract: values.token,
      tokenSymbol: symbol,
      tokenDecimals: decimals,
      amountBase: amountBase,
      amountDisplay: formatTronAmount(amountBase, decimals),
      feeLimitSun: values.feeLimitSun,
      block: fresh.block,
      request: request,
      tx: tx,
      builtAt: settings.now === undefined ? Date.now() : settings.now,
      providerUrl: fresh.providerUrl,
      providerLabel: fresh.providerLabel,
      warnings: ['This TRON transaction is irreversible once it is broadcast.']
    };
  }

  /* Sign the reviewed request and broadcast exactly once to the reviewed
   * provider. A stale review or an unarmed mainnet is refused before signing.
   * options: { review, fetchJson, sign(request) -> JSON text, mainnetArmed?,
   *            now? } */
  async function confirmTronTransfer(options) {
    var settings = options || {};
    var review = settings.review;
    if (!review || typeof review !== 'object') {
      throw new Error('Prepare and review the transaction first.');
    }
    var network = tronNetworkBySlug(review.networkSlug);
    if (!network) throw new Error('The reviewed TRON network is unknown.');
    assertReviewedTron(review);
    assertTronMainnetArmed(network, settings.mainnetArmed);
    assertReviewFresh(review, settings.now);
    var provider = assertTronProvider(network, review.providerUrl);
    if (typeof settings.sign !== 'function') {
      throw new Error('Local signing is unavailable.');
    }
    if (typeof settings.fetchJson !== 'function') {
      throw new Error('The TRON provider is missing from the review.');
    }

    var signed = parseTxResult(await Promise.resolve(settings.sign(review.request)));
    if (typeof signed.signature !== 'string' || !/^[0-9a-f]{130}$/.test(signed.signature)) {
      throw new Error('The local core returned no TRON signature.');
    }
    /* What you see is what you sign: the signed bytes must be exactly the
     * reviewed bytes. A signer that returns different raw_data (a swapped
     * recipient, amount or token) is refused before anything is broadcast. */
    if (!review.tx || signed.raw_data_hex !== review.tx.raw_data_hex) {
      throw new Error('The signed transaction bytes do not match the reviewed bytes. ' +
        'Refusing to broadcast.');
    }
    /* One broadcast, no retry: the provider error is surfaced verbatim. */
    var response;
    try {
      response = await fetchJsonPost(settings.fetchJson,
        tronEndpoint(provider, '/wallet/broadcasttransaction'), {
          txID: signed.txID,
          raw_data: signed.raw_data,
          raw_data_hex: signed.raw_data_hex,
          signature: [signed.signature]
        });
    } catch (err) {
      throw new Error('Broadcasting to ' + (provider.label || provider.url) +
        ' failed: ' + errorText(err));
    }
    if (!response || response.result !== true) {
      var detail = '';
      if (response && response.code) detail += ' (' + response.code + ')';
      if (response && response.message) detail += ' ' + response.message;
      throw new Error((provider.label || provider.url) + ' rejected the transaction' + detail + '.');
    }
    return {
      txHash: signed.txID,
      txID: signed.txID,
      signedHex: JSON.stringify({
        txID: signed.txID,
        raw_data: signed.raw_data,
        raw_data_hex: signed.raw_data_hex,
        signature: [signed.signature]
      }),
      chainName: network.name,
      symbol: network.symbol,
      testnet: network.testnet,
      providerUrl: provider.url,
      providerLabel: provider.label || provider.url,
      explorerUrl: explorerTxUrl(network, signed.txID)
    };
  }

  return {
    TRON_NETWORKS: TRON_NETWORKS,
    TRON_DECIMALS: TRON_DECIMALS,
    TRON_REVIEW_TTL_MS: TRON_REVIEW_TTL_MS,
    TRON_EXPIRATION_MS: TRON_EXPIRATION_MS,
    tronNetworks: tronNetworks,
    tronNetworkBySlug: tronNetworkBySlug,
    assertTronMainnetArmed: assertTronMainnetArmed,
    assertTronProvider: assertTronProvider,
    assertReviewFresh: assertReviewFresh,
    parseTronAmount: parseTronAmount,
    formatTronAmount: formatTronAmount,
    tronOptionValue: tronOptionValue,
    tronNetworkFromOption: tronNetworkFromOption,
    sendFieldLabels: sendFieldLabels,
    tronProviderOrder: tronProviderOrder,
    parseNowBlock: parseNowBlock,
    fetchNowBlock: fetchNowBlock,
    validateTronSend: validateTronSend,
    buildTransferRequest: buildTransferRequest,
    decodeTokenDecimals: decodeTokenDecimals,
    decodeTokenSymbol: decodeTokenSymbol,
    assertReviewedTron: assertReviewedTron,
    prepareTronTransfer: prepareTronTransfer,
    confirmTronTransfer: confirmTronTransfer
  };
});
