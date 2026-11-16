# Tasks: GPU clients for the coordinator

## 1. Generic loop  (blocked by: —)
- [x] `src/coordinator/chunk_loop.rs`: `ChunkScanner`, `ScanOutcome`,
      `run_leases` (lease → scan → heartbeat 5 s → submit → re-lease; 204 ends;
      errors abort).
- [x] Tests with a stub scanner and an in-process coordinator: disjoint leases,
      found proof accepted, invalid proof, 204, lost lease.

## 2. GPU scanner  (blocked by: —)
- [x] Extract `scan_window` from `gpu_search::run`; engine created once, reused
      per lease; existing verify/`Found.txt` path reused.
- [x] No behavior change for the non-coordinator GPU path.

## 3. Wiring  (blocked by: 1, 2)
- [x] `gpu_search::run`: coordinator branch using `CoordinatorClient` and
      `run_leases`.
- [x] CLI: allow `-g --coordinator` for address/xpoint/ETH; keep BSGS rejected
      with a clear message; update tests.

## 4. Verification and docs
- [ ] Device run on RTX 5070 in the CUDA container over a small range; record
      the command/result.  (not performed: no CUDA toolkit/device in this
      environment; CI compiles `--features gpu`, the host-loop tests cover the
      loop semantics.)
- [x] README: GPU coordinator usage and limits.
- [x] fmt/clippy/test on default features (`cargo build --features gpu` type
      checked by inspection only — nvcc is unavailable here).
- [ ] Archive and PR (do not commit from this task; left for the parent).
