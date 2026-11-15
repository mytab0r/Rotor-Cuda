# Device verification: GPU-BSGS and GPU address search

Date: 2026-11-16
GPU: NVIDIA GeForce RTX 5070, driver 616.92, compute capability sm_120
Environment: Docker Desktop (WSL2), image `nvidia/cuda:13.0.0-devel-ubuntu24.04`,
Rust stable, nvcc 13.0

## Command

```bash
ROTOR_CUDA_ARCHS=120 cargo test --features gpu --release
```

## Result

95 tests passed, 0 failed, 0 skipped (no "skipping: no CUDA device" line was
printed, so the device path actually executed).

| suite | tests | what it proves |
|---|---:|---|
| `tests/gpu_address.rs` | 7 | CPU and GPU report the same private key for BTC compressed, uncompressed, both, ETH address, single xpoint, multi-address and multi-xpoint records |
| `tests/gpu_bsgs.rs` | 2 | CPU and GPU recover the same scalar on a fixture, and agree on not-found |
| lib/unit + CLI/CPU suites | 86 | planner (chunk midpoints, generator table, window filtering), limb/fold encoding, mode mapping, unchanged CPU behaviour |

`tests/gpu_address.rs` takes ~22 s on this GPU (it launches the real kernels);
the rest are host-side tests.

## CLI smoke

```bash
./target/release/rotor -l
./target/release/rotor -g -m bsgs --range 0:4 0279BE667E...F81798
```

Output: `GPU #0: NVIDIA GeForce RTX 5070`, `BACKEND : GPU-BSGS`,
`=====> KEY FOUND: 1`, exit code 0, and `Found.txt` contains
`0279BE667E...F81798 1`.

## Other gates

- Windows CI job `gpu-bsgs-compile` compiles both CUDA translation units with
  nvcc 12.5.1 (MSVC host compiler) and runs the Rust build/tests with the
  feature; hosted runners have no GPU, so device tests skip there.
- The Linux link path needs `-lstdc++` for the nvcc objects; `build.rs` adds it
  (commit `a6976e6`), which this device run exercised.

## Not covered

- Address search performance/throughput and long-running batch behaviour.
- Multi-GPU, random mode (`-r`) and checkpoints (`-n`) are rejected by design.
