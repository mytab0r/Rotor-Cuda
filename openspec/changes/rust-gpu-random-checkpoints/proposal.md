# GPU random mode and checkpoints

## Goal

Stop rejecting `-r` and `-n` for GPU address/xpoint searches: rotate random
start keys like the CPU path and persist/resume GPU runs through the existing
`Rotor-Cuda_Continue.bat` / `START.bat` files.

## Why

These are the last CLI options the GPU path refuses, and the C++ tool supports
both. Distributed/GPU users otherwise lose the ability to resume long runs or to
scan uniformly at high bit widths.

## Scope

- `-r`/`-n`/`-z` for GPU single- and multi-device address/addresses/xpoint/
  xpoints/ETH searches, using the CPU `RandomSpec` semantics:
  - every `rkey * 1e9` globally scanned keys each device picks a new random
    start (uniform in `--range`, or below `2^next`/bit band `-n..-z`);
  - scans proceed upward from the random key; the process runs until found,
    set exhausted, or Ctrl-C.
- `-n` checkpoints: before starting, read `Continue.bat`; shift each device's
  range by its saved count (the existing `threads`/`chunks` extension); write
  the file every `next * 55` s with per-device cumulative counts, and on exit.
  `START.bat` is written when no checkpoint exists.
- `-r` and `-n` remain mutually exclusive (random runs are not resumable);
  coordinator mode keeps rejecting both.

## Out of scope

- Device multi-GPU verification (single RTX 5070 here; Docker store broken).
- Changing the CUDA kernels.

## Acceptance

- Host tests: random-start selection respects `--range` and `-n`/`-z`; the epoch
  trigger uses the shared scanned counter; checkpoint resume shifts each device
  range and rejects mismatched parameters.
- `-r` GPU output uses the `[R: n]` progress form; `-n` writes the exact 7-line
  file plus the per-device extension.
- Single-GPU and multi-GPU paths both wired; default behavior without the flags
  is unchanged; `cargo test`/clippy/fmt green and CI compiles the feature.
