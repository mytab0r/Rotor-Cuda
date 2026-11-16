# Tasks: coordinator and dashboard

## 1. Core state  (blocked by: —)
- [x] `src/coordinator/state.rs`: jobs, chunks, leases, results, BSGS state;
      atomic JSON load/save; `lease(client, now)`, `heartbeat`, `submit_result`
      with proof verification, TTL expiry, `status()` snapshot.
- [x] Unit tests: disjoint allocation, exhaustion, TTL re-lease, reload from
      disk, invalid proof rejected, BSGS manifest mismatch rejected.

## 2. HTTP API  (blocked by: 1)
- [x] `src/coordinator/mod.rs`: `tiny_http` server, token auth (401), routes
      `/api/v1/jobs` (POST/GET), `/lease`, `/heartbeat`, `/result`,
      `/status`, `/bsgs/state` (GET/POST), `/` dashboard.
- [x] Integration tests on `127.0.0.1:0`: auth rejection, job create, two
      disjoint leases, heartbeat, result with valid/invalid proof.

## 3. Client  (blocked by: 2)
- [x] `--coordinator URL --token` in CLI; `ChunkSource::Coordinator` in the
      engine (CPU address plus BSGS giant-range loop); heartbeat every 5 s;
      re-lease on completion/TTL; POST result alongside `Found.txt`.
- [x] `--client-id` (default hostname+pid).
- [x] Tests against an in-process coordinator: one client consumes chunks and
      reports found; a stopped client's chunk is re-leased.

## 4. BSGS remote state  (blocked by: 2)
- [x] Post/restore `{manifest, giant_index}`; verify `TableManifest::compatible`;
      resume the giant walk from the stored index after `TableManifest::compatible`
      accepts the deterministically rebuilt baby table.
- [x] Test: two clients, one posts state, the other resumes and finds the key.

## 5. Dashboard  (blocked by: 2)
- [x] `web/index.html` embedded: job form, progress, client/lease table,
      results, 2 s polling; `--token` stored in localStorage.
- [x] Snapshot test of the status JSON shape. Manual browser check not run:
      only the served HTML was verified over HTTP.

## 6. Docs and close-out
- [x] README: coordinator quick start (one job, two clients), security notes
      (token, localhost, reverse proxy), limitations.
- [x] `cargo test`/clippy/fmt green; archive the change.
