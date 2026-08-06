# Tasks

## Cloud foundation
- [x] Create personal fork and verified commit identity.
- [x] Add first Windows cloud build workflow.
- [ ] Make CUDA/GMP/MSBuild workflow green.
- [x] Add CPU `--help` and deterministic BSGS smoke test.
- [x] Add release-on-tag packaging and SHA-256.

## Search modes
- [x] Extract CPU BSGS interfaces and state model.
- [ ] Add versioned table manifest/checksum.
- [x] Add sequential checkpoint/restart test.
- [ ] Port GPU giant-step and lookup kernel over Rotor CUDA math.
- [ ] Add CPU/GPU statistics with separate backend labels.

## Filters
- [x] Keep Bloom reader/writer compatibility.
- [x] Integrate binary-fuse filter behind explicit selection.
- [x] Add filter format tests and reject mismatched manifests.
- [x] Add non-overwriting range catalog.

## Quality gate
- [ ] Hosted CI passes build and CPU tests.
- [ ] NVIDIA self-hosted smoke passes GPU kernel test.
- [ ] Random recovery either fixed with evidence or documented as unsupported.
