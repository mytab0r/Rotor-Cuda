# GPU BSGS device-run evidence

Hosted CI runners have **no GPU**, so the `gpu-bsgs-compile` workflow can only
prove `bsgs/BsgsGpu.cu` *compiles* against real CUDA + the fork's device math.
Actual device **execution** is verified locally on NVIDIA hardware and recorded
here (openspec quality gate: "NVIDIA self-hosted smoke passes GPU kernel test").

## Harness

`bsgs/gpu_smoke.cu` launches the giant-step kernel (`R_{i+1} = R_i - S`) on the
GPU, then cross-checks every emitted point against an **independent libgmp**
double-and-add EC implementation (separate code path — agreement is real
evidence, not a tautology). It compares X **mod P** (device uses VanitySearch
quasi-reduced representation: X is congruent mod P but not the least residue);
Y-parity is informational only (y vs y+P flips it since P is odd).

Build + run:

```bash
nvcc bsgs/gpu_smoke.cu bsgs/BsgsGpu.cu \
  -gencode arch=compute_120,code=sm_120 -std=c++14 -I. -lgmp -o gpu_smoke
./gpu_smoke 4 8        # threads steps
./gpu_smoke 32 64
./gpu_smoke 256 256    # 65536 giant-steps
```

## Result — PASS

- **GPU:** NVIDIA GeForce RTX 5070 (sm_120), CUDA 13.3, driver 610.88, WSL2.
- Decisive PROBE (`R0-S` via independent GMP `ec_add`) matches GPU step 1
  bit-for-bit — isolates device math from ground-truth expectation.
- `4×8` → checked=32 mismatches=0
- `32×64` → checked=2048 mismatches=0
- `256×256` → **checked=65536 mismatches=0**

Device math (`point_sub_S` + `GPU/GPUMath.h` primitives) == GMP ground truth on
all sizes. The fork's single-TU device code runs correctly on sm_120.
