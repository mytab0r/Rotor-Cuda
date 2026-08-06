# Tasks

## Cloud foundation
- [x] Create personal fork and verified commit identity.
- [x] Add first Windows cloud build workflow.
- [ ] Make CUDA/GMP/MSBuild workflow green.
- [ ] Add CPU `--help` and deterministic BSGS smoke test.
- [ ] Add release-on-tag packaging and SHA-256.

## Search modes
- [ ] Extract CPU BSGS interfaces and state model.
- [ ] Add versioned table manifest/checksum.
- [ ] Add sequential checkpoint/restart test.
- [ ] Port GPU giant-step and lookup kernel over Rotor CUDA math.
- [ ] Add CPU/GPU statistics with separate backend labels.

## Filters
- [ ] Keep Bloom reader/writer compatibility.
- [ ] Integrate binary-fuse filter behind explicit selection.
- [ ] Add filter format tests and reject mismatched manifests.
- [ ] Add non-overwriting range catalog.

## Quality gate
- [ ] Hosted CI passes build and CPU tests.
- [ ] NVIDIA self-hosted smoke passes GPU kernel test.
- [ ] Random recovery either fixed with evidence or documented as unsupported.
