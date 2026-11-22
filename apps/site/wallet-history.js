/* Wallet transaction history: pure parsing and formatting.
 *
 * wallet.js owns the network calls and the DOM. This module only turns a
 * provider answer into the rows the history table renders, so every rule can
 * be tested in Node without a browser or a network.
 *
 * Sources:
 *  - Bitcoin mainnet/testnet: the configured mempool provider's
 *    `/api/address/<addr>/txs`, read directly by the page (the same host the
 *    balance button already uses).
 *  - TRON mainnet: the coordinator's normalized
 *    `/api/v1/chain/tron/transactions` answer (TronScan stays server-side).
 *  - EVM: no indexer or API key ships with this build, so the module returns
 *    an explicit unavailable state; it never pretends an empty list is "no
 *    history" and never names a provider.
 *
 * Amounts are atomic integers (sats / sun) formatted with RotorAmount, so no
 * float ever touches a balance. Timestamps are epoch milliseconds.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.RotorWalletHistory = factory(root);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  var AMOUNT = root.RotorAmount;
  var CHAINS = root.RotorChains;
  var PROVIDERS = root.RotorProviders;

  var MAX_TXS = 50;
  var EVM_UNAVAILABLE = 'Transaction history for EVM chains needs an indexer or an API key; this build does not ship one.';
  var OTHER_UNAVAILABLE = 'Transaction history is not available for this chain in this build.';
  var DOCS_HREF = '/docs';
  var EVM_CHAINS = [
    'ethereum', 'bnb', 'arbitrum', 'optimism', 'base', 'polygon', 'avalanche', 'zksync'
  ];

  function support(slug) {
    if (slug === 'bitcoin' || slug === 'bitcoin-testnet') return { kind: 'btc' };
    if (slug === 'tron') return { kind: 'tron' };
    if (EVM_CHAINS.indexOf(slug) >= 0) {
      return { kind: 'evm', message: EVM_UNAVAILABLE, docsHref: DOCS_HREF };
    }
    return { kind: 'other', message: OTHER_UNAVAILABLE, docsHref: DOCS_HREF };
  }

  function chainUnit(slug) {
    var meta = CHAINS && CHAINS.bySlug ? CHAINS.bySlug[slug] : null;
    if (!meta || typeof meta.decimals !== 'number' || typeof meta.symbol !== 'string') {
      throw new Error('unknown chain: ' + slug);
    }
    return { decimals: meta.decimals, symbol: meta.symbol };
  }

  function atomicText(value) {
    var text = value === undefined || value === null ? '0' : String(value).trim();
    if (!/^\d+$/.test(text)) throw new Error('amount must be a non-negative integer string');
    return text;
  }

  function formatNative(amountAtomic, slug) {
    var unit = chainUnit(slug);
    return AMOUNT.formatUnits(BigInt(atomicText(amountAtomic)), unit.decimals, { symbol: unit.symbol });
  }

  function truncateMiddle(text, head, tail) {
    var value = String(text === undefined || text === null ? '' : text);
    var left = head === undefined ? 8 : head;
    var right = tail === undefined ? 6 : tail;
    if (value.length <= left + right + 1) return value;
    return value.slice(0, left) + '…' + value.slice(value.length - right);
  }

  function formatTime(timestamp) {
    if (typeof timestamp !== 'number' || !isFinite(timestamp) || timestamp <= 0) return 'Pending';
    var iso = new Date(timestamp).toISOString();
    return iso.slice(0, 16).replace('T', ' ') + ' UTC';
  }

  function directionLabel(direction) {
    return direction === 'in' ? 'In' : 'Out';
  }

  function statusLabel(confirmed) {
    return confirmed === true ? 'Confirmed' : 'Pending';
  }

  function btcApiBase(slug) {
    var provider = slug === 'bitcoin-testnet'
      ? PROVIDERS.find('bitcoin-testnet', 'mempool')
      : PROVIDERS.find('bitcoin', 'mempool');
    if (!provider || typeof provider.url !== 'string') {
      throw new Error('no mempool provider endpoint for ' + slug);
    }
    return provider.url;
  }

  function btcTxsUrl(slug, address) {
    return btcApiBase(slug) + '/address/' + encodeURIComponent(address) + '/txs';
  }

  function ownedValue(outputs, address) {
    var total = 0n;
    (Array.isArray(outputs) ? outputs : []).forEach(function (output) {
      if (!output || typeof output.value !== 'number') return;
      if (output.scriptpubkey_address === address) total += BigInt(Math.trunc(output.value));
    });
    return total;
  }

  function firstForeignOutput(outputs, address) {
    var list = Array.isArray(outputs) ? outputs : [];
    for (var i = 0; i < list.length; i += 1) {
      var output = list[i];
      if (output && typeof output.scriptpubkey_address === 'string' &&
          output.scriptpubkey_address && output.scriptpubkey_address !== address) {
        return output.scriptpubkey_address;
      }
    }
    return '';
  }

  function firstForeignInput(inputs, address) {
    var list = Array.isArray(inputs) ? inputs : [];
    for (var i = 0; i < list.length; i += 1) {
      var prev = list[i] && list[i].prevout;
      if (prev && typeof prev.scriptpubkey_address === 'string' &&
          prev.scriptpubkey_address && prev.scriptpubkey_address !== address) {
        return prev.scriptpubkey_address;
      }
    }
    return '';
  }

  /* Bitcoin: an address owns an input when its prevout belongs to it. Any
   * owned input makes the transaction outgoing; the displayed amount is the
   * value that left to other outputs (change back to self is excluded), and
   * the provider fee is shown separately for outgoing rows. Incoming rows
   * show the sum of the outputs that pay this address. */
  function parseBtcTxs(address, txs) {
    if (!Array.isArray(txs)) return [];
    var rows = [];
    for (var i = 0; i < txs.length && rows.length < MAX_TXS; i += 1) {
      var tx = txs[i];
      if (!tx || typeof tx.txid !== 'string' || !tx.txid) continue;
      var inputs = Array.isArray(tx.vin) ? tx.vin : [];
      var outputs = Array.isArray(tx.vout) ? tx.vout : [];
      var ownedIn = 0n;
      inputs.forEach(function (input) {
        var prev = input && input.prevout;
        if (prev && typeof prev.value === 'number' && prev.scriptpubkey_address === address) {
          ownedIn += BigInt(Math.trunc(prev.value));
        }
      });
      var outgoing = ownedIn > 0n;
      var amount = outgoing ? sentValue(outputs, address) : ownedValue(outputs, address);
      var status = tx.status && typeof tx.status === 'object' ? tx.status : {};
      var confirmed = status.confirmed === true;
      var timestamp = confirmed && typeof status.block_time === 'number' && status.block_time > 0
        ? status.block_time * 1000
        : null;
      var row = {
        txid: tx.txid,
        timestamp: timestamp,
        direction: outgoing ? 'out' : 'in',
        amountAtomic: amount.toString(),
        counterparty: outgoing ? firstForeignOutput(outputs, address) : firstForeignInput(inputs, address),
        confirmed: confirmed
      };
      if (outgoing && typeof tx.fee === 'number' && tx.fee > 0) {
        row.feeAtomic = String(Math.trunc(tx.fee));
      }
      rows.push(row);
    }
    return rows;
  }

  function sentValue(outputs, address) {
    var total = 0n;
    (Array.isArray(outputs) ? outputs : []).forEach(function (output) {
      if (!output || typeof output.value !== 'number') return;
      if (output.scriptpubkey_address && output.scriptpubkey_address !== address) {
        total += BigInt(Math.trunc(output.value));
      }
    });
    return total;
  }

  /* TRON: the coordinator already normalized the TronScan answer, so this
   * validates and caps it; no provider shape leaks into the page. */
  function parseTronPayload(address, payload) {
    var list = payload && Array.isArray(payload.transactions) ? payload.transactions : [];
    var rows = [];
    for (var i = 0; i < list.length && rows.length < MAX_TXS; i += 1) {
      var tx = list[i];
      if (!tx || typeof tx.txid !== 'string' || !tx.txid) continue;
      var direction = tx.direction === 'in' ? 'in' : 'out';
      var amount = tx.amountSun === undefined || tx.amountSun === null ? '0' : String(tx.amountSun);
      if (!/^\d+$/.test(amount)) amount = '0';
      var row = {
        txid: tx.txid,
        timestamp: typeof tx.timestamp === 'number' ? tx.timestamp : null,
        direction: direction,
        amountAtomic: amount,
        counterparty: typeof tx.counterparty === 'string' ? tx.counterparty : '',
        confirmed: tx.confirmed === true
      };
      if (tx.fee !== undefined && tx.fee !== null && /^\d+$/.test(String(tx.fee))) {
        row.feeAtomic = String(tx.fee);
      }
      rows.push(row);
    }
    return rows;
  }

  root.RotorWalletHistory = {
    MAX_TXS: MAX_TXS,
    EVM_UNAVAILABLE: EVM_UNAVAILABLE,
    OTHER_UNAVAILABLE: OTHER_UNAVAILABLE,
    DOCS_HREF: DOCS_HREF,
    support: support,
    btcTxsUrl: btcTxsUrl,
    parseBtcTxs: parseBtcTxs,
    parseTronPayload: parseTronPayload,
    formatNative: formatNative,
    formatTime: formatTime,
    truncateMiddle: truncateMiddle,
    directionLabel: directionLabel,
    statusLabel: statusLabel
  };

  return root.RotorWalletHistory;
});
