# Browser (WASM) puzzle-search client

## Summary

Add a volunteer client that runs the existing secp256k1 key search in
WebAssembly inside a Web Worker, leases disjoint chunks from `rotor-coord` over
the current JSON API, heartbeats every ~5 s, and submits the same 16 challenge
samples and found key as the native client. The coordinator already embeds and
serves the site from a single binary; the same mechanism will carry the page,
the worker JS and the `.wasm` artifact.

## Problem / motivation

- Mass participation from phones and browsers is a stated product goal. Today a
  contributor must build or download a native binary and pass `--coordinator` /
  `--token` on the command line (`README.md:172-187`); there is no in-browser
  worker.
- The coordinator already serves a public site and a token-protected lease
  protocol: static assets are embedded with `include_str!`
  (`src/coordinator/mod.rs:30-36`, routes at `:482-491`), and lease results
  carry `lease_id` plus 16 `challenge_offsets`
  (`src/coordinator/state.rs:35-36`, `:362-372`, `:822-830`). No new wire
  protocol is required for a client.
- All scan primitives needed by a browser client are already pure Rust with no
  OS dependencies: `field`, `scalar`, `point`, `secp`, `hashes`, `base58`, and
  the membership parts of `filter` (`src/field.rs:9`, `src/scalar.rs:10`,
  `src/point.rs:6`, `src/secp.rs:3-6`, `src/filter.rs:200-251`).

## Scope

In:

- A new workspace member `crates/rotor-wasm` (cdylib, no new external
  dependencies) that reuses the existing crypto modules and exposes a minimal
  pointer+length ABI to JS.
- `web/rotor-worker.js`: a Web Worker that fetches jobs, leases a chunk, drives
  the wasm scan in bounded batches, refreshes the lease every ~5 s, sends the
  completion heartbeat only after the full chunk is scanned, and submits a found
  key.
- `web/run.html` plus asset routes for `/run`, `/rotor-worker.js` and
  `/rotor_wasm.wasm`; the artifact is embedded with `include_bytes!`.
- A repeatable wasm build (`cargo build -p rotor-wasm --target
  wasm32-unknown-unknown --release` followed by copying the artifact into
  `web/`) wired into CI and the Docker image.
- Correctness parity with the native client for scan ranges, target matching,
  challenge samples and fixed-width key/address encodings.
- A measured-rate UI, pause on tab hide, and re-lease on expiry.

Out:

- BSGS in the browser (giant-table memory and a different lease/proof model).
- Multi-target jobs above the v1 cap (50,000 target records), or a new
  paginated targets endpoint. V1 reads targets from `GET /api/v1/jobs`, which already exposes
  `target` / `targets` (`src/coordinator/state.rs:1253-1276`).
- Multiple wasm workers per tab, SIMD, `SharedArrayBuffer`, COOP/COEP headers.
- Local checkpoint/resume files. Resume is coordinator-side: done bitmap and
  scanned watermarks live in the state file
  (`src/coordinator/state.rs:897-921`).
- TLS termination or CORS. The page is same-origin and served behind the
  operator's reverse proxy; the coordinator itself has no TLS
  (`src/bin/rotor-coord.rs:5-6`, `:102-105`).
- Wallet sweeping or any target the operator has not explicitly created as a
  job. The client only scans jobs it can lease.

## Impacted domains

- New domain: `browser-client` (wasm crate, worker, page, build).
- `coordinator`: static asset serving and build packaging only; no API change.
- `search`: parity requirements for scan/sample semantics.

## Acceptance criteria

1. `cargo build -p rotor-wasm --target wasm32-unknown-unknown --release`
   succeeds on a machine with that target installed, and a Node smoke script
   instantiates the artifact, scans a fixed range, reports a positive rate, and
   returns non-empty samples.
2. Host-side parity tests show the wasm scanner produces byte-identical
   challenge samples to `rotor::coordinator::state::challenge_samples`
   (`src/coordinator/state.rs:1541-1567`) for BTC compressed, BTC uncompressed,
   BTC xpoint and ETH address modes, and finds a fixture key.
3. End-to-end against a live coordinator: a job with `chunk_width = 2^20`,
   `lease_ttl = 120` is leased by the browser worker; `/api/v1/status` shows
   `scanned` rising, and `chunks_done` becomes 1 only after the whole window is
   scanned and a `done: true` heartbeat with valid samples is accepted
   (compare `tests/coordinator_api.rs:510-591`).
4. With a mocked clock/fetch, progress heartbeats occur at most every ~5 s and
   never carry `done: true` before the full span; `204`, `401`, `409` and `429`
   are handled without marking the chunk done.
5. The coordinator serves `/run`, `/rotor-worker.js` and `/rotor_wasm.wasm`
   with the correct content types, and the response body for the wasm route is
   the embedded artifact.
6. Hiding the tab stops scanning and does not send a completion; showing it
   either resumes the same lease or discards the cursor and re-leases, never
   reporting a false completion.
7. The token is sent only in the `Authorization` header to relative same-origin
   URLs; it never appears in a URL, log or page text, and the page refuses to
   start in an insecure context unless it is `localhost`.
8. CI builds the wasm target and runs the smoke test; `cargo fmt --check`,
   `cargo clippy --all-targets -- -D warnings`, `cargo test --release` and the
   Docker build still pass.

## Risks / unknowns

- **Portability unverified.** Only `x86_64-pc-windows-gnu` and
  `x86_64-unknown-linux-gnu` are installed locally (`rustup target list
  --installed`, 2026-11-16); no wasm build has been attempted. `xorf` and
  `bs58` are expected to work on wasm but must be proven by CI. `filter::load`
  uses `std::path`/`std::fs` (`src/filter.rs:12`, `:178-197`); the browser will
  only use `from_records`/`contains` (`:200-251`), so this is not a blocker.
- **Dependency build blockers.** `ctrlc`, `tiny_http`, `ureq` (native-tls) and
  `bip39` are unconditional dependencies today (`Cargo.toml:24-35`); they will
  fail or bloat a wasm target. They must move behind
  `cfg(not(target_arch = "wasm32"))`.
- **No browser clock.** `std::time::Instant` is not usable on
  `wasm32-unknown-unknown`; timing must come from JS `performance.now()`.
- **Performance is unknown.** Native CPU is ~1.3 Mk/s per core
  (`README.md:696`). A single-threaded wasm tab is expected to be an order of
  magnitude slower; the UI must show a measured number, not a promise.
- **Default chunk is too wide for tabs.** `DEFAULT_CHUNK_WIDTH = 0x10000000`
  (268 M keys, `src/coordinator/state.rs:27-30`); at browser rates one chunk
  takes tens of minutes. Operators need documented browser-sized jobs.
- **Per-token rate limit.** 20 req/s with burst 40
  (`src/coordinator/mod.rs:42-43`, `:442-445`); roughly 100 tabs heartbeating at
  0.2/s saturate one shared token.
- **Token in `localStorage`.** The existing site stores the bearer token at
  `rotor-coord-token` (`web/site.js:5-22`); any script on the origin can read
  it. The new page must not add injection sinks and should stay same-origin.
- **Multi-target payload.** `GET /api/v1/jobs` returns every target string
  (`src/coordinator/state.rs:1269`); very large sets are heavy for a browser.

## References

- Lease/heartbeat/result API: `src/coordinator/mod.rs:622-749`;
  `src/coordinator/client.rs:96-182`.
- Lease selection, TTL, offsets: `src/coordinator/state.rs:704-831`,
  `:1466-1492`.
- Completion verification and sample forms: `src/coordinator/state.rs:1494-1568`.
- Native scan loop and 5 s heartbeat: `src/engine.rs:570-727`,
  `:1193-1260`; generic chunk loop: `src/coordinator/chunk_loop.rs:68-172`.
- Site/token handling: `web/site.js:5-88`, `web/app.html:88`,
  `web/me.html:29`.
- Existing completion test: `tests/coordinator_api.rs:510-591`.
- Build/CI/Docker: `Cargo.toml:20-35`, `build.rs:43-44`,
  `.github/workflows/rust.yml:22-29`, `Dockerfile:8-11`.
