# Design: GPU-BSGS backend в CLI

## Decisions

### D1. Переиспользовать `launch_giant_dp` с `dpBits=0`, не писать новый launcher
`launch_giant_dp` уже device-run проверен (A2, RTX 5070) и возвращает
**canonical-X** hits через atomic-cursor + честный `total`/`truncated`. При
`dpBits=0` `is_distinguished()` возвращает `true` для каждой точки → получаем
полный exhaustive giant-обход, что и нужно точному BSGS (в отличие от
kangaroo, где DP-подмножества достаточно). Плюс batch-inversion (W=8) даёт
проверенный x1.6 speedup бесплатно. Альтернатива (сырой `launch_giant`) не даёт
canonical-X и требует host-канонизацию — лишний код. Отклонено.

### D2. Один и тот же fold для GPU-hits и baby-table — обязателен
baby-table фолдит `sec.GetXBytes(true, point, xb)` → `fold32(xb)`. GPU-hit несёт
canonical-X как 4 limbs. Матч в `map` возможен ТОЛЬКО если fold совпадает
байт-в-байт. Поэтому в `solve_gpu` limbs собираются обратно в `Point.x`
(`Int.bits64[0..3]`) и фолдятся тем же `GetXBytes`+`fold32`. Прямой `fold32`
поверх limb-байт запрещён — порядок байт `GetXBytes` (big-endian сжатый X) может
не совпасть с little-endian limbs. Это единственная точка тихого false-negative:
EC-reverify срабатывает лишь при попадании в `map`, значит промах fold =
пропущенный ключ без всякого сигнала. Страж — GPU-vs-CPU self-test.

### D3. Разложение giant-индексов: `i = walk*nSteps + step`
`launch_giant_dp` кладёт hit как `(walk, step)`. Восстанавливаем линейный giant
`i = walk*nSteps + step`, `startXY[walk] = Q − (walk*nSteps)·S`, каждый walk
делает `nSteps` шагов `R -= S`. Покрытие `[0, giants)` полное, порядок обхода
меняется (не важно: BSGS не зависит от порядка, reverify исключает
false-positive). `nSteps` фикс (1024); `nThreads = ceil(giants/nSteps)`.

### D4. `truncated` → fail loud
`launch_giant_dp` при `total > maxHits` ставит `truncated=true` и теряет hits.
При dpBits=0 `total == giants`, поэтому `maxHits` ставим `= giants` (все точки
влезают). Если аллокация не тянет (очень большой диапазон) → вернуть ошибку, а
не тихо недосканировать. `// ponytail:` про chunked giant-loop как upgrade path.

### D5. `build_baby` — локальный struct в TU, не в публичном .h
Общий билдер нужен только `solve`/`solve_gpu` внутри `BsgsCpu.cpp`. Держим
`struct BabyTable` + `static build_baby()` в .cpp — публичный API (`BsgsResult`,
`TableManifest`) не трогаем. Минимальный диф, никакого нового заголовочного
контракта.

### D6. Device-selection параметром, cudaSetDevice
Добавляем `int deviceIndex` в `launch_giant_dp` (default перегрузка не нужна —
единственный вызывающий это `solve_gpu`). `cudaSetDevice(deviceIndex)` первым
делом; невалидный id → `cudaGetDeviceCount` уже вернёт ошибку/loud.

## Data flow
```
target,kStart,kEnd,gpuId
  → Q = target − kStart·G ; S = m·G ; bt = build_baby()
  → nThreads=ceil(giants/1024); startXY[w]=Q−(w*1024)·S
  → launch_giant_dp(startXY,S,nThreads,1024,W=8,dpBits=0,maxHits=giants,gpuId)
  → ∀ hit: i=w*1024+step; f=fold32(GetXBytes(pointFrom(hit.x)))
       ; fuse.maybe && map[f]=j && kp=i*m+j≤span && k·G==target → k
```

## Risks
- fold-mismatch тихий false-negative → D2 + self-test (главный страж).
- reorder обхода → безопасен (D3).
- OOM на большом диапазоне → D4 fail loud.
- LNK2005 → снят, BsgsGpu.cu unity-include в GPUEngine.cu.
- CI без GPU → ручной RTX 5070 gate.

## Verification
CPU регресс (`bsgs_selftest`) + GPU self-test на RTX 5070 (recover==CPU==k) +
оба режима компиляции (WITHGPU / CPU-only) + CLI e2e на карте + remote-head через
GitHub API.
