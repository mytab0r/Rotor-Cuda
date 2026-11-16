# Design: benchmark command

## D1. Measurement without touching the search semantics

Add to `src/engine.rs`:
- `pub(crate) fn request_stop()` — sets the existing stop flag (used by the
  timer and tests).
- `pub fn run_for(config: &Config, duration: Duration) -> Result<SearchOutcome, String>`
  — spawn a timer thread that sleeps `duration` and calls `request_stop()`, then
  calls the normal `run`. `run` clears the flag at startup, so the timer starts
  before it; durations below ~50 ms are not a supported use (the CLI default is
  5 s, tests use 200–300 ms). The GPU path already checks `stop_requested()`
  between launches, so the same helper bounds it.

## D2. Synthetic miss target

The benchmark clones the user's `Config` and replaces the search inputs:
- address mode: the README key-1 address, a range starting at `0x100000000`;
- ETH address: `0x7e5f…5bdf`, same range;
- xpoint: the generator X, same range;
- `display = 0`, `output_file` = a unique temp path removed after the run;
- `next = 0`, `rkey = 0`, coordinator fields cleared.
The target cannot be in the range, so no finding is possible.

## D3. Result and output

`pub struct Measurement { backend: &'static str, threads: usize, seconds: f64,
scanned: u64, keys_per_second: f64 }`.
`pub fn measure(config: &Config, duration: Duration) -> Result<Measurement, String>`
runs the engine/GPU path, measures wall time around it, and derives the rate
from `SearchOutcome.scanned`.
`pub fn run(config: &Config) -> Result<i32, String>` prints either:
```
BENCHMARK    : CPU
THREADS      : 8
DURATION     : 5.02 s
SCANNED      : 26,589,184
RATE         : 5.30 Mk/s
```
or, with `--benchmark-json`, a single `serde_json` object with the same fields
(`backend`, `threads`, `seconds`, `scanned`, `keys_per_second`).

## D4. CLI

- `--benchmark` flag, `--benchmark-seconds N` (float, default 5),
  `--benchmark-json` flag in `src/cli.rs`; all rejected without `--benchmark`
  where they make no sense (seconds/json require the flag).
- `main.rs` handles `--benchmark` before normal mode dispatch and exits with the
  returned code.

## D5. Validation

Reject `-m addresses|xpoints|bsgs`, `--coordinator`, and `--bsgs-work*` with a
clear error: the benchmark measures a single target. `-g` without the feature
uses the existing loud error. Default mode when `-m` is absent: `address`/BTC.

## D6. Tests

- `measure` with 200–300 ms, one thread, address mode: `scanned > 0`,
  `keys_per_second > 0`, backend label `CPU`.
- JSON shape: serialize a `Measurement` fixture and parse it back (serde).
- Validation errors for multi/bsgs/coordinator modes.
- No GPU required; the GPU branch stays behind the feature flag and its error
  path is covered by the existing no-feature test.
