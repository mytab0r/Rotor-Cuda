# Tasks: accounts, stats, cabinet

## 1. Client records and stats  (blocked by: auth change)
- [ ] `ClientRecord` + `State.clients`; import `--clients` once; create/disable;
      stats on heartbeat/done/result with no double counting; history ring.
- [ ] Tests: aggregation, bounds, disable, import.

## 2. API  (blocked by: 1)
- [ ] `/api/v1/clients` (admin list/create/disable), `/api/v1/me`, status totals;
      disabled tokens rejected.
- [ ] Tests: auth matrix, `/me` scope, totals.

## 3. Cabinet UI  (blocked by: 2)
- [ ] `web/me.html` embedded at `/me`: token login, cards, sparkline, lease,
      results; main dashboard global cards + clients table + link.
- [ ] Tests: page served, required ids/links present.

## 4. Multi-user verification and close-out
- [ ] Run three clients with distinct tokens on small jobs; record evidence;
      fmt/clippy/test; README; archive; PR.
