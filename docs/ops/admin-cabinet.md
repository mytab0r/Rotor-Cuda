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

## User cabinet WalletConnect

The public cabinet at `/cabinet` offers WalletConnect for mobile EVM wallets.
The coordinator serves the Reown/WalletConnect project id as
`walletconnect_project_id` from `GET /api/v1/monitor/config`; set it with
`ROTOR_WALLETCONNECT_PROJECT_ID`.

- **Whitelist the origin.** In the Reown dashboard (project settings -> allowed
  domains) add every served origin, for example `https://rotor.pxbt.app` and the
  staging origin. A missing entry makes the relay verification fail; the
  cabinet shows that error verbatim because it is diagnostic.
- The bundle is built by `sh scripts/build-walletconnect.sh` and committed as
  `apps/site/walletconnect.js`. It is a vendored artifact; the script is the
  source of truth.
- `chains: [1]` stays the required chain. `optionalChains` covers every EVM
  chain the site supports: 1, 56, 137, 42161, 10, 8453, 43114 and 324. One EVM
  account is exposed; the page never invents a per-chain address.
- The provider is built with `showQrModal: false`. The cabinet listens for
  `display_uri` and renders its own panel: QR code, copy action, wallet deep
  links (MetaMask, Trust Wallet, Rainbow, Coinbase Wallet and a generic `wc:`
  link), and loading/error/expired states. On a mobile user agent the panel
  opens the selected wallet app instead of showing the QR.
- After `connect()` resolves, the SIWE `personal_sign` flow is unchanged. The
  session token stays in `localStorage` and is never rendered.

### Manual test with a real wallet

A headless browser cannot drive a real wallet, so the handoff and signature
steps stay a human check. The automated audit stubs the provider and
`display_uri`, covers the desktop QR and links, the Android-Chrome mobile
chooser and deep-link navigation, the expired state, and the abort path.

1. **Desktop QR** - open `/cabinet`, click WalletConnect, scan the QR with
   MetaMask, Trust Wallet, Rainbow or Coinbase Wallet on a phone. The wallet
   asks to approve the session, then shows the sign-in message.
2. **Mobile deep link** - open `/cabinet` in a phone browser and choose the
   wallet app. The app must open on its own with the connection request; no
   copying the URI into the wallet's dapp browser. Return to the browser and
   approve the signature.
3. **Expired URI** - leave the panel open for about five minutes without
   approving. The panel must say the URI expired and offer Regenerate; the dead
   URI, QR and wallet-link controls must disappear, and Regenerate must restore
   a fresh QR or deep link.
4. **Rejected signature** - approve the connection but reject the
   `personal_sign` request. The page must say the request was rejected and stay
   signed out.
5. **Unlisted origin** - remove the origin from the Reown allowlist and retry.
   The relay/verify error must be shown as-is.

## Routes and the site map

Every route family, admin included, lives in `data/routes.json`. The operator
view is `/cabinet/admin/site-map`: it renders that file with family, renderer,
auth and status filters plus a search box, and is served behind the same signed
cookie and CSP as the design gallery. `node scripts/check-ssot.mjs` fails when
the coordinator serves a route missing from the map or names a template file
that does not exist. The donor-parity ledger in `docs/site-map` covers the
public site only and defers route facts to the map; `/cabinet/admin/design` and
`/cabinet/admin/site-map` are admin surfaces in `data/routes.json`.
