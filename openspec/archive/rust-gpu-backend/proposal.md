# Rust GPU backend (feature `gpu`)

## Goal

Give the Rust binary real GPU-BSGS execution without rewriting the CUDA kernels:
a C ABI over the existing `Rotor-Cuda/bsgs/BsgsGpu.cu` launcher, nvcc compilation
from `build.rs`, and Rust host orchestration mirroring `BsgsCpu.cpp::solve_gpu`.

## Why

The Rust port (`314a84b`) implements CPU search and CPU-BSGS but `-g` exits with
"GPU code not compiled". The CUDA giant-step kernel already exists, is
nvcc-compiled in CI, and was device-verified on RTX 5070. Only the host side is
missing.

## Scope

- New `Rotor-Cuda/bsgs/BsgsGpuAbi.cu` with `extern "C"` entry points.
- `build.rs` invoking nvcc for the ABI + kernel translation units, linking cudart.
- `Cargo.toml` feature `gpu` (default off).
- `src/gpu.rs` (FFI + safe wrapper) and `bsgs::solve_gpu` host orchestration.
- `-g` / `--gpui` / `-l` wiring in `main.rs` and `bsgs::run_cli`.
- CPU==GPU fixture test, no-device walk-planning test, CI compile gate.

## Non-goals

- GPU address/xpoint search: requires the GMP-based C++ core and is a separate
  change. `-g` on those modes errors loudly.
- Multi-GPU scheduling, GPU checkpointing, kernel changes.

## Risks

- No local CUDA/MSVC: device execution is unverified locally; CI proves
  compilation and an NVIDIA host must run the equivalence test.
- RTX 5070 is sm_120; default build emits sm_75 cubin + PTX so it JITs, and
  `ROTOR_CUDA_ARCHS=120` produces a native cubin.
