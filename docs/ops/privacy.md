# Privacy and origin lockdown

Status: implementation for the worker, the optional coordinator switch and the
header override landed with `openspec/changes/edge-privacy/`. The Cloudflare
account changes below are owner-run.

## Goal

Keep three things apart:

1. **The origin address.** A client or provider must not learn the public IP of
   the machine that runs `rotor-coord`. The origin accepts no inbound public
   ports; Cloudflare reaches it through an outbound tunnel.
2. **Provider keys.** TronScan/TronGrid/Sun.io keys live in Worker secrets, not
   in browser code and not in the origin's environment once the switch is done.
3. **Client addresses.** We do not persist or log them. The per-client rate
   limiter keeps only an in-memory salted digest for the lifetime of a worker
   isolate.

Client anonymity is the client's choice. We do not promise that a visitor is
anonymous to Cloudflare or to their ISP; see [Honest limits](#honest-limits).

## Traffic model

```
client ──TLS──▶ Cloudflare edge ──tunnel──▶ cloudflared ──▶ 127.0.0.1:7878 rotor-coord
                      │
                      └─ Worker route /edge/* ──▶ provider-proxy Worker ──▶ provider
rotor-coord ──HTTPS──▶ https://site/edge/* ──▶ provider-proxy Worker ──▶ provider
```

- The client's TLS terminates at Cloudflare. The origin has no public listener.
- The Worker route is mounted on the same site host, so the browser calls
  `/edge/*` same-origin; there is no extra DNS name and no CORS preflight.
- The coordinator may call the Worker at `https://site/edge/*` with
  `X-Edge-Secret`.
- Providers see Cloudflare's egress address. They do not see the origin and do
  not see a client address.

## What each party can see

| Party | Can see | Cannot see |
|---|---|---|
| Client | The site host and `/edge/*` paths it requests | The origin address, provider keys |
| Client's ISP / VPN | TLS connection to Cloudflare (SNI, timing, volume) | The provider call, unless the client calls the provider itself |
| Cloudflare | Client IP, full URL, headers, TLS metadata; Worker secrets | The origin's inbound port (there is none); the provider key in client code |
| Origin | Requests through the tunnel, Worker responses | Client IP beyond what Cloudflare forwards; provider keys once the switch is done |
| Provider | Cloudflare's egress IP, the public address queried, timing | The origin, the client, our key |

## Origin lockdown

### 1. Cloudflare Tunnel (preferred)

The origin makes an outbound connection to Cloudflare; no inbound port is
published.

```sh
cloudflared tunnel login
cloudflared tunnel create rotor
```

`/etc/cloudflared/config.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /etc/cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: rotor.pxbt.app
    service: http://127.0.0.1:7878
  - service: http_status:404
```

```sh
cloudflared tunnel route dns rotor rotor.pxbt.app
sudo cloudflared service install
```

Then:

- Remove any DNS `A`/`AAAA` record that points at the origin. The tunnel
  creates a proxied `CNAME` to `<uuid>.cfargotunnel.com`; it must stay proxied
  (orange cloud).
- Keep the coordinator bound to `127.0.0.1:7878` (systemd unit) or to the
  private container network without a published host port.
- Host firewall default-deny inbound. Allow SSH only from a management network
  or through a separate Cloudflare Access SSH app; allow nothing on 80/443/7878
  from the public internet.
- Audit hostnames that can leak the origin: `mail`, `smtp`, `ftp`, `direct`,
  `dev`, `staging`, `vpn`, wildcard records, and historical DNS. A single
  DNS-only subdomain defeats the tunnel.
- Outbound egress from the origin must include Cloudflare (for the tunnel and
  the Worker call) and the provider only if the coordinator is still in direct
  mode. After the switch, the provider is no longer contacted from the origin.

### 2. Headers

`tiny_http` injects `Server: tiny-http (Rust)` for every response that does not
already carry a `Server` header. The coordinator now overrides it on every
response with an empty value (`respond_hidden` in
`src/coordinator/mod.rs`); `tests/coordinator_api.rs` locks this. Add a
Cloudflare Transform Rule as defense in depth:

- `Remove` response header `Server`
- `Remove` response header `X-Powered-By`
- `Remove` response header `Via`

Do not add `X-Backend`, `X-Origin` or a debug header.

### 3. Cloudflare Access for the admin cabinet

Create a self-hosted Access application for `rotor.pxbt.app/cabinet/admin*`.
Use a one-time PIN or the operator's IdP and a policy that allows only the
operator. The coordinator keeps its own admin token and cookie; Access is the
outer lock, not a replacement.

### 4. Logs and analytics

- Disable Logpush for the site zone, or use a job with the shortest retention
  and a field set that excludes client IP, referrer and user agent. Cloudflare's
  own edge and Access logs still exist; that is outside our control.
- Do not enable third-party analytics beacons. The site has none.
- The Worker has no `console` call and persists nothing. It must not be given a
  Logpush job.
- The coordinator writes no access log. Its rate limiters keep client IPs in
  memory only. Do not add request logging that includes an address.

## Provider proxy

Worker: `deploy/cloudflare/provider-proxy/`.

- Fixed upstreams: `api.tronscanapi.com`, `api.trongrid.io`,
  `api.tronstack.io`, `api.sun.io`. The client names a route, never a URL.
- EVM JSON-RPC: the client names a chain from `RPC_ENDPOINTS`; the URL is an
  operator binding. Read-only `eth_*` methods only.
- Secrets: `TRONSCAN_API_KEY`, `TRONGRID_API_KEY`, `TRONSTACK_API_KEY`,
  `SUNIO_API_KEY`, `EDGE_PROXY_SECRET`, `RPC_ENDPOINTS`, `SUNIO_QUOTE_PATH`.
  No value is in `wrangler.toml`.
- Response: a fresh JSON response. Upstream status headers, `Server`,
  `X-Powered-By` and error bodies are discarded; only a fixed error code
  crosses.
- Limits: 5 s timeout, 16 KiB request, 2 MiB response, per-client and per-
  isolate global token buckets (both per isolate, not global).
- SSRF: HTTPS only, no credentials in the URL, port 443 only, no loopback,
  private, link-local, CGNAT or metadata host, and redirects are refused.
- CORS: only `SITE_ORIGIN`, never `*`.
- Cache: public GET responses for 15 s under a key built from the route and
  canonical query, never from a client header.

Full route table and deploy steps: `deploy/cloudflare/provider-proxy/README.md`.

## Route plan

### Browser

1. Deploy the Worker and mount `rotor.pxbt.app/edge/*` (route in
   `wrangler.toml`).
2. Migrate the browser's direct provider calls to same-origin paths:
   - `apps/site/browse.js:719`, `key.js:2054`, `site.js:703`,
     `wallet.js:1360` call `apilist.tronscanapi.com` directly today. Replace
     them with `/edge/v1/tron/account?address=...` (fall back to
     `/api/v1/chain/tron/address`, which stays public).
   - `site.js:688` and `key.js:2097` already use the coordinator route.
3. Keep the coordinator route as the fallback while the Worker is not
   configured.

The site migration is a follow-up task; this change ships the Worker and the
documented route, not the `apps/site` edit.

### Coordinator

`EDGE_PROXY_URL` and `EDGE_PROXY_SECRET` are off by default:

```sh
# /etc/rotor/rotor-coord.env
EDGE_PROXY_URL=https://rotor.pxbt.app/edge
EDGE_PROXY_SECRET=<openssl rand -hex 32>
```

- With `EDGE_PROXY_URL` set, `tron_lookup` calls
  `{EDGE_PROXY_URL}/v1/tron/account` and `/v1/tron/transactions` instead of
  TronScan. It sends `X-Edge-Secret`, never `TRON-PRO-API-KEY`.
- With it unset, the current direct TronScan path is unchanged.
- `TRONSCAN_API_KEY` stays supported until the Worker has the key and the
  coordinator is switched. After a canary comparison, remove the key from the
  coordinator environment so there is one copy.
- The paid-orders poller still calls TronScan directly
  (`src/coordinator/orders.rs`). Routing it through the Worker is a follow-up;
  until then it is a residual origin-to-provider connection.

### Verification

```sh
cd deploy/cloudflare/provider-proxy && npm test
node scripts/check-projects.mjs
node scripts/check-defect-ledger.mjs
cargo test --release --test coordinator_api
```

Canary after the switch:

```sh
curl -s 'https://rotor.pxbt.app/api/v1/chain/tron/address?address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
curl -s -H "X-Edge-Secret: $EDGE_PROXY_SECRET" \
  'https://rotor.pxbt.app/edge/v1/tron/account?address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
```

The balance and transaction count must match. Then confirm the origin makes no
new outbound connection to `apilist.tronscanapi.com` (for example with
`ss -tpn | grep tronscan` during a lookup).

## What we retain

| Data | Where | Retention |
|---|---|---|
| Client IP for rate limiting | Coordinator memory (`RateLimiter`, `RegisterLimiter`), Worker salted digest | Process/isolate lifetime; never written |
| Client IP for registration window | Coordinator memory | One minute |
| Account, job, lease, order state | `/data/*.json` | Until the operator deletes it |
| No request body, no provider key, no access log | — | — |

The admin-cabinet proposal plans a hashed IP in the audit log; until that lands
there is no persisted per-request IP. If it lands, document the hash salt and
retention there.

## Honest limits

- **Cloudflare still sees everything.** It terminates client TLS, sees the
  client IP, the URL, the headers and the timing, and it holds the provider
  keys as Worker secrets. A Worker proxy hides the origin from providers, not
  from Cloudflare.
- **The provider sees a Cloudflare egress IP.** That address is shared with
  other Cloudflare customers, but repeated lookups of one address can be
  correlated by timing.
- **The client's ISP/VPN sees the connection to Cloudflare.** It sees the site
  hostname and traffic shape, not the provider call. Anonymity from the ISP
  requires the client's own VPN or Tor.
- **A malicious provider or Cloudflare can return wrong data.** Treat balances
  as public chain data and verify high-value decisions independently.
- **Per-isolate limits are not a global quota.** A rate limiter in a Worker
  isolate bounds one PoP, not the whole network. Use a Cloudflare Rate Limiting
  binding or a Durable Object if a hard global limit is required.
- **Tor/I2P is not implemented.** An optional later mirror can serve the static
  site over an onion service; it does not change the provider or origin model.
- **No single control is sufficient.** DNS history, an old certificate, a
  forgotten subdomain or a direct provider call from the origin can undo the
  tunnel. Review the checklist after every infrastructure change.

## Owner checklist

- [ ] Create the tunnel and the proxied CNAME; remove every origin IP record.
- [ ] Firewall: default-deny inbound; the coordinator binds loopback/private.
- [ ] Mount `rotor.pxbt.app/edge/*` to the provider-proxy Worker.
- [ ] `wrangler secret put` the provider keys and `EDGE_PROXY_SECRET`.
- [ ] Add the `Server` / `X-Powered-By` / `Via` Transform Rules.
- [ ] Create the Cloudflare Access application for `/cabinet/admin*`.
- [ ] Disable Logpush for the site (or minimize fields and retention).
- [ ] Audit subdomains and historical DNS for origin leakage.
- [ ] Set `EDGE_PROXY_URL` / `EDGE_PROXY_SECRET` on the coordinator after the
      canary; then remove `TRONSCAN_API_KEY` from the origin.
- [ ] Migrate the browser's direct provider calls to `/edge/*`.
