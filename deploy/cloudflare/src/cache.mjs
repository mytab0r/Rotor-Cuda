// Edge-cache key, freshness decision and caches.default access.
//
// The synthetic key is stable across visitors and independent of the incoming
// host/query ordering: https://cache.internal/balance/<chain>/<address>.

export const CACHE_ORIGIN = "https://cache.internal";
export const PROVIDER_TTL_MS = 60_000;
export const CLIENT_TTL_MS = 15_000;
export const STALE_MAX_MS = 15 * 60_000;

export function cacheKeyUrl(chain, address) {
  return `${CACHE_ORIGIN}/balance/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`;
}

export function buildCacheKey(chain, address) {
  return new Request(cacheKeyUrl(chain, address), { method: "GET" });
}

// "fresh": serve without touching the provider.
// "stale": serve immediately, revalidate in the background (waitUntil).
// "expired"/"miss": blocking provider fetch, stale copy only as a fallback.
export function decideCache(entry, now, options = {}) {
  const providerTtlMs = options.providerTtlMs ?? PROVIDER_TTL_MS;
  const clientTtlMs = options.clientTtlMs ?? CLIENT_TTL_MS;
  const staleMaxMs = options.staleMaxMs ?? STALE_MAX_MS;

  if (!entry || typeof entry !== "object" || !Number.isFinite(entry.fetchedAt)) return "miss";
  const age = now - entry.fetchedAt;
  if (age <= 0) return "fresh";
  const ttl = entry.source === "client" ? clientTtlMs : providerTtlMs;
  if (age <= ttl) return "fresh";
  if (age <= staleMaxMs) return "stale";
  return "expired";
}

export function edgeCache() {
  const cache = globalThis.caches?.default;
  return cache && typeof cache.match === "function" ? cache : null;
}

export async function readCache(key) {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const response = await cache.match(key);
    if (!response) return null;
    const entry = await response.json();
    return entry && typeof entry === "object" ? entry : null;
  } catch {
    return null;
  }
}

export async function writeCache(key, entry, ttlMs) {
  const cache = edgeCache();
  if (!cache) return false;
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
  try {
    await cache.put(
      key,
      new Response(JSON.stringify(entry), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${ttlSeconds}`,
        },
      }),
    );
    return true;
  } catch {
    // Cache writes are an optimization; never fail the request over one.
    return false;
  }
}
