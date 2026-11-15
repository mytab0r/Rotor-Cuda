# Tasks: Rust GPU backend

- [x] Add `Rotor-Cuda/bsgs/BsgsGpuAbi.cu` with device count/name and giant-batch C ABI.
- [x] Add `build.rs`: nvcc compile of ABI + kernel TUs, cudart link, loud failures.
- [x] Add `gpu` feature to `Cargo.toml` (default off).
- [x] Add `src/gpu.rs`: FFI declarations, `GiantHits`, safe launch wrapper, device info.
- [x] Add `bsgs::solve_gpu` mirroring `BsgsCpu.cpp::solve_gpu`; share the baby table builder.
- [x] Wire `-g` / `--gpui` / `-l` in `main.rs` and `bsgs::run_cli`; loud errors elsewhere.
- [x] Unit test walk planning and GPU limb→fold encoding; integration test CPU==GPU.
- [x] CLI test: `-g` without the feature fails loudly.
- [x] CI job: `cargo build --features gpu` + `cargo test --features gpu --no-run` on Windows+CUDA.
- [x] README: build instructions, arch override, `-g` limits.
- [x] Verify: `cargo build` / `cargo test` unchanged; feature code type-checks and its unit
      tests run locally with a stub ABI (no CUDA on this machine).
