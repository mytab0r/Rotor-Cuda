# Coordinator domain

## Requirements

### Requirement: embedded browser assets
The coordinator MUST continue to ship the site inside the single coordinator
binary. It MUST embed the browser worker and the wasm artifact (`include_str!`
for JS/HTML, `include_bytes!` for wasm) and serve them, without authentication,
with `text/html; charset=utf-8`, `application/javascript; charset=utf-8` and
`application/wasm` respectively. Source: `src/coordinator/mod.rs:30-36`,
`:397-411`, `:481-491`.

#### Scenario: wasm route
- GIVEN a release coordinator built after `scripts/build-wasm.sh`
- WHEN `GET /rotor_wasm.wasm` is requested
- THEN the response is 200 with `Content-Type: application/wasm` and a body
  equal to the embedded artifact

#### Scenario: missing artifact
- GIVEN `apps/site/rotor_wasm.wasm` is absent at compile time
- WHEN the coordinator is built
- THEN the build fails loudly (`include_bytes!`); it MUST NOT serve a redirect,
  a 404 or a stale inline stub

### Requirement: build-fingerprinted assets
Every HTML document the coordinator emits MUST reference each first-party
`.css`, `.js`, `.wasm`, `.svg`, `.woff2`, `.png` and `.ico` asset as
`/a/<ROTOR_BUILD_ID>/<path>`, and MUST expose the build to the runtime as
`data-build` on `<html>`. The rewrite MUST NOT touch external URLs, `/api/v1/*`
paths or page routes, and MUST preserve a query string or fragment on the
original reference. The coordinator MUST serve a build-prefixed asset by
stripping the first `/a/<segment>/`, answering `Cache-Control: public,
max-age=31536000, immutable` plus the content `ETag`; any non-empty segment
resolves, so a shell cached from an older deploy does not 404 its assets. Bare
asset paths MUST keep working with `Cache-Control: no-cache` and the `ETag`, and
HTML MUST stay `no-store`. Source: `src/coordinator/mod.rs` (`handle`,
`fingerprint_assets`, `prefixed_asset_path`), `apps/site/theme.js`
(`RotorAssets`).

#### Scenario: served page references the build
- GIVEN a coordinator built with `ROTOR_BUILD_ID=<build>`
- WHEN `GET /` or `GET /docs` is requested
- THEN the body references `/a/<build>/site.js` and `/a/<build>/site.css` and
  contains no bare `"/site.js"` or `"/site.css"` asset reference

#### Scenario: immutable asset
- GIVEN a page referenced `/a/<build>/site.css`
- WHEN that URL is requested
- THEN the response is `200` with `Cache-Control: public,
  max-age=31536000, immutable` and an `ETag`
- AND `GET /site.css` still answers `200` with `Cache-Control: no-cache`

#### Scenario: unknown asset under the prefix
- GIVEN a request for `/a/<build>/nope.css`
- WHEN the coordinator handles it
- THEN the response is `404`

### Requirement: HEAD mirrors GET for public resources
Every public route (embedded assets, build-fingerprinted assets, SEO pages,
redirects and the unknown non-API 404 page) MUST accept `HEAD` and answer with
the same status and the same `Cache-Control`, `ETag` and `Content-Type` a `GET`
would produce, with an empty body. `HEAD` MUST NOT enter an API handler or
create a side effect. Source: `src/coordinator/mod.rs` (`handle`); `tiny_http`
suppresses the body for a `HEAD` response while keeping the headers.

#### Scenario: HEAD on assets and a page
- GIVEN a coordinator serving `/site.css`, `/docs` and `/a/<build>/site.css`
- WHEN each is requested with `HEAD`
- THEN the status and the `Cache-Control`, `ETag` and `Content-Type` headers
  equal the `GET` response for the same path
- AND the `HEAD` body is empty while the `GET` body is not

#### Scenario: HEAD on an unknown page
- GIVEN an unknown non-API path
- WHEN it is requested with `HEAD`
- THEN the response is `404` with an empty body

### Requirement: no protocol change
The browser client MUST use the existing `/api/v1/jobs`, `/lease`, `/heartbeat`
and `/result` endpoints and the existing token, lease-nonce and challenge-sample
rules. No new browser-only protocol, CORS header or unauthenticated target
endpoint is added by this change. Source: `src/coordinator/mod.rs:452-479`.

#### Scenario: client-token identity
- GIVEN a request with a client bearer token and a body `client_id`
- WHEN `/lease` or `/heartbeat` is handled
- THEN the server uses the token identity and ignores the body value

### Requirement: browser-sized jobs are documented
Documentation MUST state that the default `chunk_width` (0x10000000) is sized
for native clients, and that browser-oriented jobs SHOULD use 2^20–2^22 with
`lease_ttl` 120–300. Source: `src/coordinator/state.rs:27-30`,
`apps/site/app.html:88-91`.

#### Scenario: operator creates a browser job
- GIVEN an operator creates a job for browser participation
- WHEN they follow the docs
- THEN the job uses a chunk width that completes in seconds to a couple of
  minutes at the measured tab rate and has a TTL comfortably longer than a
  paused tab's resume path

### Requirement: processor-free paid downloads
The coordinator MUST serve paid-download orders only when `ORDERS_CONFIG` is
set; without it `POST /api/v1/orders` and the other order routes answer `503`
`orders_not_configured`. The public order routes MUST bypass the client-token
matrix because a buyer has no client account. Order creation MUST refuse an
unknown or `active: false` list with `404`, and MUST quote a unique atomic
amount above the frozen USD price. Order and delivery tokens MUST be stored
only as SHA-256 hashes. A delivery link MUST be HMAC-signed over
`order|list|expiry|nonce`, expire after `link_ttl_secs`, allow at most
`max_downloads` deliveries, and answer `404` for a bad token. The artifact hash
MUST be checked before streaming, and the response MUST carry
`Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
`X-Robots-Tag: noindex`. Source: `src/coordinator/orders.rs`,
`docs/donor-parity/payments.md` §3-4.

#### Scenario: orders are not configured
- GIVEN `ORDERS_CONFIG` is unset
- WHEN `POST /api/v1/orders` is requested
- THEN the response is `503 {"error":"orders_not_configured"}`

#### Scenario: list is not for sale
- GIVEN a configured list with `active: false`
- WHEN `POST /api/v1/orders` names its slug
- THEN the response is `404` and no order is persisted

#### Scenario: forged delivery token
- GIVEN a paid order with an entitlement
- WHEN `GET /api/v1/orders/{id}/download` carries a token that fails the HMAC
  check
- THEN the response is `404`, indistinguishable from an unknown order

#### Scenario: licence document
- GIVEN an order whose list carries a `licence` and an optional `provenance`
- WHEN `GET /api/v1/orders/{id}/licence?token=...` carries the order token
- THEN the response is `200 text/plain; charset=utf-8` with
  `Content-Disposition: attachment; filename="<slug>-LICENCE.txt"`,
  `Cache-Control: no-store` and `X-Robots-Tag: noindex`, and the body names the
  list, its licence identifier and, when configured, its provenance
- AND a missing or wrong token, or an unknown order, answers `404` with no
  document
- AND the order status response always exposes `licence_url` for the buyer

#### Scenario: download cap is exhausted
- GIVEN an entitlement whose `downloads` equals `max_downloads`
- WHEN a correctly signed link is used again
- THEN the response is `410` and the artifact is not streamed

### Requirement: operator cabinet authentication
The coordinator MUST serve the operator surfaces under `/cabinet/admin`. A
session is a signed cookie `v1.<exp>.<nonce>.<mac>` minted by
`POST /cabinet/admin/login` from the coordinator token, valid for 12 hours,
scoped to `Path=/cabinet/admin`, and invalidated by rotating the token. The
cookie MUST be `HttpOnly; SameSite=Strict` and `Secure` unless the canonical
public origin is plain `http://`. Admin HTML without a session MUST redirect to
`/cabinet/admin/login`; admin API without a session or the bearer token MUST
answer `401`. Script clients MAY use `Authorization: Bearer`. Mutating calls
MUST require a double-submit `X-CSRF-Token` and a same-origin `Origin`.
Source: `src/coordinator/admin.rs`, `src/coordinator/mod.rs` (`handle_admin`).

#### Scenario: unauthenticated admin request
- GIVEN no session cookie and no bearer token
- WHEN `GET /cabinet/admin` is requested
- THEN the response is `302` with `Location: /cabinet/admin/login`
- AND `GET /cabinet/admin/api/*` answers `401` instead

#### Scenario: token rotation
- GIVEN a cookie minted from token A
- WHEN the coordinator is restarted with token B
- THEN the cookie no longer validates and HTML redirects to the login page

### Requirement: admin response headers
Every admin HTML, JSON and asset response MUST carry
`Cache-Control: no-store, private`, `Vary: Cookie`,
`X-Robots-Tag: noindex, nofollow, noarchive`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff` and the admin
`Content-Security-Policy` with no inline script or style. The design gallery
MUST be served at `/cabinet/admin/design`; `/design` MUST answer `404`.
Source: `src/coordinator/mod.rs` (`apply_admin_headers`, `ADMIN_CSP`).

#### Scenario: missing header is a bug
- GIVEN any `/cabinet/admin*` response
- WHEN its headers are inspected
- THEN all six admin headers are present and `Content-Type` matches the body

### Requirement: read-only admin inventory
The coordinator MUST expose read-only inventory under
`/cabinet/admin/api/{clients,monitor/users,monitor/users/{id},monitor/events,jobs,workers,leases,orders,payments,providers,integrations,audit}`
behind the session/bearer gate. List responses MUST use the page envelope
`{items, page, page_size, total, has_more}` with a 1-based `page`, a default
`page_size` of 50 and a hard cap of 200. Payloads MUST NOT contain
`token_hash`, `order_token_hash`, provider keys, HMAC secrets, Telegram bot
tokens, session tokens or order tokens. The audit endpoint MUST answer an
explicit empty page until the audit store ships. Source:
`src/coordinator/mod.rs` (admin handlers), `src/monitor/store.rs`,
`src/coordinator/state.rs`, `src/coordinator/orders.rs`,
`src/coordinator/tron_cache.rs`.

#### Scenario: page size is bounded
- GIVEN `?page_size=5000`
- WHEN a list endpoint answers
- THEN `page_size` is `200`, never the requested value

#### Scenario: secrets stay out
- GIVEN a coordinator configured with a TronScan key, an edge secret, an
  orders HMAC secret and an orders admin token
- WHEN every admin inventory response is serialized
- THEN none of those values appears in any payload

#### Scenario: empty inventory is honest
- GIVEN no orders and no audit store
- WHEN `/cabinet/admin/api/orders` and `/cabinet/admin/api/audit` are requested
- THEN both answer `200` with an empty `items` array and explicit
  `configured`/`available` flags; no placeholder rows are invented
