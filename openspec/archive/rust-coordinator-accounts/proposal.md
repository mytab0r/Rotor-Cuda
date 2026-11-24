# Public site, accounts, per-user stats and cabinet

## Goal

Turn the coordinator dashboard into a proper public resource like
ref-site-b: a landing page, an app section with live global stats, a
leaderboard, self-service registration (admin-issued tokens or open signup), and
a personal cabinet with each user's contribution.

## Why

The current page is an operator console. To let many people contribute to
puzzle solving, users need their own identity, their own stats and a clear entry
point; the operator needs aggregated global information and user management.

## Scope

- Static site served by the coordinator (no build step, embedded files):
  - `/` landing: what it is, how it works, live global counters, join CTA,
    links to app/docs/cabinet.
  - `/app` the existing dashboard: jobs, active clients, results, leaderboard,
    global stats.
  - `/me` personal cabinet: token login, personal scanned/chunks/found/rate,
    history sparkline, current lease, recent results, leaderboard rank.
  - `/docs` short FAQ: registration, running a client (CPU/GPU/coordinator),
    security notes, puzzle-only disclaimer.
  - Shared `site.css`/`site.js`; responsive layout.
- Accounts:
  - `ClientRecord` (id, name, token hash, created_at, disabled, stats, bounded
    history).
  - Admin API: list/create/disable clients; `POST /api/v1/register` for
    self-service when `--open-registration` is set (rate-limited, returns the
    token once); disabled clients get 401.
  - Stats update on heartbeat/completion/result without double counting.
- API: `GET /api/v1/me`, `GET /api/v1/clients` (admin), status adds global
  totals and a leaderboard; existing fields stay.
- Multi-user verification: three clients with distinct tokens, global and
  personal numbers, leaderboard order, disabled token rejected.

## Out of scope

- Passwords/OAuth/email verification, payments, invite-only quotas.
- Mobile/browser compute clients (separate change).

## Acceptance

- Pages render at `/`, `/app`, `/me`, `/docs`; navigation works; the landing
  shows live totals.
- Registration (when enabled) returns a token that can immediately lease; the
  cabinet shows that user's stats; disabling it rejects the token.
- `cargo test` covers stats, register, `/me` scoping, leaderboard, disabled
  tokens, page availability; manual 3-user run recorded.
