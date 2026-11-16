# Design: binary fuse filters

## D1. Crate

`xorf = "0.13"` (pure Rust). Its `BinaryFuse8` is built from a `&[u64]` key set
and answers `contains(&u64)`; a false positive is possible, a false negative is
not. If the API needs a seed, store it; the filter is rebuilt per process from
the record array, so no persistence is required.

## D2. Key derivation

Hash each record to `u64` with FNV-1a/64 (offset `14695981039346656037`, prime
`1099511628211`) — the same fold the C++ `FilterCatalog` uses. Keys are
independent of record length.

## D3. Selection and API

```rust
enum Prefilter { Bloom(Bloom), Fuse(xorf::BinaryFuse8) }
const FUSE_THRESHOLD: usize = 1024;
```

`TargetSet::from_records` builds the fuse filter when `len >= FUSE_THRESHOLD`,
Bloom otherwise. `may_contain(&[u8])` hashes the needle and asks the selected
filter; `contains` keeps the exact binary search after `may_contain`.
`TargetSet` exposes a `#[doc(hidden)] fn prefilter_kind(&self) -> &'static str`
for tests. Small sets keep byte-identical Bloom behavior.

## D4. Failure modes

`BinaryFuse8::try_from` can fail on degenerate sizes (0/1 keys); the constructor
falls back to Bloom in that case and the exact search still applies. An empty
set keeps the current behavior (no members).

## D5. Tests

- 100_000 deterministic synthetic 20-byte records (LCG), `TargetSet::from_records`:
  `prefilter_kind() == "fuse"`; every record `contains`; a byte-flipped record
  is not contained; a sample of non-members may false-positive in `may_contain`
  but never in `contains`.
- Small set (10 records): `prefilter_kind() == "bloom"`, all members contained.
- The existing `Others/Puzzles_1_37_ETH.bin` and engine tests stay green.
