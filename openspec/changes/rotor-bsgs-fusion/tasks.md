# Tasks

## Cloud foundation
- [x] Create personal fork and verified commit identity.
- [x] Add first Windows cloud build workflow.
- [x] Make CUDA/GMP/MSBuild workflow green. (run 31224945126 / 632e4a5: MSBuild+Smoke+E2E green)
- [x] Add CPU `--help` and deterministic BSGS smoke test.
- [x] Add release-on-tag packaging and SHA-256.

## Search modes
- [x] Extract CPU BSGS interfaces and state model.
- [ ] Add versioned table manifest/checksum.
- [x] Add sequential checkpoint/restart test.
- [x] Port GPU giant-step kernel over Rotor CUDA math (nvcc compile-only; device run pending self-hosted NVIDIA).
- [ ] Add CPU/GPU statistics with separate backend labels.

## Filters
- [x] Keep Bloom reader/writer compatibility.
- [x] Integrate binary-fuse filter behind explicit selection.
- [x] Add filter format tests and reject mismatched manifests.
- [x] Add non-overwriting range catalog.

## Quality gate
- [x] Hosted CI passes build and CPU tests. (run 31224945126: Smoke CLI + E2E BSGS CPU pass, artifact 5.96MB)
- [ ] NVIDIA self-hosted smoke passes GPU kernel test.
- [ ] Random recovery either fixed with evidence or documented as unsupported.
