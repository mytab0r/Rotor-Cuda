# Tasks: GPU-BSGS backend в CLI

## Core
- [x] `BsgsCpu.cpp`: вынести `struct BabyTable` + `static build_baby(sec,kStart,kEnd,m)`
      (map + binary-fuse + TableManifest); переписать `solve()` поверх него.
- [x] `BsgsCpu.h`: объявить `solve_gpu(sec,target,kStart,kEnd,int gpuId,uint64_t m=0)`
      под `#ifdef WITHGPU`.
- [x] `BsgsCpu.cpp`: реализовать `solve_gpu` — Q, S, build_baby, nThreads×nSteps,
      startXY precompute, `launch_giant_dp(W=8,dpBits=0)`, фолд canonical-X через
      `GetXBytes`+`fold32`, fuse→map→reverify, truncated→fail loud.
- [x] `BsgsGpu.h`+`BsgsGpu.cu`: `int deviceIndex` в `launch_giant_dp`, `cudaSetDevice`.

## Wiring
- [x] `Main.cpp` ветка BSGS: `-g` → `solve_gpu` под `#ifdef WITHGPU` (иначе loud);
      один GPU (multi-GPU deferred); BACKEND-лейбл CPU-BSGS/GPU-BSGS; `-r` reject.
- [x] `README.md`: GPU-BSGS как CLI-фича (пример `-g --gpui 0`, один GPU, deferred).

## QA
- [x] `bsgs_gpu_selftest.cpp`: solve_gpu vs CPU solve vs истинный k; hit в
      начале/середине/конце/на границе giant.
- [x] `.github/workflows/gpu-bsgs-compile.yml`: build нового self-test в device-run job.

## Acceptance (evidence)
- [x] CPU `bsgs_selftest` PASS после рефактора build_baby (регресс не сломан).
- [x] GPU self-test PASS на RTX 5070 (sm_120): recover == CPU == истинный k.
- [x] Компиляция: `make all` CPU-only (без solve_gpu); GPU `make gpu=1` + CUDA unity build.
- [x] CLI e2e на RTX 5070: `--mode bsgs -g --gpui 0 --range 1:100 <G>` → KEY FOUND 1,
      exit 0; тот же без `-g` тот же ключ; malformed `deadbeef` → validation error.
- [ ] Push → remote head через GitHub API; win-build + gpu-bsgs-compile + bsgs-selftest success.
- [ ] Archive change в openspec/archive/, memory обновлена.
