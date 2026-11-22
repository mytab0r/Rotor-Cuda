/* Shared public-balance providers for the directory pages.
 *
 * One implementation of the free/keyless provider calls, used by both
 * `browse.js` (the private-key directory) and `mnemonic-seeds.js` (the
 * mnemonic directory) so a chain wired in one page cannot silently stay "—"
 * in the other. Reads `globalThis.RotorProviders` (chains.generated.js) and
 * `globalThis.RotorBalanceCache` at call time; no DOM, no page state, so the
 * Node tests can call `fetchProvider` against a stubbed `fetch`.
 *
 * Every fetcher resolves to `{ values, errors }`: `values[address]` is the
 * page's balance shape and `errors[address]` is an honest error string. A
 * provider failure is never reported as a zero balance.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.RotorBalanceProviders = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var BALANCE_LIMIT = 5;
  /* Above this many addresses the TRON provider uses one batch request
   * instead of one request per address. The coordinator caps a batch at 60. */
  var TRON_BATCH_THRESHOLD = 5;
  var TRON_BATCH_MAX = 60;

  function providers() {
    return root.RotorProviders || null;
  }

  function cacheApi() {
    return root.RotorBalanceCache || null;
  }

  function uniqueAddresses(addresses) {
    var out = [];
    (addresses || []).forEach(function (address) {
      if (!address) return;
      if (out.indexOf(address) < 0) out.push(address);
    });
    return out;
  }

  async function fetchJson(url, options) {
    var response = await fetch(url, options);
    if (!response.ok) {
      var err = new Error('HTTP ' + response.status);
      err.status = response.status;
      throw err;
    }
    return response.json();
  }

  function retryOptions() {
    return { attempts: 2, baseDelay: 500, maxDelay: 4000 };
  }

  function requestJson(url, options) {
    var api = cacheApi();
    if (!api) return fetchJson(url, options);
    return api.withRetry(function () { return fetchJson(url, options); }, retryOptions());
  }

  function errorMessage(err) {
    return err && err.message ? err.message : 'unavailable';
  }

  /* blockchain.info answers one object keyed by the requested address. */
  async function btcProvider(addresses) {
    var values = {};
    var errors = {};
    var unique = uniqueAddresses(addresses);
    if (!unique.length) return { values: values, errors: errors };
    var url = providers().find('bitcoin', 'blockchain-info').url + unique.map(encodeURIComponent).join('|');
    var data = await requestJson(url);
    unique.forEach(function (address) {
      var info = data[address];
      if (!info) {
        errors[address] = 'Balance row missing from the provider.';
        return;
      }
      values[address] = {
        balance: String(info.final_balance || 0),
        received: String(info.total_received || 0),
        tx: Number(info.n_tx || 0)
      };
    });
    return { values: values, errors: errors };
  }

  /* One JSON-RPC batch for the balances and a best-effort second batch for the
   * nonces (which only marks the row active). */
  async function evmProvider(meta, addresses) {
    var values = {};
    var errors = {};
    var entry = providers().first(meta.chain);
    if (!entry) throw new Error('No RPC for this chain');
    var rpc = entry.url;
    var unique = uniqueAddresses(addresses);
    if (!unique.length) return { values: values, errors: errors };
    var payload = unique.map(function (address, index) {
      return { jsonrpc: '2.0', id: index + 1, method: 'eth_getBalance', params: [address, 'latest'] };
    });
    var list = await requestJson(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var byId = {};
    (Array.isArray(list) ? list : [list]).forEach(function (item) {
      if (item && item.id !== undefined) byId[item.id] = item;
    });
    unique.forEach(function (address, index) {
      var item = byId[index + 1];
      if (!item || typeof item.result !== 'string') {
        errors[address] = item && item.error && item.error.message
          ? item.error.message
          : 'unexpected response';
        return;
      }
      values[address] = { balance: BigInt(item.result).toString() };
    });
    /* Optional second batch: one eth_getTransactionCount per unique address.
     * It only feeds the "Active" summary counter, so any failure (network,
     * shape, non-string result) is ignored and never fails the balance load.
     * The nonce is not stored as `tx`: the donor does not render per-row tx
     * counts on EVM chains. */
    try {
      var noncePayload = unique.map(function (address, index) {
        return { jsonrpc: '2.0', id: index + 1, method: 'eth_getTransactionCount', params: [address, 'latest'] };
      });
      var nonceList = await requestJson(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(noncePayload)
      });
      var nonceById = {};
      (Array.isArray(nonceList) ? nonceList : [nonceList]).forEach(function (item) {
        if (item && item.id !== undefined) nonceById[item.id] = item;
      });
      unique.forEach(function (address, index) {
        var item = nonceById[index + 1];
        if (!item || typeof item.result !== 'string' || !values[address]) return;
        if (parseInt(item.result, 16) > 0) values[address].active = true;
      });
    } catch (err) {
      /* best effort: the Active counter simply stays without these marks */
    }
    return { values: values, errors: errors };
  }

  /* One request for every address on the page. Providers are tried in the
   * data order: the official RPC first, a public fallback second. */
  function solanaBatchBody(addresses) {
    return {
      jsonrpc: '2.0',
      id: 1,
      method: 'getMultipleAccounts',
      params: [addresses, { encoding: 'base64', commitment: 'confirmed' }]
    };
  }

  async function solanaProvider(addresses) {
    var values = {};
    var unique = uniqueAddresses(addresses);
    if (!unique.length) return { values: values, errors: {} };
    var body = solanaBatchBody(unique);
    var urls = providers().byChain.solana.map(function (provider) { return provider.url; });
    var amounts = null;
    var lastError = null;
    for (var i = 0; i < urls.length; i += 1) {
      try {
        var data = await requestJson(urls[i], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        var api = cacheApi();
        amounts = api && typeof api.parseSolanaAccounts === 'function'
          ? api.parseSolanaAccounts(data)
          : null;
        if (amounts) break;
        lastError = new Error('bad response');
      } catch (err) {
        lastError = err;
      }
    }
    if (!amounts) throw lastError || new Error('bad response');
    unique.forEach(function (address, index) {
      values[address] = { balance: amounts[index] || '0' };
    });
    return { values: values, errors: {} };
  }

  /* Sui's public JSON-RPC fullnodes are deprecated; GraphQL serves the same
   * MIST total with CORS enabled. */
  async function suiBalance(address) {
    var data = await fetchJson(providers().find('sui', 'graphql').url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($a: SuiAddress!){address(address:$a){balance(coinType:"0x2::sui::SUI"){totalBalance}}}',
        variables: { a: address }
      })
    });
    var api = cacheApi();
    var parsed = api && typeof api.parseSuiBalance === 'function'
      ? api.parseSuiBalance(data)
      : null;
    if (!parsed) throw new Error('unexpected response');
    return { balance: parsed.amount };
  }

  async function accountJson(url, options) {
    var response = await fetch(url, options);
    if (response.status === 404) return {};
    if (!response.ok) {
      var err = new Error('HTTP ' + response.status);
      err.status = response.status;
      throw err;
    }
    var text = await response.text();
    if (!text) return {};
    return JSON.parse(text);
  }

  async function perAddressProvider(addresses, fetcher) {
    var values = {};
    var errors = {};
    var unique = uniqueAddresses(addresses);
    var api = cacheApi();
    var limit = api ? api.createLimiter(BALANCE_LIMIT) : function (task) { return task(); };
    await Promise.all(unique.map(function (address) {
      return limit(async function () {
        try {
          var task = function () { return fetcher(address); };
          var value = api ? await api.withRetry(task, retryOptions()) : await task();
          /* TRON returns balance + tx metadata; the other per-address
           * providers return a bare balance. */
          values[address] = value && typeof value === 'object'
            ? value
            : { balance: String(value) };
        } catch (err) {
          errors[address] = errorMessage(err);
        }
      });
    }));
    return { values: values, errors: errors };
  }

  function tonCenterBalance(address) {
    return fetchJson(providers().find('ton', 'toncenter').url + '/getAddressBalance?address=' + encodeURIComponent(address))
      .then(function (data) {
        var api = cacheApi();
        var parsed = api && typeof api.parseTonBalance === 'function'
          ? api.parseTonBalance(data)
          : null;
        if (!parsed) throw new Error('unexpected response');
        return parsed.amount;
      });
  }

  function tronBalanceDirect(address) {
    return accountJson(providers().find('tron', 'tronscan').url + '/account?address=' + encodeURIComponent(address))
      .then(function (data) { return { balance: String(Number(data.balance || 0)) }; });
  }

  /* The coordinator's TRON response, mapped to the per-address value shape
   * the cache and the balance cell already use. */
  function tronValue(data) {
    if (!data || typeof data !== 'object' || data.chain !== 'tron') return null;
    var balance = data.balance_sun === null || data.balance_sun === undefined
      ? null
      : String(data.balance_sun);
    return {
      balance: balance,
      tx: typeof data.tx_count === 'number' && isFinite(data.tx_count) ? data.tx_count : undefined,
      lastTxAt: typeof data.last_tx_at === 'number' && isFinite(data.last_tx_at) ? data.last_tx_at : undefined
    };
  }

  async function tronBalance(address) {
    /* Same-origin first; only a static host (404) or a coordinator without
     * the key (501) falls back to the previous direct TronScan request. */
    var response = await fetch('/api/v1/chain/tron/address?address=' + encodeURIComponent(address));
    if (response.status === 404 || response.status === 501) return tronBalanceDirect(address);
    if (!response.ok) {
      var err = new Error('HTTP ' + response.status);
      err.status = response.status;
      throw err;
    }
    var data = await response.json();
    var value = tronValue(data);
    if (!value) throw new Error('unexpected response');
    return value;
  }

  function tronChunks(addresses) {
    var chunks = [];
    for (var i = 0; i < addresses.length; i += TRON_BATCH_MAX) {
      chunks.push(addresses.slice(i, i + TRON_BATCH_MAX));
    }
    return chunks;
  }

  /* One batch request per 60 addresses. Returns null when the batch route is
   * absent (static host 404 / coordinator without a key 501) so the caller
   * can use the per-address path; per-address provider failures stay in the
   * results map. */
  async function tronBatchProvider(addresses) {
    var values = {};
    var errors = {};
    var unique = uniqueAddresses(addresses);
    if (!unique.length) return { values: values, errors: errors };
    var chunks = tronChunks(unique);
    for (var i = 0; i < chunks.length; i += 1) {
      var chunk = chunks[i];
      var response = await fetch('/api/v1/chain/tron/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: chunk })
      });
      if (response.status === 404 || response.status === 501) return null;
      if (!response.ok) {
        var message = 'HTTP ' + response.status;
        chunk.forEach(function (address) { errors[address] = message; });
        continue;
      }
      var data = null;
      try { data = await response.json(); } catch (err) { data = null; }
      var results = data && data.results ? data.results : null;
      if (!results) {
        chunk.forEach(function (address) { errors[address] = 'unexpected response'; });
        continue;
      }
      chunk.forEach(function (address) {
        var item = results[address];
        if (!item) {
          errors[address] = 'Balance row missing from the provider.';
          return;
        }
        if (item.error) {
          errors[address] = String(item.error);
          return;
        }
        var value = tronValue(item);
        if (!value) {
          errors[address] = 'unexpected response';
          return;
        }
        values[address] = value;
      });
    }
    return { values: values, errors: errors };
  }

  function xrpBalance(address) {
    /* XRPScan redirects some accounts to its bulk dataset
     * (data.xrpscan.com/tx.json), which carries no CORS header; the browser
     * would fail the request anyway, and following it downloads a huge file.
     * A redirect is therefore an honest provider failure, never a balance. */
    return accountJson(providers().find('xrp', 'xrpscan').url + '/account/' + encodeURIComponent(address), {
      redirect: 'error'
    })
      .then(function (data) {
        /* 404 (unactivated account) comes back as {}: a real zero balance. */
        if (!data || typeof data !== 'object' || !Object.keys(data).length) return '0';
        var api = cacheApi();
        var parsed = api && typeof api.parseXrpAccount === 'function'
          ? api.parseXrpAccount(data)
          : null;
        if (!parsed) throw new Error('unexpected response');
        return { balance: parsed.amount, tx: parsed.tx === null ? undefined : parsed.tx };
      });
  }

  /* Haskoin `GET /address/balances?addresses=<csv>`: one row per requested
   * address in the SAME ORDER as the query, and the provider echoes the
   * address in CashAddr form even when a legacy address was sent. The rows
   * are therefore mapped back to the request list by index. One bad address
   * fails the whole call (HTTP 400), which the caller reports as an error for
   * every address, never as zero balances. */
  function haskoinBatchUrl(addresses) {
    var unique = uniqueAddresses(addresses);
    return providers().find('bitcoin-cash', 'haskoin').url +
      '/address/balances?addresses=' + unique.map(encodeURIComponent).join(',');
  }

  async function haskoinBchProvider(addresses) {
    var values = {};
    var errors = {};
    var unique = uniqueAddresses(addresses);
    if (!unique.length) return { values: values, errors: errors };
    var data = await requestJson(haskoinBatchUrl(unique));
    var api = cacheApi();
    var rows = api && typeof api.parseHaskoinBchBatch === 'function'
      ? api.parseHaskoinBchBatch(data, unique)
      : null;
    if (!rows) throw new Error('unexpected response');
    unique.forEach(function (address, index) {
      var row = rows[index];
      if (!row) {
        errors[address] = 'Balance row missing from the provider.';
        return;
      }
      values[address] = {
        balance: row.amount,
        tx: row.tx === null || row.tx === undefined ? undefined : row.tx
      };
    });
    return { values: values, errors: errors };
  }

  /* TonAPI `POST /accounts/_bulk`: `{ account_ids: [...] }` answers
   * `{ accounts: [...] }` in the SAME ORDER as the request. The echoed
   * `address` is the raw `0:hex` form, so rows are mapped back by index,
   * never by string. A short/malformed body throws (the row shows the retry
   * state) instead of reporting a zero balance. `toncenter` stays for the
   * single-address `/key` page; the directories use this one-request batch. */
  function tonApiBatchUrl() {
    return providers().find('ton', 'tonapi').url + '/accounts/_bulk';
  }

  function parseTonApiAccounts(addresses, data) {
    var unique = uniqueAddresses(addresses);
    if (!data || !Array.isArray(data.accounts)) throw new Error('unexpected response');
    if (data.accounts.length !== unique.length) throw new Error('unexpected account count');
    var values = {};
    unique.forEach(function (address, index) {
      var account = data.accounts[index];
      if (!account || typeof account !== 'object') throw new Error('unexpected account row');
      var balance = account.balance === undefined || account.balance === null
        ? ''
        : String(account.balance);
      if (!/^\d+$/.test(balance)) throw new Error('unexpected account balance');
      values[address] = { balance: balance };
    });
    return values;
  }

  async function tonApiProvider(addresses) {
    var values = {};
    var errors = {};
    var unique = uniqueAddresses(addresses);
    if (!unique.length) return { values: values, errors: errors };
    var data = await requestJson(tonApiBatchUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_ids: unique })
    });
    values = parseTonApiAccounts(unique, data);
    return { values: values, errors: errors };
  }

  /* The keyless LTC fallback declared in data/providers.json is an Esplora
   * instance: `GET /address/<address>` answers one JSON object per address and
   * the confirmed satoshi balance is decoded by the shared
   * `parseLitecoinSpaceAddress`. The base URL comes from the SSOT entry, never
   * from a literal in this file. */
  function litecoinSpaceProvider(addresses) {
    var entry = providers().find('litecoin', 'litecoinspace');
    if (!entry) {
      return Promise.resolve({
        values: {},
        errors: uniqueAddresses(addresses).reduce(function (errors, address) {
          errors[address] = 'No Litecoin Space provider for litecoin.';
          return errors;
        }, {})
      });
    }
    var base = entry.url;
    return perAddressProvider(addresses, function (address) {
      return requestJson(base + '/address/' + encodeURIComponent(address))
        .then(function (data) {
          var api = cacheApi();
          var parsed = api && typeof api.parseLitecoinSpaceAddress === 'function'
            ? api.parseLitecoinSpaceAddress(data)
            : null;
          if (!parsed) throw new Error('unexpected response');
          return { balance: parsed.amount };
        });
    });
  }

  /* SoChain v3 `GET /balance/<ticker>/<address>`: one request per address,
   * decimal coin strings converted by the shared `parseSochainBalance`. The
   * endpoint comes from the chain's provider list, never from this file. */
  function sochainProvider(meta, addresses) {
    var list = (providers().byChain[meta.chain] || []).filter(function (provider) {
      return provider.id === 'sochain';
    });
    if (!list.length) {
      return Promise.resolve({
        values: {},
        errors: uniqueAddresses(addresses).reduce(function (errors, address) {
          errors[address] = 'No SoChain provider for this chain.';
          return errors;
        }, {})
      });
    }
    var base = list[0].url;
    var ticker = meta.symbol;
    if (!ticker) {
      return Promise.resolve({
        values: {},
        errors: uniqueAddresses(addresses).reduce(function (errors, address) {
          errors[address] = 'No SoChain ticker for this chain.';
          return errors;
        }, {})
      });
    }
    /* SoChain's keyless budget is 2500 lookups a DAY per IP. Once it answers
     * 429 ("Limits reached") every further address would fail the same way, so
     * the first 429 stops the rest of the page: without this a 60-row page
     * turns one exhausted quota into ~240 failing lookups. DOGE and ZEC have no
     * fallback, so their rows keep the honest retry state; Litecoin serves the
     * whole page through the keyless `litecoinspace` Esplora provider that the
     * SSOT already declares, like `/key` falls back to BlockCypher. */
    var exhausted = null;
    var sochain = perAddressProvider(addresses, function (address) {
      if (exhausted) return Promise.reject(exhausted);
      return requestJson(base + '/balance/' + encodeURIComponent(ticker) + '/' + encodeURIComponent(address))
        .then(function (data) {
          var api = cacheApi();
          var parsed = api && typeof api.parseSochainBalance === 'function'
            ? api.parseSochainBalance(data)
            : null;
          if (!parsed) throw new Error('unexpected response');
          var amount = BigInt(parsed.confirmed) + BigInt(parsed.unconfirmed);
          if (amount < 0n) amount = 0n;
          return { balance: amount.toString() };
        })
        .catch(function (err) {
          if (Number(err && err.status) === 429) exhausted = err;
          throw err;
        });
    });
    if (meta.chain !== 'litecoin') return sochain;
    return sochain.then(function (result) {
      return exhausted ? litecoinSpaceProvider(addresses) : result;
    });
  }

  var FETCHERS = {
    'blockchain.info': function (meta, addresses) { return btcProvider(addresses); },
    'evm': evmProvider,
    'solana': function (meta, addresses) { return solanaProvider(addresses); },
    'sui': function (meta, addresses) { return perAddressProvider(addresses, suiBalance); },
    'tronscan': function (meta, addresses) {
      if (addresses.length > TRON_BATCH_THRESHOLD) {
        return tronBatchProvider(addresses).then(function (batch) {
          return batch || perAddressProvider(addresses, tronBalance);
        });
      }
      return perAddressProvider(addresses, tronBalance);
    },
    'xrpscan': function (meta, addresses) { return perAddressProvider(addresses, xrpBalance); },
    'toncenter': function (meta, addresses) { return perAddressProvider(addresses, tonCenterBalance); },
    'tonapi': function (meta, addresses) { return tonApiProvider(addresses); },
    'haskoin-bch': function (meta, addresses) { return haskoinBchProvider(addresses); },
    'sochain': function (meta, addresses) { return sochainProvider(meta, addresses); }
  };

  function supportsProvider(name) {
    return Object.prototype.hasOwnProperty.call(FETCHERS, String(name));
  }

  function fetchProvider(meta, addresses) {
    if (!meta || !supportsProvider(meta.provider)) {
      return Promise.resolve({ values: {}, errors: {} });
    }
    return FETCHERS[meta.provider](meta, addresses || []);
  }

  return {
    BALANCE_LIMIT: BALANCE_LIMIT,
    TRON_BATCH_THRESHOLD: TRON_BATCH_THRESHOLD,
    TRON_BATCH_MAX: TRON_BATCH_MAX,
    providers: Object.keys(FETCHERS),
    supportsProvider: supportsProvider,
    fetchProvider: fetchProvider,
    uniqueAddresses: uniqueAddresses,
    solanaBatchBody: solanaBatchBody,
    haskoinBatchUrl: haskoinBatchUrl,
    parseTonApiAccounts: parseTonApiAccounts,
    tronValue: tronValue,
    tronChunks: tronChunks
  };
}));
