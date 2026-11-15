# Tasks: GPU address/xpoint search

- [x] Add `Rotor-Cuda/GPU/GpuAddressAbi.cu`: MA/SA/MX/SX + ETH kernel wrappers,
      engine create/set-keys/launch/destroy C ABI, loud error strings.
      (`BsgsGpu.cu` unity-included so device globals stay in one TU.)
- [x] Update `build.rs`: compile the address TU, unity-include `BsgsGpu.cu`,
      add the GPU headers to rerun inputs.
- [x] Add `Fe::to_limbs`, `Bloom`/`TargetSet` accessors, crate-internal engine
      helpers (target build, split, emit, ctrl-c).
- [x] Add `src/gpu.rs` FFI + `AddrEngine`; add `src/gpu_search.rs` with chunk
      planning, key upload, bloom/table wiring, hit verification and output.
- [x] Route `-g` address/xpoint in `main.rs`; keep `-g` without the feature and
      `-l` behavior intact; reject `-r`, `-n`, multi-GPU loudly.
- [x] Unit tests (`src/gpu_plan.rs`): chunk/midpoint planning, generator table,
      window filtering and group-overrun rejection, target/mode mapping.
- [x] Integration test `tests/gpu_address.rs`: CPU vs GPU for BTC compressed,
      uncompressed, both, ETH address, single xpoint, multi-address and
      multi-xpoint records, plus loud no-device/unsupported-option errors;
      device tests skip with a printed line.
- [x] Review fixes: hit mode bit read as compressed (kernel convention), checked
      `cudaMemset`, honest per-batch key counter, wider CI path filter.
- [x] CLI/feature behavior: `-g` without the feature still exits 2; `-l`
      unchanged.
- [x] README GPU section and CI path filter.
- [x] Verify on an NVIDIA host: `ROTOR_CUDA_ARCHS=120 cargo test --features gpu`
      (device execution cannot run on the local machine — no CUDA Toolkit).
      Evidence: `evidence.md` (RTX 5070, 95 tests, 0 skipped).
- [x] Verify locally: default `cargo build` / `cargo test` / `cargo clippy` /
      `cargo fmt` green; `--features gpu --all-targets` type-checks with a stub
      nvcc; CI compiles the real CUDA translation unit.
