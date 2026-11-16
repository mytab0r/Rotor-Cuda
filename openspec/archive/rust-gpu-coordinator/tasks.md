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
- [ ] Device run on RTX 5070 in the CUDA container over a small range. Blocked
      by the local Docker engine failure (containerd content-store corruption);
      not fixed here because resetting Docker data would destroy unrelated
      images. Mitigation: PR #8 `rust-gpu-build` compiled the feature, the
      `scan_window` extraction is a reviewed mechanical move of the previously
      device-verified batch loop, and the lease loop is covered by host tests.
      Re-run on an NVIDIA host when Docker is healthy.
- [x] README: GPU coordinator usage and limits.
- [x] fmt/clippy/test on default features (`cargo build --features gpu` type
      checked by inspection only — nvcc is unavailable here).
- [x] Archive and PR: PR #8 merged; archived with the device-run gap documented
      above.
