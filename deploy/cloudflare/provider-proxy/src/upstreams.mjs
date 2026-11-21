// Allowlisted upstream routes for the Rotor provider proxy.
//
// The client never supplies a URL or a host: it names a route and validated
// query parameters, and this module builds the upstream request from fixed
// origins. Anything that does not fit an allowlist below is rejected before a
// network call is made.

export const TRONSCAN_ORIGIN = "https://apilist.tronscanapi.com";
export const TRONGRID_ORIGIN = "https://api.trongrid.io";
export const TRONSTACK_ORIGIN = "https://api.tronstack.io";
export const SUNIO_ORIGIN = "https://api.sun.io";

const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CHAIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Query parameters a route is allowed to read. Everything else is rejected so
// a caller cannot smuggle an unexpected parameter into the upstream request.
export const TRONSCAN_QUERY = Object.freeze({
  account: new Set(["address"]),
  transactions: new Set(["address", "limit", "start"]),
  "token-transfers": new Set(["address", "contract", "limit", "start"]),
});
export const TRONGRID_QUERY = new Set(["address"]);
export const QUOTE_QUERY = new Set(["tokenIn", "tokenOut", "amountIn"]);

// Read-only JSON-RPC methods. Broadcasting and signing stay outside the proxy:
// a compromise of the proxy must not be able to move funds.
export const EVM_RPC_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
]);
export const TRON_RPC_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
]);

export const TRONSTACK_RPC_URL = new URL("/jsonrpc", TRONSTACK_ORIGIN);

export function isTronAddress(value) {
  return typeof value === "string" && TRON_ADDRESS_RE.test(value);
}

export function isEvmAddress(value) {
  return typeof value === "string" && EVM_ADDRESS_RE.test(value);
}

export function isChainName(value) {
  return typeof value === "string" && CHAIN_NAME_RE.test(value);
}

export function hasOnlyAllowedParams(params, allowed) {
  for (const key of params.keys()) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

// A non-negative decimal integer within [min, max], or `fallback` when absent.
// `null` means the parameter was present but invalid.
function integerParam(params, name, min, max, fallback) {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^(?:0|[1-9][0-9]{0,8})$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

export function buildTronScanUrl(route, params) {
  switch (route) {
    case "account": {
      if (!hasOnlyAllowedParams(params, TRONSCAN_QUERY.account)) return null;
      const address = params.get("address");
      if (!isTronAddress(address)) return null;
      const url = new URL("/api/accountv2", TRONSCAN_ORIGIN);
      url.searchParams.set("address", address);
      return url;
    }
    case "transactions": {
      if (!hasOnlyAllowedParams(params, TRONSCAN_QUERY.transactions)) return null;
      const address = params.get("address");
      if (!isTronAddress(address)) return null;
      const limit = integerParam(params, "limit", 1, 50, 1);
      const start = integerParam(params, "start", 0, 1_000_000, 0);
      if (limit === null || start === null) return null;
      const url = new URL("/api/transaction", TRONSCAN_ORIGIN);
      url.searchParams.set("sort", "-timestamp");
      url.searchParams.set("count", "true");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("start", String(start));
      url.searchParams.set("address", address);
      return url;
    }
    case "token-transfers": {
      if (!hasOnlyAllowedParams(params, TRONSCAN_QUERY["token-transfers"])) return null;
      const address = params.get("address");
      const contract = params.get("contract");
      if (!isTronAddress(address) || !isTronAddress(contract)) return null;
      const limit = integerParam(params, "limit", 1, 50, 50);
      const start = integerParam(params, "start", 0, 1_000_000, 0);
      if (limit === null || start === null) return null;
      const url = new URL("/api/token_trc20/transfers", TRONSCAN_ORIGIN);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("start", String(start));
      url.searchParams.set("contract_address", contract);
      url.searchParams.set("relatedAddress", address);
      return url;
    }
    default:
      return null;
  }
}

export function buildTronGridUrl(params) {
  if (!hasOnlyAllowedParams(params, TRONGRID_QUERY)) return null;
  const address = params.get("address");
  if (!isTronAddress(address)) return null;
  return new URL(`/v1/accounts/${encodeURIComponent(address)}`, TRONGRID_ORIGIN);
}

// Sun.io's quote path changes with their API version, so the operator supplies
// it by name. The path must stay on the fixed `api.sun.io` origin.
export function buildQuoteUrl(params, env = {}) {
  const path =
    typeof env.SUNIO_QUOTE_PATH === "string"
      ? env.SUNIO_QUOTE_PATH.trim()
      : env.SUNIO_QUOTE_PATH;
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    return null;
  }
  if (path.includes("?") || path.includes("#") || path.includes("..")) return null;
  if (!hasOnlyAllowedParams(params, QUOTE_QUERY)) return null;
  const tokenIn = params.get("tokenIn");
  const tokenOut = params.get("tokenOut");
  const amountIn = params.get("amountIn");
  if (!isTronAddress(tokenIn) || !isTronAddress(tokenOut)) return null;
  if (!/^[0-9]{1,40}$/.test(amountIn ?? "")) return null;
  const url = new URL(path, SUNIO_ORIGIN);
  if (url.origin !== SUNIO_ORIGIN) return null;
  url.searchParams.set("tokenIn", tokenIn);
  url.searchParams.set("tokenOut", tokenOut);
  url.searchParams.set("amountIn", amountIn);
  return url;
}

// JSON-RPC bodies are rebuilt from a closed shape: unknown fields (including a
// caller-supplied URL) never reach the upstream.
export function validateRpcBody(body, methods) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (body.jsonrpc !== "2.0") return null;
  if (typeof body.method !== "string" || !methods.has(body.method)) return null;
  if (!Array.isArray(body.params) || body.params.length > 8) return null;
  const id = body.id;
  if (!(typeof id === "string" || typeof id === "number" || id === null)) return null;
  return { jsonrpc: "2.0", id, method: body.method, params: body.params };
}

export function parseRpcEndpoints(env = {}) {
  const raw = env.RPC_ENDPOINTS;
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Resolve a chain name to its configured endpoint. The client supplies only the
// chain name; the URL comes from an operator binding. `safeUpstreamUrl` rejects
// HTTP, credentials in the URL, odd ports and private/loopback hosts.
export function resolveRpcEndpoint(chain, env = {}) {
  if (!isChainName(chain)) return null;
  const endpoints = parseRpcEndpoints(env);
  if (!Object.prototype.hasOwnProperty.call(endpoints, chain)) return null;
  const endpoint = endpoints[chain];
  if (typeof endpoint !== "string") return null;
  return safeUpstreamUrl(endpoint);
}

export function safeUpstreamUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  if (url.hash) return null;
  if (isForbiddenHostname(url.hostname)) return null;
  return url;
}

// Best-effort SSRF guard. Workers' own fetch blocks some of these, but an
// explicit check keeps a misconfigured endpoint from becoming a probe of the
// local network.
export function isForbiddenHostname(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host.length === 0) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "metadata.google.internal" || host === "metadata.google.internal.") return true;
  return isPrivateIpv4(host) || isPrivateIpv6(host);
}

function isPrivateIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part))) return false;
  const [a, b] = parts.map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return a >= 224; // multicast and reserved
}

function isPrivateIpv6(host) {
  if (!host.includes(":")) return false;
  const lower = host.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return lower.startsWith("::ffff:");
}
