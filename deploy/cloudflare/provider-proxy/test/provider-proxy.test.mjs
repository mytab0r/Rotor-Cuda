import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  EVM_RPC_METHODS,
  buildTronScanUrl,
  isForbiddenHostname,
  safeUpstreamUrl,
  validateRpcBody,
} from "../src/upstreams.mjs";
import { handleRequest, resetRateLimits } from "../src/worker.mjs";

const SITE = "https://rotor.pxbt.app";
const CLIENT_IP = "203.0.113.9";
const TRON_ADDR = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const EVM_ADDR = "0x52908400098527886E0F7030069857D2E4169EE7";
const RPC_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "eth_getBalance",
  params: [EVM_ADDR, "latest"],
};

test.beforeEach(() => resetRateLimits());

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
  });
  return cache;
}

function providerJson(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function get(path, headers) {
  return new Request(`https://proxy.test${path}`, {
    headers: { "cf-connecting-ip": CLIENT_IP, ...headers },
  });
}

function post(path, body, headers) {
  return new Request(`https://proxy.test${path}`, {
    method: "POST",
    headers: { "cf-connecting-ip": CLIENT_IP, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// --- allowlist -----------------------------------------------------------

test("an allowlisted tronscan route reaches the fixed upstream host", async (t) => {
  const seen = [];
  installRuntime(t, async (url) => {
    seen.push(String(url));
    return providerJson({ balance: 1000 });
  });

  const response = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}`),
    { SITE_ORIGIN: SITE },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { balance: 1000 });
  assert.deepEqual(seen, [`https://apilist.tronscanapi.com/api/accountv2?address=${TRON_ADDR}`]);
});

test("unknown routes, extra query parameters and unknown chains are rejected", async (t) => {
  const seen = [];
  installRuntime(t, async (url) => {
    seen.push(String(url));
    return providerJson({});
  });
  const env = { SITE_ORIGIN: SITE };

  let response = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}&url=https://evil.example`),
    env,
  );
  assert.equal(response.status, 400);

  response = await handleRequest(get(`/v1/tron/unknown?address=${TRON_ADDR}`), env);
  assert.equal(response.status, 404);

  response = await handleRequest(post("/v1/rpc/evil", RPC_BODY), env);
  assert.equal(response.status, 400);

  response = await handleRequest(
    get(`/v1/tron/account?address=https://evil.example/`),
    env,
  );
  assert.equal(response.status, 400);

  assert.equal(seen.length, 0, "a rejected route must not call the provider");
});

test("route builders keep every upstream on a fixed origin", () => {
  const account = buildTronScanUrl("account", new URLSearchParams({ address: TRON_ADDR }));
  assert.equal(account.origin, "https://apilist.tronscanapi.com");
  const transfers = buildTronScanUrl(
    "token-transfers",
    new URLSearchParams({ address: TRON_ADDR, contract: TRON_CONTRACT, limit: "50" }),
  );
  assert.equal(transfers.origin, "https://apilist.tronscanapi.com");
  assert.equal(
    buildTronScanUrl("account", new URLSearchParams({ address: TRON_ADDR, host: "evil" })),
    null,
  );
});

// --- SSRF guard ----------------------------------------------------------

test("the SSRF guard refuses HTTP, private hosts and non-443 ports", () => {
  assert.equal(safeUpstreamUrl("http://rpc.example.com"), null);
  assert.equal(safeUpstreamUrl("https://127.0.0.1/rpc"), null);
  assert.equal(safeUpstreamUrl("https://10.0.0.5/rpc"), null);
  assert.equal(safeUpstreamUrl("https://169.254.169.254/latest/meta-data"), null);
  assert.equal(safeUpstreamUrl("https://192.168.1.1/rpc"), null);
  assert.equal(safeUpstreamUrl("https://[::1]/rpc"), null);
  assert.equal(safeUpstreamUrl("https://metadata.google.internal/"), null);
  assert.equal(safeUpstreamUrl("https://rpc.example.com:8443/rpc"), null);
  assert.equal(safeUpstreamUrl("https://user:pass@rpc.example.com/rpc"), null);
  assert.ok(safeUpstreamUrl("https://rpc.example.com/rpc"));
  assert.equal(isForbiddenHostname("localhost"), true);
  assert.equal(isForbiddenHostname("rpc.example.com"), false);
});

test("a configured RPC endpoint is validated before any fetch", async (t) => {
  const seen = [];
  installRuntime(t, async (url) => {
    seen.push(String(url));
    return providerJson({ jsonrpc: "2.0", id: 1, result: "0x0" });
  });

  let response = await handleRequest(post("/v1/rpc/eth", RPC_BODY), {
    SITE_ORIGIN: SITE,
    RPC_ENDPOINTS: JSON.stringify({ eth: "http://127.0.0.1:8545" }),
  });
  assert.equal(response.status, 400);
  assert.equal(seen.length, 0);

  response = await handleRequest(post("/v1/rpc/eth", RPC_BODY), {
    SITE_ORIGIN: SITE,
    RPC_ENDPOINTS: { eth: "https://169.254.169.254/latest/meta-data" },
  });
  assert.equal(response.status, 400);
  assert.equal(seen.length, 0);

  response = await handleRequest(post("/v1/rpc/eth", RPC_BODY), {
    SITE_ORIGIN: SITE,
    RPC_ENDPOINTS: { eth: "https://rpc.example.com" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["https://rpc.example.com/"]);
});

test("JSON-RPC allows read-only methods only", async (t) => {
  const seen = [];
  installRuntime(t, async (url) => {
    seen.push(String(url));
    return providerJson({ jsonrpc: "2.0", id: 1, result: "0x0" });
  });

  assert.equal(
    validateRpcBody(
      { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [] },
      EVM_RPC_METHODS,
    ),
    null,
  );
  assert.equal(
    validateRpcBody({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: "x" }, EVM_RPC_METHODS),
    null,
  );

  const response = await handleRequest(
    post("/v1/rpc/eth", { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [] }),
    { SITE_ORIGIN: SITE, RPC_ENDPOINTS: { eth: "https://rpc.example.com" } },
  );
  assert.equal(response.status, 400);
  assert.equal(seen.length, 0);
});

// --- key handling --------------------------------------------------------

test("the provider key is injected server-side and never reaches the response", async (t) => {
  let upstreamHeaders;
  installRuntime(t, async (url, init) => {
    upstreamHeaders = init.headers;
    return providerJson(
      { balance: 1 },
      200,
      { server: "upstream/1.0", "x-powered-by": "PHP/8" },
    );
  });

  const response = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}`, {
      origin: SITE,
      "cf-connecting-ip": "203.0.113.9",
      "x-edge-secret": "must-not-be-forwarded",
    }),
    { SITE_ORIGIN: SITE, TRONSCAN_API_KEY: "sk-live-secret" },
  );

  assert.equal(upstreamHeaders["tron-pro-api-key"], "sk-live-secret");
  assert.equal(upstreamHeaders["cf-connecting-ip"], undefined);
  assert.equal(upstreamHeaders["x-forwarded-for"], undefined);
  assert.equal(upstreamHeaders["x-edge-secret"], undefined);

  const text = await response.text();
  assert.equal(text.includes("sk-live-secret"), false);
  assert.equal(response.headers.get("server"), null);
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), SITE);
});

test("provider failures never echo the key or the upstream message", async (t) => {
  installRuntime(t, async () => {
    throw new Error("upstream said sk-live-secret");
  });

  const response = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}`),
    { SITE_ORIGIN: SITE, TRONSCAN_API_KEY: "sk-live-secret" },
  );
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.equal(text.includes("sk-live-secret"), false);
  assert.equal(text.includes("upstream said"), false);
  assert.deepEqual(JSON.parse(text), { error: "provider_unreachable" });
});

test("upstream error bodies and headers are replaced with a fixed code", async (t) => {
  let status = 404;
  installRuntime(
    t,
    async () =>
      new Response('{"detail":"provider secret detail"}', {
        status,
        headers: { "content-type": "application/json", server: "upstream/1.0" },
      }),
  );

  let response = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}`),
    { SITE_ORIGIN: SITE },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
  assert.equal(response.headers.get("server"), null);

  status = 429;
  response = await handleRequest(
    get(`/v1/tron/transactions?address=${TRON_ADDR}`),
    { SITE_ORIGIN: SITE },
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.deepEqual(await response.json(), { error: "rate_limited" });
});

// --- limits and caching --------------------------------------------------

test("an oversized upstream body is rejected", async (t) => {
  installRuntime(t, async () => new Response("x".repeat(2 * 1024 * 1024 + 1)));

  const response = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}`),
    { SITE_ORIGIN: SITE },
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "provider_response_too_large" });
});

test("an aborted provider call becomes a timeout", async (t) => {
  installRuntime(t, async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  });

  const response = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}`),
    { SITE_ORIGIN: SITE },
  );
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "provider_timeout" });
});

test("a client that exceeds the quota gets 429 with Retry-After", async (t) => {
  installRuntime(t, async () => providerJson({ balance: 1 }));

  let response;
  for (let index = 0; index < 500; index += 1) {
    response = await handleRequest(
      get(`/v1/tron/account?address=${TRON_ADDR}`),
      { SITE_ORIGIN: SITE },
    );
    if (response.status === 429) break;
  }
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.deepEqual(await response.json(), { error: "rate_limited" });
});

test("a request without a client address is rejected instead of sharing a bucket", async (t) => {
  const seen = [];
  installRuntime(t, async (url) => {
    seen.push(String(url));
    return providerJson({ balance: 1 });
  });

  // Built without the helper so no CF-Connecting-IP is present. This can only
  // happen off the Cloudflare route; refusing beats merging callers into one
  // "unknown" bucket.
  const response = await handleRequest(
    new Request(`https://proxy.test/v1/tron/account?address=${TRON_ADDR}`),
    { SITE_ORIGIN: SITE },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "missing_client_ip" });
  assert.equal(seen.length, 0, "a rejected request must not call the provider");
});

test("different client addresses get independent buckets", async (t) => {
  installRuntime(t, async () => providerJson({ balance: 1 }));
  const env = { SITE_ORIGIN: SITE };
  const first = { "cf-connecting-ip": "203.0.113.9" };
  const second = { "cf-connecting-ip": "198.51.100.4" };

  let response;
  for (let index = 0; index < 61; index += 1) {
    response = await handleRequest(
      get(`/v1/tron/account?address=${TRON_ADDR}`, first),
      env,
    );
  }
  assert.equal(response.status, 429, "the first address exhausted its bucket");

  response = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}`, second),
    env,
  );
  assert.equal(response.status, 200, "a second address must not inherit the limit");
});

test("GET responses are cached without the caller's identity in the key", async (t) => {
  let calls = 0;
  installRuntime(t, async () => {
    calls += 1;
    return providerJson({ balance: 7 });
  });

  const first = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}`, { "cf-connecting-ip": "203.0.113.9" }),
    { SITE_ORIGIN: SITE },
  );
  const second = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}`, { "cf-connecting-ip": "198.51.100.4" }),
    { SITE_ORIGIN: SITE },
  );

  assert.equal(calls, 1);
  assert.equal(await first.text(), await second.text());
});

// --- CORS and the coordinator secret ------------------------------------

test("CORS allows only the configured site origin, never a wildcard", async (t) => {
  installRuntime(t, async () => providerJson({ ok: true }));
  const env = { SITE_ORIGIN: SITE };

  let response = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}`, { origin: "https://evil.example" }),
    env,
  );
  assert.equal(response.status, 403);

  response = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}`, { origin: SITE }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), SITE);
  assert.notEqual(response.headers.get("access-control-allow-origin"), "*");

  response = await handleRequest(
    new Request(`https://proxy.test/v1/tron/account?address=${TRON_ADDR}`, {
      method: "OPTIONS",
      headers: { origin: SITE },
    }),
    env,
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), SITE);
});

test("a wrong shared secret is refused and a valid one is accepted", async (t) => {
  installRuntime(t, async () => providerJson({ balance: 1 }));
  const env = { SITE_ORIGIN: SITE, EDGE_PROXY_SECRET: "edge-secret" };

  let response = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}`, { "x-edge-secret": "wrong" }),
    env,
  );
  assert.equal(response.status, 403);

  response = await handleRequest(
    get(`/v1/tron/account?address=${TRON_ADDR}`, { "x-edge-secret": "edge-secret" }),
    env,
  );
  assert.equal(response.status, 200);
});

// --- same-origin mount, quote route, source hygiene ---------------------

test("the same-origin /edge prefix is accepted", async (t) => {
  const seen = [];
  installRuntime(t, async (url) => {
    seen.push(String(url));
    return providerJson({ balance: 1 });
  });

  const response = await handleRequest(
    get(`/edge/v1/tron/account?address=${TRON_ADDR}`),
    { SITE_ORIGIN: SITE },
  );
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].startsWith("https://apilist.tronscanapi.com/"));
});

test("the Sun.io route needs an explicit path on the fixed origin", async (t) => {
  const seen = [];
  installRuntime(t, async (url) => {
    seen.push(String(url));
    return providerJson({ amountOut: "1" });
  });
  const query = `tokenIn=${TRON_ADDR}&tokenOut=${TRON_CONTRACT}&amountIn=1000`;

  let response = await handleRequest(get(`/v1/quote?${query}`), { SITE_ORIGIN: SITE });
  assert.equal(response.status, 501);
  assert.equal(seen.length, 0);

  response = await handleRequest(get(`/v1/quote?${query}`), {
    SITE_ORIGIN: SITE,
    SUNIO_QUOTE_PATH: "https://evil.example/quote",
  });
  assert.equal(response.status, 501);
  assert.equal(seen.length, 0);

  response = await handleRequest(get(`/v1/quote?${query}`), {
    SITE_ORIGIN: SITE,
    SUNIO_QUOTE_PATH: "/v2/quote",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [
    `https://api.sun.io/v2/quote?tokenIn=${TRON_ADDR}&tokenOut=${TRON_CONTRACT}&amountIn=1000`,
  ]);
});

test("the worker source has no logging and never reads an upstream error message", () => {
  const source = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");
  assert.equal(/console\./.test(source), false, "the worker must not log");
  assert.equal(/error\.message/.test(source), false, "provider messages must not be surfaced");
  assert.equal(/x-forwarded-for/i.test(source), false, "forwarding headers are never read");
});
