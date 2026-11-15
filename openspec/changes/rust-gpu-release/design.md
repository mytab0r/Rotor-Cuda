# Design: GPU release asset

## Static vs bundled cudart

Chosen: **static cudart**.

- `cudart_static` is an import library-free static runtime, so the exe imports no
  `cudart64_*.dll`; it still loads `nvcuda.dll` from the installed NVIDIA driver,
  which every CUDA-capable machine has.
- No `-rdc=true` is used, so `cudadevrt` is not needed.
- The alternative (zip with `cudart64_12.dll`) was rejected because
  `selfupdate.rs` downloads a single file and has no archive extraction; supporting
  it would require changing update logic, which this change avoids.
- Linux links `libcudart_static.a` plus `pthread`, `dl`, `rt` (host-side deps the
  Rust linker does not add). macOS has no CUDA support; a GPU build there fails at
  link time with the usual "cannot find -lcudart_static".

If CI ever shows that static linking is impossible (for example a CRT mismatch with
cudart_static on a future CUDA), the documented fallback is to keep the dynamic
runtime, publish `rotor-gpu.zip` (exe + `cudart64_*.dll`), and add a zip branch to
`selfupdate.rs`. That fallback is deliberately not implemented now.

## Architecture set

`52,75,80,86,89,90,100,120` — the release binary runs natively on every supported
NVIDIA generation from Maxwell to Blackwell consumer (RTX 50xx), plus `compute_<max>`
PTX (emitted by `build.rs` for the highest arch) as a JIT fallback.

sm_120 and sm_100 require CUDA 12.8+, so both the gate and the release job moved
from 12.5.1 to 12.8.1 (available in `Jimver/cuda-toolkit`). CUDA 13 is not used
because it drops older architectures that this repo still supports.

## Workflow

- `rust-release.yml`: new `release-gpu` job with `needs: release`, so the CPU job
  creates the release first and the two uploads do not race. Building on
  `workflow_dispatch` produces no assets; publishing is gated by
  `startsWith(github.ref, 'refs/tags/')`.
- `gpu-bsgs-compile.yml`: the build step is now release (the debug compile is
  covered by `cargo test --features gpu`) and a release smoke checks `--version`,
  the `-l` failure mode, and the absence of a cudart DLL import. This makes the
  static link a per-push gate, and it is the job that can be dispatched from a
  feature branch (the release workflow file does not exist on the default branch
  yet, so GitHub will not dispatch it).

## Asset names

`rotor-gpu.exe` and `rotor-gpu.exe.sha256`, hash line `<lowercase hex>  rotor-gpu.exe`
(two spaces), matching `asset_suffixes()` and `verify_sha_and_install()`.

## Known limitation

A GPU build cannot self-update to a CPU build or vice versa by design: the asset
suffix is fixed per build. Legacy GPUs not in the cubin list fall back to the PTX
JIT at the cost of first-launch compilation.
