# Tasks: GPU random mode and checkpoints

## 1. Random planner  (blocked by: —)
- [x] `gpu_random.rs`: `RandomPlanner` (reuse `engine::RandomSpec`, window,
      epoch rotation, advance, bit-range); unit tests.
- [x] Runner integration: random loop, `[R: n]` progress, stop/found semantics.

## 2. Checkpoints  (blocked by: —)
- [x] Resume: read `Continue.bat`, per-device shift (extension or `count/devices`),
      `START.bat` when absent; unit tests with fixtures.
- [x] Writer thread: every `next*55` s and at exit, cumulative per-device counts;
      disabled in random mode.

## 3. CLI and wiring  (blocked by: 1, 2)
- [x] Remove the `-r`/`-n` rejections; validation mirrors CPU semantics
      (`-n` = bit width when `-r > 0`, checkpoint period otherwise).
- [x] CLI tests; README: GPU random/checkpoint usage and the pending-hardware note.

## 4. Verification and close-out
- [x] fmt/clippy/test locally; `--features gpu` type-checked with a forced
      cfg (no nvcc here); CI compiles the real feature.
- [x] archive; PR #13 merged; CI green (real nvcc build).
