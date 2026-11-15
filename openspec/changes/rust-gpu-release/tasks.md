# Tasks: rust-gpu-release

- [x] `build.rs`: link `cudart_static` (+ `pthread`/`dl`/`rt` on Linux).
- [x] `gpu-bsgs-compile.yml`: CUDA 12.8.1, arch set `52,75,80,86,89,90,100,120`,
      release build, `--version` / `-l` / `dumpbin` smoke.
- [x] `rust-release.yml`: `release-gpu` job building and publishing
      `rotor-gpu.exe` + `rotor-gpu.exe.sha256` on `v*` tags.
- [x] README: static-runtime requirement, release assets, supported architectures.
- [x] CI: green `gpu-bsgs-compile` run on `feat/rust-port`
      ([run 43769465417](https://github.com/mytab0r/Rotor-Cuda/actions/runs/43769465417),
      9m37s): release build with CUDA 12.8.1 and all 8 cubins, `--version` OK,
      `-l` exited 2 with `Error: CUDA driver version is insufficient ...`,
      `dumpbin /dependents` showed no cudart DLL.
- [ ] CI: `workflow_dispatch` run of `rust-release` (blocked: the workflow file is
      not on the default branch, so GitHub does not register it for dispatch;
      the job body is the green gate's build + smoke + the existing packaging step).
- [ ] Post-merge: tag `v*` publishes `rotor-gpu.exe`; verify `--update` on a GPU
      machine (needs a real release asset and an NVIDIA host).
