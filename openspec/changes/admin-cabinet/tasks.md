# Tasks — admin cabinet

## 1. Gate, auth, shell

- [x] `src/coordinator/admin.rs`: cookie format `v1.<exp>.<nonce>.<mac>`, key
      derivation from the admin token, `constant_time_eq` validation, CSRF token,
      `Origin` check, 12 h TTL, logout.
- [x] `POST /cabinet/admin/login` (JSON token) and `POST /cabinet/admin/logout`;
      `Set-Cookie` with `HttpOnly; Secure; SameSite=Strict; Path=/cabinet/admin`.
- [x] Rate-limit login through the shared `IpRateLimiter`: 5 failures / 15 min /
      IP, fixed delay, audit failures with hashed IP.
- [x] Gate in `handle` before SEO/static: `/cabinet/admin*` without a valid cookie
      → 302 to `/cabinet/admin/login` for HTML, 401 for API; bearer still accepted.
- [x] Remove `/design` from `static_asset`; serve the gallery at
      `/cabinet/admin/design` with admin headers.
- [x] `apps/site/admin.html` + `admin.css` + `admin.js`: shell with the shared nav
      language, no inline script/style, `/cabinet/admin/api/overview` for the
      dashboard (jobs, leases, clients, build id, uptime).
- [x] CI: `ui-audit --serve` logs in through the token it started the server with
      and sets the cookie via CDP; admin routes are part of the run, and a missing
      token is a harness error, not a skip.
- [x] Tests: cookie flags and TTL, MAC tamper, expiry, token rotation invalidates,
      CSRF missing/wrong, origin mismatch, 429 after five failures, `/design` 404.

> Phase 1 note: the login limiter and its fixed delay are implemented and
> tested; the failure *audit line* (`admin-audit.jsonl`, hash chain) ships with
> the phase-2 audit store. Phase 1 has no audit writer yet.

## 2. Read-only inventory

- [x] Missing store accessors: monitor user list/detail, sessions, events tail;
      order list and payments; provider counters (cache hit/miss/error, limiter
      wait/reject, last error).
- [x] Admin API endpoints for clients, monitor, jobs, orders, providers,
      integrations, audit tail; pagination; `no-store`.
- [x] DTOs with no `token_hash`, no secret values; a test serializes responses
      with test secrets set and asserts they are absent.
- [x] Panels with real data or explicit empty states; no fake placeholders.
- [x] Delta spec at `openspec/changes/admin-cabinet/specs/coordinator/spec.md`
      for the admin cabinet: `/cabinet/admin` cookie/CSRF auth, admin response
      headers, the `/cabinet/admin/design` move and the `/design` 404 (phase 1
      shipped without one). The source spec stays untouched; the delta merges
      at archive.
- [x] Runbook/trade-off notes: the admin cookies' `Secure` flag follows
      `ROTOR_PUBLIC_URL` (an `http://` origin drops it); the per-IP login lock
      can be held by one attacker behind a shared proxy IP (deliberate
      availability trade-off, not a bypass).

## 3. Mutations

- [ ] Client create/disable/rotate; order revoke; payments reconcile; Telegram
      webhook re-register; `open_registration` toggle.
- [ ] `admin-settings.json`: 0600, atomic write, audited before/after; CLI/env
      remain defaults.
- [ ] Tests: CSRF and origin enforcement, one audit line per success, disabling a
      client frees its leases.

## 4. Visits and hardening

- [x] First-party visit analytics at `/cabinet/admin/analytics`
      (`src/coordinator/analytics.rs`): a public Astro beacon posts one view per
      page to `POST /api/v1/analytics/collect`; the coordinator derives
      country/device/browser server-side and keeps hourly aggregate buckets for
      168 h in the coordinator state (coalesced writes, flush on shutdown).
      Route families are a fixed allowlist (`other` for anything unknown), not a
      top-200 path list, so request input cannot grow the key space.
- [x] No IP, cookie, storage identifier or User-Agent is stored, and there is no
      hashed-IP unique count: the owner's privacy constraint forbids visitor
      identifiers. The remote address is only a transient in-memory rate-limit
      key; the UA is reduced to `desktop|mobile|tablet|bot` and
      `chrome|safari|firefox|edge|other`.
- [ ] Audit rotation at 5 MiB, retention 90 days, hash-chain verification on read.
- [ ] CSP enforced on admin responses; security-header test.

## 5. SEO templates

- [ ] Template registry keyed by page kind, replacing hard-coded
      `*_TITLE`/`*_DESCRIPTION` constants; variable set closed and documented.
- [ ] Renderer escapes values, rejects unknown variables and raw HTML, keeps
      defaults when a template is absent.
- [ ] `admin-seo.json` (0600, atomic), audit before/after; admin page lists
      variables per kind and shows a live preview.
- [ ] Tests: unknown variable rejected, HTML in a template is escaped, defaults
      unchanged when the file is missing, title/description length warnings.
- [ ] Verify canonical/og/JSON-LD still derive from the same values.

## 6. Redirects

- [ ] `admin-redirects.json` with `{from, to, status}`, 301/302 only.
- [ ] Validation: internal `from`, internal or allowlisted `to`, no loops, target
      exists; applied in `redirect_target` before static/SEO routes.
- [ ] Admin CRUD with audit; tests for open-redirect rejection and loop rejection.

## 7. External link health

- [ ] Crawl first-party HTML for external `href`s, deduplicate, cap 1000.
- [ ] Checker: HEAD with GET fallback, 10 s timeout, concurrency 4, per-host rate
      limit, robots.txt respected for GET.
- [ ] SSRF guard: resolve the host and reject RFC1918, loopback and link-local
      targets before any request.
- [ ] `admin-links.json` report; daily job and a "run now" action; admin panel
      lists failures with status and error.
- [ ] Tests: SSRF rejection, timeout handling, report persistence.
