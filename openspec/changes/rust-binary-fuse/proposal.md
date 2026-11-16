# Binary fuse filters for large target sets

## Goal

Restore the C++ fork's binary-fuse prefilter for large `.bin` target sets: lower
memory and false-positive rate than Bloom while keeping the exact binary search
as the source of truth.

## Why

The fork advertises binary-fuse as its advantage for large hash160 sets; the Rust
port deferred it. At tens of millions of records, a Bloom at 1e-6 costs ~29
bits/key and still needs the full record array; a binary fuse8 uses ~9 bits/key
with a lower FP rate, and the GPU/CPU hot path checks it once per candidate.

## Scope

- Add `xorf = "0.13"` (pure Rust) and a `FuseFilter` keyed by FNV-1a/64 of the
  record bytes.
- `TargetSet` uses the fuse filter when the set is large (≥ 1024 records) and the
  existing Bloom otherwise; `may_contain`/`contains` semantics unchanged.
- No change to the `.bin` format or to the exact binary search.

## Out of scope

- Persisting filters to disk or the C++ filter-catalog manifest format.
- Changing Bloom parameters for small sets.

## Acceptance

- Existing filter/engine/coordinator tests stay green.
- With 100_000 deterministic synthetic 20-byte records: every member is
  contained (no false negatives); a mutated non-member is rejected by the exact
  check; the fuse path is actually selected (assert the variant).
- `cargo test`/clippy/fmt green without C dependencies; default behavior for
  small sets is byte-identical.
