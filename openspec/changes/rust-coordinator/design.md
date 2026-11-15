# Design: coordinator and dashboard

## D1. One crate, second binary

Add `[[bin]] rotor-coord` to the existing package; reuse `field/point/secp` for
proof checks. No new crate/workspace.

## D2. HTTP stack: `tiny_http` + `serde_json`

Pure Rust, no async runtime and no C dependencies (the local GNU build has no
`sccache`/`cc`). A coordinator serves a handful of clients; one thread per
request is enough. TLS is terminated by a reverse proxy; the coordinator binds
`127.0.0.1:7878` by default and prints a warning when told to bind elsewhere.

## D3. State: one JSON file, atomic rewrite

`coordinator.json` holds `jobs`, `chunks`, `leases`, `results`, `bsgs_state`.
All mutations happen under one `Mutex<State>`; every mutation rewrites the file
via `tmp + rename`. Restart reloads it. A database is unnecessary at this scale
and would add a C dependency (rusqlite).

## D4. Chunks and leases

- A job has `[start,end]`, a chunk width (default `0x10000000`) and a lease TTL
  (default 600 s).
- Lease: pick the first chunk not `done` and not leased (or whose lease
  expired), mark it leased to `client_id` with `expires_at`.
- Heartbeat: `client_id`, `scanned`, `rate`; refreshes the lease.
- Result: `client_id`, `key`, `pubkey` — the coordinator verifies
  `key*G == job.target` (pubkey jobs) or derives and compares the address/hash
  (other modes) before recording; invalid proofs are rejected 400.
- When all chunks are done or found, `lease` returns 204.

## D5. Client loop

`engine::run` gains a chunk source: `Local` (current split) or `Coordinator`.
A coordinator worker asks for one lease at a time, scans it with the existing
batch machinery, reports scanned counts every 5 s, and re-leases. Ctrl-C sends a
final heartbeat; the lease simply expires otherwise. `Found.txt` output is
unchanged; the result is also POSTed.

## D6. BSGS state

A BSGS client posts `{job_id, manifest, giant_index}`; the coordinator stores it
and returns it to a client that has no compatible local checkpoint. Manifest
compatibility is checked with the existing `TableManifest::compatible`, so a
client only resumes a table it can reproduce.

## D7. Dashboard

One static `web/index.html` (+ inline JS/CSS) embedded with `include_str!`.
It polls `GET /api/v1/status` every 2 s: job selector, progress bar, per-client
scanned/rate/lease, results, and a form to create a job (token kept in
`localStorage`). No build step, no frontend dependencies.

## D8. Auth

`Authorization: Bearer <token>`; token from `--token` or `ROTOR_COORD_TOKEN`.
Comparison is constant-time over the byte strings. Missing/wrong token → 401.
