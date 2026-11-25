/* SunSwap V2 swap helpers (pure browser/Node code, no DOM, no network).
 *
 * The calldata encoder and the signing live in the WASM core
 * (crates/rotor-wasm/src/tron.rs); this module owns the same-chain swap
 * arithmetic the page needs before and after the encoder runs:
 *  - the router path (TRX is wrapped as WTRX, the contract read from the
 *    generated SSOT globals, never a page-local copy);
 *  - slippage parsing and the minimum-received bound (BigInt, never a float);
 *  - the deadline and the quote TTL (a stale quote is not turned into a
 *    transaction);
 *  - the approve decision;
 *  - the getAmountsOut return decode and the route caption. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorSwap = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Basis points in one percent and the maximum allowed slippage (50%). */
  var BPS_PER_PERCENT = 100;
  var BPS_SCALE = 10000;
  var MAX_SLIPPAGE_BPS = 5000;

  /* Twenty minutes: the reviewed deadline margin for a SunSwap swap. */
  var SWAP_DEADLINE_TTL_MS = 20 * 60 * 1000;

  /* A quote older than this is refreshed before it is signed. */
  var SWAP_QUOTE_TTL_MS = 60000;

  /* WTRX is chain data, not a constant in this file: it comes from
   * data/chains.json through the generated chains.generated.js. A missing
   * value is a load-time error, not a silent zero-address swap. */
  var SSOT_ROOT = typeof globalThis !== 'undefined' ? globalThis : this;
  var SSOT_CHAINS = SSOT_ROOT.RotorChains;
  var TRON = SSOT_CHAINS && SSOT_CHAINS.bySlug ? SSOT_CHAINS.bySlug.tron : null;
  var WTRX = TRON ? TRON.wtrx : null;
  if (typeof WTRX !== 'string' || !WTRX) {
    throw new Error('The SSOT chain data carries no tron.wtrx wrapped-TRX contract. ' +
      'Load chains.generated.js (run node scripts/gen-ssot.mjs) before wallet-swap.js.');
  }

  /* ---------------------------------------------------------------- route */

  /* The router path. An empty address means native TRX, which the router
   * only sees as WTRX: before a token and after it (token -> TRX unwraps at
   * the end). The caller supplies the wtrx contract explicitly so the module
   * never carries a second copy of it. */
  function buildPath(route) {
    var input = route || {};
    var from = input.from;
    var to = input.to;
    var wtrx = input.wtrx;
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new Error('The swap route needs token addresses; use an empty string for TRX.');
    }
    if (typeof wtrx !== 'string' || !wtrx) {
      throw new Error('The swap route needs the wrapped-TRX contract (tron.wtrx).');
    }
    if (from === to) {
      throw new Error('The swap route starts and ends at the same asset; there is no swap.');
    }
    if (!from) return [wtrx, to];
    if (!to) return [from, wtrx];
    return [from, wtrx, to];
  }

  /* ------------------------------------------------------- min received */

  /* Floor the quote by the slippage in basis points. Exact BigInt arithmetic:
   * a float division would round the bound and could sign a worse swap. */
  function minReceived(quote, slippageBps) {
    if (typeof quote !== 'bigint') {
      throw new Error('The swap quote must be a BigInt amount.');
    }
    if (quote < 0n) {
      throw new Error('The swap quote must not be negative.');
    }
    if (typeof slippageBps !== 'number') {
      throw new Error('The slippage must be an integer number of basis points, not ' +
        typeof slippageBps + ' (BigInt amounts only).');
    }
    if (!Number.isInteger(slippageBps)) {
      throw new Error('The slippage must be an integer number of basis points; got ' +
        slippageBps + '.');
    }
    if (slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
      throw new Error('The slippage must be between 0 and ' + MAX_SLIPPAGE_BPS +
        ' bps; got ' + slippageBps + '.');
    }
    return (quote * BigInt(BPS_SCALE - slippageBps)) / BigInt(BPS_SCALE);
  }

  /* ----------------------------------------------------------- slippage */

  /* A percent string to basis points without a float round trip: `0.5` -> 50,
   * `12.34` -> 1234. Two fraction digits are the basis-point resolution; more
   * precision would be silently dropped, so it is refused. */
  function parseSlippage(text) {
    var value = typeof text === 'string' ? text.trim() : '';
    if (!value) {
      throw new Error('Enter a slippage percentage (for example 0.5).');
    }
    if (value.charAt(0) === '-') {
      throw new Error('The slippage cannot be negative; enter a percent number.');
    }
    var match = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) {
      throw new Error('Enter the slippage as a percent number (for example 0.5).');
    }
    var fraction = match[2] || '';
    if (fraction.length > 2) {
      throw new Error('The slippage precision is two decimal places (one basis point) at most.');
    }
    var bps = Number(match[1]) * BPS_PER_PERCENT +
      Number((fraction + '00').slice(0, 2));
    if (!Number.isSafeInteger(bps)) {
      throw new Error('The slippage percent is too large.');
    }
    if (bps > MAX_SLIPPAGE_BPS) {
      throw new Error('The slippage must be between 0 and 50 percent.');
    }
    return bps;
  }

  /* ----------------------------------------------------------- deadline */

  /* The transaction deadline in milliseconds. It defaults to twenty minutes
   * and must stay ahead of `now`. */
  function deadlineFrom(now, ttlMs) {
    var ttl = ttlMs === undefined ? SWAP_DEADLINE_TTL_MS : ttlMs;
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl <= 0) {
      throw new Error('The swap deadline needs a positive time to live in milliseconds.');
    }
    if (typeof now !== 'number' || !Number.isFinite(now) || now <= 0) {
      throw new Error('The swap deadline needs the current time in milliseconds.');
    }
    return String(BigInt(now) + BigInt(ttl));
  }

  /* ---------------------------------------------------------- quote TTL */

  /* A quote older than the TTL is refused: its amountOut would be signed as a
   * stale bound. `now` is injected in tests. */
  function assertQuoteFresh(quote, now) {
    var fetchedAt = quote ? quote.fetchedAt : undefined;
    var at = now === undefined ? Date.now() : now;
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt) ||
        typeof at !== 'number' || !Number.isFinite(at)) {
      throw new Error('The swap quote has no fetch time; refresh it before signing.');
    }
    if (at - fetchedAt > SWAP_QUOTE_TTL_MS) {
      throw new Error('The swap quote is stale (older than 60 seconds); refresh it before signing.');
    }
  }

  /* ------------------------------------------------------------- approve */

  /* A TRC-20 swap spends the allowance; an allowance at least the amount is
   * enough and does not need another approve. */
  function approveNeeded(allowance, amount) {
    if (typeof allowance !== 'bigint' || typeof amount !== 'bigint') {
      throw new Error('The allowance and the amount must be BigInt values.');
    }
    return allowance < amount;
  }

  /* ------------------------------------------------------ getAmountsOut */

  /* Decode the ABI uint256[] return of getAmountsOut:
   * [offset = 32][length][amount0..amountN-1]. The length must equal the
   * router path length, or the route would silently drop a hop. */
  function parseAmountsOut(blob, pathLength) {
    if (typeof blob !== 'string') {
      throw new Error('The getAmountsOut response is not an ABI hex string.');
    }
    if (typeof pathLength !== 'number' || !Number.isInteger(pathLength) || pathLength < 2) {
      throw new Error('The swap path needs at least two addresses.');
    }
    var hex = blob.trim().replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]+$/.test(hex)) {
      throw new Error('The getAmountsOut response is not ABI hex data.');
    }
    if (hex.length < 128) {
      throw new Error('The getAmountsOut response is truncated: no length word.');
    }
    var offset = BigInt('0x' + hex.slice(0, 64));
    if (offset !== 32n) {
      throw new Error('The getAmountsOut response has a non-standard ABI offset; ' +
        'expected a uint256[] return.');
    }
    var declared = BigInt('0x' + hex.slice(64, 128));
    if (declared !== BigInt(pathLength)) {
      throw new Error('The getAmountsOut length ' + declared.toString() +
        ' does not match the swap path (' + pathLength + ' amounts).');
    }
    var needed = 128 + pathLength * 64;
    if (hex.length < needed) {
      throw new Error('The getAmountsOut response is truncated: ' +
        ((hex.length - 128) / 64) + ' of ' + pathLength + ' amounts are present.');
    }
    var amounts = [];
    for (var i = 0; i < pathLength; i += 1) {
      amounts.push(BigInt('0x' + hex.slice(128 + i * 64, 128 + (i + 1) * 64)));
    }
    return amounts;
  }

  /* ---------------------------------------------------------------- route */

  /* The user-facing caption: symbols, one per hop, in the router order. A TRX
   * swap shows "TRX", not the wrapped contract address. */
  function formatRoute(addresses, symbols) {
    if (!Array.isArray(addresses) || !Array.isArray(symbols) || addresses.length !== symbols.length) {
      throw new Error('The swap route caption needs one symbol per path address.');
    }
    var labels = [];
    for (var i = 0; i < symbols.length; i += 1) {
      if (typeof symbols[i] !== 'string' || !symbols[i].trim()) {
        throw new Error('The swap route caption has an empty symbol at hop ' + (i + 1) + '.');
      }
      labels.push(symbols[i].trim());
    }
    return labels.join(' → ');
  }

  return {
    WTRX: WTRX,
    MAX_SLIPPAGE_BPS: MAX_SLIPPAGE_BPS,
    SWAP_DEADLINE_TTL_MS: SWAP_DEADLINE_TTL_MS,
    SWAP_QUOTE_TTL_MS: SWAP_QUOTE_TTL_MS,
    buildPath: buildPath,
    minReceived: minReceived,
    parseSlippage: parseSlippage,
    deadlineFrom: deadlineFrom,
    assertQuoteFresh: assertQuoteFresh,
    approveNeeded: approveNeeded,
    parseAmountsOut: parseAmountsOut,
    formatRoute: formatRoute
  };
});
