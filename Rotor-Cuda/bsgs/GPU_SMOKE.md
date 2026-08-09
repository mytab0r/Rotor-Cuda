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

## Boundary result — PASS

The same RTX 5070 device run now includes explicit affine boundary fixtures:

- `A == S`: emits infinity without calling `_ModInv(0)`;
- infinity minus `S`: emits `-S`;
- `A == -S`: emits doubling;
- DP output carries and preserves explicit infinity marker.

Observed output:

```text
launch_giant OK: 4 threads x 8 steps on GPU
boundary fixtures: A==S, A==-S, infinity marker OK
checked=32 mismatches=0
GPU BSGS DEVICE-RUN: PASS (device math == GMP ground truth on RTX 5070)
```

## DP filter result — PASS

Independent GMP comparison for `32` walks × `64` steps, `W=4`, `dpBits=8`:

```text
launch_giant_dp OK: 32 walks x 64 steps (W=4, dpBits=8) -> total=11 stored=11
GMP DP count=11   device total=11   COUNT-MATCH
stored-hit checks: not-distinguished=0 x-mismatch=0 unknown-key=0
GPU BSGS DP-FILTER DEVICE-RUN: PASS (device DP == GMP ground truth on RTX 5070)
```

Boundary fixture source: `bsgs/gpu_smoke.cu`. DP fixture source: `bsgs/gpu_smoke_dp.cu`.
