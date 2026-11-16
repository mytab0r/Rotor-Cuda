Post-merge review 2026-11-16 (branch main, 146 tests green, clippy/fmt clean).
Scope: coordinator, benchmark, GPU coordinator wiring, BSGS work files, docs/spec drift.

VERDICT: PASS

Findings:

1. MAJOR benchmark: GPU rate is silently under-reported when the synthetic range
   exhausts before the timer fires. Range 0x100000000..0x1FFFFFFFF = 4,294,967,295
   keys; an RTX 4090 (~3.1 Gk/s) covers it in ~1.4 s < the 5 s default. run_gpu()
   (src/benchmark.rs:171-179) then blocks in timer.join() until the full duration,
   and measure() (src/benchmark.rs:76-88) computes keys_per_second = scanned /
   elapsed, i.e. 4.29e9/5.0 = 0.86 Gk/s instead of the real ~3 Gk/s. Same shape in
   engine::run_for (src/engine.rs:86-94). Fix: widen the synthetic range or stop
   the clock when the scan returns early.

2. minor coordinator: bsgs_put (src/coordinator/state.rs:658-695) stores giant_index
   verbatim - not monotonic, unlike chunk.scanned (kept via max()). Any client that
   rebuilds an identical manifest can rewind the resume point (full re-walk), and
   any authenticated client can post giant_index > giants to force a bsgs job done,
   silently skipping the remaining range. Consider max() retention.

3. minor coordinator: heartbeat (src/coordinator/state.rs:507-566) trusts the lease
   holder: done=true marks a chunk complete with no evidence of scan, and scanned
   is arbitrary. Accepted under the single-shared-token model (README limitations),
   but worth stating in the API docs.

4. minor coordinator: read_body (src/coordinator/mod.rs:323-330) has no request
   size limit (whole body buffered in RAM) and the accept loop spawns one thread
   per request with no cap (mod.rs:83-88). Both sit behind the token check, so
   this is an authenticated-only DoS surface; a size cap (e.g. 1 MiB) is cheap.

5. minor coordinator: run_leases (src/coordinator/chunk_loop.rs:115-134) aborts the
   whole GPU client on any heartbeat error, including the benign lease-lost that
   happens when another client submits the found key while this chunk is in
   flight; the CPU path handles that gracefully (src/engine.rs:653-669).
   Documented in the chunk_loop header, but README.md:121 says GPU clients lease
   chunks "exactly like the CPU client" - misleading. Also: a chunk wider than
   TTL * rate can livelock a GPU client (no heartbeats during a synchronous scan).

6. minor client: CoordinatorClient::request (src/coordinator/client.rs:225-233)
   interpolates the token raw into the request head; a token containing CRLF
   corrupts the request. Config footgun only; reject control chars at parse time.

7. minor spec drift: openspec/specs/search/spec.md (merged source of truth) has no
   requirements for the coordinator, benchmark, BSGS work files or the GPU
   coordinator; the archived changes (rust-coordinator, rust-gpu-coordinator,
   rust-benchmark, rust-bsgs-workfile) shipped without delta specs. Also
   openspec/archive/gpu-bsgs-chunked-output/tasks.md is archived with every task
   unchecked, while the code (bounded launch_giant_dp) is actually implemented.
   rust-gpu-coordinator leaves the RTX 5070 device run unchecked with the blocker
   documented - acceptable.

Fine (verified, no defect):

- Lease/TTL/double-lease: all mutations under one mutex; expiry boundary semantics
  tested (state.rs:453-501, tests at state.rs:1113-1177); expired leases are
  reclaimed atomically inside lease().
- Proof verification: k*G compared against the target for address (base58check
  P2PKH), xpoint (padded lowercase hex), ETH (keccak160) and bsgs (full point
  equality); invalid/zero/non-hex keys rejected (state.rs:766-777 + tests).
- Auth: missing/blank token -> 401; constant-time compare; empty token refused at
  spawn (mod.rs:339-358, rotor-coord.rs:77-80).
- Ctrl-C: a partial chunk is never marked done - CPU gates the done-heartbeat on
  !stop_requested (engine.rs:653-665), GPU breaks before both heartbeats
  (chunk_loop.rs:110-113); the lease expires and the chunk is rescanned.
- Chunk tiling: no overlap, no infinite loop, MAX_CHUNKS cap enforced.
- Dashboard: escapeHtml on every server-derived string; numeric-only interpolations
  remain; token used only in localStorage and the Authorization header.
- Work files: header offsets match HEADER_LEN=101; body length checked against
  baby_size/target_len; SHA-256 digest and FNV table checksum both validated;
  range/target/baby-size mismatches rejected with the field named
  (src/bsgs_workfile.rs); a foreign file is never silently reused.
- Resume after a found key: giant_steps-1 makes a restart re-check the found chunk
  (bsgs.rs:646-650); 30 s throttled saves plus a final save; save failures exit
  non-zero instead of looking successful.
- Benchmark: JSON purity holds (display forced to 0 suppresses banner/monitor/hit
  prints; src/gpu.rs prints nothing); the temp output file is removed before error
  propagation (benchmark.rs:77-80); nan/inf seconds fall back to 5.0.
- STOP/timer races: both timers are joined inside run_for/run_gpu, so no timer from
  a previous run survives; the documented <50 ms reset race only overshoots until
  range exhaustion.
- GPU extraction: scan_window is the single loop for both paths; the non-coordinator
  call passes target.stop_after(), the coordinator passes 1; the key plan is rebuilt
  per lease while the engine and generator table are created once; Window::key
  clips group overruns; found accounting matches the CPU block-per-mode semantics;
  -g --coordinator rejects bsgs plus -r/-n (src/cli.rs:602-644).

Blockers: none.
