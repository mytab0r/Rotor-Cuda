# CPU/GPU benchmark command

## Goal

`rotor --benchmark [SECONDS]` measures the current backend's key rate so users
can compare hardware and the dashboard can report it later.

## Why

ref-site-b-style tools expose a benchmark page; our users currently guess rates
from the progress line. A repeatable, JSON-able measurement is cheap and useful.

## Scope

- `--benchmark` flag (default 5 s) and `--benchmark-seconds N` override: run the
  selected backend on a synthetic, guaranteed-miss range.
- Backend/mode selection follows existing flags: `-g` (gpu feature), `-t`,
  `-m address|xpoint`, `--coin btc|eth`, `-u/-b`.
- `--benchmark-json`: machine-readable result on stdout and nothing else.
- Human output: backend, threads, duration, scanned keys, keys/s.
- Multi-target, BSGS and coordinator modes are rejected (benchmark uses the
  single-target address/xpoint path).

## Acceptance

- CPU benchmark on any machine finishes within ~duration and reports a positive
  rate; the synthetic target never matches.
- With `--features gpu -g`, the GPU path is measured; without a device it fails
  loudly.
- JSON output parses and its `scanned / seconds` matches the reported rate.
- Tests use a short duration (≤300 ms) and assert positive scanned/rate and the
  chosen backend label; no network, no GPU required.
