# Tasks

## Cloud foundation
- [x] Create personal fork and verified commit identity.
- [x] Add first Windows cloud build workflow.
- [x] Make CUDA/GMP/MSBuild workflow green. (run 31224945126 / 632e4a5: MSBuild+Smoke+E2E green)
- [x] Add CPU `--help` and deterministic BSGS smoke test.
- [x] Add release-on-tag packaging and SHA-256.

## Search modes
- [x] Extract CPU BSGS interfaces and state model.
- [x] Add versioned table manifest/checksum. (BsgsCpu.h TableManifest: format ver+curve+baby_size+range+FNV-1a/64 checksum, compatible() reject; selftest 731919f)
- [x] Add sequential checkpoint/restart test.
- [x] Port GPU giant-step kernel over Rotor CUDA math (nvcc compile-only; device run pending self-hosted NVIDIA).
- [x] Add CPU/GPU statistics with separate backend labels. (Main.cpp BACKEND line + [CPU-BSGS] GIANT STEPS stat; 731919f)

## Filters
- [x] Keep Bloom reader/writer compatibility.
- [x] Integrate binary-fuse filter behind explicit selection.
- [x] Add filter format tests and reject mismatched manifests.
- [x] Add non-overwriting range catalog.

## Quality gate
- [x] Hosted CI passes build and CPU tests. (run 31224945126: Smoke CLI + E2E BSGS CPU pass, artifact 5.96MB)
- [x] NVIDIA self-hosted smoke passes GPU kernel test. (RTX 5070 sm_120 device-run: 65536 giant-steps mismatches=0 vs GMP ground truth, GPU_SMOKE.md 731919f; opt-in [self-hosted,gpu] CI job 10df873)
- [x] Random recovery documented as unsupported. (Main.cpp: -r random BSGS rejected as non-resumable; 731919f)
