/* Local balance cache policy and storage.
 *
 * Pure TTL/merge/retry codec plus a thin IndexedDB adapter (memory fallback).
 * No DOM access: the pages own all rendering. Only public addresses, balances
 * and transaction counts are stored; private keys and mnemonic phrases never
 * touch this module.
 *
 * Provider TTLs (documented contract):
 *   BTC / Bitcoin-family providers  60 s
 *   EVM providers                   30 s
 *   TRON and every other provider   60 s
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.RotorBalanceCache = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TTL_MS = { btc: 60000, evm: 30000, other: 60000 };
  var DB_NAME = 'rotor-balance-cache';
  var STORE_NAME = 'balances';

  function nowMs(now) {
    return typeof now === 'number' && isFinite(now) ? now : Date.now();
  }

  function providerKind(provider) {
    var name = String(provider || '').toLowerCase();
    if (name === 'mempool' || name === 'blockchain.info' || name === 'btc') return 'btc';
    if (name === 'evm' || name === 'eth' || name.indexOf('evm:') === 0) return 'evm';
    return 'other';
  }

  function ttlFor(provider) {
    return TTL_MS[providerKind(provider)];
  }

  function cacheKey(provider, chain, address) {
    return String(provider) + '|' + String(chain) + '|' + String(address);
  }

  /* ------------------------------------------------- provider response codecs
   * Raw bodies from the free public providers, decoded to the one shape the
   * pages cache: an atomic amount as a decimal string. A parser returns null
   * when the body does not carry a balance, so the caller can fail loud
   * instead of caching an invented zero. */

  function atomicAmount(value) {
    if (typeof value === 'string' && /^\d+$/.test(value)) return value;
    if (typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value) {
      return String(value);
    }
    return null;
  }

  /* XRPScan `/api/v1/account/<address>`: drops in `Balance` (a string); the
   * live body is flat, while `account_data.Balance` and `balance_drops` cover
   * the alternate shapes. An unactivated account answers 404 and the caller
   * treats it as zero. */
  function parseXrpAccount(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    var account = data.account_data && typeof data.account_data === 'object' ? data.account_data : {};
    var amount = atomicAmount(account.Balance);
    if (amount === null) amount = atomicAmount(data.Balance);
    if (amount === null) amount = atomicAmount(data.balance_drops);
    if (amount === null) return null;
    var count = atomicAmount(account.TransactionCount);
    if (count === null) count = atomicAmount(data.transaction_count);
    if (count === null) count = atomicAmount(data.tx_count);
    return { amount: amount, tx: count === null ? null : Number(count) };
  }

  /* Solana JSON-RPC. `getBalance` returns {result:{value:<lamports>}}; the
   * unwrap also tolerates a bare number in `result`. */
  function parseSolanaBalance(data) {
    if (!data || typeof data !== 'object') return null;
    var result = data.result;
    if (result && typeof result === 'object' && !Array.isArray(result) && 'value' in result) {
      result = result.value;
    }
    var amount = atomicAmount(result);
    return amount === null ? null : { amount: amount };
  }

  /* `getMultipleAccounts` returns one entry per requested address in order;
   * a missing account is null and counts as zero. */
  function parseSolanaAccounts(data) {
    if (!data || typeof data !== 'object') return null;
    var value = data.result && data.result.value;
    if (!Array.isArray(value)) return null;
    return value.map(function (item) {
      if (!item || typeof item !== 'object') return '0';
      var amount = atomicAmount(item.lamports);
      return amount === null ? '0' : amount;
    });
  }

  /* Sui balance in MIST. The public JSON-RPC fullnodes now answer -32601
   * (deprecated in favour of gRPC), so the page queries the GraphQL endpoint;
   * the JSON-RPC `result.totalBalance` shape is still accepted. */
  function parseSuiBalance(data) {
    if (!data || typeof data !== 'object') return null;
    var result = data.result;
    if (result && typeof result === 'object') {
      var rpc = atomicAmount(result.totalBalance);
      if (rpc !== null) return { amount: rpc };
    }
    var gql = data.data && data.data.address && data.data.address.balance;
    var graphql = gql && typeof gql === 'object' ? atomicAmount(gql.totalBalance) : null;
    return graphql === null ? null : { amount: graphql };
  }

  /* TON Center `getAddressBalance`: nanotons in `result` (a string). */
  function parseTonBalance(data) {
    if (!data || typeof data !== 'object' || data.ok === false) return null;
    var amount = atomicAmount(data.result);
    return amount === null ? null : { amount: amount };
  }

  /* BlockCypher `/v1/<chain>/main/addrs/<address>/balance`: atomic units in
   * `final_balance` (unconfirmed included) with `balance` as the fallback,
   * lifetime `total_received`, and the transaction counts `n_tx`/`final_n_tx`. */
  function parseBlockcypherBalance(data) {
    if (!data || typeof data !== 'object') return null;
    var amount = atomicAmount(data.final_balance);
    if (amount === null) amount = atomicAmount(data.balance);
    if (amount === null) return null;
    var txs = atomicAmount(data.final_n_tx);
    if (txs === null) txs = atomicAmount(data.n_tx);
    return {
      amount: amount,
      received: atomicAmount(data.total_received),
      txs: txs === null ? null : Number(txs)
    };
  }

  function hasAddress(address) {
    return typeof address === 'string' && address.trim().length > 0;
  }

  function isSuccess(entry) {
    return !!entry && !entry.error && entry.value !== null && entry.value !== undefined;
  }

  function isFresh(entry, ttlOrProvider, now) {
    if (!isSuccess(entry)) return false;
    var ttl = typeof ttlOrProvider === 'number' ? ttlOrProvider : ttlFor(ttlOrProvider);
    var fetchedAt = Number(entry.fetchedAt);
    if (!isFinite(fetchedAt)) return false;
    var age = nowMs(now) - fetchedAt;
    return age >= 0 && age < ttl;
  }

  function isStale(entry, ttlOrProvider, now) {
    return !isFresh(entry, ttlOrProvider, now);
  }

  function shouldRefresh(entry, ttlOrProvider, now) {
    return !isSuccess(entry) || !isFresh(entry, ttlOrProvider, now);
  }

  function makeEntry(value, source, now) {
    return { value: value, fetchedAt: nowMs(now), source: source || null };
  }

  function makeErrorEntry(message, source, now) {
    return {
      value: null,
      fetchedAt: nowMs(now),
      source: source || null,
      error: String(message || 'failed')
    };
  }

  /* A failed refresh never replaces a good value: the cached success is
   * returned, and a failure-only record is kept only when there was nothing. */
  function mergeEntries(previous, next) {
    if (isSuccess(next)) return next;
    if (isSuccess(previous)) return previous;
    return next || previous || null;
  }

  function ageMs(entry, now) {
    if (!entry || !isFinite(Number(entry.fetchedAt))) return null;
    return Math.max(0, nowMs(now) - Number(entry.fetchedAt));
  }

  /* Relative label for an absolute timestamp in ms; the TRON balance rows use
   * it for the last-transaction age. */
  function relativeTime(at, now) {
    var diff = nowMs(now) - Number(at);
    if (!isFinite(diff) || diff < 0) return '';
    var seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'just now';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    if (days < 30) return days + 'd ago';
    var months = Math.floor(days / 30);
    if (months < 12) return months + 'mo ago';
    return Math.floor(months / 12) + 'y ago';
  }

  function ageLabel(entry, now) {
    var age = ageMs(entry, now);
    if (age === null) return '';
    if (age < 1000) return 'just now';
    if (age < 60000) return Math.round(age / 1000) + 's ago';
    if (age < 3600000) return Math.round(age / 60000) + 'm ago';
    return Math.round(age / 3600000) + 'h ago';
  }

  /* records: [{ key, entry }]; returns the keys that are missing, failed or
   * older than the provider TTL. This is the set the global refresh runs. */
  function selectStale(records, ttlOrProvider, now) {
    var time = nowMs(now);
    var out = [];
    (records || []).forEach(function (record) {
      if (record && record.key && shouldRefresh(record.entry, ttlOrProvider, time)) {
        out.push(record.key);
      }
    });
    return out;
  }

  /* One retry for transient failures. 429/5xx are retried within the same
   * attempt budget and then stop; other 4xx errors are not retried. */
  function defaultIsRetryable(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return false;
    var status = Number(err.status || 0);
    if (status === 429 || status >= 500) return true;
    if (status >= 400 && status < 500) return false;
    return true;
  }

  function backoffDelay(attempt, options) {
    var opts = options || {};
    var base = typeof opts.baseDelay === 'number' ? opts.baseDelay : 400;
    var factor = typeof opts.factor === 'number' ? opts.factor : 2;
    var cap = typeof opts.maxDelay === 'number' ? opts.maxDelay : 8000;
    var jitter = typeof opts.jitter === 'number' ? opts.jitter : 0.3;
    var random = typeof opts.random === 'function' ? opts.random : Math.random;
    var raw = Math.min(cap, base * Math.pow(factor, Math.max(0, attempt)));
    var spread = raw * jitter;
    return Math.max(0, Math.round(raw - spread + random() * spread * 2));
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function withRetry(task, options) {
    var opts = options || {};
    var attempts = Math.max(1, Number(opts.attempts) || 2);
    var isRetryable = typeof opts.isRetryable === 'function'
      ? opts.isRetryable
      : defaultIsRetryable;
    var attempt = 0;
    for (;;) {
      try {
        return await task(attempt);
      } catch (err) {
        attempt += 1;
        if (attempt >= attempts || !isRetryable(err)) throw err;
        await sleep(backoffDelay(attempt - 1, opts));
      }
    }
  }

  function createLimiter(limit) {
    var max = Math.max(1, Number(limit) || 1);
    var active = 0;
    var queue = [];
    function next() {
      if (active >= max || !queue.length) return;
      active += 1;
      var item = queue.shift();
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .then(function () {
          active -= 1;
          next();
        });
    }
    return function run(task) {
      return new Promise(function (resolve, reject) {
        queue.push({ task: task, resolve: resolve, reject: reject });
        next();
      });
    };
  }

  function jitterDelay(maxMs) {
    var max = typeof maxMs === 'number' && maxMs > 0 ? maxMs : 400;
    return Math.floor(Math.random() * max);
  }

  function createMemoryStore() {
    var map = new Map();
    return {
      get: async function (key) { return map.has(key) ? map.get(key) : null; },
      put: async function (key, entry) { map.set(key, entry); },
      clear: async function () { map.clear(); },
      close: function () {}
    };
  }

  function requestPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function createStore(name) {
    if (typeof indexedDB === 'undefined') return Promise.resolve(createMemoryStore());
    var dbName = name || DB_NAME;
    return new Promise(function (resolve) {
      var request;
      try {
        request = indexedDB.open(dbName, 1);
      } catch (err) {
        resolve(createMemoryStore());
        return;
      }
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onerror = function () { resolve(createMemoryStore()); };
      request.onblocked = function () { resolve(createMemoryStore()); };
      request.onsuccess = function () {
        var db = request.result;
        resolve({
          get: function (key) {
            return requestPromise(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key))
              .then(function (entry) { return entry || null; });
          },
          put: function (key, entry) {
            return requestPromise(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(entry, key))
              .then(function () { return entry; });
          },
          clear: function () {
            return requestPromise(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).clear());
          },
          close: function () { try { db.close(); } catch (err) { /* closed */ } }
        });
      };
    });
  }

  return {
    TTL_MS: TTL_MS,
    DB_NAME: DB_NAME,
    providerKind: providerKind,
    ttlFor: ttlFor,
    cacheKey: cacheKey,
    atomicAmount: atomicAmount,
    parseXrpAccount: parseXrpAccount,
    parseSolanaBalance: parseSolanaBalance,
    parseSolanaAccounts: parseSolanaAccounts,
    parseSuiBalance: parseSuiBalance,
    parseTonBalance: parseTonBalance,
    parseBlockcypherBalance: parseBlockcypherBalance,
    hasAddress: hasAddress,
    isSuccess: isSuccess,
    isFresh: isFresh,
    isStale: isStale,
    shouldRefresh: shouldRefresh,
    makeEntry: makeEntry,
    makeErrorEntry: makeErrorEntry,
    mergeEntries: mergeEntries,
    ageMs: ageMs,
    ageLabel: ageLabel,
    relativeTime: relativeTime,
    selectStale: selectStale,
    defaultIsRetryable: defaultIsRetryable,
    backoffDelay: backoffDelay,
    withRetry: withRetry,
    createLimiter: createLimiter,
    jitterDelay: jitterDelay,
    createStore: createStore,
    createMemoryStore: createMemoryStore
  };
}));
