# Tasks: benchmark command

## 1. Engine hook  (blocked by: —)
- [x] `engine::request_stop()` and `engine::run_for(config, duration)`.
- [x] Test: `run_for` over a small range stops near the requested duration and
      returns a positive `scanned`.

## 2. Benchmark module  (blocked by: 1)
- [x] `src/benchmark.rs`: `Measurement`, `measure(config, duration)`, `run(config)`
      with human and JSON output (serde_json), synthetic miss config, temp output
      file removed afterwards.
- [x] Validation: reject multi-target/BSGS/coordinator/work-file combinations.
- [x] Tests: short CPU measurement, JSON round-trip, validation errors.

## 3. CLI and dispatch  (blocked by: 2)
- [x] `src/cli.rs`: `--benchmark`, `--benchmark-seconds N`, `--benchmark-json`.
- [x] `src/main.rs`: dispatch before normal search; exit code from `run`.
- [x] CLI parser tests.

## 4. Docs and close-out
- [x] README: usage, JSON example, what is measured (synthetic miss range).
- [x] fmt/clippy/test green.
- [x] Archive change; PR. PR #7 merged; CI green (ubuntu, windows, rust-gpu-build).

