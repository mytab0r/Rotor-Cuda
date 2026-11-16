# Tasks: binary fuse filters

## 1. Filter  (blocked by: —)
- [x] Add `xorf = "0.13"`; verify a pure-Rust build.
- [x] `Prefilter` enum; `TargetSet` picks fuse at ≥1024 records, Bloom below;
      FNV-1a/64 key derivation; `prefilter_kind()` for tests.
- [x] Tests: 100k synthetic records (no false negatives, fuse selected),
      mutated record, small-set Bloom path, existing fixture.

## 2. Docs and close-out
- [x] README: replace the "BinaryFuse not ported" note with the new behavior.
- [x] fmt/clippy/test green; archive; PR #10 merged, CI green.
