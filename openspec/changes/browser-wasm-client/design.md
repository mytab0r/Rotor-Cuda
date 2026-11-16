# Design: browser (WASM) puzzle-search client

## D1. Architecture

```
web/run.html (main thread)
  |  token from localStorage (site.js:5-22), UI, measured rate
  v postMessage {token, start/stop}
web/rotor-worker.js (Web Worker)
  |  fetch /api/v1/jobs, /lease, /heartbeat, /result (same origin)
  v ptr+len ABI
rotor_wasm.wasm (crates/rotor-wasm, cdylib)
  field + scalar + point + secp + hashes + base58 + filter::TargetSet
  scan(start..end), challenge_samples(offsets), found key
```

The worker owns the whole protocol loop so a slow scan never blocks the page.
The main thread owns `localStorage` and the UI only; it passes the token to the
worker once and never writes it to the DOM.

Components:

- `crates/rotor-wasm`: new workspace member, `crate-type = ["cdylib"]`,
  `[dependencies] rotor = { path = "../..", default-features = false }`.
  Neither wasm-bindgen nor any other new crate is added.
- `web/rotor-worker.js`: protocol state machine and wasm glue.
- `web/run.html` + `/run` route: contributor page (nav link added next to
  `/app` and `/me`, cf. `web/app.html:13-17`).
- Coordinator: one `include_bytes!` asset and two `include_str!` assets, plus a
  `static_asset` signature change (D5).

## D2. Which modules compile for `wasm32-unknown-unknown`

Verified by reading the sources (no wasm toolchain is installed locally, so the
build claim is unproven until CI runs it):

| Module | Reusable as-is | Evidence |
|---|---|---|
| `field.rs` | yes | only `std::fmt::Write` (`src/field.rs:9`), pure limb arithmetic |
| `scalar.rs` | yes | only `std::fmt::Write` (`src/scalar.rs:10`) |
| `point.rs` | yes | imports `field` only (`src/point.rs:6`); `batch_to_affine` public at `:127` |
| `secp.rs` | yes | `field`/`hashes`/`point`/`scalar` only (`src/secp.rs:3-6`); `mul_g` `:45`, `hash160` `:149`, `eth_address` `:158` |
| `hashes.rs` | yes | sha2/ripemd/sha3 only, no `std` (`src/hashes.rs:3-5`) |
| `base58.rs` | yes | `bs58` + `sha256d` + `Scalar` (`src/base58.rs:3-4`); `decode_check` `:12` |
| `filter.rs` | parts | `from_records`/`contains` are pure (`src/filter.rs:200-251`); `load` uses `std::path`/`std::fs` (`:12`, `:178-197`) and will not be called |
| `engine.rs` | no | `std::fs`, `std::thread`, `ctrlc` (`src/engine.rs:16-21`, `:49`, `:100`, `:508`) |
| `coordinator/*` | no | `tiny_http`, `std::net`, `ureq`, state file (`src/coordinator/mod.rs:14-18`, `state.rs:10`) |
| `mnemonic.rs` | no | `bip39`, `std::io`, `std::fs` (`src/mnemonic.rs:13-17`, `:392`) |
| `bsgs*`, `checkpoint`, `cli`, `benchmark`, `selfupdate`, `gpu*`, `targets_text` | no | not needed; several pull files/threads/CUDA |

`build.rs` is not a blocker: it returns immediately without the `gpu` feature
(`build.rs:43-44`), so a wasm build never invokes `nvcc`. The `gpu` feature is
not enabled for the wasm crate.

Gating plan:

- `src/lib.rs`: add `#[cfg(not(target_arch = "wasm32"))]` to every module the
  browser does not need (`benchmark`, `bsgs`, `bsgs_workfile`, `checkpoint`,
  `cli`, `coordinator`, `engine`, `mnemonic`, `selfcheck`, `selfupdate`,
  `targets_text`; keep the `gpu*` gating). This also removes `state.rs`'s import
  of `engine::{SplitMix64, thread_seed}` (`src/coordinator/state.rs:20`) from
  the wasm build.
- `Cargo.toml`: move `ctrlc`, `tiny_http`, `ureq` and `bip39` under
  `[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`
  (`Cargo.toml:24-35`). Cargo compiles unconditional dependencies even when the
  modules using them are cfg'd out, so this move is mandatory.
- Keep `sha2`, `ripemd`, `sha3`, `bs58`, `serde`, `serde_json`, `xorf`
  universal. `serde_json` is not needed by the wasm crate itself, but stays for
  the native lib.
- Bins are not part of the wasm build: CI uses `cargo build -p rotor-wasm
  --target wasm32-unknown-unknown --release`.

Why `cfg(target_arch)` plus a separate crate, not a Cargo feature:

- A feature would have to be threaded through every build command and could be
  combined accidentally with `gpu`; the target triple is already the exact
  discriminator.
- The separate cdylib keeps the export surface and `crate-type` out of the
  native library and gives host-side tests a normal `rlib` target.

Residual portability risk: `xorf::BinaryFuse8` (used by `TargetSet`,
`src/filter.rs:228`) and `bs58` must compile for wasm; CI proves it. If `xorf`
fails, the fallback is a local open-addressing set behind the same
`TargetSet` API, not a protocol change.

## D3. WASM boundary

Hand-written `extern "C"` exports plus the default exported `memory`; no
wasm-bindgen, no `web-sys`, no JS imports. Strings are UTF-8 pointer+length
pairs, never NUL-terminated, so no C-string ABI is involved. In edition 2024
exports need `#[unsafe(no_mangle)]`. The shell build script passes
`RUSTFLAGS=-C panic=abort` for the wasm command so the artifact has no unwinding
imports; the native profile is untouched.

Export surface (names indicative):

| Export | Purpose |
|---|---|
| `alloc(len) -> ptr`, `dealloc(ptr, len)` | JS uploads mode/coin/comp/targets/hex strings |
| `init(mode_ptr, mode_len, coin_ptr, coin_len, comp_ptr, comp_len, targets_ptr, targets_len) -> i32` | Parse config and build the target matcher; newline-separated targets |
| `begin(start_hex_ptr, start_len) -> i32` | Reset the cursor to a leased chunk start |
| `scan(max_keys: u32) -> u32` | Scan at most `max_keys`, advance the internal cursor; returns keys scanned now |
| `scanned() -> u64` | Cumulative keys scanned in the current chunk (watermark sent to the coordinator) |
| `found(ptr, cap) -> i32` | Write the found key as 64 lowercase hex chars; 0 when none |
| `samples(offsets_ptr, count, out_ptr, out_cap) -> i32` | Write `count` fixed-stride samples; `sample_len()` gives the stride |
| `last_error(ptr, cap) -> i32` | Copy the last error string |

The wasm exports that return `u64` surface in JS as `BigInt`; the glue converts
them where a Number is safe (chunk spans are far below 2^53 when browser jobs
follow the sizing guidance). Keep browser job `chunk_width` below 2^32, both for
exact Number arithmetic and because challenge offsets are `u32` (`src/coordinator/state.rs:1466-1490`).

`init` maps the coordinator target forms:

- `address`/BTC: `base58::decode_check` and the 21-byte `0x00` payload
  (`src/base58.rs:12-25`; same check as `src/engine.rs:880-894`).
- `address`/ETH: 20 bytes from 40 hex (`src/engine.rs:896-908`).
- `xpoint`: 32-byte big-endian X (`src/engine.rs:910-918`).
- `addresses`: 40-hex hash160 records; `xpoints`: 64-hex records. The server
  already normalizes both (`src/coordinator/state.rs:1787-1791`,
  `:1807-1810`), so the worker passes `job.targets` verbatim.
- `TargetSet::from_records(records, record_len)` (`src/filter.rs:200-213`)
  supplies `contains` (`:244-251`). V1 accepts at most 50,000 records;
  larger jobs are skipped with an explicit message.

The scanned range is inclusive `[start, end]`, exactly like the native client
(`src/engine.rs:620-635`, `:1200-1260`). JS owns the span arithmetic with
`BigInt` (`end - start + 1n`). This client accepts only chunk widths below
2^32 (challenge offsets are `u32`, `src/coordinator/state.rs:1466-1490`), so
the span is also exact as a Number when it is passed as the batch limit.
`scan` never needs to compute a 256-bit range length.

Scan semantics copied from `scan_batch` (`src/engine.rs:1200-1260`):

- Chain Jacobian points with `add_affine(G)` and one `batch_to_affine` per
  batch (`src/point.rs:75`, `:127`); batch size 2048 as in `BATCH_SIZE`
  (`src/engine.rs:34-35`).
- Skip the point at infinity (key 0) but still count it as scanned
  (`src/engine.rs:1219-1222`).
- Xpoint mode compares `point.x.to_bytes_be()`; address modes compare
  `secp::hash160(point, compressed)` or `secp::eth_address(point)`
  (`src/engine.rs:1225-1250`, `src/secp.rs:149-166`). The compression flags are
  `[true]` for compressed, `[false]` for uncompressed, `[true, false]` for
  `both`, and always `[false]` for ETH (`src/coordinator/state.rs:1889-1898`,
  `src/engine.rs:441-449`).
- `begin` must special-case a zero start with `Jacobian::infinity()`, because
  `secp::mul_g` panics on zero (`src/secp.rs:39-57`; the native helper does the
  same at `src/engine.rs:1329-1335`).

Challenge samples mirror `challenge_samples` (`src/coordinator/state.rs:1541-1567`):
for each `u32` offset, `point = secp::mul_g(start.add_u64(offset))`, then X
bytes, ETH address, or hash160. For `comp_mode = "both"` send the compressed
form; the server accepts either (`src/coordinator/state.rs:1522-1532`,
`:1558-1561`).

No clock in wasm: `Instant`/`SystemTime` are avoided entirely; the worker
passes elapsed time and computes the rate. The wasm crate keeps no timers and
no threads.

## D4. Threading and lifecycle model

- One Web Worker, one wasm instance, one leased chunk at a time (mirrors the
  GPU `ChunkScanner` contract in `src/coordinator/chunk_loop.rs:31-41`).
  Multiple tabs are multiple independent clients; multiple workers per tab are a
  later change.
- The worker runs a loop of `scan(BATCH)` calls. Between calls it drains
  `postMessage` commands (pause/resume/stop) and checks the heartbeat deadline.
  Bounded calls are what keep the worker responsive; a 2048-key batch is
  milliseconds even on a phone.
- Heartbeat policy: cumulative `scanned` and
  `rate = scanned / elapsed` (same formula as `src/engine.rs:642-647`);
  progress every 5 s, completion only after `scanned == span`
  (`src/engine.rs:690-721`). A heartbeat error is resolved like the native
  client: 409/lease lost and job still active -> discard the chunk and re-lease
  (`src/engine.rs:661-666`, `src/coordinator/chunk_loop.rs:174-202`); job
  found/done -> stop; transient network error -> bounded backoff, then
  re-lease.
- On `POST /api/v1/result` acceptance the job closes and its leases are dropped
  server-side (`src/coordinator/state.rs:927-959`, `:984-1010`), so the worker
  stops without sending a `done` heartbeat (the native path does the same,
  `src/engine.rs:690-725`).
- Hidden tab: `visibilitychange -> paused` stops scanning and sends one
  progress heartbeat (`done: false`). On `visible`, send a progress heartbeat:
  200 -> resume from the in-memory cursor; 409 -> discard the cursor and lease a
  new chunk. No completion is sent while paused. Full reload is always a new
  lease; the old lease is not resumable through the client because
  `GET /api/v1/me` exposes no `lease_id` or offsets
  (`src/coordinator/state.rs:334-341`, `:1094-1107`), and the chunk stays
  reserved until TTL (`:751-758`).
- Resume across reloads is coordinator-side: the done bitmap and scanned
  watermark are persisted (`src/coordinator/state.rs:897-921`); the browser
  keeps no files, IndexedDB or checkpoints.

## D5. Asset serving and build

The coordinator currently embeds six text assets with `include_str!` and serves
them through `static_asset(&str) -> Option<(&'static str, &'static str)>`
(`src/coordinator/mod.rs:30-36`, `:481-491`); the dispatcher writes them with
`Response::from_string` before the auth check (`:397-411`). Changes:

- Add `const ROTOR_WASM: &[u8] = include_bytes!("../../web/rotor_wasm.wasm");`
  and `const RUN_PAGE: &str = include_str!("../../web/run.html");`,
  `const ROTOR_WORKER: &str = include_str!("../../web/rotor-worker.js");`.
- Change the asset type to carry a byte slice (for example
  `enum Asset { Text(&'static str), Bytes(&'static [u8]) }` and a content type),
  or return a `Vec<u8>`; serve the wasm with
  `Content-Type: application/wasm` and the worker with
  `application/javascript; charset=utf-8`. The binary stays a single file, as
  intended by the existing comment at `src/coordinator/mod.rs:30`.
- Add routes `/run`, `/rotor-worker.js`, `/rotor_wasm.wasm` next to
  `/site.css` and `/site.js` (`:483-490`). `/run` is a normal HTML asset, so it
  is served without auth like the other pages.

Build step (not in `build.rs`: invoking Cargo from a build script is recursive
and fragile; `build.rs` also correctly no-ops without the `gpu` feature,
`build.rs:43-44`):

- `scripts/build-wasm.sh` (and a `.ps1` twin if Windows dev is required): check
  `rustup target list --installed`, run
  `cargo build -p rotor-wasm --target wasm32-unknown-unknown --release`, copy
  `target/wasm32-unknown-unknown/release/rotor_wasm.wasm` to
  `web/rotor_wasm.wasm`, and fail loudly on a missing or suspiciously small
  artifact.
- Commit `web/rotor_wasm.wasm` so an ordinary `cargo build --release` and the
  existing Dockerfile work without a wasm toolchain. CI rebuilds it and runs
  the smoke test, so a stale committed artifact fails the build rather than
  silently shipping.
- CI: add a wasm job (or steps to `rust.yml`) with
  `rustup target add wasm32-unknown-unknown`, the build script, and
  `node web/wasm-smoke.mjs`. The existing steps at
  `.github/workflows/rust.yml:22-29` already cover fmt/clippy/test/build; the
  wasm job runs before the packaging build so `include_bytes!` finds the file.
- Docker: `Dockerfile:8-10` copies `Cargo.toml`, `build.rs`, `src` and `web`.
  Add `COPY crates ./crates`, run the wasm target/build/copy before the
  `cargo build --release --bin rotor-coord` step at `Dockerfile:11`. The final
  image still contains only the coordinator binary and its embedded assets.

Workspace: add `[workspace] members = ["crates/rotor-wasm"]` to the root
manifest (root package remains the implicit member). `cargo test --release`
then also runs the wasm crate's host-side parity tests.

## D6. Protocol correctness

The worker uses the same JSON shapes as `CoordinatorClient`
(`src/coordinator/client.rs:96-182`) and the same endpoints as the handlers in
`src/coordinator/mod.rs:452-479`:

1. `GET /api/v1/jobs` with `Authorization: Bearer <client token>`; choose a
   non-found, non-done job whose `mode`/`coin` are supported. If several are
   eligible, the page lists them and the user picks one; the default is the
   first running job. (The endpoint is readable by any authenticated identity,
   `src/coordinator/mod.rs:215-217`.) `JobView` carries
   `target`, `targets`, `mode`, `coin`, `comp_mode`, `start`, `end`,
   `chunk_width`, `chunks_total` (`src/coordinator/state.rs:309-330`,
   `:1253-1276`).
2. `POST /api/v1/lease` with the chosen job's own
   `{mode, coin, start, end}` (the server matches a job by exact canonical
   range, `src/coordinator/state.rs:716-721`, `:732-748`) and `target` for
   `address`/`xpoint` only. Comp mode is not part of the lease request; the
   client takes it from the job view. Every body also carries a per-tab
   `client_id` such as `web-<random>`, exactly like the native client
   (`src/coordinator/client.rs:106`, `:145`, `:170`): with a client bearer
   token the server overrides it from the token (`src/coordinator/mod.rs:637-641`),
   but with the admin token in legacy mode the lease body MUST contain it
   (`src/coordinator/state.rs:705-708`; `effective_client_id`,
   `src/coordinator/mod.rs:751-758`). The target is optional for multi-target
   modes (`src/coordinator/state.rs:718-746`).
   - 200: `{job_id, chunk_index, start, end, expires_at, lease_id,
     challenge_offsets[16]}` (`src/coordinator/state.rs:362-372`).
   - 204: no free chunk, or the job just became found/done. Re-check
     `GET /api/v1/jobs`: stop if the job is finished, otherwise show "all
     chunks leased" and retry after ~2 s (`RETRY_DELAY`,
     `src/coordinator/chunk_loop.rs:57-58`, `:89-95`).
   - 404: no matching job; tell the operator to create one
     (`src/coordinator/mod.rs:647-649`).
3. `wasm.init(...)` with the job's target data, then `wasm.begin(lease.start)`.
4. Loop `wasm.scan(batch)`; after each batch send a progress heartbeat when
   >= 5 s have elapsed since the last one:
   `{client_id, job_id, chunk_index, lease_id, scanned, rate, done: false,
   samples: []}`.
   `scanned` is cumulative within the chunk, matching the server watermark
   logic (`src/coordinator/state.rs:874-885`) and the native client
   (`src/engine.rs:642-668`).
5. When `scanned == BigInt(end) - BigInt(start) + 1n`, call
   `wasm.samples(lease.challenge_offsets)` and send
   `done: true` with 16 samples. Each sample is a JSON array of byte values,
   not a hex string (the server deserializes `Vec<Vec<u8>>`,
   `src/coordinator/mod.rs:654-669`). The server recomputes each sample from
   `chunk_start + offset` and returns 400 on a mismatch
   (`src/coordinator/state.rs:1494-1520`; proven in
   `tests/coordinator_api.rs:510-591`). A 400 is a client bug (wrong sample
   bytes), not a transient error: surface it and stop; re-leasing would
   repeat it.
6. When `wasm.found(ptr, cap)` reports a key, `POST /api/v1/result` with
   `{client_id, job_id, lease_id, key}` (`src/coordinator/mod.rs:708-749`). The server
   re-verifies `k*G` against the job target (`src/coordinator/state.rs:1716-1728`).
   On 200 stop; on 409 the lease was lost, so keep the key in the UI but stop
   scanning and re-lease.
7. `409` on any heartbeat means the lease was lost or the job finished; query
   `/api/v1/jobs` (or a fresh lease) to distinguish and re-lease/stop. `401`
   means the token is invalid; show the same guidance as the cabinet page
   (`web/me.html:135-145`). `429` obeys `Retry-After: 1`
   (`src/coordinator/mod.rs:934-941`).

Completion is only ever sent after a full sequential scan of the leased window;
there is no "mark done optimistically". The key 0 edge case and the inclusive
range follow `src/engine.rs:1219-1222` and `:620-635`.

## D7. Performance and UI honesty

- Native reference: ~5.3 Mk/s on 4 threads, ~1.3 Mk/s per core
  (`README.md:696`). A single-threaded wasm tab has no SIMD and no threads.
- Expected order of magnitude, to be measured and then written into the docs
  and the page: roughly 100k–400k keys/s on a desktop tab and 20k–100k on a
  mid-range phone. These numbers are unverified; the acceptance bar is "the
  smoke test reports a positive rate" and "the UI displays the measured rate",
  not a promised number.
- UI must show: measured keys/s for this tab, keys scanned in the current
  chunk, chunk progress and ETA computed from the measured rate, and a line
  explaining that a GPU client does billions of keys/s (`README.md:435`), so a
  browser is a small volunteer contribution, not a competitive one.
- Chunk sizing: the default 268 M-key chunk (`src/coordinator/state.rs:28`) is
  wrong for browsers. Document `chunk_width` 2^20–2^22 (always below 2^32)
  and `lease_ttl` 120–300 for jobs intended for browser participation; the admin form already exposes
  both fields (`web/app.html:88-91`, `:330-333`). A job with `chunk_width` 2^22
  at 100k keys/s is ~42 s per chunk, which keeps completions frequent and
  leases healthy.
- The page must not promise a fake "total time"; it shows the current job's
  remaining chunks only if the operator exposes them through
  `GET /api/v1/jobs`.

## D8. Security

- Token storage: reuse `rotor-coord-token` in `localStorage` via
  `Rotor.token()` / `Rotor.setToken()` (`web/site.js:5-22`, `:116-124`); the
  private-mode fallback is already handled there.
- The page is same-origin, so `fetch('/api/v1/...')` needs no CORS and can
  carry `Authorization: Bearer` (`web/site.js:52-65`). The worker gets the
  token once via `postMessage`; it never puts the token in a URL, a log line or
  the DOM.
- Refuse to start when `!window.isSecureContext` unless the host is
  `localhost`/`127.0.0.1`; the coordinator itself has no TLS and expects a
  reverse proxy (`src/bin/rotor-coord.rs:5-6`, `:102-105`).
- Render all server-supplied strings with `textContent` (or the existing
  `R.escapeHtml`, `web/site.js:24-34`); do not introduce a new `innerHTML`
  sink. A strict CSP is desirable but would require a coordinator header
  change; keep it as a follow-up.
- The token is a bearer credential: the server stores only its SHA-256 hash
  (`src/coordinator/state.rs:121-128`) and shows it once on creation/registration
  (`src/coordinator/mod.rs:538-546`, `:576-583`).
- Rate limiting already exists per token (20/s, burst 40,
  `src/coordinator/mod.rs:42-43`, `:442-445`) and per IP for registration
  (`:44-45`, `:550-560`). The worker must treat 429 as backoff, not as a reason
  to spawn more requests.
- Authorized use only: the browser does not accept an arbitrary target or a
  free-form range; it only leases a job the operator created. The page should
  carry the same "authorized puzzle targets only" note as the README/docs.
- Found keys are public by design: the job target is public, and a found key is
  recorded in the coordinator state and dashboard (`ResultRecord`,
  `src/coordinator/state.rs:104-111`).

## D9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| wasm build fails on `xorf`/`bs58`/std APIs | wasm CI job from task 1; fallback local membership set behind `TargetSet`; no protocol change |
| Unconditional native deps break the target | target-gated `ctrlc`/`tiny_http`/`ureq`/`bip39`; cfg-gated modules (D2) |
| `Instant`/timers unavailable | no clock in wasm; JS `performance.now()` and in-loop deadlines (D4) |
| Throughput disappoints users | measured-rate UI, honest docs, browser-sized chunk guidance, GPU comparison |
| Sample/scan mismatch wastes work | parity tests against `challenge_samples`, E2E completion test, done only after full span |
| Hidden-tab throttling loses leases | pause without done, one progress heartbeat, re-lease on 409, no local checkpoints |
| Per-token rate limit throttles a crowd | document ~100 tabs/token; operators issue per-tab tokens or raise the limit; heartbeat stays at 5 s |
| Token theft via XSS or plain HTTP | same-origin only, no new HTML sinks, HTTPS/insecure-context guard, no token in URLs/logs |
| Large multi-target payload | v1 cap on `job.targets` length; skip jobs above the cap with an explicit message; paginated endpoint later |
| Stale committed wasm artifact | CI rebuilds and smoke-tests; build script fails loud on a missing/small artifact |

## D10. Verification plan

- Unit (host): golden vectors for `hash160`, ETH address and xpoint; scan of a
  fixture window finds the known key; samples equal
  `rotor::coordinator::state::challenge_samples` for all four mode/coin
  combinations.
- ABI (Node): instantiate `web/rotor_wasm.wasm` without imports, `alloc` a
  lease start, scan 10k keys, read `scanned`, `found`, `samples`; assert no
  traps and a positive rate.
- Protocol (Node, mocked fetch): fake /jobs, /lease, /heartbeat, /result;
  assert 5 s cadence, cumulative scanned, no `done` before span, handling of
  204/401/409/429.
- Integration (live coordinator): reuse the harness style of
  `tests/coordinator_api.rs:510-591`; create a 2^20-key job, run the worker,
  assert `chunks_done` 0 -> 1 only after the full scan, and a wrong sample still
  returns 400.
- HTTP asset test: spawn the coordinator and assert `/run`, `/rotor-worker.js`,
  `/rotor_wasm.wasm` status and content types; compare the wasm body length to
  the committed file.
- Manual: desktop Chrome/Firefox/Safari and one Android/iOS phone; hide/show
  the tab; confirm pause, resume/re-lease, measured rate and no false done.
