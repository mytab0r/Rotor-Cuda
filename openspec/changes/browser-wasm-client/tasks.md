# Tasks: browser (WASM) puzzle-search client

Areas: `[build]` target/workspace/CI, `[wasm]` Rust scan core, `[web]`
worker/page, `[server]` asset serving, `[test]` parity/E2E. Backend and frontend
can proceed in parallel after task 1; task 4 is the interface between them.

## 1. [build] Make the crate wasm-portable  (blocked by: —)

- [ ] Add `[workspace] members = ["crates/rotor-wasm"]`; create
      `crates/rotor-wasm/Cargo.toml` with `crate-type = ["cdylib"]` and a path
      dependency on `rotor` (no new external crates).
- [ ] Move `ctrlc`, `tiny_http`, `ureq`, `bip39` under
      `[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`
      (`Cargo.toml:24-35`).
- [ ] Gate the non-browser modules in `src/lib.rs` with
      `#[cfg(not(target_arch = "wasm32"))]` (D2 list) and keep the `gpu*`
      gating.
- Acceptance: `rustup target add wasm32-unknown-unknown` followed by
      `cargo build -p rotor-wasm --target wasm32-unknown-unknown --release`
      succeeds; host `cargo fmt --check`, `cargo clippy --all-targets -- -D
      warnings`, `cargo test --release` still pass.

## 2. [wasm] Scan core and ptr+len ABI  (blocked by: 1)

- [ ] Implement `alloc`/`dealloc`, `init` (mode/coin/comp/targets),
      `begin`, `scan`, `scanned`, `found`, `samples`, `last_error` per design
      D3, using only `field`, `scalar`, `point`, `secp`, `hashes`, `base58`,
      `filter`.
- [ ] Target parsing: BTC address base58 payload, ETH 40-hex, xpoint 64-hex,
      multi sets via `TargetSet::from_records`; reject unsupported mode/coin
      pairs loudly.
- [ ] Batch scan with `add_affine(G)` + `batch_to_affine`, 2048 keys, skip
      key 0, inclusive range; sample generation mirroring
      `challenge_samples`.
- Acceptance: host tests find a fixture key for BTC address (compressed and
      uncompressed), BTC xpoint and ETH address; samples are byte-equal to
      `rotor::coordinator::state::challenge_samples`; zero start does not
      panic; `scan` returns at most `max_keys`.

## 3. [wasm] Error and size discipline  (blocked by: 2)

- [ ] No `Instant`, `SystemTime`, threads, files or network in the wasm crate;
      no panic across the ABI (catch and report via `last_error`).
- [ ] Reject a target set above the v1 cap (50,000 records) with a clear error;
      report record length so JS can validate `job.targets` shape.
- Acceptance: `grep` shows no `std::time`, `std::thread`, `std::fs`,
      `std::net`; a forced invalid config returns a non-zero status and a
      readable error; `cargo tree -p rotor-wasm` adds no external
      dependency beyond the root crate's existing set.

## 4. [web] Worker protocol loop  (blocked by: 2)

- [ ] `web/rotor-worker.js`: instantiate the wasm (no imports), receive
      `{token, clientId}`, `GET /api/v1/jobs`, pick a job, `POST /api/v1/lease`
      (with `client_id`), drive `scan` batches, progress heartbeat every >= 5 s, completion after the
      full span, `/result` on a hit.
- [ ] Handle 200/204/401/404/409/429 exactly as design D6; never send
      `done: true` when `scanned < span`; never send a done heartbeat after an
      accepted result.
- [ ] Pause/resume messages from the main thread; on resume, a progress
      heartbeat decides whether the same lease survives.
- Acceptance: Node test with mocked `fetch`/clock records: at most one
      progress heartbeat per 5 s of simulated time; `done` only after the final
      batch; 409 triggers re-lease without a done; 429 backs off; 204 re-checks jobs and either stops or
      waits ~2 s; 401 surfaces "invalid token"; cumulative `scanned` never decreases.

## 5. [server] Serve page, worker and wasm  (blocked by: 2, 4)

- [ ] Embed `web/run.html`, `web/rotor-worker.js` with `include_str!` and
      `web/rotor_wasm.wasm` with `include_bytes!`; widen the asset type from
      `&'static str` to bytes (`src/coordinator/mod.rs:482-491`).
- [ ] Add `/run`, `/rotor-worker.js`, `/rotor_wasm.wasm`; content types
      `text/html`, `application/javascript`, `application/wasm`.
- [ ] `scripts/build-wasm.sh` builds and copies the artifact; add
      `web/wasm-smoke.mjs` (Node instantiation and 10k-key scan); add a minimal
      `/run` shell for this task (task 6 completes the UI); commit
      `web/rotor_wasm.wasm`; add the nav link on the existing pages.
- Acceptance: a coordinator test asserts 200 and the exact content type for
      all three routes and that the wasm body length equals
      `web/rotor_wasm.wasm`; `cargo build --release` fails loudly if the
      artifact is missing; `/run` loads the worker in a browser.

## 6. [web] Contributor page and honest UI  (blocked by: 4, 5)

- [ ] `web/run.html`: token field using `Rotor.token()/setToken()`, a job
      picker when several jobs are running, start/stop, current job/chunk,
      cumulative scanned, measured keys/s, ETA, and a GPU-comparison note; no new `innerHTML` sink for server strings.
- [ ] Refuse to start on an insecure non-localhost context; show actionable
      401/404/429 messages; never render the token.
- Acceptance: with a mocked worker, the page displays the measured rate and
      ETA; hiding the tab sends pause and shows "paused"; a token is present
      only in the `Authorization` header (assert on the recorded requests and
      on `document.body.innerText`).

## 7. [test] Integration with a live coordinator  (blocked by: 4, 5)

- [ ] Reuse the harness style of `tests/coordinator_api.rs:510-591`: create a
      `chunk_width = 2^20`, `lease_ttl = 120` job, run the worker (Node or
      headless browser), assert progress then completion.
- [ ] Add a wrong-sample negative test to prove the client cannot mark a chunk
      done with fabricated samples.
- Acceptance: `/api/v1/status` shows `chunks_done = 0` before the full scan
      and `1` after the valid done heartbeat; a deliberately altered sample
      yields 400 and `chunks_done` stays 0; the found-key fixture reaches
      `/api/v1/result` and the job becomes `found`.

## 8. [test] CI, Docker and docs  (blocked by: 5, 7)

- [ ] CI: install `wasm32-unknown-unknown`, run the build script and
      `node web/wasm-smoke.mjs`; keep the existing fmt/clippy/test/build steps
      green (`.github/workflows/rust.yml:22-29`).
- [ ] Docker: `COPY crates`, build/copy the wasm before
      `cargo build --release --bin rotor-coord` (`Dockerfile:8-11`).
- [ ] Docs: README coord section and `/docs` explain the browser client, the
      measured-rate caveat, `chunk_width` 2^20–2^22, `lease_ttl` 120–300,
      HTTPS/reverse proxy, token storage and authorized-use scope.
- Acceptance: a fresh clone/CI run builds the wasm, smoke-passes, and builds
      the coordinator; the Docker image serves `/run` and the wasm; the docs
      contain the sizing and security guidance; all existing tests pass.
