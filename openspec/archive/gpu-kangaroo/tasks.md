# Tasks: GPU Pollard kangaroo baseline (track B)

## GPU kangaroo
- [x] Add `point_add_J` device helper (affine `P += jump`, one `_ModInv`/jump) to bsgs/BsgsGpu.cu, reusing GPUMath.h primitives
- [x] Add `kangaroo_jump_kernel`: per-thread walk, jump `f(x)=canonical_X.limb0 & (nJumps-1)`, distance accumulate, reuse canonicalize_X + is_distinguished, atomic-cursor DP emit with kind+dist
- [x] Add `launch_kangaroo` host launcher (validates nJumps power-of-two ≤64, dpBits 0..64, sizes SoA to maxHits, honest total + truncated)
- [x] Declare `KangHit` / `KangarooResult` / `launch_kangaroo` in bsgs/BsgsGpu.h
- [x] Host collision-solve helper: bucket by canonical DP X, tame×wild → cand=(kStart+d_tame−d_wild) mod n, EC-reverify cand·G==Q before reporting

## Verification
- [x] gpu_smoke_kangaroo.cu: GMP ground-truth on a small bounded range with known fixture scalar
- [x] RTX 5070 (sm_120): DP-collision solve recovers the fixture scalar, key·G==target passes
- [x] DP canonical-X matches GMP; honest-total/truncated path holds (A2 three-check discipline)
- [x] Evidence written to bsgs/KANGAROO.md

## CI
- [x] Add `gpu_smoke_kangaroo.cu` to gpu-bsgs-compile.yml paths trigger + device-run script; nvcc compile-only stays green (kangaroo device code in same TU)

## Archive
- [x] Merge nothing into specs if behaviour/CLI unchanged; move change to openspec/archive/
