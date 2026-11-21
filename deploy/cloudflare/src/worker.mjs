// Rotor shared edge balance cache.
//
// Public, read-mostly cache in front of public balance providers. Only public
// chain data crosses this worker: chain id, public address, balance, unit,
// fetchedAt. Client reports are hints, never truth.
//
// Routes:
//   GET  /v1/balance?chain=<chain>&address=<addr>
//   GET  /v1/balances?chain=<chain>&addresses=<csv>  (max 60)
//   POST /v1/report   {chain,address,value,fetchedAt}
//   GET  /healthz

import {
  CLIENT_TTL_MS,
  PROVIDER_TTL_MS,
  STALE_MAX_MS,
  buildCacheKey,
  decideCache,
  readCache,
  writeCache,
} from "./cache.mjs";
import { isKnownChain, isValidAddress, normalizeAddress, unitFor } from "./chains.mjs";
import { validateHint } from "./hint.mjs";
import { createKeyedLimiter } from "./limiters.mjs";
import { findSensitiveMaterial } from "./security.mjs";
import { ProviderError, fetchProviderBalance, providerHealth, resolveProvider } from "./providers.mjs";

const MAX_BODY_BYTES = 4096;
const MAX_BATCH_ADDRESSES = 60;
const RETRY_AFTER_MS = 250;

// Per-client quota (keyed by client IP). Honest limitation: the counter is
// per isolate, so it is a per-isolate best-effort limit across a PoP, not a
// global quota shared by every visitor of the worker.
const CLIENT_LIMIT_CAPACITY = 120;
const CLIENT_LIMIT_REFILL_PER_SECOND = 20;
const clientLimiter = createKeyedLimiter({
  capacity: CLIENT_LIMIT_CAPACITY,
  refillPerSecond: CLIENT_LIMIT_REFILL_PER_SECOND,
});

export function resetClientLimits() {
  clientLimiter.reset();
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  ...CORS_HEADERS,
};

export default {
  async fetch(request, env = {}, ctx = {}) {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...CORS_HEADERS, "access-control-max-age": "86400" },
    });
  }
  if (url.pathname === "/healthz" && request.method === "GET") {
    return json({ ok: true, providers: providerHealth(env) });
  }

  const refusal = enforceClientLimit(request, url);
  if (refusal) return refusal;

  if (url.pathname === "/v1/balance" && request.method === "GET") {
    return handleBalance(url, env, ctx);
  }
  if (url.pathname === "/v1/balances" && request.method === "GET") {
    return handleBalances(url, env, ctx);
  }
  if (url.pathname === "/v1/report" && request.method === "POST") {
    return handleReport(request);
  }
  return json({ error: "not_found" }, 404);
}

export async function handleBalance(url, env = {}, ctx = {}) {
  const chain = (url.searchParams.get("chain") ?? "").trim().toLowerCase();
  const rawAddress = (url.searchParams.get("address") ?? "").trim();
  if (!isKnownChain(chain)) return json({ error: "bad_chain" }, 400);
  if (!isValidAddress(chain, rawAddress)) return json({ error: "bad_address" }, 400);

  const address = normalizeAddress(chain, rawAddress);
  const key = buildCacheKey(chain, address);
  const cached = await readCache(key);
  const state = decideCache(cached, Date.now());

  if (state === "fresh") {
    return json(balanceBody(cached, false));
  }
  if (state === "stale") {
    schedule(ctx, refreshBalance(chain, address, key, env));
    return json(balanceBody(cached, true));
  }

  const result = await refreshBalance(chain, address, key, env);
  if (result.ok) return json(balanceBody(result.entry, false));
  if (cached) return json({ ...balanceBody(cached, true), error: result.error });
  if (result.error === "no_provider") return json({ error: "no_provider" }, 501);
  return json(
    {
      chain,
      address,
      value: null,
      unit: unitFor(chain),
      fetchedAt: null,
      source: "none",
      stale: true,
      error: result.error,
    },
    result.status,
  );
}

export async function handleBalances(url, env = {}, ctx = {}) {
  const chain = (url.searchParams.get("chain") ?? "").trim().toLowerCase();
  if (!isKnownChain(chain)) return json({ error: "bad_chain" }, 400);

  const parts = (url.searchParams.get("addresses") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return json({ error: "bad_addresses" }, 400);
  if (parts.length > MAX_BATCH_ADDRESSES) {
    return json({ error: "too_many_addresses", max: MAX_BATCH_ADDRESSES }, 400);
  }

  // Normalize and dedupe first-seen: mixed-case duplicates cost one provider
  // call. Invalid entries keep their raw text for the per-item error.
  const seen = new Set();
  const targets = [];
  for (const raw of parts) {
    const valid = isValidAddress(chain, raw);
    const address = valid ? normalizeAddress(chain, raw) : raw;
    if (seen.has(address)) continue;
    seen.add(address);
    targets.push({ address, valid });
  }

  // A cold batch above the per-isolate bucket (burst 8, refill 4/s) resolves
  // roughly the first eight items and returns rate_limited for the rest.
  const balances = await Promise.all(
    targets.map((target) => batchBalance(chain, target, env, ctx)),
  );
  return json({ chain, unit: unitFor(chain), balances });
}

async function batchBalance(chain, target, env, ctx) {
  // Never echo an invalid input: it could be key-shaped and is not public.
  if (!target.valid) return { error: "bad_address" };

  const { address } = target;
  const key = buildCacheKey(chain, address);
  const cached = await readCache(key);
  const state = decideCache(cached, Date.now());

  if (state === "fresh") return balanceBody(cached, false);
  if (state === "stale") {
    schedule(ctx, refreshBalance(chain, address, key, env));
    return balanceBody(cached, true);
  }

  const result = await refreshBalance(chain, address, key, env);
  if (result.ok) return balanceBody(result.entry, false);
  if (cached) return { ...balanceBody(cached, true), error: result.error };
  if (result.error === "rate_limited") {
    return { address, error: result.error, retryAfterMs: RETRY_AFTER_MS };
  }
  return { address, error: result.error };
}

export async function handleReport(request) {
  const read = await readLimitedBody(request);
  if (!read.ok) return json({ error: read.error }, read.status);

  // Scan the raw body before parsing so key-shaped strings never reach the
  // validator, the cache or a log line.
  if (findSensitiveMaterial(read.text).length > 0) {
    return json({ error: "invalid_hint", reasons: ["sensitive_material"] }, 400);
  }

  let body;
  try {
    body = JSON.parse(read.text);
  } catch {
    return json({ error: "invalid_hint", reasons: ["bad_json"] }, 400);
  }

  const validated = validateHint(body, Date.now());
  if (!validated.ok) return json({ error: "invalid_hint", reasons: validated.reasons }, 400);

  const { hint } = validated;
  const key = buildCacheKey(hint.chain, hint.address);
  const existing = await readCache(key);

  // Provider values are authoritative: a hint never replaces one, and among
  // hints only a newer one wins. Either way the hint is accepted (204).
  if (existing && existing.source === "provider") return accepted();
  if (existing && existing.source === "client" && Number(existing.fetchedAt) >= hint.fetchedAt) {
    return accepted();
  }

  await writeCache(
    key,
    {
      chain: hint.chain,
      address: hint.address,
      value: hint.value,
      unit: hint.unit,
      fetchedAt: hint.fetchedAt,
      source: "client",
    },
    CLIENT_TTL_MS,
  );
  return accepted();
}

async function refreshBalance(chain, address, key, env) {
  const provider = resolveProvider(chain, env);
  if (!provider) return { ok: false, error: "no_provider", status: 501 };

  try {
    const fetched = await fetchProviderBalance(provider, address);
    const entry = {
      chain,
      address,
      value: fetched.value,
      unit: fetched.unit,
      fetchedAt: fetched.fetchedAt,
      source: "provider",
    };
    await writeCache(key, entry, PROVIDER_TTL_MS);
    return { ok: true, entry };
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : "provider_error";
    const status = error instanceof ProviderError ? error.status : 502;
    return { ok: false, error: code === "rate_limited" ? "rate_limited" : "provider_error", status };
  }
}

function balanceBody(entry, stale) {
  return {
    chain: entry.chain,
    address: entry.address,
    value: entry.value,
    unit: entry.unit,
    fetchedAt: entry.fetchedAt,
    source: entry.source,
    stale,
  };
}

function schedule(ctx, promise) {
  const guarded = Promise.resolve(promise).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(guarded);
  return guarded;
}

async function readLimitedBody(request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "body_too_large" };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "body_too_large" };
  }
  return { ok: true, text };
}

function accepted() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function requestCost(url) {
  if (url.pathname !== "/v1/balances") return 1;
  const count = (url.searchParams.get("addresses") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
  return Math.min(MAX_BATCH_ADDRESSES, Math.max(1, count));
}

function enforceClientLimit(request, url) {
  const key = (request.headers.get("cf-connecting-ip") ?? "").trim() || "unknown";
  if (clientLimiter.take(key, Date.now(), requestCost(url))) return null;
  return json({ error: "rate_limited", retryAfterMs: RETRY_AFTER_MS }, 429, {
    "retry-after": String(Math.max(1, Math.ceil(RETRY_AFTER_MS / 1000))),
  });
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...extraHeaders },
  });
}
