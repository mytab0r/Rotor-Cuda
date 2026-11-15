# Tasks: rust-gpu-release

- [x] `build.rs`: link `cudart_static` (+ `pthread`/`dl`/`rt` on Linux).
- [x] `gpu-bsgs-compile.yml`: CUDA 12.8.1, arch set `52,75,80,86,89,90,100,120`,
      release build, `--version` / `-l` / `dumpbin` smoke.
- [x] `rust-release.yml`: `release-gpu` job building and publishing
      `rotor-gpu.exe` + `rotor-gpu.exe.sha256` on `v*` tags.
- [x] README: static-runtime requirement, release assets, supported architectures.
- [ ] CI: green `gpu-bsgs-compile` run on `feat/rust-port` (release build + smoke).
- [ ] CI: `workflow_dispatch` run of `rust-release` (blocked: the workflow file is
      not on the default branch, so GitHub does not register it for dispatch).
- [ ] Post-merge: tag `v*` publishes `rotor-gpu.exe`; verify `--update` on a GPU
      machine (needs a real release asset and an NVIDIA host).
