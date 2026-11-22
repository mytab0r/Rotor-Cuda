# Admin cabinet runbook

The operator cabinet lives at `/cabinet/admin`. It is read-only in phase 2; the
audit store, mutations, SEO templates, redirects and the link checker ship in
later phases.

## Sign in and sessions

- `POST /cabinet/admin/login` with `{"token": "<ROTOR_COORD_TOKEN>"}` sets two
  cookies: `rotor_admin` (HttpOnly, signed, 12 h) and `rotor_admin_csrf`
  (readable by `admin.js`). Both are scoped to `Path=/cabinet/admin`.
- The cookie is stateless: there is no server-side session registry. Logging
  out clears the browser cookies; a copied cookie stays valid until its `exp`
  (12 h) or until `ROTOR_COORD_TOKEN` is rotated. Rotation is the revocation
  mechanism.
- Scripts may call `/cabinet/admin/api/*` with
  `Authorization: Bearer <ROTOR_COORD_TOKEN>` and need no CSRF token.
- The login limiter allows 5 failures per IP per 15 minutes with a fixed 200 ms
  delay. Behind a shared reverse-proxy IP one attacker can hold the lock for
  every operator behind that IP. That is a deliberate availability trade-off,
  not a bypass; use a dedicated egress/ingress address for the cabinet.
- The `Secure` cookie flag follows `ROTOR_PUBLIC_URL`: an `http://` origin (the
  local CI harness) drops it, any other origin keeps it.

## Read-only endpoints

All endpoints are gated by the cookie or bearer token and answer the page
envelope `{items, page, page_size, total, has_more}`. `page` is 1-based;
`page_size` defaults to 50 and is capped at 200.

| Endpoint | Data source |
|---|---|
| `/cabinet/admin/api/overview` | jobs, leases, clients, build id, uptime |
| `/cabinet/admin/api/clients` | coordinator client accounts (no token hash) |
| `/cabinet/admin/api/monitor/users` | monitor accounts, settings, sessions, watches, Telegram link |
| `/cabinet/admin/api/monitor/users/{id}` | one account plus a bounded event tail |
| `/cabinet/admin/api/monitor/events` | global event tail, newest first |
| `/cabinet/admin/api/jobs` | coordinator jobs |
| `/cabinet/admin/api/workers` | enabled clients and their live lease |
| `/cabinet/admin/api/leases` | live leases |
| `/cabinet/admin/api/orders` | paid-download orders (no order token hash) |
| `/cabinet/admin/api/payments` | recorded payments |
| `/cabinet/admin/api/providers` | TRON cache hit/miss/error, limiter wait/reject, last error class, watcher health |
| `/cabinet/admin/api/integrations` | Telegram, TronScan, orders and WalletConnect configuration flags |
| `/cabinet/admin/api/audit` | explicit empty page until phase 3 |

Disabling the monitor store or the orders store keeps the endpoint working and
returns `available: false` / `configured: false` with no invented rows.

## Secrets

Admin payloads never contain `token_hash`, `order_token_hash`, provider keys,
HMAC secrets, Telegram bot tokens, session tokens or order tokens. Integration
rows may name environment variables such as `ROTOR_TELEGRAM_BOT_TOKEN` and
`ORDERS_HMAC_SECRET`; the values never leave the process.
`tests/coordinator_api.rs` serializes every inventory response with test secrets
configured and asserts that none appears.

## UI

`apps/site/admin.html` and `apps/site/admin.js` render one panel per section
and fetch only the active panel's endpoint. Panels use the shared
`.data-table` inside `.table-scroll`, the shared `.empty-state` and `.error`
boxes, and no row actions exist in phase 2. The admin surfaces are app shells:
they use the shared navigation and intentionally carry no marketing footer.
`node scripts/ui-audit.mjs --serve` covers every panel at 375/768/1280 in dark
and light.

## Routes and the site map

The admin API endpoints are not content routes and are intentionally absent
from `docs/site-map`; that ledger covers the public site. The only admin route
in it is `/cabinet/admin/design`, the design-system gallery.
