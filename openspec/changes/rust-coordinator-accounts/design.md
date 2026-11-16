# Design: accounts, stats, cabinet

## D1. Client records

```rust
struct ClientRecord {
    id: String, name: String, token_hash: String, created_at: u64, disabled: bool,
    scanned_total: u64, chunks_done: u64, found: u64, last_seen: u64, rate: f64,
    history: VecDeque<HistoryPoint>, // { at: u64, scanned: u64, rate: f64 } max 240
}
```

Stored in `State.clients`; token hash is SHA-256 hex of the bearer token (the
auth change's map format). `--clients FILE` is imported once when
`State.clients` is empty; afterwards the state is authoritative and the file is
ignored (documented). All mutations under the existing state mutex; atomic save
unchanged.

## D2. Stats updates

- Heartbeat: `scanned_total += scanned_delta` (keep the max seen per lease to
  avoid double counting after retries; the lease holds the last reported
  scanned), `rate = reported`, `last_seen = now`, push a history point (replace
  the last point if < 5 s since the previous one).
- Chunk done: `chunks_done += 1`.
- Accepted result: `found += 1`.
- A lease carries `client_id`; the server resolves the record and rejects a
  disabled client (401) even with a valid token.

## D3. API

- `GET /api/v1/clients` (admin): id, name, created_at, disabled, stats, history.
- `POST /api/v1/clients` (admin): `{name}` → `{id, token}` (token shown once;
  stored hashed).
- `POST /api/v1/clients/{id}/disable` (admin): set the flag; existing leases
  for that client become invalid.
- `GET /api/v1/me` (client): own record, active lease/job progress, results.
- `GET /api/v1/status` (admin or client): adds `totals { scanned, clients_active,
  results, jobs }`; keeps the existing fields.

## D4. Dashboard and cabinet

- `web/index.html`: global stat cards + clients table (name, scanned, chunks,
  found, rate, last seen) + jobs/results as today.
- `web/me.html` (new, embedded): token field (localStorage), cards (scanned,
  chunks, found, rate), an SVG sparkline of the history ring, the current lease
  and recent results; polls `/api/v1/me` every 2 s.
- The cabinet is served at `/me`; the main dashboard links to it.

## D5. Tests

- State: stats aggregation (no double counting), history bound, disable,
  create/import.
- API: `/clients` admin-only; `/me` requires a client token and returns only
  that client; disabled token 401; status totals.
- Dashboard HTML contains the cabinet link and the stat card ids; cabinet page
  parses (basic string assertions).
- Manual multi-user run (3 tokens) documented in the change evidence.
