/* Pure top-10 asset model for /cabinet/wallet. No DOM, no network and no
 * storage: data/assets.json (through the generated RotorAssetsData global)
 * supplies the list, wallet.js supplies per-network balance states and the
 * shared public ticker, and this module orders, prices and formats.
 *
 * A network state is:
 *   'ok'           the balance loaded; amount is a non-negative bigint and a
 *                  zero is a real zero;
 *   'loading'      a request is in flight;
 *   'error'        the lookup failed (never rendered as zero);
 *   'missing'      no request has succeeded yet or the vault has no address
 *                  for that network;
 *   'unavailable'  no balance read path is wired for this asset.
 *
 * USD is rendered only from a fresh ticker (or the explicit USDT peg). A
 * stale, loading or offline ticker keeps the native amount and prints —.
 */
(function (global) {
  'use strict';

  var AMOUNT = global.RotorAmount;
  var TOOLS = global.RotorKeyTools;

  function toBigInt(value) {
    if (typeof value === 'bigint') return value;
    if (value === null || value === undefined || value === '') return null;
    try {
      return BigInt(value);
    } catch (err) {
      return null;
    }
  }

  function chainInfo(chain) {
    var chains = global.RotorChains;
    return chains && chains.bySlug ? chains.bySlug[chain] : null;
  }

  function chainLabel(chain) {
    var info = chainInfo(chain);
    return info && info.name ? info.name : String(chain || '');
  }

  function networksFor(asset) {
    if (asset && Array.isArray(asset.networks)) return asset.networks;
    return [];
  }

  function balanceKey(asset, network) {
    return String(asset.rank) + '|' + String(network.chain) + '|' +
      String(network.contract || 'native');
  }

  /* Base ticker used from the shared price table. USDT has an explicit peg,
   * not a market pair, so the reason is visible in the row title. */
  function priceBase(asset) {
    if (!asset) return '';
    if (asset.pegUsd) return 'USD';
    return String(asset.ticker || '');
  }

  function priceScaled(asset, prices) {
    if (!TOOLS || typeof TOOLS.priceScaled !== 'function') return null;
    if (asset.pegUsd) return TOOLS.priceScaled(asset.pegUsd);
    if (!asset.ticker) return null;
    var table = prices && typeof prices === 'object' ? prices : {};
    if (!Object.prototype.hasOwnProperty.call(table, asset.ticker)) return null;
    return TOOLS.priceScaled(table[asset.ticker]);
  }

  function priceReason(asset, prices, priceState) {
    if (priceState === 'loading' || priceState === 'idle') return 'prices-loading';
    if (priceState === 'stale') return 'prices-stale';
    if (priceState === 'unavailable') return 'prices-unavailable';
    if (!TOOLS || typeof TOOLS.priceScaled !== 'function' ||
        typeof TOOLS.atomicToCents !== 'function') {
      return 'prices-unavailable';
    }
    if (priceScaled(asset, prices) === null) {
      return asset.pegUsd ? 'peg-invalid' : 'ticker-missing';
    }
    return '';
  }

  function usdTitle(reason, asset) {
    if (reason === 'prices-loading') return 'Waiting for the public ticker.';
    if (reason === 'prices-stale') {
      return 'The cached public ticker is stale, so no USD value is shown.';
    }
    if (reason === 'prices-unavailable') {
      return 'No public ticker is reachable, so no USD value is shown.';
    }
    if (reason === 'ticker-missing') {
      return 'The shared ticker has no ' + priceBase(asset) + ' pair, so no USD value is shown.';
    }
    if (reason === 'peg-invalid') return 'The USDT peg in data/assets.json is not a valid price.';
    return '';
  }

  function balanceText(asset, amount) {
    var value = toBigInt(amount);
    if (value === null || value < 0n) return null;
    var text = AMOUNT && typeof AMOUNT.coin === 'function'
      ? AMOUNT.coin(value, asset.decimals)
      : value.toString(10);
    return text + ' ' + asset.symbol;
  }

  function usdText(cents) {
    if (cents === null || cents === undefined) return '—';
    if (!TOOLS || typeof TOOLS.formatUsd !== 'function') return '—';
    return TOOLS.formatUsd(cents);
  }

  /* rows: ordered by rank, then by the declared network order. Every asset
   * gets one row per network, so a multi-chain token shows a value per chain
   * instead of one invented aggregate. */
  function buildRows(assets, states, prices, priceState) {
    var list = Array.isArray(assets) ? assets.slice() : [];
    list.sort(function (left, right) { return left.rank - right.rank; });
    var stateTable = states && typeof states === 'object' ? states : {};
    var out = {
      rows: [],
      loaded: 0,
      failed: 0,
      pending: 0,
      unavailable: 0,
      missing: 0,
      totalCents: null,
      totalText: '—'
    };
    var total = 0n;
    var priced = 0;

    list.forEach(function (asset) {
      networksFor(asset).forEach(function (network) {
        var key = balanceKey(asset, network);
        var state = stateTable[key] || { state: 'missing' };
        var row = {
          rank: asset.rank,
          symbol: asset.symbol,
          name: asset.name,
          chain: network.chain,
          chainLabel: chainLabel(network.chain),
          contract: network.contract || null,
          key: key,
          state: state.state || 'missing',
          balanceText: 'not loaded',
          balanceTitle: state.detail || 'Not loaded yet; no request has succeeded.',
          usdText: '—',
          usdTitle: '',
          cents: null
        };
        if (row.state === 'ok') {
          var amount = toBigInt(state.amount);
          var text = amount === null ? null : balanceText(asset, amount);
          if (text === null) {
            row.state = 'error';
            row.balanceText = 'lookup failed';
            row.balanceTitle = 'The provider returned an invalid amount.';
            out.failed += 1;
          } else {
            row.balanceText = text;
            row.balanceTitle = state.detail || '';
            out.loaded += 1;
            var reason = priceReason(asset, prices, priceState);
            if (!reason) {
              var cents = TOOLS.atomicToCents(amount, asset.decimals, priceScaled(asset, prices));
              if (cents !== null) {
                row.cents = cents;
                row.usdText = usdText(cents);
                total += cents;
                priced += 1;
              } else {
                row.usdTitle = 'The amount could not be priced exactly.';
              }
            } else {
              row.usdTitle = usdTitle(reason, asset);
            }
          }
        } else if (row.state === 'loading') {
          row.balanceText = 'loading…';
          row.balanceTitle = 'Balance lookup in flight.';
          out.pending += 1;
        } else if (row.state === 'error') {
          row.balanceText = 'lookup failed';
          row.balanceTitle = state.detail || 'The public provider did not return a balance.';
          out.failed += 1;
        } else if (row.state === 'unavailable') {
          row.balanceText = 'unavailable';
          row.balanceTitle = state.detail || 'No balance read path is wired for this asset yet.';
          out.unavailable += 1;
        } else {
          row.state = 'missing';
          row.balanceText = 'not loaded';
          row.balanceTitle = state.detail || 'Not loaded yet; no request has succeeded.';
          out.missing += 1;
        }
        out.rows.push(row);
      });
    });

    if (out.loaded > 0 && priced > 0) {
      out.totalCents = total;
      out.totalText = usdText(total);
    }
    return out;
  }

  /* TronScan `/account?address=` lists every TRC-20 holding as
   * [{ "<contract>": "<atomic amount>" }]. An activated account with no row
   * for the contract holds zero; a body that is neither an account nor an
   * empty 404 object is not a balance. */
  function parseTronTokenBalance(data, contract) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    var target = String(contract || '');
    if (!target) return null;
    if (Array.isArray(data.trc20)) {
      for (var index = 0; index < data.trc20.length; index += 1) {
        var item = data.trc20[index];
        if (!item || typeof item !== 'object') continue;
        if (!Object.prototype.hasOwnProperty.call(item, target)) continue;
        var value = String(item[target]);
        return /^\d+$/.test(value) ? value : null;
      }
      return '0';
    }
    if (data.address || data.balance !== undefined || Object.keys(data).length === 0) {
      return '0';
    }
    return null;
  }

  /* eth_call balanceOf returns a 32-byte word. Empty return data is not a
   * balance, so it fails loud instead of becoming zero. */
  function parseEvmBalance(value) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) return null;
    if (value.length <= 2 || value.length % 2 !== 0) return null;
    try {
      return BigInt(value);
    } catch (err) {
      return null;
    }
  }

  var api = {
    networksFor: networksFor,
    balanceKey: balanceKey,
    priceBase: priceBase,
    priceScaled: priceScaled,
    priceReason: priceReason,
    usdTitle: usdTitle,
    buildRows: buildRows,
    parseTronTokenBalance: parseTronTokenBalance,
    parseEvmBalance: parseEvmBalance
  };

  global.RotorWalletAssets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
