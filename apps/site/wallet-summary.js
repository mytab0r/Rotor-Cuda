/* Pure portfolio summary math for /cabinet/wallet. No DOM, no network and no
 * storage: wallet.js supplies the balance rows and the cached public ticker,
 * this module only aggregates, excludes and formats.
 *
 * A row is {chain, label, symbol, decimals, amount, state}:
 *   state 'ok'      the balance loaded; amount is a non-negative bigint and
 *                   zero is a real zero;
 *   state 'loading' a request is in flight;
 *   state 'error'   the lookup failed;
 *   state 'missing' it was never requested or the address is not derived.
 * Only 'ok' rows contribute to a total, so an unloaded balance can never be
 * counted as zero.
 *
 * Chains with no market price are excluded from the USD total and returned in
 * `excluded`, so the caller can name them. Testnet coins are never priced at
 * the mainnet ticker: the value would be invented. */
(function (global) {
  'use strict';

  var AMOUNT = global.RotorAmount;
  var TOOLS = global.RotorKeyTools;

  /* Testnet coins have no market price even when their symbol matches a
   * mainnet ticker (Bitcoin testnet carries the symbol BTC). */
  var UNPRICED_CHAINS = {
    'bitcoin-testnet': true
  };

  function toBigInt(value) {
    if (typeof value === 'bigint') return value;
    if (value === null || value === undefined || value === '') return null;
    try {
      return BigInt(value);
    } catch (err) {
      return null;
    }
  }

  function aggregate(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var out = {
      total: list.length,
      loaded: 0,
      loading: 0,
      failed: 0,
      pending: 0,
      perChain: []
    };
    var byChain = {};
    list.forEach(function (row) {
      if (!row) {
        out.pending += 1;
        return;
      }
      if (row.state === 'ok') {
        var amount = toBigInt(row.amount);
        if (amount === null || amount < 0n) {
          out.failed += 1;
          return;
        }
        out.loaded += 1;
        var chain = String(row.chain || '');
        var entry = byChain[chain];
        if (!entry) {
          entry = {
            chain: chain,
            label: row.label || chain,
            symbol: row.symbol || '',
            decimals: Number.isInteger(row.decimals) ? row.decimals : 0,
            amount: 0n,
            addresses: 0
          };
          byChain[chain] = entry;
          out.perChain.push(entry);
        }
        entry.amount += amount;
        entry.addresses += 1;
        return;
      }
      if (row.state === 'loading') out.loading += 1;
      else if (row.state === 'error') out.failed += 1;
      else out.pending += 1;
    });
    return out;
  }

  function loadedLine(summary) {
    var loaded = summary && typeof summary.loaded === 'number' ? summary.loaded : 0;
    var total = summary && typeof summary.total === 'number' ? summary.total : 0;
    return loaded + ' of ' + total + (total === 1 ? ' balance loaded' : ' balances loaded');
  }

  /* The per-row state implied by the address outcome. A missing or failed
   * address is an error row, never a zero balance, so a bulk refresh surfaces
   * it instead of leaving it silently "missing". */
  function loadState(derived) {
    if (!derived || derived.error || !derived.address) return 'error';
    return 'ready';
  }

  function formatNative(amount, decimals, symbol) {
    var value = toBigInt(amount);
    if (value === null || value < 0n) return '—';
    var places = Number(decimals);
    if (!Number.isInteger(places) || places < 0 || places > 100) places = 0;
    var text = AMOUNT && typeof AMOUNT.coin === 'function'
      ? AMOUNT.coin(value, places)
      : value.toString(10);
    return symbol ? text + ' ' + symbol : text;
  }

  function pricedBase(row) {
    if (!TOOLS) return '';
    if (UNPRICED_CHAINS[String(row.chain || '').toLowerCase()]) return '';
    return TOOLS.tickerFor(row.chain) || TOOLS.tickerFor(row.symbol) || '';
  }

  /* priceState: 'fresh', 'stale', 'loading' or 'unavailable' (an 'idle'
   * caller may pass 'loading' while it starts the first request).
   *
   * Returns {state, cents, included, excluded, reason}, where state is one of
   * empty | loading | stale | unavailable | unpriced | partial | ready.
   * `cents` is null unless the value can be shown without inventing a price. */
  function fiat(summary, prices, priceState) {
    var result = {
      state: 'empty',
      cents: null,
      included: 0,
      excluded: [],
      reason: 'no-loaded-balances'
    };
    var chains = summary && Array.isArray(summary.perChain) ? summary.perChain : [];
    if (!chains.length) return result;
    var allExcluded = function () {
      return chains.map(function (row) {
        return { chain: row.chain, label: row.label };
      });
    };
    if (priceState === 'loading') {
      result.state = 'loading';
      result.reason = 'prices-loading';
      return result;
    }
    if (priceState === 'stale') {
      result.state = 'stale';
      result.reason = 'prices-stale';
      result.excluded = allExcluded();
      return result;
    }
    if (priceState === 'unavailable' || !prices || typeof prices !== 'object') {
      result.state = 'unavailable';
      result.reason = 'prices-unavailable';
      result.excluded = allExcluded();
      return result;
    }
    if (!TOOLS || typeof TOOLS.priceScaled !== 'function' || typeof TOOLS.fiatTotals !== 'function') {
      result.state = 'unavailable';
      result.reason = 'prices-unavailable';
      return result;
    }
    var priced = [];
    chains.forEach(function (row) {
      var base = pricedBase(row);
      var scaled = base && Object.prototype.hasOwnProperty.call(prices, base)
        ? TOOLS.priceScaled(prices[base])
        : null;
      if (scaled === null) {
        result.excluded.push({ chain: row.chain, label: row.label });
        return;
      }
      priced.push({
        chain: row.chain,
        symbol: row.symbol,
        amount: row.amount,
        decimals: row.decimals
      });
    });
    if (!priced.length) {
      result.state = 'unpriced';
      result.reason = 'no-priced-balances';
      return result;
    }
    var totals = TOOLS.fiatTotals(priced, prices);
    result.cents = totals.cents;
    result.included = totals.included;
    result.state = result.excluded.length ? 'partial' : 'ready';
    result.reason = '';
    return result;
  }

  function totalText(result) {
    if (!result || result.cents === null || result.cents === undefined) {
      return result && result.state === 'loading' ? '…' : '—';
    }
    if (!TOOLS || typeof TOOLS.formatUsd !== 'function') return '—';
    return TOOLS.formatUsd(result.cents);
  }

  function formatTime(ms) {
    if (!TOOLS || typeof TOOLS.formatPriceTime !== 'function') return '';
    return TOOLS.formatPriceTime(ms);
  }

  var api = {
    aggregate: aggregate,
    loadedLine: loadedLine,
    loadState: loadState,
    formatNative: formatNative,
    fiat: fiat,
    totalText: totalText,
    formatTime: formatTime
  };

  global.RotorWalletSummary = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
