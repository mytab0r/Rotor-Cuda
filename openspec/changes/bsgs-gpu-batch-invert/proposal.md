# Proposal: GPU BSGS batch modular inversion

## Why
GPU giant-step walk `point_sub_S` does one `_ModInv` per step. Modular
inverse is the dominant cost in affine EC point subtraction. Threads already
run independent walks that share the same stride S, so their per-step
denominators `dx_j = Sx - Ax_j` are independent and can be inverted together
with Montgomery's trick — W inversions folded into a single `_ModInv` plus
`3(W-1)` multiplications.

## What
- Add `point_sub_S_batch` + `bsgs_giant_kernel_batch` + `launch_giant_batch`
  to the GPU BSGS path. Each thread processes W walks (W in 1..8).
- Keep the existing scalar `launch_giant` untouched — batch is an additive,
  opt-in code path with an identical output layout (index `walk*nSteps+step`),
  so every existing verifier works unchanged.
- No change to CLI behaviour or to the built executable's wiring: GPU BSGS is
  still not user-exposed. This is an internal performance option proven by
  device evidence.

## Out of scope
- Wiring GPU BSGS into the CLI backend selector.
- On-device DP/target filtering (separate change; batch makes it cheaper).
- Multi-GPU.

## Evidence
Correctness: RTX 5070 (sm_120), 65536 points, 0 mismatch vs GMP double-and-add
ground truth, W in {1,3,5,7,8} including tail groups. Speedup conditional:
memory-bound micro-benchmark shows up to x1.65 at high parallelism
(131072 walks x 8 steps, W=4); W=4 is the sweet spot. See bsgs/BATCH_INVERT.md.
