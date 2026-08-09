# GPU BSGS batch modular inversion — evidence

Change: bsgs-gpu-batch-invert

## What was added
- `point_sub_S_batch` — affine `R = A - S` for W independent walks, folding the
  W denominators `dx_j = Sx - Ax_j` into a single `_ModInv` via Montgomery's
  trick (1 inverse + 3(W-1) mults instead of W inverses).
- `bsgs_giant_kernel_batch` — each thread walks W lanes; output layout identical
  to the scalar kernel (index `walk*nSteps + step`).
- `launch_giant_batch` — host launcher, grid over `ceil(nWalks/W)`, W in 1..8.

## Correctness (RTX 5070, sm_120, CUDA 13.3, WSL2)
Cross-checked against an independent GMP double-and-add ground truth. Device X
is VanitySearch quasi-reduced, so X is compared **mod P**; Y parity is
informational only.

```
nvcc bsgs/gpu_smoke_batch.cu bsgs/BsgsGpu.cu   -gencode arch=compute_120,code=sm_120 -std=c++14 -I. -lgmp -o gpu_smoke_batch
./gpu_smoke_batch 256 256 1000000 8
-> launch_giant_batch OK: 256 walks x 256 steps (W=8) on GPU
-> PROBE R0-S: ... MATCH
-> checked=65536 mismatches=0
-> GPU BSGS DEVICE-RUN: PASS (device math == GMP ground truth on RTX 5070)
```
PASS also confirmed for W in {1,3,5,7} (tail groups exercised).

## Performance (RTX 5070, 131072 walks x 8 steps = 1048576 pts)
Micro-benchmark stores every point, so it is memory-bound — this understates
the arithmetic win. Scalar path = existing `launch_giant`.

| W | scalar | batch | speedup |
|---|--------|-------|---------|
| 1 | 79.6 Mpt/s | 98.2 Mpt/s | x1.23 |
| 2 | 68.3 Mpt/s | 78.1 Mpt/s | x1.14 |
| 4 | 72.7 Mpt/s | 120.8 Mpt/s | **x1.66** |
| 8 | 60.6 Mpt/s | 103.6 Mpt/s | x1.71 |

Win grows with parallelism; at low walk counts occupancy (nWalks/W threads)
drops and batch can be slower. **W=4 is the sweet spot** (best speedup without
the register pressure of W=8). Real payoff is larger once on-device DP filtering
removes the per-point store that dominates this bench.

## Reproduce
```
export PATH=/usr/local/cuda/bin:$PATH
cd Rotor-Cuda
nvcc bsgs/gpu_smoke_batch.cu bsgs/BsgsGpu.cu -gencode arch=compute_120,code=sm_120   -std=c++14 -I. -lgmp -o gpu_smoke_batch && ./gpu_smoke_batch 256 256 1000000 8
```
