# Tasks: multi-GPU address/xpoint search

## 1. Partition and sink  (blocked by: —)
- [x] `engine::split_ranges(start, end, n)` with exact-once tests.
- [x] `OutputSink` (mutex + block writer + progress lock); `scan_window` takes
      it; interleaving test.

## 2. Device driver  (blocked by: 1)
- [x] `DeviceJob`, `DeviceRunner`, `drive` (threads, shared stop/found,
      `stop_after`); stub-runner tests (found stops others, errors abort, sums).

## 3. Wiring  (blocked by: 2)
- [x] `gpu_search::run`: N>1 creates one engine/runner per id with disjoint
      ranges; N==1 keeps the current path.
- [x] Coordinator mode: N independent lease loops with `client_id-gpuN`.
- [x] Validation: duplicate/negative ids rejected; CLI tests; README multi-GPU
      section with the pending-hardware note.

## 4. Verification and close-out
- [x] fmt/clippy/test; single-GPU code path unchanged; `--features gpu`
      type-checked with a stub nvcc (no CUDA Toolkit locally).
- [ ] `--features gpu` real nvcc build/CI run and a multi-GPU device run
      (pending a multi-GPU host).
- [ ] archive; PR.
