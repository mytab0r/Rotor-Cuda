# Publishable, self-contained GPU build

## Goal

Ship `rotor-gpu.exe` as a release asset that runs on a clean Windows machine and
that `--update` can install, without changing the CPU engine, the crypto core, or
the self-update logic.

## Problem

`build.rs` linked `cudart` dynamically, so `rotor-gpu.exe` needed the CUDA
Toolkit's runtime DLL. `src/selfupdate.rs` downloads a single file (no archive
extraction), so a bare exe is the only thing it can install. There was also no
GPU job in the release workflow at all.

## Change

1. `build.rs` links `cudart_static` (plus `pthread`/`dl`/`rt` on Linux), making the
   GPU binary depend on the NVIDIA driver only.
2. `rust-release.yml` gains a `release-gpu` job: CUDA 12.8.1, release build with
   cubins for `52,75,80,86,89,90,100,120`, smoke, package, and publish
   `rotor-gpu.exe` + `rotor-gpu.exe.sha256` on `v*` tags only.
3. `gpu-bsgs-compile.yml` now builds release (same CUDA/arch set as the release)
   and smokes the binary, so the static-link path is gated on every push.
4. `selfupdate.rs` is untouched: it already selects `rotor-gpu.exe` /
   `rotor-gpu.exe.sha256` for a `--features gpu` build, and the new assets match.

## Out of scope

Multi-GPU, GPU `-r`, GPU `-n` checkpoints, BinaryFuse, C++ assets, tags/releases.

## Verification

- `cargo build --release --features gpu` in CI (Windows + MSVC + CUDA 12.8.1).
- `dumpbin /dependents` shows no `cudart*.dll`.
- `rotor-gpu.exe --version` succeeds; `-l` on a GPU-less runner exits 2 with an
  error line instead of crashing.
