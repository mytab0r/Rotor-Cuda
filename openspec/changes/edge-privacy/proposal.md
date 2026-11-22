# Edge privacy

## Summary

Stop exposing the origin server and the provider keys, and stop persisting
client addresses. The origin moves behind a Cloudflare Tunnel with no inbound
public ports; provider calls go through an allowlisted Cloudflare Worker; the
coordinator can use that Worker for its own TRON lookups; public responses no
longer advertise the server stack.

Status: worker, coordinator switch and header override implemented in this
change. Cloudflare account changes and the site migration are owner/follow-up
tasks.

Evidence gathered 2026-11-22 from the current tree.

## Threat model

| Threat | Vector | Mitigation | Residual risk |
|---|---|---|---|
| Origin IP discovery | DNS `A`/`AAAA`, historical DNS, a DNS-only subdomain, a direct provider call from the origin | Tunnel with a proxied CNAME only; default-deny inbound; provider calls through the Worker; subdomain audit | An old certificate, an email header or a forgotten record can still leak it |
| Provider key exposure | Key in browser JS, in a URL, in an error body or in a log | Worker secret added server-side; upstream headers and error bodies discarded; no `console` in the Worker; a test greps the worker source | Cloudflare holds the key as a Worker secret |
| Client IP retention | Access logs, analytics, persisted rate-limit keys | No access log; no third-party analytics; in-memory rate limits only; Worker uses a salted digest | Cloudflare edge/Access logs still exist |
| Traffic analysis | Repeated provider calls for one address; client-to-Cloudflare connection | Cache public reads; provider sees Cloudflare egress, not the client; client may use its own VPN | Timing correlation remains possible for the provider and Cloudflare |
| Open proxy / SSRF | A request supplies a URL or the operator misconfigures an endpoint | Route + parameter allowlist; fixed upstream origins; HTTPS-only, public-host-only, port 443, no redirects | Operator bindings are trusted; DNS-level SSRF is handled by the platform and the explicit guard |
| Stack fingerprinting | `Server: tiny-http (Rust)`, `X-Powered-By` | Coordinator overrides `Server` on every response; edge Transform Rule removes `Server`/`X-Powered-By`/`Via`; a test locks the origin behaviour | None known at the origin |

## Decisions

1. **Tunnel, not port forwarding.** `cloudflared` connects outbound; the origin
   firewall denies inbound. The current Zoraxy path can stay as a fallback only
   if it is limited to Cloudflare IP ranges and uses Authenticated Origin
   Pulls. The tunnel is the target model.
2. **One Worker, route-mounted on the site host.** The browser calls
   `/edge/*` same-origin; the coordinator calls the same base with a shared
   secret. No extra DNS name. `workers_dev = false`.
3. **Allowlist by route, not by URL.** Every upstream origin is a constant;
   the request carries an address, a chain name or a quote tuple. JSON-RPC
   bodies are rebuilt from a closed shape.
4. **Read-only provider surface.** The JSON-RPC allowlist excludes
   `eth_sendRawTransaction`; a proxy compromise cannot move funds.
5. **Keys in Worker secrets.** The coordinator sends only
   `X-Edge-Secret` in edge mode. `EDGE_PROXY_URL` without
   `EDGE_PROXY_SECRET` is a startup error, and the worker rejects a public
   request without `CF-Connecting-IP` instead of merging callers into one
   bucket. `TRONSCAN_API_KEY` stays supported in direct mode until the Worker
   is configured and a canary matches.
6. **No logging, no persistence.** The Worker has no `console` call, no KV/D1
   and no Logpush. The coordinator writes no access log; rate limits use
   in-memory keys.
7. **Honest privacy boundary.** Cloudflare is still in the path and sees the
   client. The Worker hides the origin from providers, not the client from
   Cloudflare. Client anonymity requires the client's own VPN or Tor.

## Worker allowlist

| Method | Route | Upstream |
|---|---|---|
| GET | `/v1/tron/account?address=` | `api.tronscanapi.com/api/accountv2` |
| GET | `/v1/tron/transactions?address=&limit=&start=` | `api.tronscanapi.com/api/transaction` |
| GET | `/v1/tron/token-transfers?address=&contract=&limit=&start=` | `api.tronscanapi.com/api/token_trc20/transfers` |
| GET | `/v1/tron/trongrid/accounts?address=` | `api.trongrid.io/v1/accounts/<address>` |
| POST | `/v1/tron/tronstack/jsonrpc` | `api.tronstack.io/jsonrpc` |
| POST | `/v1/rpc/<chain>` | `RPC_ENDPOINTS[chain]`, HTTPS + public host |
| GET | `/v1/quote?tokenIn=&tokenOut=&amountIn=` | `api.sun.io` + `SUNIO_QUOTE_PATH` |
| GET | `/healthz` | none; `configured` booleans only |

An optional `/edge` prefix is stripped for the same-origin mount. Unknown
routes and unexpected query parameters are rejected before a network call.

Secrets: `TRONSCAN_API_KEY`, `TRONGRID_API_KEY`, `TRONSTACK_API_KEY`,
`SUNIO_API_KEY`, `EDGE_PROXY_SECRET`, `RPC_ENDPOINTS`, `SUNIO_QUOTE_PATH`.
`SITE_ORIGIN` is a public variable.

## Coordinator change

- `ServerOptions.edge_proxy_url` / `edge_proxy_secret` (default: read
  `EDGE_PROXY_URL` / `EDGE_PROXY_SECRET`; both off).
- `EdgeProxy::from_parts` requires HTTPS and a non-empty shared secret, and
  keeps the secret out of `Debug`. A URL without a secret refuses to start
  instead of silently using the public bucket or the direct provider path.
- `tron_lookup` uses `{base}/v1/tron/account` and
  `{base}/v1/tron/transactions` in edge mode. `tron_auth_headers` sends
  `X-Edge-Secret` and never the provider key.
- `respond_hidden` overrides tiny_http's `Server` banner on every response.
- The paid-orders poller remains direct; a follow-up routes it through the
  Worker.

## Visibility

| Party | Sees | Does not see |
|---|---|---|
| Client | Site host, `/edge/*` path | Origin IP, provider keys |
| Client ISP/VPN | Connection to Cloudflare | Provider call detail |
| Cloudflare | Client IP, URL, headers, Worker secrets | Inbound origin port (none) |
| Origin | Tunnel requests, Worker responses | Client IP beyond proxy headers; provider keys after the switch |
| Provider | Cloudflare egress IP, queried public address, timing | Origin, client, key |

## Honest limits

- Cloudflare is a trusted party in this model. It can see the client and holds
  the provider keys; the design does not remove it.
- The provider can correlate repeated lookups of one address by timing.
- The client's ISP/VPN can see that the client connects to Cloudflare. Only the
  client's own VPN/Tor changes that.
- Per-isolate Worker limits are not a global quota.
- A stale DNS record, an old certificate or a direct provider call from the
  origin can undo the tunnel. The owner checklist is part of the control.
- Tor/I2P is an optional later mirror, not part of this change.

## Out of scope

- Tor/I2P mirror.
- A DEX aggregator integration beyond the Sun.io quote route.
- A global (cross-colo) rate limiter; use a Cloudflare binding or a Durable
  Object if needed.
- Changing the coordinator's per-IP rate limiting model or the account state.
- Server-side anonymous payments or a privacy-preserving account scheme.
- The `apps/site` migration (follow-up tasks; the Worker accepts the route).
- Cloudflare account configuration (owner-run; documented in
  `docs/ops/privacy.md`).

## Acceptance

- `cd deploy/cloudflare/provider-proxy && npm test` is green: allowlisted host
  passes, non-allowlisted route/query is rejected, key is injected and absent
  from the response, private IP is rejected, oversized body is rejected, rate
  limit is 429.
- `cargo test --release --test coordinator_api` is green, including the
  no-`Server`-identity test and the edge header unit tests.
- `node scripts/check-projects.mjs` and `node scripts/check-defect-ledger.mjs`
  are green.
- `docs/ops/privacy.md` lists the owner steps and the residual risks.
