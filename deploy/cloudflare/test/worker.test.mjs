import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CACHE_ORIGIN,
  buildCacheKey,
  cacheKeyUrl,
  decideCache,
} from "../src/cache.mjs";
import {
  formatBalance,
  isKnownChain,
  isValidAddress,
  normalizeAddress,
  unitFor,
} from "../src/chains.mjs";
import {
  HINT_MAX_AGE_MS,
  HINT_MAX_FUTURE_MS,
  parseBalanceValue,
  parseFetchedAt,
  validateHint,
} from "../src/hint.mjs";
import {
  backoffDelay,
  createConcurrencyLimiter,
  createTokenBucket,
  shouldRetryStatus,
} from "../src/limiters.mjs";
import {
  fetchProviderBalance,
  providerHealth,
  resetProviderState,
  resolveProvider,
} from "../src/providers.mjs";
import { containsSensitiveMaterial, findSensitiveMaterial } from "../src/security.mjs";
import { handleRequest } from "../src/worker.mjs";

const BTC_ADDR = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const BTC_BECH32 = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const EVM_ADDR = "0x52908400098527886E0F7030069857D2E4169EE7";
const TRON_ADDR = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const WIF = "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ";
const XPRV =
  "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
const HEX_KEY = "e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35";

// --- runtime stubs -------------------------------------------------------

function memoryCache() {
  const store = new Map();
  return {
    store,
    async match(request) {
      const response = store.get(request.url);
      return response ? response.clone() : undefined;
    },
    async put(request, response) {
      store.set(request.url, response.clone());
    },
  };
}

function installRuntime(t, fetchImpl) {
  const cache = memoryCache();
  const previousCaches = globalThis.caches;
  const previousFetch = globalThis.fetch;
  globalThis.caches = { default: cache };
  globalThis.fetch =
    fetchImpl ??
    (async () => {
      throw new Error("unexpected provider fetch");
    });
  t.after(() => {
    globalThis.caches = previousCaches;
    globalThis.fetch = previousFetch;
    resetProviderState();
  });
  return cache;
}

async function seed(cache, chain, address, entry) {
  await cache.put(
    buildCacheKey(chain, address),
    new Response(JSON.stringify(entry), { headers: { "content-type": "application/json" } }),
  );
}

function balanceRequest(chain, address) {
  return new Request(
    `https://edge.test/v1/balance?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`,
  );
}

function balancesRequest(chain, addresses) {
  const csv = Array.isArray(addresses) ? addresses.join(",") : addresses;
  return new Request(
    `https://edge.test/v1/balances?chain=${encodeURIComponent(chain)}&addresses=${encodeURIComponent(csv)}`,
  );
}

function reportRequest(body) {
  return new Request("https://edge.test/v1/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function providerJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- address validation --------------------------------------------------

test("btc validator accepts legacy and bech32 mainnet addresses only", () => {
  assert.equal(isValidAddress("btc", BTC_ADDR), true);
  assert.equal(isValidAddress("btc", BTC_BECH32), true);
  assert.equal(isValidAddress("btc", BTC_BECH32.toUpperCase()), true);
  assert.equal(isValidAddress("btc", EVM_ADDR), false);
  assert.equal(isValidAddress("btc", "1Boat"), false);
  assert.equal(isValidAddress("btc", "bc1qshort"), false);
  assert.equal(isValidAddress("btc", "tb1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"), false);
});

test("evm validator requires 0x plus 40 hex characters", () => {
  assert.equal(isValidAddress("eth", EVM_ADDR), true);
  assert.equal(isValidAddress("polygon", EVM_ADDR), true);
  assert.equal(isValidAddress("eth", EVM_ADDR.slice(2)), false);
  assert.equal(isValidAddress("eth", "0x123"), false);
  assert.equal(isValidAddress("eth", `${EVM_ADDR}00`), false);
});

test("tron validator requires T plus 33 base58 characters", () => {
  assert.equal(isValidAddress("tron", TRON_ADDR), true);
  assert.equal(isValidAddress("tron", TRON_ADDR.slice(0, -1)), false);
  assert.equal(isValidAddress("tron", `T${"0".repeat(33)}`), false);
  assert.equal(isValidAddress("tron", EVM_ADDR), false);
});

test("chain names and units are constrained to public identifiers", () => {
  assert.equal(isKnownChain("btc"), true);
  assert.equal(isKnownChain("tron"), true);
  assert.equal(isKnownChain("eth"), true);
  assert.equal(isKnownChain("polygon-zkevm"), true);
  assert.equal(isKnownChain(""), false);
  assert.equal(isKnownChain("../etc"), false);
  assert.equal(isKnownChain("BTC"), false);
  assert.equal(unitFor("btc"), "sats");
  assert.equal(unitFor("tron"), "sun");
  assert.equal(unitFor("eth"), "wei");
});

test("evm and bech32 addresses normalize to a stable lowercase form", () => {
  assert.equal(normalizeAddress("eth", EVM_ADDR), EVM_ADDR.toLowerCase());
  assert.equal(normalizeAddress("btc", BTC_BECH32.toUpperCase()), BTC_BECH32);
  assert.equal(normalizeAddress("btc", BTC_ADDR), BTC_ADDR);
  assert.equal(normalizeAddress("tron", TRON_ADDR), TRON_ADDR);
});

test("balance formatting stays exact: number while safe, decimal string beyond", () => {
  assert.equal(formatBalance(0), 0);
  assert.equal(formatBalance(2_100_000_000_000_000n), 2_100_000_000_000_000);
  assert.equal(formatBalance(10n ** 18n), "1000000000000000000");
  assert.throws(() => formatBalance(-1n), RangeError);
});

// --- cache key and stale-while-revalidate --------------------------------

test("cache key is stable and independent of visitor or query order", () => {
  assert.equal(cacheKeyUrl("btc", BTC_ADDR), `${CACHE_ORIGIN}/balance/btc/${encodeURIComponent(BTC_ADDR)}`);
  assert.equal(cacheKeyUrl("btc", BTC_ADDR), cacheKeyUrl("btc", BTC_ADDR));
  assert.equal(buildCacheKey("btc", BTC_ADDR).url, cacheKeyUrl("btc", BTC_ADDR));
  assert.notEqual(cacheKeyUrl("btc", BTC_ADDR), cacheKeyUrl("tron", BTC_ADDR));
  assert.equal(
    cacheKeyUrl("eth", normalizeAddress("eth", EVM_ADDR)),
    cacheKeyUrl("eth", EVM_ADDR.toLowerCase()),
  );
});

test("decideCache applies provider TTL, shorter hint TTL and the stale window", () => {
  const now = 1_700_000_000_000;
  const options = { providerTtlMs: 60_000, clientTtlMs: 15_000, staleMaxMs: 900_000 };
  assert.equal(decideCache(null, now, options), "miss");
  assert.equal(decideCache({ source: "provider" }, now, options), "miss");
  assert.equal(decideCache({ source: "provider", fetchedAt: now - 30_000 }, now, options), "fresh");
  assert.equal(decideCache({ source: "client", fetchedAt: now - 10_000 }, now, options), "fresh");
  assert.equal(decideCache({ source: "client", fetchedAt: now - 30_000 }, now, options), "stale");
  assert.equal(decideCache({ source: "provider", fetchedAt: now - 120_000 }, now, options), "stale");
  assert.equal(decideCache({ source: "provider", fetchedAt: now - 900_001 }, now, options), "expired");
  assert.equal(decideCache({ source: "provider", fetchedAt: now + 5_000 }, now, options), "fresh");
});

// --- limits --------------------------------------------------------------

test("token bucket drains, refills and caps at capacity", () => {
  const bucket = createTokenBucket({ capacity: 2, refillPerSecond: 1 });
  assert.equal(bucket.take(0), true);
  assert.equal(bucket.take(0), true);
  assert.equal(bucket.take(0), false);
  assert.equal(bucket.available(500), 0.5);
  assert.equal(bucket.take(1_000), true);
  assert.equal(bucket.available(1_000), 0);
  assert.equal(bucket.available(100_000), 2);
});

test("concurrency limiter never exceeds max and hands slots to waiters", async () => {
  const limiter = createConcurrencyLimiter(1);
  const releaseFirst = await limiter.acquire();
  assert.equal(limiter.active, 1);

  let secondAcquired = false;
  const second = limiter.acquire().then((release) => {
    secondAcquired = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(secondAcquired, false);
  assert.equal(limiter.queued, 1);

  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondAcquired, true);
  assert.equal(limiter.active, 1);
  releaseSecond();
  assert.equal(limiter.active, 0);
});

test("exponential backoff grows, jitters and caps", () => {
  assert.equal(backoffDelay(0, { baseMs: 200, maxMs: 2_000, random: () => 1 }), 200);
  assert.equal(backoffDelay(0, { baseMs: 200, maxMs: 2_000, random: () => 0 }), 100);
  assert.equal(backoffDelay(1, { baseMs: 200, maxMs: 2_000, random: () => 1 }), 400);
  assert.equal(backoffDelay(2, { baseMs: 200, maxMs: 2_000, random: () => 1 }), 800);
  assert.equal(backoffDelay(10, { baseMs: 200, maxMs: 2_000, random: () => 1 }), 2_000);
  assert.equal(shouldRetryStatus(429), true);
  assert.equal(shouldRetryStatus(500), true);
  assert.equal(shouldRetryStatus(503), true);
  assert.equal(shouldRetryStatus(400), false);
  assert.equal(shouldRetryStatus(200), false);
});

test("provider adapter retries one 503 with backoff and then succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response("upstream down", { status: 503 });
    return providerJson({ chain_stats: { funded_txo_sum: 10, spent_txo_sum: 4 } });
  };
  const result = await fetchProviderBalance(resolveProvider("btc", {}), BTC_ADDR, {
    fetchImpl,
    random: () => 0,
    now: () => 1_700_000_000_000,
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, { value: 6, unit: "sats", fetchedAt: 1_700_000_000_000 });
});

test("provider adapter gives up after one retry on 429", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("slow down", { status: 429 });
  };
  await assert.rejects(
    fetchProviderBalance(resolveProvider("btc", {}), BTC_ADDR, { fetchImpl, random: () => 0 }),
    (error) => error.code === "http_429" && error.status === 429,
  );
  assert.equal(calls, 2);
});

// --- secret-shaped input -------------------------------------------------

test("key-shaped strings are detected", () => {
  assert.deepEqual(findSensitiveMaterial(WIF), ["wif"]);
  assert.deepEqual(findSensitiveMaterial(XPRV), ["extended_private_key"]);
  assert.ok(findSensitiveMaterial(HEX_KEY).includes("hex_private_key"));
  assert.ok(findSensitiveMaterial('{"privateKey":"anything"}').includes("keypair_json"));
  assert.ok(
    findSensitiveMaterial('{"crypto":{"cipher":"aes-128-ctr"},"kdf":"scrypt"}').includes("keystore_json"),
  );
  assert.ok(
    findSensitiveMaterial("-----BEGIN EC PRIVATE KEY-----\nAAAA").includes("pem_private_key"),
  );
  assert.ok(
    findSensitiveMaterial("abandon ability able about above absent absorb abstract absurd abuse access accident").includes(
      "seed_words",
    ),
  );
  assert.equal(containsSensitiveMaterial(`{"chain":"btc","address":"${BTC_ADDR}"}`), false);
});

// --- hint validation -----------------------------------------------------

test("hint validation accepts a public balance and rejects bad fields", () => {
  const now = 1_700_000_000_000;
  const good = validateHint(
    { chain: "btc", address: BTC_ADDR, value: 1234, fetchedAt: now - 1_000 },
    now,
  );
  assert.equal(good.ok, true);
  assert.deepEqual(good.hint, {
    chain: "btc",
    address: BTC_ADDR,
    value: 1234,
    unit: "sats",
    fetchedAt: now - 1_000,
    source: "client",
  });

  const reasonsFor = (body) => validateHint(body, now).reasons;
  assert.deepEqual(reasonsFor({ chain: "btc", address: "nope", value: 1, fetchedAt: now }), ["bad_address"]);
  assert.deepEqual(
    reasonsFor({ chain: "btc", address: BTC_ADDR, value: -1, fetchedAt: now }),
    ["bad_value"],
  );
  assert.deepEqual(
    reasonsFor({ chain: "btc", address: BTC_ADDR, value: "NaN", fetchedAt: now }),
    ["bad_value"],
  );
  assert.deepEqual(
    reasonsFor({ chain: "btc", address: BTC_ADDR, value: 1.5, fetchedAt: now }),
    ["bad_value"],
  );
  assert.deepEqual(
    reasonsFor({ chain: "btc", address: BTC_ADDR, value: 1, fetchedAt: now + HINT_MAX_FUTURE_MS + 1 }),
    ["future_timestamp"],
  );
  assert.deepEqual(
    reasonsFor({ chain: "btc", address: BTC_ADDR, value: 1, fetchedAt: now - HINT_MAX_AGE_MS - 1 }),
    ["ancient_timestamp"],
  );
  assert.deepEqual(
    reasonsFor({ chain: "btc", address: BTC_ADDR, value: 1, fetchedAt: "not-a-date" }),
    ["bad_timestamp"],
  );
  assert.deepEqual(
    reasonsFor({ chain: "btc", address: BTC_ADDR, value: "12", fetchedAt: now, extra: true }),
    ["unknown_field"],
  );
  assert.deepEqual(reasonsFor({ chain: "../x", address: BTC_ADDR, value: 1, fetchedAt: now }), [
    "bad_chain",
  ]);
});

test("hint value and timestamp parsers accept safe numeric forms only", () => {
  assert.equal(parseBalanceValue("00012"), null);
  assert.equal(parseBalanceValue("18446744073709551616"), "18446744073709551616");
  assert.equal(parseBalanceValue(-1), null);
  assert.equal(parseBalanceValue(Number.NaN), null);
  assert.equal(parseBalanceValue(Infinity), null);
  assert.equal(parseFetchedAt("1700000000000"), 1_700_000_000_000);
  assert.equal(parseFetchedAt("2026-11-20T00:00:00.000Z"), Date.parse("2026-11-20T00:00:00.000Z"));
  assert.equal(parseFetchedAt("1700000000000abc"), null);
  assert.equal(parseFetchedAt(null), null);
});

// --- HTTP handler --------------------------------------------------------

test("GET /v1/balance fetches mempool.space on a miss and caches provider data", async (t) => {
  const calls = [];
  const cache = installRuntime(t, async (input) => {
    calls.push(String(input));
    return providerJson({ chain_stats: { funded_txo_sum: 5_000, spent_txo_sum: 2_000 } });
  });

  const response = await handleRequest(balanceRequest("btc", BTC_ADDR), {}, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.chain, "btc");
  assert.equal(body.address, BTC_ADDR);
  assert.equal(body.value, 3_000);
  assert.equal(body.unit, "sats");
  assert.equal(body.source, "provider");
  assert.equal(body.stale, false);
  assert.equal(Number.isInteger(body.fetchedAt), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/mempool\.space\/api\/address\//);

  const stored = await cache.store.get(buildCacheKey("btc", BTC_ADDR).url).json();
  assert.equal(stored.source, "provider");
  assert.equal(stored.value, 3_000);
});

test("GET /v1/balance serves a fresh cache entry without calling the provider", async (t) => {
  const cache = installRuntime(t);
  await seed(cache, "btc", BTC_ADDR, {
    chain: "btc",
    address: BTC_ADDR,
    value: 777,
    unit: "sats",
    fetchedAt: Date.now() - 1_000,
    source: "provider",
  });

  const response = await handleRequest(balanceRequest("btc", BTC_ADDR), {}, {});
  const body = await response.json();
  assert.equal(body.value, 777);
  assert.equal(body.source, "provider");
  assert.equal(body.stale, false);
});

test("GET /v1/balance serves a client hint while its shorter TTL lasts", async (t) => {
  const cache = installRuntime(t);
  await seed(cache, "btc", BTC_ADDR, {
    chain: "btc",
    address: BTC_ADDR,
    value: 321,
    unit: "sats",
    fetchedAt: Date.now() - 1_000,
    source: "client",
  });

  const body = await (await handleRequest(balanceRequest("btc", BTC_ADDR), {}, {})).json();
  assert.equal(body.value, 321);
  assert.equal(body.source, "client");
  assert.equal(body.stale, false);
});

test("GET /v1/balance serves stale immediately and revalidates in waitUntil", async (t) => {
  const cache = installRuntime(t, async () => providerJson({ chain_stats: { funded_txo_sum: 9_000, spent_txo_sum: 0 } }));
  await seed(cache, "btc", BTC_ADDR, {
    chain: "btc",
    address: BTC_ADDR,
    value: 111,
    unit: "sats",
    fetchedAt: Date.now() - 120_000,
    source: "provider",
  });

  const pending = [];
  const response = await handleRequest(balanceRequest("btc", BTC_ADDR), {}, {
    waitUntil(promise) {
      pending.push(promise);
    },
  });
  const body = await response.json();
  assert.equal(body.value, 111);
  assert.equal(body.stale, true);
  assert.equal(pending.length, 1);

  await Promise.all(pending);
  const updated = await cache.store.get(buildCacheKey("btc", BTC_ADDR).url).json();
  assert.equal(updated.value, 9_000);
  assert.equal(updated.source, "provider");
});

test("GET /v1/balance refetches synchronously once the stale window is over", async (t) => {
  const cache = installRuntime(t, async () => providerJson({ chain_stats: { funded_txo_sum: 42, spent_txo_sum: 0 } }));
  await seed(cache, "btc", BTC_ADDR, {
    chain: "btc",
    address: BTC_ADDR,
    value: 1,
    unit: "sats",
    fetchedAt: Date.now() - 16 * 60_000,
    source: "provider",
  });

  const body = await (await handleRequest(balanceRequest("btc", BTC_ADDR), {}, {})).json();
  assert.equal(body.value, 42);
  assert.equal(body.stale, false);
});

test("GET /v1/balance falls back to a stale copy when the provider fails", async (t) => {
  const cache = installRuntime(t, async () => {
    throw new Error("network down");
  });
  await seed(cache, "btc", BTC_ADDR, {
    chain: "btc",
    address: BTC_ADDR,
    value: 333,
    unit: "sats",
    fetchedAt: Date.now() - 16 * 60_000,
    source: "provider",
  });

  const response = await handleRequest(balanceRequest("btc", BTC_ADDR), {}, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.value, 333);
  assert.equal(body.stale, true);
  assert.equal(body.error, "provider_error");
});

test("GET /v1/balance returns 501 no_provider for an unconfigured chain", async (t) => {
  installRuntime(t);
  const response = await handleRequest(balanceRequest("polygon", EVM_ADDR), {}, {});
  assert.equal(response.status, 501);
  assert.deepEqual(await response.json(), { error: "no_provider" });
});

test("GET /v1/balance rejects bad chain and bad address without echoing input", async (t) => {
  const cache = installRuntime(t);
  const badChain = await handleRequest(balanceRequest("not a chain", BTC_ADDR), {}, {});
  assert.equal(badChain.status, 400);
  assert.deepEqual(await badChain.json(), { error: "bad_chain" });

  const badAddress = await handleRequest(balanceRequest("btc", WIF), {}, {});
  assert.equal(badAddress.status, 400);
  const text = await badAddress.text();
  assert.equal(text.includes(WIF), false);
  assert.deepEqual(JSON.parse(text), { error: "bad_address" });
  assert.equal(cache.store.size, 0);
});

test("GET /v1/balance uses CHAIN_RPCS for EVM eth_getBalance and keeps wei exact", async (t) => {
  let seen;
  installRuntime(t, async (input, init) => {
    seen = { url: String(input), init };
    return providerJson({ jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" });
  });

  const env = { CHAIN_RPCS: JSON.stringify({ eth: "https://rpc.example/eth" }) };
  const body = await (await handleRequest(balanceRequest("eth", EVM_ADDR), env, {})).json();
  assert.equal(body.chain, "eth");
  assert.equal(body.value, "1000000000000000000");
  assert.equal(body.unit, "wei");
  assert.equal(seen.url, "https://rpc.example/eth");
  assert.equal(seen.init.method, "POST");
  assert.deepEqual(JSON.parse(seen.init.body).params, [EVM_ADDR.toLowerCase(), "latest"]);
});

test("GET /v1/balance reads the TRON balance in sun", async (t) => {
  let seen;
  installRuntime(t, async (input) => {
    seen = String(input);
    return providerJson({ balance: 1_234_567 });
  });

  const body = await (await handleRequest(balanceRequest("tron", TRON_ADDR), {}, {})).json();
  assert.equal(body.value, 1_234_567);
  assert.equal(body.unit, "sun");
  assert.match(seen, /^https:\/\/apilist\.tronscanapi\.com\/api\/account\?address=/);
});

// --- batch handler -------------------------------------------------------

test("GET /v1/balances serves fresh seeded entries in request order", async (t) => {
  let calls = 0;
  const cache = installRuntime(t, async () => {
    calls += 1;
    throw new Error("unexpected provider fetch");
  });
  await seed(cache, "btc", BTC_BECH32, {
    chain: "btc",
    address: BTC_BECH32,
    value: 222,
    unit: "sats",
    fetchedAt: Date.now() - 1_000,
    source: "provider",
  });
  await seed(cache, "btc", BTC_ADDR, {
    chain: "btc",
    address: BTC_ADDR,
    value: 111,
    unit: "sats",
    fetchedAt: Date.now() - 1_000,
    source: "provider",
  });

  const response = await handleRequest(balancesRequest("btc", [BTC_BECH32, BTC_ADDR]), {}, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.chain, "btc");
  assert.equal(body.unit, "sats");
  assert.deepEqual(
    body.balances.map((item) => [item.address, item.value, item.stale]),
    [
      [BTC_BECH32, 222, false],
      [BTC_ADDR, 111, false],
    ],
  );
  assert.equal(calls, 0);
});

test("GET /v1/balances dedupes mixed-case EVM addresses into one provider call", async (t) => {
  const calls = [];
  const env = { CHAIN_RPCS: JSON.stringify({ eth: "https://rpc.example/eth" }) };
  installRuntime(t, async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(init.body) });
    return providerJson({ jsonrpc: "2.0", id: 1, result: "0x1" });
  });

  const mixedCase = `0x${EVM_ADDR.slice(2).toUpperCase()}`;
  const body = await (
    await handleRequest(balancesRequest("eth", [EVM_ADDR, mixedCase]), env, {})
  ).json();
  assert.equal(calls.length, 1);
  assert.equal(body.balances.length, 1);
  assert.equal(body.balances[0].address, EVM_ADDR.toLowerCase());
  assert.equal(body.balances[0].value, 1);
  assert.equal(body.balances[0].unit, "wei");
  assert.deepEqual(calls[0].body.params, [EVM_ADDR.toLowerCase(), "latest"]);
});

test("GET /v1/balances rejects empty and oversized address lists", async (t) => {
  installRuntime(t);

  const empty = await handleRequest(balancesRequest("btc", "  ,  "), {}, {});
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: "bad_addresses" });

  const tooMany = Array.from(
    { length: 61 },
    (_, index) => `0x${index.toString(16).padStart(40, "0")}`,
  );
  const oversized = await handleRequest(balancesRequest("btc", tooMany), {}, {});
  assert.equal(oversized.status, 400);
  assert.deepEqual(await oversized.json(), { error: "too_many_addresses", max: 60 });

  const badChain = await handleRequest(balancesRequest("not a chain", [BTC_ADDR]), {}, {});
  assert.equal(badChain.status, 400);
  assert.deepEqual(await badChain.json(), { error: "bad_chain" });
});

test("GET /v1/balances reports one bad address without failing the others", async (t) => {
  let calls = 0;
  installRuntime(t, async () => {
    calls += 1;
    return providerJson({ chain_stats: { funded_txo_sum: 5_000, spent_txo_sum: 2_000 } });
  });

  const body = await (
    await handleRequest(
      balancesRequest("btc", [BTC_ADDR, "not-an-address", BTC_BECH32]),
      {},
      {},
    )
  ).json();
  assert.equal(calls, 2);
  assert.deepEqual(body.balances[0].value, 3_000);
  assert.deepEqual(body.balances[1], { address: "not-an-address", error: "bad_address" });
  assert.equal(body.balances[2].address, BTC_BECH32);
  assert.equal(body.balances[2].value, 3_000);
});

test("GET /v1/balances stops at the per-isolate bucket and flags the rest", async (t) => {
  resetProviderState();
  installRuntime(t, async () => providerJson({ chain_stats: { funded_txo_sum: 7, spent_txo_sum: 0 } }));

  const addresses = Array.from(
    { length: 9 },
    (_, index) => `${BTC_ADDR.slice(0, -1)}${"123456789"[index]}`,
  );
  const body = await (await handleRequest(balancesRequest("btc", addresses), {}, {})).json();

  assert.equal(body.balances.length, 9);
  for (const item of body.balances.slice(0, 8)) {
    assert.equal(item.value, 7);
    assert.equal(item.error, undefined);
  }
  assert.deepEqual(body.balances[8], {
    address: addresses[8],
    error: "rate_limited",
    retryAfterMs: 250,
  });
});

test("GET /v1/balances serves a stale entry and schedules the refresh", async (t) => {
  const cache = installRuntime(t, async () =>
    providerJson({ chain_stats: { funded_txo_sum: 9_000, spent_txo_sum: 0 } }),
  );
  await seed(cache, "btc", BTC_ADDR, {
    chain: "btc",
    address: BTC_ADDR,
    value: 111,
    unit: "sats",
    fetchedAt: Date.now() - 120_000,
    source: "provider",
  });

  const pending = [];
  const response = await handleRequest(balancesRequest("btc", [BTC_ADDR]), {}, {
    waitUntil(promise) {
      pending.push(promise);
    },
  });
  const body = await response.json();
  assert.equal(body.balances[0].value, 111);
  assert.equal(body.balances[0].stale, true);
  assert.equal(pending.length, 1);

  await Promise.all(pending);
  const updated = await cache.store.get(buildCacheKey("btc", BTC_ADDR).url).json();
  assert.equal(updated.value, 9_000);
  assert.equal(updated.source, "provider");
});

test("POST /v1/report stores a valid hint with source client and a short TTL", async (t) => {
  const cache = installRuntime(t);
  const response = await handleRequest(
    reportRequest({ chain: "btc", address: BTC_ADDR, value: 42, fetchedAt: Date.now() - 500 }),
    {},
    {},
  );
  assert.equal(response.status, 204);

  const stored = await cache.store.get(buildCacheKey("btc", BTC_ADDR).url);
  assert.ok(stored);
  assert.match(stored.headers.get("cache-control"), /max-age=15/);
  const entry = await stored.json();
  assert.equal(entry.source, "client");
  assert.equal(entry.value, 42);
  assert.equal(entry.unit, "sats");
});

test("POST /v1/report accepts numeric strings and older client hints lose", async (t) => {
  const cache = installRuntime(t);
  const now = Date.now();

  let response = await handleRequest(
    reportRequest({ chain: "btc", address: BTC_ADDR, value: "100", fetchedAt: now - 2_000 }),
    {},
    {},
  );
  assert.equal(response.status, 204);

  response = await handleRequest(
    reportRequest({ chain: "btc", address: BTC_ADDR, value: 50, fetchedAt: now - 5_000 }),
    {},
    {},
  );
  assert.equal(response.status, 204);

  const entry = await cache.store.get(buildCacheKey("btc", BTC_ADDR).url).json();
  assert.equal(entry.value, 100);
});

test("POST /v1/report never overwrites a provider entry", async (t) => {
  const cache = installRuntime(t);
  await seed(cache, "btc", BTC_ADDR, {
    chain: "btc",
    address: BTC_ADDR,
    value: 999,
    unit: "sats",
    fetchedAt: Date.now() - 10 * 60_000,
    source: "provider",
  });

  const response = await handleRequest(
    reportRequest({ chain: "btc", address: BTC_ADDR, value: 1, fetchedAt: Date.now() }),
    {},
    {},
  );
  assert.equal(response.status, 204);
  const entry = await cache.store.get(buildCacheKey("btc", BTC_ADDR).url).json();
  assert.equal(entry.source, "provider");
  assert.equal(entry.value, 999);
});

test("POST /v1/report rejects secret-shaped bodies with 400", async (t) => {
  installRuntime(t);
  const now = Date.now();

  const wifResponse = await handleRequest(
    reportRequest({ chain: "btc", address: WIF, value: 1, fetchedAt: now }),
    {},
    {},
  );
  assert.equal(wifResponse.status, 400);
  assert.deepEqual(await wifResponse.json(), { error: "invalid_hint", reasons: ["sensitive_material"] });

  const keypairResponse = await handleRequest(
    reportRequest({ chain: "btc", address: BTC_ADDR, value: 1, fetchedAt: now, privateKey: HEX_KEY }),
    {},
    {},
  );
  assert.equal(keypairResponse.status, 400);
  assert.deepEqual(await keypairResponse.json(), {
    error: "invalid_hint",
    reasons: ["sensitive_material"],
  });

  const xprvResponse = await handleRequest(
    reportRequest({ chain: "btc", address: BTC_ADDR, value: 1, fetchedAt: now, seed: XPRV }),
    {},
    {},
  );
  assert.equal(xprvResponse.status, 400);
  assert.deepEqual(await xprvResponse.json(), { error: "invalid_hint", reasons: ["sensitive_material"] });
});

test("POST /v1/report returns reasons for invalid hints", async (t) => {
  installRuntime(t);
  const now = Date.now();

  const negative = await handleRequest(
    reportRequest({ chain: "btc", address: BTC_ADDR, value: -5, fetchedAt: now }),
    {},
    {},
  );
  assert.equal(negative.status, 400);
  assert.deepEqual(await negative.json(), { error: "invalid_hint", reasons: ["bad_value"] });

  const future = await handleRequest(
    reportRequest({ chain: "btc", address: BTC_ADDR, value: 5, fetchedAt: now + 3_600_000 }),
    {},
    {},
  );
  assert.equal(future.status, 400);
  assert.deepEqual(await future.json(), { error: "invalid_hint", reasons: ["future_timestamp"] });

  const unknown = await handleRequest(
    reportRequest({ chain: "btc", address: BTC_ADDR, value: 5, fetchedAt: now, nickname: "alice" }),
    {},
    {},
  );
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: "invalid_hint", reasons: ["unknown_field"] });

  const badJson = await handleRequest(reportRequest("{not json"), {}, {});
  assert.equal(badJson.status, 400);
  assert.deepEqual(await badJson.json(), { error: "invalid_hint", reasons: ["bad_json"] });
});

test("POST /v1/report rejects an oversized body", async (t) => {
  installRuntime(t);
  const response = await handleRequest(reportRequest("x".repeat(5_000)), {}, {});
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "body_too_large" });
});

test("GET /healthz reports which providers are configured", async () => {
  const response = await handleRequest(
    new Request("https://edge.test/healthz"),
    { CHAIN_RPCS: JSON.stringify({ eth: "https://rpc.example", polygon: "not-a-url" }) },
    {},
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.providers.btc, { configured: true });
  assert.deepEqual(body.providers.tron, { configured: true });
  assert.deepEqual(body.providers.eth, { configured: true });
  assert.deepEqual(body.providers.polygon, { configured: false });
});

test("unknown routes return 404 and OPTIONS is answered", async (t) => {
  installRuntime(t);
  const notFound = await handleRequest(new Request("https://edge.test/nope"), {}, {});
  assert.equal(notFound.status, 404);

  const preflight = await handleRequest(
    new Request("https://edge.test/v1/balance", { method: "OPTIONS" }),
    {},
    {},
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
});

// --- health helper -------------------------------------------------------

test("providerHealth lists configured EVM chains from CHAIN_RPCS JSON", () => {
  const providers = providerHealth({
    CHAIN_RPCS: '{"eth":"https://rpc.example","bnb":"http://localhost:8545"}',
  });
  assert.equal(providers.btc.configured, true);
  assert.equal(providers.tron.configured, true);
  assert.equal(providers.eth.configured, true);
  assert.equal(providers.bnb.configured, true);
});
