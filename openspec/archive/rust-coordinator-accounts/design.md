# Design: public site, accounts, stats, cabinet

## D1. Static site served by the coordinator

Files under `web/`, embedded with `include_str!`:
- `landing.html` → `/` (hero, how-it-works, live totals, join CTA, nav)
- `app.html` → `/app` (current dashboard: jobs, clients, results, leaderboard)
- `me.html` → `/me` (personal cabinet, token login)
- `docs.html` → `/docs` (FAQ, client commands, security/disclaimer)
- `site.css`, `site.js` shared (dark theme matching the current dashboard;
  no frameworks, no build step; responsive at 480 px).

`/` no longer serves the dashboard; `/api/*` unchanged. Unknown non-API paths
return the landing page (SPA-ish) or 404 — landing is fine.

## D2. Client records and stats

`State.clients: Vec<ClientRecord>`:
```rust
struct ClientRecord { id, name, token_hash, created_at, disabled,
    scanned_total, chunks_done, found, last_seen, rate,
    history: VecDeque<{at, scanned, rate}> } // max 240 points
```
- Token hash = SHA-256 hex; tokens are 32 random bytes hex, shown once.
- Heartbeat: add the lease scanned delta (per-lease max watermark, no double
  counting), set rate/last_seen, push/replace a history point (≥5 s apart).
- Chunk done: `chunks_done += 1`; accepted result: `found += 1`, `last_seen`.
- Disabled clients: 401 on every authenticated call; their leases invalidated.
- Creation: admin `POST /api/v1/clients {name}`; open registration
  `POST /api/v1/register {name}` when `--open-registration` (rate-limited by
  IP/token bucket, e.g. 1/min per IP, max name length 64, sanitize HTML).
- Import: an existing `--clients FILE` map is imported into `State.clients` on
  first start (names = ids) and the file is then ignored.

## D3. API

- `GET /api/v1/me` (client token): own record, active lease, current job
  progress, recent results, rank.
- `GET /api/v1/clients` (admin): records with stats/history.
- `POST /api/v1/clients` (admin), `POST /api/v1/clients/{id}/disable` (admin).
- `POST /api/v1/register` (public when enabled).
- `GET /api/v1/status` adds `totals {scanned, clients_active, results, jobs}` and
  `leaderboard: [{id, name, scanned, chunks_done, found}]` (top 10); existing
  fields untouched.

## D4. Pages

- Landing: live totals polled every 2 s, "Join" form (if registration open: name
  → token shown once with copy button), links to app/docs/cabinet.
- App: keep current tables; add global stat cards and the leaderboard.
- Cabinet: token field (localStorage), cards (scanned, chunks, found, rate,
  rank), SVG sparkline from history, active lease, recent results; poll `/me`
  every 2 s.
- Docs: registration, `rotor -m addresses ... --coordinator URL --token ...`,
  CPU/GPU/BGS notes, security (tokens are secrets, puzzle-only disclaimer).

## D5. Tests

- State: stats aggregation/no double count, history bound, disable, import,
  registration.
- API: admin/client/register authorization matrix, `/me` scope, leaderboard
  order, totals, disabled token 401, registration rate limit/flag off.
- Pages: `/`, `/app`, `/me`, `/docs` return 200 and contain key ids/links;
  `site.css` served.
- Manual: 3 users, global vs personal numbers, leaderboard, cabinet.
