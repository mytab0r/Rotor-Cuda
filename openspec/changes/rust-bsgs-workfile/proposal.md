# BSGS work files (local resume)

## Goal

Let a CPU-BSGS run stop and resume without rebuilding the baby table or
restarting the giant walk: close the spec requirement that sequential BSGS
persists its table identity and position.

## Why

The search spec requires sequential BSGS to persist table/filter/range and
position and to resume without skipping. Today the Rust CLI rebuilds the table
on every run (the coordinator can store state remotely, but an offline machine
has nothing). Kangaroo solves this with work files; we need the same.

## Scope

- `--bsgs-work FILE`: binary work file with magic/version, curve, range,
  target public key, baby size, table checksum, giant index and the fold table.
- Resume: validate identity and file checksum, rebuild the map from the stored
  folds (no baby-step EC), continue at the stored giant index.
- Save: after progress chunks, throttled to at most once per 30 s, and on
  completion/stop; atomic tmp+rename.
- `--bsgs-work-reset`: overwrite a mismatched/stale work file explicitly.
- Mismatch (target/range/m/checksum/file hash) fails loudly; never silently
  discards or reuses a foreign work file.

## Out of scope

- GPU-BSGS work files (remote state via the coordinator is already supported).
- Compressing the fold table; m·8 bytes on disk is accepted.

## Acceptance

- A small-range run writes a work file, a second run resumes from the saved
  giant index and finds the key; deleting the mid-run table build is observable
  in the tests (load path does not call `build_baby_table`).
- Corrupted file, wrong target, wrong range/m or a foreign checksum → non-zero
  error naming the mismatch; `--bsgs-work-reset` then succeeds.
- `cargo test`/clippy/fmt green; README documents the flags.
