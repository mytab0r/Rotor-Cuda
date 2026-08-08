# GPU BSGS on-device distinguished-point (DP) filter — evidence

A2 on top of batch inversion (`BATCH_INVERT.md`). Same batch giant-step walk,
but a point is stored only when its **canonical** X has the low `dpBits` bits
zero. Removes the per-point store that dominates the memory-bound walk.

## Correctness + completeness (RTX 5070, sm_120, CUDA 13.3, WSL2)

`bsgs/gpu_smoke_dp.cu` builds an independent GMP double-and-add ground truth,
walks `R_{i+1}=R_i-S` per walk, and checks three things:
1. every stored hit's canonical X equals the GMP canonical X;
2. every stored hit is genuinely distinguished (low `dpBits` == 0);
3. the device `total` equals a brute-force GMP DP count (found ALL, no spurious).

```
nvcc bsgs/gpu_smoke_dp.cu bsgs/BsgsGpu.cu -I. \
     -gencode arch=compute_120,code=sm_120 -std=c++14 -lgmp -o gpu_smoke_dp
# args: nWalks nSteps m W dpBits maxHits
```

| config                         | GMP DP | device total | stored | verdict |
|--------------------------------|-------:|-------------:|-------:|---------|
| 256×256 W=4 dpBits=8           |    266 |          266 |    266 | PASS    |
| 64×64  W=8 dpBits=0 (emit all) |   4096 |         4096 |   4096 | PASS    |
| 256×256 W=1 dpBits=12          |     25 |           25 |     25 | PASS    |
| 64×64  W=8 dpBits=0 maxHits=100|   4096 |         4096 |    100 | PASS (truncated, total honest) |

All checks: `not-distinguished=0 x-mismatch=0 unknown-key=0`.

## Performance (RTX 5070)

`/home/test/rcbench/bench.cu` times scalar `launch_giant`, batch
`launch_giant_batch`, and `launch_giant_dp` back to back. dpBits=24 (few/no
stores) isolates the store-removal win; the long-walk row uses dpBits=16 with
real hits.

| config              | scalar | batch  | batch+DP | DP vs batch | DP vs scalar |
|---------------------|-------:|-------:|---------:|------------:|-------------:|
| 131072×8  W=4       | 10.56ms| 8.12ms |  5.48ms  |   x1.48     |   x1.93      |
| 131072×8  W=8       | 15.33ms|10.64ms |  5.15ms  |   x2.06     |   x2.97      |
| 16384×256 W=8 (hits)| 45.17ms|38.61ms | 23.78ms  |   x1.62     |   x1.90      |
| 16384×256 W=4 (hits)| 39.38ms|30.98ms | 17.49ms  |   x1.77     |   x2.25      |

The plain batch walk is memory-bound (stores every point), so removing that
store is where the real BSGS-shaped win lives — confirming the A2 premise.

## Representation caveat

Device X is VanitySearch quasi-reduced; the kernel canonicalizes with one
conditional `SubP` before the DP test, so stored hits carry the least-residue
X directly. Y parity is informational only (y vs y+P flips it, P odd).
