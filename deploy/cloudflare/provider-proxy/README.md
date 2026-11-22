# Rotor provider proxy (Cloudflare Worker)

An allowlisted outbound proxy for public chain providers. The origin server and
browser clients call this worker instead of a provider, so:

- the provider sees Cloudflare's egress address, never the origin address;
- a provider key lives in a Worker secret and never in browser code or in a
  response;
- one public edge cache serves repeated reads of the same public chain data.

This worker is not an open proxy. A request names a route and validated
parameters; the upstream origin, path and query are built here from fixed
constants. There is no request parameter that selects a URL.

## Routes

An optional `/edge` prefix is stripped, so the worker can be mounted on the
site zone as `https://rotor.pxbt.app/edge/*` and called same-origin.

| Method | Route | Upstream | Notes |
|---|---|---|---|
| GET | `/v1/tron/account?address=` | `api.tronscanapi.com/api/accountv2` | 15 s cache |
| GET | `/v1/tron/transactions?address=&limit=&start=` | `api.tronscanapi.com/api/transaction` | `sort=-timestamp`, `count=true`; `limit` 1-50, default 1 |
| GET | `/v1/tron/token-transfers?address=&contract=&limit=&start=` | `api.tronscanapi.com/api/token_trc20/transfers` | `limit` 1-50, default 50 |
| GET | `/v1/tron/trongrid/accounts?address=` | `api.trongrid.io/v1/accounts/<address>` | 15 s cache |
| POST | `/v1/tron/tronstack/jsonrpc` | `api.tronstack.io/jsonrpc` | TRON JSON-RPC method allowlist |
| POST | `/v1/rpc/<chain>` | `RPC_ENDPOINTS[chain]` | EVM JSON-RPC method allowlist; `chain` is a name, never a URL |
| GET | `/v1/quote?tokenIn=&tokenOut=&amountIn=` | `api.sun.io` + `SUNIO_QUOTE_PATH` | path is configured by name |
| GET | `/healthz` | none | `{configured}` booleans and configured chain names only |

Unknown routes are `404`. A route with an unexpected query parameter is `400`
and never calls a provider.

## Secrets and variables

Set secrets by name; no value is committed here.

| Name | Purpose |
|---|---|
| `TRONSCAN_API_KEY` | TronScan Pro key, sent as `TRON-PRO-API-KEY` |
| `TRONGRID_API_KEY` | TronGrid key, sent as `TRON-PRO-API-KEY` |
| `TRONSTACK_API_KEY` | optional TronStack key |
| `SUNIO_API_KEY` | optional Sun.io bearer token |
| `SUNIO_QUOTE_PATH` | current Sun.io quote path, for example `/vN/quote`; without it `/v1/quote` answers `501` |
| `EDGE_PROXY_SECRET` | shared secret the coordinator sends as `X-Edge-Secret` |
| `RPC_ENDPOINTS` | JSON map `{"eth":"https://...","bnb":"https://..."}`; the chain name is the only client input |
| `SITE_ORIGIN` | public site origin for CORS; default `https://rotor.pxbt.app` |

`RPC_ENDPOINTS` URLs are validated at request time: HTTPS only, no user/password,
port 443 only, and no loopback, private, link-local, carrier-grade-NAT or
metadata host. Redirects from an upstream are refused, not followed.

## Key handling

- The key is read from the environment and added to the outbound request only.
- Upstream response headers are discarded; the client receives a fresh response
  with a minimal JSON content type.
- Upstream error bodies are never forwarded. A fixed code (`not_found`,
  `rate_limited`, `provider_rejected`, `provider_redirect`,
  `provider_response_too_large`, `provider_bad_response`, `provider_timeout`,
  `provider_unreachable`) is returned instead.
- The worker has no `console` call: request URLs, headers, addresses and keys
  are never logged.

## Client identity

- A public request without `CF-Connecting-IP` is rejected with
  `400 {error:"missing_client_ip"}`. Callers are never merged into a shared
  "unknown" bucket; the worker must be reached through Cloudflare (it is not
  exposed on `workers.dev`). A trusted call with a valid `X-Edge-Secret` is
  exempt because it is already operator-controlled.
- The per-client token bucket is keyed by `SHA-256(per-isolate random salt ||
  client IP)`. The raw address is not stored, logged or persisted; the digest
  changes when the isolate restarts.
- `CF-Connecting-IP`, `X-Forwarded-For` and the client's `X-Edge-Secret` are
  never forwarded upstream.
- Public GET responses are cached under `https://cache.internal/...` built from
  the route and its canonical query, never from a client header.

## Limits

- Per-client: burst 60, refill 10/s (per isolate); a request without
  `CF-Connecting-IP` is `400` rather than a shared bucket.
- Global provider calls: burst 120, refill 30/s (per isolate).
- Upstream timeout: 5 s. Request body: 16 KiB. Upstream body: 2 MiB.
- A request that presents `EDGE_PROXY_SECRET` bypasses the per-client bucket
  (it is already a trusted, operator-controlled call) but still consumes the
  global bucket. A wrong secret is `403`.

These are per-isolate safeguards, not a global quota. For a hard global limit
use a Cloudflare Rate Limiting binding or a Durable Object (see
`openspec/changes/edge-privacy/tasks.md`).

## CORS

`Access-Control-Allow-Origin` is the configured `SITE_ORIGIN` and only that
value. A request with another `Origin` is `403`; there is no wildcard. Requests
without an `Origin` (curl, the coordinator) are allowed on the public,
allowlisted routes.

## Deploy

```sh
cd deploy/cloudflare/provider-proxy
npm test
npx wrangler secret put TRONSCAN_API_KEY
npx wrangler secret put EDGE_PROXY_SECRET
npx wrangler deploy
```

Uncomment the `[[routes]]` block in `wrangler.toml` and set
`rotor.pxbt.app/edge/*` so the browser can call the worker same-origin. The
worker is not exposed on `workers.dev`.

## Honest limits

- Cloudflare still terminates the client TLS connection and sees the client IP,
  the full URL and the headers. This worker hides the origin from the provider,
  not the client from Cloudflare.
- The provider sees Cloudflare's egress address, the requested public address
  and the timing. It can correlate repeated requests for one address.
- The provider key is hidden from the browser and the origin, but Cloudflare
  holds it as a Worker secret.
- The public routes are public: anyone who learns the URL can read the same
  allowlisted public chain data, subject to the per-isolate rate limits.
