# Tasks: GPU BSGS on-device distinguished-point (DP) filter

## GPU BSGS
- [x] Add `canonicalize_X` (one conditional SubP) + `is_distinguished` device helpers to bsgs/BsgsGpu.cu
- [x] Add `bsgs_giant_kernel_dp` reusing `point_sub_S_batch`, atomic-cursor emission, true total
- [x] Add `launch_giant_dp` host launcher (validates W in 1..8, dpBits 0..64, sizes SoA to maxHits, reports truncated)
- [x] Declare `DpHit` / `DpResult` / `launch_giant_dp` in bsgs/BsgsGpu.h

## Verification
- [x] gpu_smoke_dp.cu: GMP ground-truth cross-check — canonical X match, is-distinguished, and DP count completeness
- [x] RTX 5070 (sm_120): PASS for dpBits in {0,8,12,16}, W in {1,4,8}
- [x] Truncation path proven: total=4096, maxHits=100 → stored=100, total honest, all stored valid
- [x] Micro-benchmark DP vs batch vs scalar: x2.06 vs batch (131072x8 W=8), x1.77 vs batch on long walk (16384x256 W=4)
- [x] Evidence written to bsgs/DP_FILTER.md

## CI
- [x] gpu-bsgs-compile stays green (DP device code in same TU, nvcc compile-only)

## Archive
- [x] Merge nothing into specs (behaviour/CLI unchanged); move change to openspec/archive/
