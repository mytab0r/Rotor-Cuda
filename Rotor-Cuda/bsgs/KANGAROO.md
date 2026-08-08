# GPU Pollard kangaroo baseline — evidence

Track B baseline uses classic two-herd Pollard kangaroo. `bsgs/gpu_smoke_kangaroo.cu`
constructs an independent GMP secp256k1 ground truth, runs `launch_kangaroo`, then
checks canonical DP X, honest DP count, and host collision solving with an EC
reverification (`cand*G == Q`).

## RTX 5070 device run

- GPU: NVIDIA RTX 5070
- CUDA: 13.3, WSL2
- Code target: `sm_120`
- Config: `nJumps=8`, `32 tame + 32 wild`, `65536 steps`, `dpBits=10`,
  `maxHits=100000`
- Fixture: `kStart=0x1000000`; `k=0x1000004`
- DP total/stored: `3904 / 3904`
- Device math: `not-dp=0`, `math-mismatch=0`
- Collision solve: `cand=0x1000004`, fixture match
- Reverify: `cand*G == Q`

```
$ nvcc bsgs/gpu_smoke_kangaroo.cu bsgs/BsgsGpu.cu -I. \
    -gencode arch=compute_120,code=sm_120 -std=c++14 -lgmp \
    -o gpu_smoke_kangaroo
$ ./gpu_smoke_kangaroo 8 32 32 65536 10 100000
ARCH=sm_120
BUILD_EXIT=0
device DPs total=3904 stored=3904
device-math: not-dp=0 math-mismatch=0
SOLVED cand=0x1000004  fixture=0x1000004  KEY-MATCH
GPU KANGAROO DEVICE-RUN: PASS (recovered fixture k, cand*G==Q, RTX 5070)
RUN_EXIT=0
```

The smoke uses a deterministic merged-trail fixture: wild-0 starts at tame-0's
first post-jump point. This proves collision-solve and reverify without relying
on a probabilistic collision arriving in one bounded launch. The production
consumer still needs a host continuation loop / persistent DP store for arbitrary
intervals.

Intentional baseline limits:

- classic K≈2.0, not SOTA K≈1.15 equivalence classes;
- one affine `_ModInv` per jump, not warp batch inversion;
- fixed-step DP producer, not persistent on-device walks;
- no CLI wiring or multi-GPU scheduling.
