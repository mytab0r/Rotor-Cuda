# Coordinator accounts, per-user stats and personal cabinet

## Goal

Make the coordinator multi-user friendly: individual client tokens (from the
auth change) become lightweight accounts with personalized statistics, a
personal cabinet page, and shared global stats on the dashboard.

## Why

The dashboard currently shows only aggregate job/client tables. Users want to
see their own contribution (scanned keys, chunks, results, rate history) next to
the global picture, and operators want to issue/revoke access per user.

## Scope

- Client records: `id`, `name`, `token_hash`, `created_at`, `disabled`,
  `scanned_total`, `chunks_done`, `found`, `last_seen`, `rate`, and a bounded
  history ring (last 240 heartbeats: timestamp, scanned, rate).
- Stats update on heartbeat, chunk completion and accepted results; aggregates
  are persisted in the state file.
- Admin API (admin token): `GET /api/v1/clients` (list with stats),
  `POST /api/v1/clients` (create, returns the token once), `POST
  /api/v1/clients/{id}/disable`; the clients file is replaced by state-managed
  clients (migration: an existing `--clients` file is imported on first start).
- Personal API: `GET /api/v1/me` (client token) → own stats, history, leases,
  results, current job progress.
- Dashboard: global stats header (total scanned, active clients, results, jobs),
  clients table with per-user columns, and a cabinet page `web/me.html` with a
  token login, personal cards, a scanned-over-time sparkline and recent results.
- Test with 3 clients on short jobs: totals, per-user stats and each cabinet are
  correct; disabling a client rejects its token.

## Out of scope

- Passwords/registration/OAuth, payments, multi-tenant quotas.
- Public anonymous access; the operator still issues tokens.

## Acceptance

- `cargo test` covers stats aggregation, client creation/disable, `/me`
  authorization, history bounds and the status payload.
- Manual: three clients with different tokens scan a small job; global and
  personal pages show the expected numbers; disabled tokens get 401.
- No protocol break for existing clients; the admin dashboard keeps working.
