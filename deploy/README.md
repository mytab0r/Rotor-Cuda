# Rotor coordinator deployment

The coordinator is a single Rust binary (`rotor-coord`) that serves the JSON API
and the public site (`/`, `/app`, `/me`, `/docs` with shared `/site.css` and
`/site.js`). It has no database and no build step for the site: the pages are
embedded in the binary. State is one atomically rewritten JSON file in `/data`.

## Linux binary (systemd)

CI publishes `rotor-coord-linux-x86_64` (and its `.sha256`) on every release
tag. Install it with a dedicated user and the unit from this directory:

```sh
sudo useradd --system --home /var/lib/rotor --shell /usr/sbin/nologin rotor
sudo install -d -o rotor -g rotor /opt/rotor /etc/rotor /var/lib/rotor
sudo install -m 0755 rotor-coord-linux-x86_64 /opt/rotor/rotor-coord
sudo install -m 0644 deploy/rotor-coord.service /etc/systemd/system/
sudo install -m 0640 -o root -g rotor deploy/rotor-coord.env.example /etc/rotor/rotor-coord.env
# edit /etc/rotor/rotor-coord.env: ROTOR_COORD_TOKEN=<openssl rand -hex 32>
#   and set the operator login: ROTOR_ADMIN_USER=owner, ROTOR_ADMIN_PASSWORD=<a long password>
```

### Client accounts and tokens

Client accounts live in the coordinator state. Two ways to create them:

- `POST /api/v1/clients { "name": "..." }` with the admin token returns
  `{ "id": ..., "token": ... }`; the token is shown once.
- `--open-registration` enables public `POST /api/v1/register { "name": "..." }`
  on the landing page (one registration per remote IP per minute).

The legacy `--clients FILE` map is imported into the state on the first start
only; afterwards the state is authoritative and the file is ignored. In that
file each client id maps to the SHA-256 of its token (lowercase hex). The token
itself never lives on the server, only its hash:

```sh
mkdir -p /etc/rotor
jq -n \
  --arg a "$(printf '%s' 'rig-a-secret' | sha256sum | cut -d' ' -f1)" \
  --arg b "$(printf '%s' 'rig-b-secret' | sha256sum | cut -d' ' -f1)" \
  '{ "rig-a": $a, "rig-b": $b }' | sudo tee /etc/rotor/clients.json
sudo chmod 0640 /etc/rotor/clients.json
```

Run the client with the raw secret (`--token rig-a-secret`); the server hashes
what is presented and looks it up, so the id cannot be spoofed through the
request body. Without `--clients` and before the first account exists the
coordinator keeps the legacy single-token mode.

A `--clients` path that does not exist is a startup error, so after wiping the
state directory create the file first (`printf '{}' | sudo tee data/clients.json`
with owner `10001:10001`) or drop the flag.

- Admin token (`ROTOR_COORD_TOKEN`): create/list jobs, read the dashboard, list
  and create clients, disable accounts.
- Client token: lease, heartbeat, result, BSGS progress, status and `/me`; it
  cannot create jobs or manage accounts.
- A disabled account gets `401` on every authenticated call and its active
  leases are released.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now rotor-coord
curl -s -H "Authorization: Bearer $ADMIN" http://127.0.0.1:7878/api/v1/status
curl -s http://127.0.0.1:7878/api/v1/summary   # public totals + leaderboard
```

The unit binds `127.0.0.1:7878`; terminate TLS in front of it (Caddy example
below). Clients then use `https://...` directly — the `rotor` client speaks
HTTPS with the system TLS stack (SChannel on Windows, OpenSSL on Linux).

### TRON lookups

`GET /api/v1/chain/tron/address?address=<base58 T...>` returns the TRON balance
and transaction count for a public address:

```json
{"chain":"tron","address":"T...","balance_sun":"1393900000","tx_count":1015112,"last_tx_at":1700000000000,"source":"tronscan"}
```

Set `TRONSCAN_API_KEY` in `/etc/rotor/rotor-coord.env` (or the compose `.env`)
to a TronScan Pro API key. The key stays on the server: it is sent only as the
`TRON-PRO-API-KEY` header to `apilist.tronscanapi.com` and never appears in
responses, errors or browser code. The route is public but rate-limited per
client IP. Without the key it answers `501 {"error":"no_provider"}` and the
browser falls back to its previous direct TronScan request.

To stop the provider from seeing the origin, set `EDGE_PROXY_URL`
(for example `https://rotor.pxbt.app/edge`) and `EDGE_PROXY_SECRET` in the
environment. TRON lookups then go through the `deploy/cloudflare/provider-proxy`
Worker, which adds its own `TRONSCAN_API_KEY`; the coordinator sends only
`X-Edge-Secret`. `EDGE_PROXY_SECRET` is required when `EDGE_PROXY_URL` is set:
a missing or blank secret is a startup error, not a silent fallback to direct
provider calls. With both variables unset the direct path above is unchanged.
See `docs/ops/privacy.md` for the tunnel, DNS, firewall, header and Logpush
model. If TronScan reports
a negative balance (its own 64-bit overflow for huge accounts), the route
returns `balance_sun:null` with `balance_error:"provider_overflow"` instead of a
wrong number. TronScan failures are a short `502`; one retry is made on
429/5xx.

### Paid downloads (processor-free)

Paid datasets are sold without a payment processor, accounts or custody. The
buyer is identified by the order alone: one fixed deposit address per chain
plus a unique atomic-amount suffix above the list price. A background poller
verifies the transfer on-chain and issues an expiring download link. The full
design and trust model are in `docs/donor-parity/payments.md`.

Set two variables in `/etc/rotor/rotor-coord.env` (or the compose `.env`):

- `ORDERS_CONFIG` — path to a JSON file based on `deploy/orders.example.json`.
  Without it every `/api/v1/orders*` route answers `503`
  `{"error":"orders_not_configured"}`.
- `ORDERS_HMAC_SECRET` — signing key for delivery links, at least 32 random
  bytes (`openssl rand -hex 32`). Required when `ORDERS_CONFIG` is set; a
  missing or short secret is a startup error.

`deploy/orders.example.json` ships every list with `active: false` and
placeholder addresses, prices and hashes. Replace them, stage the files, and
flip a list to `active: true` only when the owner has set its price and chain.
Per-list fields:

| Field | Meaning |
|---|---|
| `slug` | Stable id used by `POST /api/v1/orders`. |
| `chain`, `asset` | `btc`, `ltc` or `tron`; display symbol. |
| `price_usd_cents` | Quoted price in cents. |
| `usd_per_unit_micros` | Frozen rate, micro-USD per one whole unit. |
| `decimals` | Atomic precision (8 for BTC/LTC, 6 for TRC-20). |
| `address` | Fixed deposit address. One per chain is enough. |
| `contract` | TRC-20 contract for a token asset; omit for native TRX. |
| `file_path`, `sha256` | Artifact streamed after payment and its hash. |
| `active` | `false` keeps the list visible in the file but unorderable. |

Root fields: `confirmations` per chain (defaults BTC 3, LTC 6, TRON 19),
`quote_ttl_secs` (30 min), `link_ttl_secs` (7 days), `max_downloads` (5),
`poll_interval_secs` (45), optional `esplora` bases for BTC/LTC, and an optional
`admin_token` accepted alongside the coordinator admin token. The order store is
`orders.json` next to the coordinator state file; it is written atomically and
holds only token hashes, never raw order or download tokens. TRON verification
needs the existing `TRONSCAN_API_KEY`; without it TRON orders stay
`awaiting_payment`.

Flow:

1. `POST /api/v1/orders {"list":"btc-pack","contact":"buyer@example.com"}`
   returns `201 {order_id, asset, amount, address, expires_at, order_token}`.
   `404` means the list is unknown or `active: false`.
2. The buyer sends the exact amount to the address before `expires_at`. A
   payment after expiry is recorded as `late_paid` for manual handling and is
   never auto-delivered.
3. `GET /api/v1/orders/{id}` with `Authorization: Bearer <order_token>` (or
   `?token=`) reports `awaiting_payment`, `confirming`, `paid`, `expired`,
   `late_paid` or `revoked`. When paid it includes `download_url`.
4. `GET /api/v1/orders/{id}/download?token=…` streams the file with
   `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
   `X-Robots-Tag: noindex`. A bad token is `404`; an expired or exhausted link
   is `410`. The file hash is checked before every delivery.

Admin routes use the coordinator admin token (or `admin_token` from the orders
file): `POST /api/v1/admin/orders/{id}/revoke` and
`POST /api/v1/admin/payments/reconcile`.

Deliberately absent: cards and payment processors, a custodial balance or
withdrawals, accounts, private keys (the deposit addresses are watch-only
strings), automatic refunds, and paywalling data that is already MIT/CC0.
Underpayment keeps the order `awaiting_payment`; overpayment is kept, but is
credited only when the amount identifies a single open order.

### Caddy (HTTPS)

`deploy/Caddyfile.example` is a two-line site block: replace the host name and
reload Caddy. Keep the coordinator on loopback or a private network; only the
proxy should be reachable from the internet.

### Docker image

`ghcr.io/mytab0r/rotor-coord:latest` is built by
`.github/workflows/coordinator-image.yml` on every push to `main`. The host runs
Watchtower with `--label-enable`, and the compose file sets
`com.centurylinklabs.watchtower.enable=true`, so a new image is pulled and the
container restarted automatically (default interval 300 s).

## First deploy

```sh
mkdir -p /opt/rotor-coord/data
cd /opt/rotor-coord
cp /path/to/deploy/docker-compose.yml .
cp /path/to/deploy/.env.example .env
# edit .env: ROTOR_COORD_TOKEN=<openssl rand -hex 32>
docker compose up -d
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7878/api/v1/status
```

The container joins the existing `stack_edge` network so a reverse proxy
(Zoraxy) can reach it as `rotor-coord:7878`.

## Reverse proxy (Zoraxy)

Add a host rule through the Zoraxy API (form fields, CSRF header required after
logging into `/api/auth/login`):

```sh
curl -b jar -X POST -H "X-CSRF-Token: $CSRF" \
  --data-urlencode "type=host" \
  --data-urlencode "rootname=rotor.pxbt.app" \
  --data-urlencode "ep=rotor-coord:7878" \
  --data-urlencode "tls=false" \
  --data-urlencode "enableUtm=false" \
  --data-urlencode "access=default" \
  http://127.0.0.1:8000/api/proxy/add
```

Cloudflare already proxies `*.pxbt.app`; Zoraxy matches the Host header on
ports 80/443. `tls=false` keeps the origin hop plain HTTP (Cloudflare terminates
client TLS); enable TLS in Zoraxy with a certificate if the origin is reached
directly.

## State and backups

- File: `/opt/rotor-coord/data/coordinator.json` (atomic tmp+rename).
- Format version 2 (packed bitmap). It now also carries client accounts, their
  stats and a bounded history. A version-2 file written before accounts existed
  loads with an empty client list; an older version is rejected with an explicit
  error, and there is no migration yet — move the old file aside and start a new
  one.
- Size: completed chunks are a bitmap — about 2 hex characters per byte of
  bitmap; 1M chunks is roughly 250 KiB plus a small lease list. Each client adds
  at most 240 history points.
- Backup: copy the file (it is always a complete JSON); restore by putting it
  back and restarting.
- Chunks are leased in a scattered (seeded full-cycle permutation) order, so
  progress is spread across the range while every chunk is covered exactly once.

## Security

- Bind is `0.0.0.0` inside the container; the compose port is not published to
  the host, so only the proxy network reaches it. The systemd unit binds
  `127.0.0.1` directly.
- Client accounts (`--clients` import, admin API, or open registration): the
  server stores only SHA-256 hashes and compares them in constant time; an
  unknown or disabled token gets 401. The admin token can manage jobs and
  accounts but cannot lease, and a client token cannot create jobs.
- Public endpoints are the static pages and `GET /api/v1/summary` (aggregate
  totals and the top-10 leaderboard only). `GET /api/v1/status` and everything
  else still requires a token.
- Open registration (`--open-registration`) is throttled to one attempt per
  remote IP per minute; names are trimmed, capped at 64 characters and reject
  control/HTML characters.
- Each lease carries `lease_id` and 16 challenge offsets. A `done` heartbeat
  must include the hashes of the keys at those offsets; wrong or missing samples
  return 400 and the chunk stays leased (BSGS is exempt). Leases and results
  with a stale nonce get 409.
- Rate limit: 20 requests/s per token with a burst of 40, then 429 with
  `Retry-After: 1`.
- Use HTTPS at the proxy (Cloudflare/Zoraxy/Caddy); tokens over plain public
  HTTP are not acceptable. The client binary supports `https://` natively.
- Request bodies are capped at 1 MiB and the lease nonces/samples stop casual
  forged progress; they are not a proof of full chunk coverage.
