# Tasks: GPU BSGS batch modular inversion

## Implementation
- [x] Add `point_sub_S_batch` (Montgomery's trick over W walks) to bsgs/BsgsGpu.cu
- [x] Add `bsgs_giant_kernel_batch` with identical output layout to scalar kernel
- [x] Add `launch_giant_batch` host launcher (validates W in 1..8, grid over nGroups)
- [x] Declare `launch_giant_batch` in bsgs/BsgsGpu.h with upgrade-path comment

## Verification
- [x] gpu_smoke_batch.cu: GMP ground-truth cross-check, X compared mod P
- [x] RTX 5070 (sm_120): 65536 points, 0 mismatch, W in {1,3,5,7,8} incl tail
- [x] Micro-benchmark scalar vs batch: up to x1.65 at high parallelism, W=4 sweet spot
- [x] Evidence written to bsgs/BATCH_INVERT.md

## CI
- [x] gpu-bsgs-compile stays green (batch device code in same TU, nvcc compile-only)

## Archive
- [ ] Merge nothing to specs (behaviour/CLI unchanged); move change to openspec/archive/
