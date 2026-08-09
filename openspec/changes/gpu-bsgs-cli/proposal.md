# Proposal: GPU-BSGS backend в CLI (track A)

## Why
GPU giant-step ядро (`bsgs/BsgsGpu.cu`) device-run проверено на RTX 5070
(batch-invert A1, DP-фильтр A2) и уже unity-included в `GPU/GPUEngine.cu:902`,
т.е. линкуется в Windows-сборку. Но CLI им не пользуется: ветка BSGS в
`Main.cpp:461` жёстко отклоняет `-g`. Проверенный код лежит мёртвым грузом —
пользователь с NVIDIA-картой не может запустить GPU-ускоренный recovery.

Это technical change: контракт `--mode bsgs` не меняется, добавляется явный
backend-выбор через существующий флаг `-g/--gpui`. Поведение и выход GPU-пути
обязаны совпадать с CPU-веткой (тот же recovered ключ).

## What
- Вынести общий baby-table билдер (`map` + binary-fuse + `TableManifest`) из
  `solve()` в статический `build_baby()` внутри `BsgsCpu.cpp` (DRY). `solve()`
  переписать поверх него — **поведение неизменно** (CPU self-test это доказывает).
- Добавить `rotor_bsgs::solve_gpu(sec, target, kStart, kEnd, gpuId, m)` под
  `#ifdef WITHGPU`:
  - `Q = target − kStart·G`, `S = m·G`, `build_baby(...)` — общий код;
  - giant-шаги `[0, giants)` разложены на `nThreads × nSteps`, индекс
    `i = walk*nSteps + step`; host-precompute `startXY[tid] = Q − (tid*nSteps)·S`;
  - вызвать **`launch_giant_dp(..., W=8, dpBits=0, ...)`** — dpBits=0 отдаёт
    КАЖДУЮ точку с уже canonical-X (точный BSGS-матч требует все точки);
  - **фолд canonical-X тем же путём, что baby-table**: limbs → `Int.bits64` →
    `Point.x` → `sec.GetXBytes(true,…)` → `fold32`. Это единственный источник
    тихого false-negative (EC-reverify ловит только false-positive), поэтому
    один и тот же fold критичен;
  - fuse-reject → `map.find` → `kp = i*m + j`, `kp ≤ span`, `k·G == target`
    reverify → found. `truncated`/`!ok` → fail loud, не тихий fallback.
- **Device-selection**: прокинуть `int deviceIndex` в `launch_giant_dp`
  (`BsgsGpu.h`/`.cu`), вызвать `cudaSetDevice(gpuId)` до аллокаций (сейчас всё
  неявно на device 0).
- **Main.cpp** ветка BSGS: `-g` → `solve_gpu` под `#ifdef WITHGPU` (иначе loud
  error); один GPU (multi-GPU deferred); лейбл `BACKEND: CPU-BSGS`/`GPU-BSGS`.
  `-r` (random) остаётся отклонён для обоих backend.
- **Self-test** `bsgs_gpu_selftest.cpp`: `solve_gpu` vs CPU `solve` vs истинный
  k, hit в начале/середине/конце/на границе giant. Skip если нет CUDA-устройства.
- README: перенести GPU-BSGS из «internal, not CLI-exposed» в CLI-фичу.

## Out of scope
- SOTA kangaroo K≈1.15, persistent/continuation DP walks.
- **Multi-GPU — в самую последнюю очередь** (явный порядок владельца).
- Расширение `span` за пределы low-64-бит (сохраняем ограничение CPU-ветки).
- CLI-экспозиция GPU-kangaroo (отдельная линия).

## Scope
Authorized public puzzle events only. Никакого mass-scanning / de-anon.
