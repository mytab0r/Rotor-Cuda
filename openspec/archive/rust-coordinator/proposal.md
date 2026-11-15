# Distributed coordinator and dashboard

## Goal

Let several machines work one puzzle range without manual range splitting:
a small coordinator leases disjoint key chunks, stores progress remotely, and
serves a web dashboard for setup and live monitoring.

## Why

Ranges like puzzle #71 are too large for one box; Kangaroo already ships
`-s`/`-c` server/client and work files, and dashboard-style tools (secretscan)
make multi-machine runs observable. Today our Rust port only splits a range
across local threads and checkpoints locally.

## Scope (phase 1–3)

- `rotor-coord` binary (same crate, second `[[bin]]`): token-protected HTTP/JSON
  API on `127.0.0.1:7878` by default; state in one atomically-written JSON file
  (no database dependency).
- Jobs: target (pubkey / address / xpoint / `.bin` set), range, mode, coin;
  create/list/status.
- Leases: coordinator hands each client a disjoint `[start,end]` chunk with a
  TTL; expired leases return to the pool; results carry the client id.
- Client: `--coordinator URL --token TOKEN`; the engine leases chunks instead of
  splitting locally, reports scanned counts/heartbeat, retries expired leases,
  and posts a found result with a `k*G == target` proof.
- Remote state: BSGS work files (table identity + giant index) can be stored on
  the coordinator and restored by another client.
- Dashboard: static HTML/JS served by the coordinator (no build step): job form,
  chunk/lease table, per-client rates, found results, SSE or 2 s polling.

## Out of scope

- Accounts, payments, public multi-tenant hosting, TLS termination (reverse
  proxy), multi-chain targets, automatic release tagging.
- Multi-GPU scheduling and GPU `-r`/`-n` (unchanged deferrals).

## Acceptance

- Two client processes lease different chunks of one job and both progress; a
  killed client's chunk is re-leased after TTL.
- Restarting the coordinator keeps jobs, leases and results (JSON state).
- BSGS progress survives a client restart via the coordinator: the client
  deterministically rebuilds the baby table, checks `TableManifest::compatible`,
  and continues the giant walk from the saved `giant_index` without repeating
  completed steps.
- A found key is accepted only with a valid `k*G == target` proof and is shown
  on the dashboard and written to the client's `Found.txt`.
- `cargo test` covers lease allocation/exhaustion/TTL, state reload, auth
  rejection, and the client's chunk loop against an in-process server.
