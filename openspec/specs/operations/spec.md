# Operations specification

## Environment

Repository operations run in WSL at `/home/test/Rotor-Cuda`. Source lives under `Rotor-Cuda/`. Windows host is for editing/launching WSL commands only; hosted CI has no GPU.

## Build

CPU and GPU builds use `Rotor-Cuda/Makefile`. GPU build uses `/usr/local/cuda/bin/nvcc`, `CCAP=120`, and unity-included BSGS CUDA code. Build artifacts are disposable and excluded from handoff/commit.

## Reproducibility

Every device claim records GPU model, driver, CUDA version, architecture, command, fixture, checked count, mismatches, and exit status. Compile-only CI and device-run evidence are separate.

## Credentials

Git operations requiring attribution use the user's personal GitHub credentials from WSL. Secrets never enter repository files, logs, specs, or command examples. External notification integrations use a secret store.

## Range progress

Future scheduler must maintain crash-safe interval state, distinguish completed from unknown-after-crash work, and choose only uncovered intervals. It must not silently treat process termination as success.
