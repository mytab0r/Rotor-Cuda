// Small dependency-free primitives for per-provider limits.
// Time and randomness are injected so the behaviour is unit-testable.

export function createTokenBucket({ capacity, refillPerSecond }) {
  if (!(capacity > 0)) throw new RangeError("capacity must be positive");
  if (!(refillPerSecond >= 0)) throw new RangeError("refillPerSecond must be non-negative");

  let tokens = capacity;
  let lastRefillMs = null;

  function refill(nowMs) {
    if (lastRefillMs === null) {
      lastRefillMs = nowMs;
      return;
    }
    if (nowMs <= lastRefillMs) return;
    tokens = Math.min(capacity, tokens + ((nowMs - lastRefillMs) / 1000) * refillPerSecond);
    lastRefillMs = nowMs;
  }

  return {
    take(nowMs, cost = 1) {
      refill(nowMs);
      if (cost <= 0) return true;
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    },
    available(nowMs) {
      refill(nowMs);
      return tokens;
    },
    get capacity() {
      return capacity;
    },
  };
}

// Per-key token buckets with bounded memory, intended for per-client quotas
// (the key is opaque, e.g. a client IP). Honest limitation: the state lives in
// this isolate only, so the result is a per-isolate best-effort limit, not a
// global quota shared across a PoP.
export function createKeyedLimiter({
  capacity,
  refillPerSecond,
  maxKeys = 5000,
  idleMs = 600000,
}) {
  if (!(capacity > 0)) throw new RangeError("capacity must be positive");
  if (!(refillPerSecond >= 0)) throw new RangeError("refillPerSecond must be non-negative");
  if (!(maxKeys >= 1)) throw new RangeError("maxKeys must be at least 1");
  if (!(idleMs >= 0)) throw new RangeError("idleMs must be non-negative");

  // Insertion order is recency order: least recently used first.
  const buckets = new Map();

  function prune(nowMs) {
    // The first entry is the oldest access; if it is still warm, all are.
    for (const [key, entry] of buckets) {
      if (nowMs - entry.lastSeenMs <= idleMs) break;
      buckets.delete(key);
    }
  }

  function touch(key, entry, nowMs) {
    entry.lastSeenMs = nowMs;
    // Re-inserting moves the entry to the end of the Map (most recent).
    buckets.delete(key);
    buckets.set(key, entry);
  }

  return {
    take(key, nowMs, cost = 1) {
      let entry = buckets.get(key);
      if (!entry) {
        prune(nowMs);
        if (buckets.size >= maxKeys) {
          buckets.delete(buckets.keys().next().value);
        }
        entry = { bucket: createTokenBucket({ capacity, refillPerSecond }), lastSeenMs: nowMs };
        buckets.set(key, entry);
      }
      touch(key, entry, nowMs);
      return entry.bucket.take(nowMs, cost);
    },
    get size() {
      return buckets.size;
    },
    reset() {
      buckets.clear();
    },
  };
}

export function createConcurrencyLimiter(max) {
  if (!(max > 0)) throw new RangeError("max must be positive");

  let active = 0;
  const queue = [];

  function release() {
    const next = queue.shift();
    if (next) next(release);
    else active -= 1;
  }

  return {
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
    acquire() {
      if (active < max) {
        active += 1;
        return Promise.resolve(release);
      }
      return new Promise((resolve) => queue.push(resolve));
    },
  };
}

export function shouldRetryStatus(status) {
  return status === 429 || status >= 500;
}

// Exponential backoff with 50-100% jitter: attempt 0 is baseMs, each further
// attempt doubles the ceiling, and maxMs caps it.
export function backoffDelay(attempt, options = {}) {
  const baseMs = options.baseMs ?? 200;
  const maxMs = options.maxMs ?? 2000;
  const random = options.random ?? Math.random;
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = 0.5 + random() * 0.5;
  return Math.max(1, Math.round(ceiling * jitter));
}
