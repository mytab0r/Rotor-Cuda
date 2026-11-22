# coordinator delta

## ADDED Requirements

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
