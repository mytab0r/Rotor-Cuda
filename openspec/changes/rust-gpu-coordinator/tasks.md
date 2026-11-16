# Tasks: GPU clients for the coordinator

## 1. Generic loop  (blocked by: —)
- [ ] `src/coordinator/chunk_loop.rs`: `ChunkScanner`, `ScanOutcome`,
      `run_leases` (lease → scan → heartbeat 5 s → submit → re-lease; 204 ends;
      errors abort).
- [ ] Tests with a stub scanner and an in-process coordinator: disjoint leases,
      found proof accepted, invalid proof, 204, lost lease.

## 2. GPU scanner  (blocked by: —)
- [ ] Extract `scan_window` from `gpu_search::run`; engine created once, reused
      per lease; existing verify/`Found.txt` path reused.
- [ ] No behavior change for the non-coordinator GPU path.

## 3. Wiring  (blocked by: 1, 2)
- [ ] `gpu_search::run`: coordinator branch using `CoordinatorClient` and
      `run_leases`.
- [ ] CLI: allow `-g --coordinator` for address/xpoint/ETH; keep BSGS rejected
      with a clear message; update tests.

## 4. Verification and docs
- [ ] Device run on RTX 5070 in the CUDA container over a small range; record
      the command/result.
- [ ] README: GPU coordinator usage and limits.
- [ ] fmt/clippy/test (default + feature type-check); archive; PR.
