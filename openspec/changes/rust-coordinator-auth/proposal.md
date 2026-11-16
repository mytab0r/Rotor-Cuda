# Coordinator: client auth, completion challenges, deploy package

## Goal

Stop unauthenticated or trivial forged progress: per-client tokens, lease-bound
nonces, sampled completion checks, per-token rate limits; plus a deployable
package (systemd/TLS/Linux binary) for a real server.

## Why

Today one shared bearer token is enough to POST `done=true` for any leased chunk
without scanning it. The user wants clients unable to "just send" completion, and
a server deployment with bounded state.

## Scope

- Per-client credentials: `--clients FILE` maps `client_id -> sha256(token)`.
  Admin `--token` (or `ROTOR_COORD_TOKEN`) remains for job/status/dashboard;
  leases/heartbeats/results require a client token, and the server takes the
  client id from the token, not from the request body.
  Without `--clients`, the legacy single-token mode still works with a loud
  startup warning (tests and small setups).
- Lease binding: the lease response carries `lease_id` and K=16 random offsets
  inside the chunk. Heartbeat/result must echo `lease_id`; a stale/foreign
  nonce is rejected (409).
- Completion challenge: `done=true` must include K `samples` = hash160 (or
  32-byte X for xpoints, 20-byte ETH address) of the keys at the lease offsets.
  The server independently derives each key (`k*G`), hashes it, compares bytes;
  a missing/wrong sample rejects the completion (400) and the chunk stays leased.
  BSGS jobs are exempt (offsets are giant-table indices); completion there is
  protected by the lease nonce only — documented.
- Rate limit per client token (20 req/s, burst 40) → 429.
- HTTPS clients: replace the hand-rolled plain-HTTP transport in
  `CoordinatorClient` with `ureq` + `native-tls`, so clients can talk to the
  public coordinator without an SSH tunnel; plain HTTP stays supported for
  localhost tests.
- Deploy package: `deploy/rotor-coord.service`, env template, Caddy/nginx TLS
  example, state dir notes; a Linux `rotor-coord` asset in the release workflow.

## Out of scope

- True proof of full chunk coverage (impossible for brute-force without massive
  overhead); samples raise the bar and block casual forgery.
- Accounts/billing/multi-tenant quotas; HTTPS termination inside the binary.

## Acceptance

- Unknown/missing client token → 401; admin token can manage jobs but not lease.
- `done` without samples or with wrong samples → 400, chunk not marked done.
- Correct samples → 200 and the chunk is marked done exactly once.
- Reused/stale `lease_id` → 409; rate limit → 429.
- Legacy mode (no `--clients`) still passes the existing tests with the warning.
- Local persistence test: a state with many chunks survives restart and stays
  < 400 KiB (shared with the storage change).
- Deploy files exist and the binary runs with a state directory; a Linux build is
  produced by CI on tags.
