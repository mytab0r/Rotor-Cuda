# Admin cabinet

## Summary

Move operator-only surfaces (design-system gallery, users, jobs, orders,
providers, integrations, settings, SEO templates, redirects, link health) into
an authenticated admin at `/cabinet/admin`, built from the existing design
system. Public pages keep their current behaviour; the admin is noindex,
no-store and never exposes secret values.

Status: proposed. Evidence gathered 2026-11-22 from the current tree.

## Decision

1. **Auth.** `POST /cabinet/admin/login` exchanges the coordinator token for a
   session cookie: `HttpOnly; Secure; SameSite=Strict; Path=/cabinet/admin;
   Max-Age=43200`, signed with `HMAC-SHA256(SHA-256("rotor-admin-cookie-v1\0" ||
   admin_token), "v1.<exp>.<nonce>")`. No server-side session registry; rotating
   `ROTOR_COORD_TOKEN` invalidates every cookie. Mutations require a double-submit
   `X-CSRF-Token` and an `Origin` check. `constant_time_eq` for both token and MAC.
2. **Paths.** Admin API lives at `/cabinet/admin/api/*`, not `/api/v1/*`, so the
   cookie path stays scoped and the bearer API contract does not change. Script
   clients may still use `Authorization: Bearer` (no CSRF needed).
3. **Rate limit.** Reuse the monitor's `IpRateLimiter`: 5 failures / 15 min / IP,
   fixed 200 ms delay, failures audited with hashed IP.
4. **Gallery.** Remove `/design` from `static_asset` (404). Serve the same
   `DESIGN_PAGE` at `/cabinet/admin/design` behind the cookie. CI audit logs in
   with the token the harness started the server with — no bypass code ships.
5. **Audit.** Append-only `admin-audit.jsonl` next to the state file (0600,
   hash-chain `sha256(prev || line)`, rotation 5 MiB, retention 90 days). Fields:
   `at, actor, action, target, result, ip_hash, prev_hash`. Never tokens, cookies,
   request bodies or secret values.
6. **Secrets policy.** Integrations expose `{configured, env_var_name,
   public_value?, health, last_error_at, last_error}` only. No field exists for a
   secret value, and a test asserts serialized responses never contain the test
   secrets.
7. **Headers for admin responses.** `Cache-Control: no-store, private`,
   `Vary: Cookie`, `X-Robots-Tag: noindex, nofollow, noarchive`,
   `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
   `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src
   'self'; img-src 'self' data:; connect-src 'self'; object-src 'none';
   base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. Admin pages use
   external `/admin.js` and `/admin.css`; no inline script or style.
8. **Visits are first-party and aggregate-only.** A beacon loaded only by the
   Astro layout posts `{event:"view", path, referrer_host?}` to
   `POST /api/v1/analytics/collect`. This is deliberately stricter than the
   phase-4 sketch: there is no per-path top-200 list (fixed route families plus
   `other`), no optional hashed-IP unique count, no cookies or storage on the
   client, no raw IP or User-Agent persisted, and no full referrer URL. Country
   comes only from `CF-IPCountry`; device/browser are coarse server-side
   classes. Retention is 168 hourly buckets. CORS allows only the two site
   origins; the per-IP limiter is memory-only. `docs/ops/analytics.md` is the
   operator-facing contract.

## Surfaces

| Route | Data source | Mode |
|---|---|---|
| `/cabinet/admin` | status, summary, jobs, leases | read-only |
| `/cabinet/admin/clients` | client list; create, disable, rotate token | read/write |
| `/cabinet/admin/monitor` | monitor users, settings, Telegram links, sessions, events | read; unlink Telegram |
| `/cabinet/admin/jobs` | jobs, live leases, workers | read |
| `/cabinet/admin/orders` | orders, payments; revoke, reconcile | read/write |
| `/cabinet/admin/providers` | TRON cache/limiter counters, last provider error | read |
| `/cabinet/admin/integrations` | Telegram, TronScan, orders, WalletConnect health | read; re-register webhook |
| `/cabinet/admin/settings` | `open_registration` (runtime); env/CLI values read-only | read/write |
| `/cabinet/admin/seo` | title/description templates per route kind | read/write |
| `/cabinet/admin/redirects` | redirect table | read/write |
| `/cabinet/admin/links` | external link check report | read; run now |
| `/cabinet/admin/analytics` | aggregate page views: today/week totals, hourly ring, route/country/device/browser/referrer counts, process load counters | read |
| `/cabinet/admin/audit` | audit tail | read |
| `/cabinet/admin/design` | design-system gallery | read |

## SEO templates

The coordinator already builds titles and descriptions from constants
(`*_TITLE`, `*_DESCRIPTION` in `src/coordinator/mod.rs`) with values such as the
chain name or the key form. Replace the hard-coded strings with a template
registry keyed by page kind (`home`, `directory`, `directory-chain`, `key`,
`key-hex`, `mnemonic-seeds`, `brainwallet`, `puzzle`, `docs`, ...):

- Each template has `title` and `description` strings with a closed set of
  variables (`{chain}`, `{chain_name}`, `{symbol}`, `{page}`, `{key_form}`,
  `{key_short}`, `{total_pages}`). Unknown variables are a validation error.
- Values are HTML-escaped by the renderer; templates cannot contain raw HTML.
- The admin shows the variable list per page kind and a live preview.
- Stored in `admin-seo.json` (0600, atomic write), loaded at startup, defaults
  remain in code; every change is audited with before/after.
- Length budgets (title ≤ 60, description ≤ 160) are warnings, not hard errors.

## Redirects

- Table `from` → `to` with status 301 or 302, persisted in `admin-redirects.json`.
- `from` must be an internal path starting with `/`; `to` is an internal path or
  a URL on an explicit allowlist. This prevents the admin from becoming an open
  redirector.
- Applied before the static/SEO routes in `redirect_target`; a redirect to a
  missing target is rejected at save time and reported in the list.
- Loops (A→B→A) are rejected.

## External link health

- A job scans first-party HTML pages for external `href`s (deduplicated, max
  1000), issues `HEAD` with `GET` fallback, timeout 10 s, concurrency 4, and
  stores `{url, status, checked_at, error}` in `admin-links.json`.
- Runs daily and on demand; the report shows non-2xx/3xx, timeouts and TLS
  errors. Links are rate-limited per host; robots.txt is respected for GET.
- The checker never follows redirects into private address space (SSRF guard:
  resolve and reject RFC1918/loopback/link-local targets).
- Results are advisory; no page fails because an external link is down.

## Phases

| Phase | Content | Acceptance |
|---|---|---|
| 1 | `admin.rs`: login/logout, cookie MAC, CSRF, limiter, gate in `handle`, move `/design`, `admin.html`/`admin.js` shell, `/api/overview` | `/design` 404; admin without cookie 302/401; cookie flags; 5 failures 429; token rotation invalidates; dashboard shows jobs/leases; audit runs green on admin routes |
| 2 | Read-only inventory: clients, monitor, jobs, orders, providers, integrations, audit tail | real data or explicit empty state; no `token_hash`/secrets in payloads |
| 3 | Mutations: create/disable client, revoke order, reconcile, re-register webhook, toggle `open_registration` | CSRF/origin 403; one audit line per success |
| 4 | Visits counters (page views, no IP by default) + hardening | retention; CSP clean; audit rotation |
| 5 | SEO templates + preview | unknown variable rejected; escaping proven; defaults preserved |
| 6 | Redirects | internal-only target; loop rejected; applied before routes |
| 7 | External link checker | SSRF guard proven; report persists; daily job |

## Out of scope

- Personal admin accounts, MFA, roles (single operator token for now).
- Editing secrets or provider keys from the UI.
- Third-party analytics.
- Content editing of public pages beyond SEO templates.

## Risks

- Stateless cookies have no server-side revocation: logout clears the browser
  cookies only, and a copied cookie stays valid until its `exp` (12 h) or until
  the admin token is rotated. Token rotation is the mitigation.
- `Set-Cookie`/`Cookie` handling in tiny_http 0.12 is untested in this repo; the
  first phase closes it with a test.
- `Secure` cookies on `http://127.0.0.1` in CI: run the harness with
  `ROTOR_PUBLIC_URL=http://127.0.0.1:<port>` so `Secure` is dropped, or set the
  cookie through CDP.
- `0600` is POSIX; on Windows the inherited ACL is documented, not guaranteed.
- Existing state/orders/clients files are written without an explicit mode; the
  new admin files use 0600, and retrofitting the old ones is a separate task.
