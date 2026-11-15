# GPU address/xpoint search in the Rust binary

## Goal

`rotor -g -m address|addresses|xpoint|xpoints` (BTC/ETH, single/multiple,
compressed/uncompressed/both) runs the existing CUDA kernels from the Rust
binary and writes the same Found.txt blocks as the CPU engine.

## Why

`rust-gpu-backend` shipped `-m bsgs -g` and left address/xpoint failing loudly.
`-g` is a user-visible promise in the README and the C++ tool; the kernels are
already in the tree and CI-compiled. Only the host side is missing.

## Decision

Option (b): a new C ABI in `Rotor-Cuda/GPU/GpuAddressAbi.cu` over the unchanged
device headers, with the generator table, keys, bloom filter and single target
passed from Rust. No GMP and no C++ core linkage. See `design.md`.

## Scope

- New CUDA TU with engine lifecycle + batch ABI; `BsgsGpu.cu` unity-included.
- `build.rs` compiles the TU with the existing nvcc pipeline.
- `src/gpu.rs` safe wrapper; `src/gpu_search.rs` host orchestration mirroring
  `Rotor.cpp:FindKeyGPU`; `main.rs` routing.
- Tests: planner/verifier units, CPU==GPU fixture (skips without a device),
  loud-error CLI tests.
- README/CI updates.

## Non-goals

- Random mode, GPU checkpoints, multi-GPU.
- C++/Makefile changes.

## Risks

- Device execution unverified locally (no CUDA/MSVC); CI proves compilation,
  an NVIDIA host must run the equivalence test.
- Copied kernel wrappers must track `GPUEngine.cu`.
