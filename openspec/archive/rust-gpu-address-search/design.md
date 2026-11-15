# GPU address/xpoint search in the Rust binary

## Goal

Make `rotor -g -m address|addresses|xpoint|xpoints` (BTC and ETH) execute on
CUDA through the Rust binary, with the same Found.txt output as the CPU engine
and no silent CPU fallback. Today those modes exit 2 with "GPU address search is
not implemented in the Rust build".

## Why

The `rust-gpu-backend` change wired `-m bsgs -g` to CUDA and deliberately left
the address/xpoint path out: `GPUEngine.cu` was built on the GMP-based C++ core
(`Int`/`Point`/`Secp256K1`). The device kernels themselves
(`GPU/GPUCompute.h`, `GPUHash.h`, `GPUMath.h`) are self-contained, so the host
side can be re-hosted in Rust without linking GMP.

## Decision: linking strategy (option b)

Do not compile the C++ core (Int/IntMod/IntGroup/Point/SECP256k1/Random/Timer/
Base58/hash) and do not link GMP. Instead add
`Rotor-Cuda/GPU/GpuAddressAbi.cu`:

- includes the unchanged device headers `GPUMath.h`, `GPUHash.h`,
  `GPUCompute.h` and the `__global__` wrappers copied from `GPUEngine.cu`;
- includes `bsgs/BsgsGpu.cu` at the end so the non-inline device globals
  (`Gx`, `Gy`, `_2Gnx`, `_2Gny`) live in exactly one CUDA translation unit —
  the same unity-include pattern `GPUEngine.cu:904` already uses;
- receives everything the C++ host used to compute itself from Rust: the
  generator table (G..1024G and 2048G, computed with the Rust EC code), the
  starting keys, the bloom filter bytes/params, or the single target bytes;
- returns hits (thread id, increment, mode bit, raw hash/X bytes) to Rust.

Rejected option (a): compiling the C++ core into build.rs would drag GMP into
the Rust build on Windows/MSVC and duplicate the already-ported EC/address code.

## Behavior to reproduce (`Rotor.cpp:FindKeyGPU`, `Rotor::Search`)

- Range `[start, end]` is split into `nbThread` chunks; thread `i` starts at
  `chunk_start + GRP_SIZE/2` with `GRP_SIZE = 2048`.
- Each kernel call advances every thread by `STEP_SIZE = 2048` keys; the device
  advances its own start points (`startP + 2048G`), so keys are uploaded once.
- A hit's private key is `keys[thId] + incr`, `incr` in `0..=2047`.
- The hit's mode bit means *compressed* (`CHECK_POINT_SEARCH_MODE_MA(..., true)`
  sets bit 15); ETH hits carry no mode bit and are always uncompressed.
- MA/MX use a bloom prefilter (`Bloom(2N, 1e-6)`), SA/SX compare the single
  20/32-byte target; the Rust host performs the exact membership check and
  recomputes the public key/address before writing a hit.
- `-b` checks both compression modes; xpoint search always compares X (mode
  independent) and emits one block per selected compression mode.
- A truncated output buffer (`found > maxFound`) is an error, never silent loss.

## Scope

- `Rotor-Cuda/GPU/GpuAddressAbi.cu` — engine create / set-keys / launch /
  destroy C ABI.
- `build.rs` — compile the new TU (and drop the now-unity-included
  `BsgsGpu.cu` from the source list); rerun inputs for the GPU headers.
- `src/gpu.rs` — FFI declarations and a safe `AddrEngine` wrapper.
- `src/gpu_plan.rs` — pure planner (chunk split, midpoints, generator table,
  sliding per-batch key windows, C-mode mapping) with unit tests, kept outside
  the FFI so it is testable without CUDA.
- `src/gpu_search.rs` — host orchestration, hit verification, progress line,
  output.
- `src/main.rs` — route `-g` address/xpoint to the GPU path.
- Small crate-internal accessors: `Fe::to_limbs`, `Bloom`/`TargetSet` bloom
  accessors, `engine` target/split/emit helpers, ctrl-c helpers.
- Tests: pure planner/verifier unit tests, a CPU==GPU integration test that
  skips without a device, CLI tests for the loud errors.
- README + CI path filter.

## Non-goals

- Random mode (`-r`) and GPU checkpointing (`-n`): rejected loudly.
- Multi-GPU scheduling: one device per run, rejected loudly otherwise.
- C++ build changes; the new TU is used only by the Rust binary.

## Risks

- No local CUDA/MSVC: nvcc compilation is proven in CI; device execution must
  be verified on an NVIDIA host (RTX 5070 is sm_120 — `ROTOR_CUDA_ARCHS=120`).
- Kernel wrappers are a copy of `GPUEngine.cu`; if the fork's kernels change,
  the copy must follow. Noted in the file header.
- The device kernel's per-thread group can overrun a short chunk; the Rust
  host filters hits to the thread's chunk, so CPU and GPU report the same keys.
