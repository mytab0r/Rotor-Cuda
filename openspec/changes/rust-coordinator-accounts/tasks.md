# Tasks: public site, accounts, stats, cabinet

## 1. Client records and stats  (blocked by: auth change)
- [x] `ClientRecord`/`State.clients`, import from `--clients`, create/disable,
      registration tokens; stats on heartbeat/done/result without double counting,
      bounded history.
- [x] Tests: aggregation, bounds, disable, import, registration.

## 2. API  (blocked by: 1)
- [x] `/api/v1/clients` (admin), `/me` (client), `/register` (open flag,
      rate-limited), status totals + leaderboard; disabled tokens rejected.
- [x] Tests: auth matrix, `/me`, leaderboard order, totals, register limits.

## 3. Site  (blocked by: 2)
- [x] `web/landing.html`, `app.html`, `me.html`, `docs.html`, `site.css`,
      `site.js`; routes `/`, `/app`, `/me`, `/docs`; responsive dark theme.
- [x] Landing live totals + join form; app stat cards + leaderboard; cabinet
      cards/sparkline/lease/results/docs; tests for page availability/ids.

## 4. Verification and close-out
- [x] `cargo fmt --all`, `cargo clippy --all-targets -- -D warnings`, `cargo test`
      (host suites green).
- [x] Manual 3-user run (global vs personal, leaderboard, disabled token);
      README/deploy updated.
- [ ] Archive and PR (left to the orchestrator; no commit requested here).
