// Provider adapters (BTC via mempool.space, EVM via JSON-RPC, TRON via
// Tronscan) plus per-provider token bucket, bounded concurrency and one
// retry with exponential backoff + jitter on 429/5xx.
//
// State lives in module memory, i.e. per isolate. That bounds this isolate's
// calls; it is not a global rate limit across all Cloudflare colos.

import { formatBalance, normalizeAddress } from "./chains.mjs";
import {
  backoffDelay,
  createConcurrencyLimiter,
  createTokenBucket,
  shouldRetryStatus,
} from "./limiters.mjs";

const LIMITS = {
  capacity: 8,
  refillPerSecond: 4,
  concurrency: 4,
  timeoutMs: 5000,
  maxRetries: 1,
  retryBaseMs: 150,
  retryMaxMs: 1500,
};

const BTC_URL = (address) => `https://mempool.space/api/address/${encodeURIComponent(address)}`;
const TRON_URL = (address) =>
  `https://apilist.tronscanapi.com/api/account?address=${encodeURIComponent(address)}`;

const states = new Map();

export class ProviderError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.retryable = false;
  }
}

function providerState(name) {
  let state = states.get(name);
  if (!state) {
    state = {
      bucket: createTokenBucket({ capacity: LIMITS.capacity, refillPerSecond: LIMITS.refillPerSecond }),
      semaphore: createConcurrencyLimiter(LIMITS.concurrency),
    };
    states.set(name, state);
  }
  return state;
}

export function resetProviderState() {
  states.clear();
}

export function parseRpcs(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function resolveProvider(chain, env = {}) {
  if (chain === "btc") return { name: "btc", kind: "btc" };
  if (chain === "tron") return { name: "tron", kind: "tron" };
  const url = parseRpcs(env.CHAIN_RPCS)[chain];
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    return { name: `evm:${chain}`, kind: "evm", rpcUrl: url };
  }
  return null;
}

export function providerHealth(env = {}) {
  const providers = {
    btc: { configured: true },
    tron: { configured: true },
  };
  for (const [chain, url] of Object.entries(parseRpcs(env.CHAIN_RPCS))) {
    if (chain === "btc" || chain === "tron") continue;
    providers[chain] = { configured: typeof url === "string" && /^https?:\/\//i.test(url) };
  }
  return providers;
}

export async function fetchProviderBalance(provider, address, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  const state = providerState(provider.name);
  if (!state.bucket.take(now())) {
    throw new ProviderError("rate_limited", 429);
  }

  const release = await state.semaphore.acquire();
  try {
    let lastError;
    for (let attempt = 0; attempt <= LIMITS.maxRetries; attempt += 1) {
      try {
        return await fetchOnce(provider, address, fetchImpl, now);
      } catch (error) {
        lastError = error;
        if (!error?.retryable || attempt === LIMITS.maxRetries) break;
        await sleep(backoffDelay(attempt, { baseMs: LIMITS.retryBaseMs, maxMs: LIMITS.retryMaxMs, random }));
      }
    }
    throw lastError;
  } finally {
    release();
  }
}

async function fetchOnce(provider, address, fetchImpl, now) {
  if (provider.kind === "btc") {
    const json = await requestJson(fetchImpl, BTC_URL(address));
    const stats = json?.chain_stats;
    const funded = Number(stats?.funded_txo_sum);
    const spent = Number(stats?.spent_txo_sum);
    if (!Number.isSafeInteger(funded) || !Number.isSafeInteger(spent)) {
      throw new ProviderError("bad_provider_response");
    }
    return { value: formatBalance(BigInt(funded) - BigInt(spent)), unit: "sats", fetchedAt: now() };
  }

  if (provider.kind === "tron") {
    const json = await requestJson(fetchImpl, TRON_URL(address));
    const raw = json?.balance ?? 0;
    let balance;
    if (typeof raw === "number" && Number.isFinite(raw) && Number.isInteger(raw)) {
      balance = BigInt(raw);
    } else if (typeof raw === "string" && /^[0-9]+$/.test(raw)) {
      balance = BigInt(raw);
    } else {
      throw new ProviderError("bad_provider_response");
    }
    return { value: formatBalance(balance), unit: "sun", fetchedAt: now() };
  }

  const json = await requestJson(fetchImpl, provider.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [normalizeAddress("evm", address), "latest"],
    }),
  });
  if (json?.error) throw new ProviderError("rpc_error");
  const hex = json?.result;
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new ProviderError("bad_provider_response");
  }
  return { value: formatBalance(BigInt(hex)), unit: "wei", fetchedAt: now() };
}

async function requestJson(fetchImpl, url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const error = new ProviderError(
        `http_${response.status}`,
        response.status === 429 ? 429 : 502,
      );
      error.retryable = shouldRetryStatus(response.status);
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const aborted = error?.name === "AbortError";
    const wrapped = new ProviderError(aborted ? "timeout" : "network_error", aborted ? 504 : 502);
    wrapped.retryable = true;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
