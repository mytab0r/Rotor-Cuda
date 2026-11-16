# Design: GPU random mode and checkpoints

## D1. Random planning (host, testable)

New `gpu_random.rs` (compiled under `feature = "gpu"` and `test`):

```rust
pub struct RandomPlanner { spec: engine::RandomSpec, rng: SplitMix64, epoch: u64, start: Scalar }
impl RandomPlanner {
    pub fn new(spec, seed) -> Self;
    /// Rotate when the global epoch changed; returns true if a new start was chosen.
    pub fn maybe_rotate(&mut self, scanned_total: u64, threshold: u64) -> bool;
    pub fn window(&self) -> (Split, Split);       // start .. start + WINDOW
    pub fn advance_window(&mut self);             // continue upward after a full window
}
```

`WINDOW = 2^24` keys (or `nb_thread * STEP_SIZE * 8`, whichever is larger, capped
at 2^32) so epoch checks happen every few hundred ms at GPU rates without
exhausting the range. `engine::RandomSpec` and the RNG are reused; expose what is
needed as `pub(crate)`.

## D2. Runner changes

- `DeviceRunner::run` receives the shared live `scanned: &AtomicU64`.
- Random mode: loop { `maybe_rotate(scanned, threshold)`; build a `KeyPlan` for the
  window; scan it; `advance_window`; stop on Ctrl-C/found/set }. The found/stop
  logic is unchanged.
- Range mode: unchanged (one plan over the device's range).
- `scan_window` gains an optional per-batch hook `&AtomicU64 scanned_total` to
  add its progress, or the runner adds `outcome.scanned` after each window (the
  window is small enough; use the latter to keep `scan_window` untouched).

## D3. Checkpoints

- With `next > 0 && rkey == 0`, before building plans:
  - read `Continue.bat`; if it carries the `threads/chunks` extension and the
    count matches devices, shift each device's range by its count and keep a
    per-device baseline; otherwise fall back to `count / devices` per device;
  - write `START.bat` when no valid checkpoint exists.
- A writer thread (same pattern as the CPU engine) writes every `next * 55` s
  and at exit: `checkpoint::write_continue_with_chunks` with the sum and
  per-device `baseline + counter`. Runners increment per-device AtomicU64
  counters per batch/window.
- `-r` (rkey > 0): `-n` is the bit width, not checkpoints; no checkpoint files,
  and the writer is disabled.

## D4. CLI/behavior

- Remove the `-r`/`-n` rejections in `gpu_search.rs`.
- Progress: random mode prints `[R: <rotations>] [KEY] [F: n] [CPU/GPU ...] [T: count]`
  (mirror the CPU format, with the GPU rate); range mode unchanged.
- Coordinator mode keeps rejecting `-r`/`-n` checkpoints (random start remains
  unsupported there).

## D5. Tests

- `RandomPlanner`: range mode stays inside `[start,end]`; bit-width mode below
  `2^width`; rotation only on epoch change; `advance_window` moves forward.
- Checkpoint shift: fixture `Continue.bat` with `threads: 2`, `chunks: 5,7` over
  a 2-device split shifts each range correctly and clips at the end; mismatched
  thread count falls back; `START.bat` is written when absent.
- CLI: `-r 5 -n 71` accepted for `-g`; `-n` with range mode accepted; no
  "not supported" errors.
- Device execution remains pending a working CUDA environment (Docker store
  broken, no local toolkit); CI compiles the feature.
