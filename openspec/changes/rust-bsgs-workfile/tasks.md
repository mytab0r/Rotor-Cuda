# Tasks: BSGS work files

## 1. Table  (blocked by: —)
- [x] `BsgsTable` keeps `folds: Vec<u64>` in table order; `build_table` fills it;
      `map`/manifest unchanged.
- [x] `workfile.rs` (module): write/read/validate the binary layout from design
      D2, atomic save, SHA-256 digest, mismatch errors naming the field.
- [x] Unit tests: round-trip, map equality, checksum equality, corrupt/truncated
      file, wrong target/range/m.

## 2. CLI and walk  (blocked by: 1)
- [x] `src/cli.rs`: `--bsgs-work FILE`, `--bsgs-work-reset` (bsgs-only).
- [x] `bsgs::run_cli`: load+validate before `build_table`; resume at
      `giant_index`; progress callback saves (30 s throttle + final save);
      reset flag overwrites.
- [x] Test: mid-index resume finds the key; no baby table rebuild on load.

## 3. Docs and close-out
- [x] README: work-file flags, format version, mismatch behavior.
- [ ] `cargo test`/clippy/fmt green (debug + release); archive change; PR.
