# Agent instructions

## Repository

Git root is `/home/test/Rotor-Cuda`; source is `/home/test/Rotor-Cuda/Rotor-Cuda`. Use WSL for all repository operations. `D:\magic\Documents\VSCode\Python\New` is not this repository.

## Before coding

Read `PROJECT_STATE.md`, `SESSION_HANDOFF.md`, `TESTING.md`, and relevant `openspec/specs/` plus active change files. Check `git status`.

## Build rules

`GPU/GPUEngine.cu` unity-includes `bsgs/BsgsGpu.cu`. Never add a second CUDA translation unit for `BsgsGpu.cu`. Use `/usr/local/cuda/bin/nvcc` inside WSL. Remove `obj/` and `Rotor` before handoff.

## Security

Authorized public puzzle events only. No mass scanning or de-anonymization. Never copy secrets from external launchers. Commits/pushes use personal GitHub credentials from WSL only.

## Spec flow

For behavior changes use `openspec/changes/<id>/` with proposal, design, tasks, and delta spec. Archive only after evidence passes and tasks are closed. Commit messages for non-trivial work include the change ID. Do not mark compile-only evidence as device correctness.
