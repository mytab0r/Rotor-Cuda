// Rotor provider proxy (Cloudflare Worker).
//
// The origin server and browser clients call this worker instead of the
// upstream provider, so the provider sees Cloudflare's egress address rather
// than the origin and never sees a provider key held by the browser.
//
// Routes (an optional `/edge` prefix is stripped, for same-origin mounting):
//   GET  /v1/tron/account?address=...
//   GET  /v1/tron/transactions?address=&limit=&start=
//   GET  /v1/tron/token-transfers?address=&contract=&limit=&start=
//   GET  /v1/tron/trongrid/accounts?address=...
//   POST /v1/tron/tronstack/jsonrpc
//   POST /v1/rpc/<chain>          (JSON-RPC, read-only method allowlist)
//   GET  /v1/quote?tokenIn=&tokenOut=&amountIn=
//   GET  /healthz
//
// This worker never logs. It stores no client identity: the per-client rate
// limit uses a salted in-memory digest, never the raw address, and nothing is
// persisted. Provider secrets are added server-side and never returned,
// echoed in an error or written anywhere.

import { readCache, writeCache } from "../../src/cache.mjs";
import { createKeyedLimiter, createTokenBucket } from "../../src/limiters.mjs";
import {
  EVM_RPC_METHODS,
  QUOTE_QUERY,
  TRONSCAN_QUERY,
  TRONGRID_QUERY,
  TRONSTACK_RPC_URL,
  TRON_RPC_METHODS,
  buildQuoteUrl,
  buildTronGridUrl,
  buildTronScanUrl,
  hasOnlyAllowedParams,
  parseRpcEndpoints,
  resolveRpcEndpoint,
  validateRpcBody,
} from "./upstreams.mjs";

const DEFAULT_SITE_ORIGIN = "https://rotor.pxbt.app";
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 15_000;
const RETRY_AFTER_SECONDS = "1";

// Per-client quota (keyed by a salted digest of the IP) and a per-isolate
// global provider quota. Both are per isolate, like the balance cache worker:
// they bound one PoP, not the whole network.
const CLIENT_LIMIT = { capacity: 60, refillPerSecond: 10 };
const GLOBAL_LIMIT = { capacity: 120, refillPerSecond: 30 };
const clientLimiter = createKeyedLimiter(CLIENT_LIMIT);
let globalLimiter = createTokenBucket(GLOBAL_LIMIT);
let clientSalt = randomSalt();

export function resetRateLimits() {
  clientLimiter.reset();
  globalLimiter = createTokenBucket(GLOBAL_LIMIT);
  clientSalt = randomSalt();
}

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export default {
  async fetch(request, env = {}, ctx = {}) {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);
  // A same-origin mount is `https://site/edge/*`; Cloudflare passes the full
  // path to the worker, so accept both forms.
  const pathname = url.pathname.startsWith("/edge/")
    ? url.pathname.slice("/edge".length)
    : url.pathname;

  const siteOrigin = nonEmpty(env.SITE_ORIGIN) ?? DEFAULT_SITE_ORIGIN;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== siteOrigin) {
    return json({ error: "forbidden_origin" }, 403);
  }
  const cors = corsHeaders(origin, siteOrigin);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...cors, "access-control-max-age": "86400" },
    });
  }
  if (pathname === "/healthz" && request.method === "GET") {
    return json({ ok: true, providers: providerHealth(env) }, 200, cors);
  }

  const caller = await callerTrust(request, env);
  if (caller.invalid) return json({ error: "forbidden" }, 403, cors);

  const refusal = await enforceLimits(request, caller.trusted);
  if (refusal) return withHeaders(refusal, cors);

  if (request.method === "GET") {
    if (pathname === "/v1/tron/account") {
      if (!hasOnlyAllowedParams(url.searchParams, TRONSCAN_QUERY.account)) {
        return json({ error: "bad_query" }, 400, cors);
      }
      return proxyJson(
        env,
        buildTronScanUrl("account", url.searchParams),
        "tronscan",
        "tron-account",
        cors,
      );
    }
    if (pathname === "/v1/tron/transactions") {
      if (!hasOnlyAllowedParams(url.searchParams, TRONSCAN_QUERY.transactions)) {
        return json({ error: "bad_query" }, 400, cors);
      }
      return proxyJson(
        env,
        buildTronScanUrl("transactions", url.searchParams),
        "tronscan",
        "tron-transactions",
        cors,
      );
    }
    if (pathname === "/v1/tron/token-transfers") {
      if (!hasOnlyAllowedParams(url.searchParams, TRONSCAN_QUERY["token-transfers"])) {
        return json({ error: "bad_query" }, 400, cors);
      }
      return proxyJson(
        env,
        buildTronScanUrl("token-transfers", url.searchParams),
        "tronscan",
        "tron-token-transfers",
        cors,
      );
    }
    if (pathname === "/v1/tron/trongrid/accounts") {
      if (!hasOnlyAllowedParams(url.searchParams, TRONGRID_QUERY)) {
        return json({ error: "bad_query" }, 400, cors);
      }
      return proxyJson(
        env,
        buildTronGridUrl(url.searchParams),
        "trongrid",
        "trongrid-accounts",
        cors,
      );
    }
    if (pathname === "/v1/quote") {
      if (!hasOnlyAllowedParams(url.searchParams, QUOTE_QUERY)) {
        return json({ error: "bad_query" }, 400, cors);
      }
      const quotePath = nonEmpty(env.SUNIO_QUOTE_PATH);
      if (
        !quotePath ||
        !quotePath.startsWith("/") ||
        quotePath.startsWith("//") ||
        quotePath.includes("?") ||
        quotePath.includes("#") ||
        quotePath.includes("..")
      ) {
        return json({ error: "provider_not_configured" }, 501, cors);
      }
      const upstream = buildQuoteUrl(url.searchParams, env);
      if (!upstream) return json({ error: "bad_query" }, 400, cors);
      return proxyJson(env, upstream, "sunio", "sunio-quote", cors);
    }
  }

  if (request.method === "POST") {
    if (pathname === "/v1/tron/tronstack/jsonrpc") {
      return proxyRpc(
        request,
        env,
        TRONSTACK_RPC_URL,
        TRON_RPC_METHODS,
        "tronstack",
        cors,
      );
    }
    const match = /^\/v1\/rpc\/([a-z0-9][a-z0-9-]{0,31})$/.exec(pathname);
    if (match) {
      const endpoint = resolveRpcEndpoint(match[1], env);
      if (!endpoint) return json({ error: "bad_chain" }, 400, cors);
      return proxyRpc(request, env, endpoint, EVM_RPC_METHODS, "evm", cors);
    }
  }

  return json({ error: "not_found" }, 404, cors);
}

async function proxyJson(env, upstream, provider, cacheLabel, cors) {
  if (!upstream) return json({ error: "bad_query" }, 400, cors);

  // Cache only public provider data. The key is built from the route and its
  // canonical query; the caller's identity, headers and secret are not part of
  // it, so one client's copy is reused for another.
  const cacheKey = cacheRequestFor(cacheLabel, upstream);
  const cached = await readCache(cacheKey);
  if (cached && typeof cached.body === "string") {
    return json(cached.body, 200, cors);
  }

  const result = await fetchUpstream(upstream, {
    method: "GET",
    headers: upstreamHeaders(provider, env),
  });
  if (!result.ok) return upstreamError(result, cors);

  await writeCache(cacheKey, { body: result.body }, CACHE_TTL_MS);
  return json(result.body, 200, cors);
}

async function proxyRpc(request, env, upstream, methods, provider, cors) {
  if (!upstream) return json({ error: "bad_chain" }, 400, cors);

  const read = await readLimitedBody(request);
  if (!read.ok) return json({ error: read.error }, read.status, cors);

  let body;
  try {
    body = JSON.parse(read.text);
  } catch {
    return json({ error: "bad_json" }, 400, cors);
  }
  const valid = validateRpcBody(body, methods);
  if (!valid) return json({ error: "bad_rpc_method" }, 400, cors);

  const result = await fetchUpstream(upstream, {
    method: "POST",
    headers: { ...upstreamHeaders(provider, env), "content-type": "application/json" },
    body: JSON.stringify(valid),
  });
  if (!result.ok) return upstreamError(result, cors);
  return json(result.body, 200, cors);
}

async function fetchUpstream(upstream, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(upstream.toString(), {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });

    // Redirects are refused, not followed: following one could turn an
    // allowlisted host into an SSRF pivot.
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, status: 502, error: "provider_redirect" };
    }
    if (response.status === 404) {
      return { ok: false, status: 404, error: "not_found" };
    }
    if (response.status === 429) {
      return { ok: false, status: 429, error: "rate_limited" };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status >= 500 ? 502 : 400,
        error: "provider_rejected",
      };
    }

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BYTES) {
      return { ok: false, status: 502, error: "provider_response_too_large" };
    }
    const text = await readLimitedText(response, MAX_UPSTREAM_BYTES);
    if (text === null) {
      return { ok: false, status: 502, error: "provider_response_too_large" };
    }
    try {
      JSON.parse(text);
    } catch {
      return { ok: false, status: 502, error: "provider_bad_response" };
    }
    return { ok: true, status: 200, body: text };
  } catch (error) {
    // Never surface the thrown text: it can contain the upstream URL or other
    // provider detail. Only a fixed code leaves this function.
    const aborted = error?.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 502,
      error: aborted ? "provider_timeout" : "provider_unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedText(response, max) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readLimitedBody(request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return { ok: false, status: 413, error: "body_too_large" };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_REQUEST_BYTES) {
    return { ok: false, status: 413, error: "body_too_large" };
  }
  return { ok: true, text };
}

function cacheRequestFor(label, upstream) {
  const sorted = [...upstream.searchParams.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const query = new URLSearchParams(sorted).toString();
  return new Request(
    `https://cache.internal/provider-proxy/${label}${upstream.pathname}?${query}`,
    { method: "GET" },
  );
}

function upstreamHeaders(provider, env) {
  const headers = { accept: "application/json" };
  if (provider === "tronscan" && nonEmpty(env.TRONSCAN_API_KEY)) {
    headers["tron-pro-api-key"] = env.TRONSCAN_API_KEY;
  }
  if (provider === "trongrid" && nonEmpty(env.TRONGRID_API_KEY)) {
    headers["tron-pro-api-key"] = env.TRONGRID_API_KEY;
  }
  if (provider === "tronstack" && nonEmpty(env.TRONSTACK_API_KEY)) {
    headers["tron-pro-api-key"] = env.TRONSTACK_API_KEY;
  }
  if (provider === "sunio" && nonEmpty(env.SUNIO_API_KEY)) {
    headers.authorization = `Bearer ${env.SUNIO_API_KEY}`;
  }
  return headers;
}

function upstreamError(result, cors) {
  const extra = { ...cors };
  if (result.status === 429) extra["retry-after"] = RETRY_AFTER_SECONDS;
  return json({ error: result.error }, result.status, extra);
}

function providerHealth(env) {
  return {
    tronscan: { configured: Boolean(nonEmpty(env.TRONSCAN_API_KEY)) },
    trongrid: { configured: Boolean(nonEmpty(env.TRONGRID_API_KEY)) },
    tronstack: { configured: Boolean(nonEmpty(env.TRONSTACK_API_KEY)) },
    sunio: { configured: Boolean(nonEmpty(env.SUNIO_QUOTE_PATH)) },
    evm: { chains: Object.keys(parseRpcEndpoints(env)) },
  };
}

// A caller may present the shared secret used by the coordinator. A wrong
// secret is refused; no secret is the public, allowlisted path.
async function callerTrust(request, env) {
  const expected = nonEmpty(env.EDGE_PROXY_SECRET);
  const provided = nonEmpty(request.headers.get("x-edge-secret"));
  if (!provided || !expected) return { trusted: false, invalid: false };
  const matches = await secretsEqual(provided, expected);
  return { trusted: matches, invalid: !matches };
}

async function enforceLimits(request, trusted) {
  const now = Date.now();
  if (!globalLimiter.take(now)) return rateLimited();
  if (trusted) return null;
  const key = await clientKey(request);
  if (!clientLimiter.take(key, now)) return rateLimited();
  return null;
}

// The raw client address is never stored: a per-isolate random salt plus
// SHA-256 produces the only value the limiter sees. The digest is not logged
// or persisted and changes whenever the isolate restarts.
async function clientKey(request) {
  const address = (request.headers.get("cf-connecting-ip") ?? "").trim() || "unknown";
  const digest = await sha256(`${clientSalt}:${address}`);
  return hex(digest);
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function secretsEqual(provided, expected) {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function corsHeaders(origin, siteOrigin) {
  if (origin !== siteOrigin) return {};
  return {
    "access-control-allow-origin": siteOrigin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-edge-secret",
    vary: "origin",
  };
}

function rateLimited() {
  return json({ error: "rate_limited" }, 429, { "retry-after": RETRY_AFTER_SECONDS });
}

function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(response.body, { status: response.status, headers: merged });
}

function json(body, status = 200, extraHeaders = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { ...BASE_HEADERS, ...extraHeaders },
  });
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
