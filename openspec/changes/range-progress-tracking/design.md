# Design: Range Progress Tracking

## Work Identity
Every interval record is keyed by:
- `JobIdentity`: `target_pubkey_hash` (SHA-256 of compressed pubkey), `algorithm`, `backend`, `table_format_version`, `table_checksum` (FNV-1a/64 over baby-step folds)
- Interval: half-open `[start, end)` in scalar space (uint64, up to 2^64-1)
- `JobIdentity::compatible()` validates exact match on all fields. No substring matching.

## Storage
- **Journal**: append-only JSONL, one line per event (`CLAIM`, `COMPLETE`, `ABORT`). Fsync after each write.
- **Snapshot**: atomic write (tmp + rename) for fast restart on large journals. Ponytail: not implemented yet; journal replay is fast enough for expected sizes.
- **Exclusive lock**: single-worker assumption. No file locking yet (OS lock + rename).

## Crash Semantics
- `CLAIM` without matching `COMPLETE`/`ABORT` → `unknown_after_crash`
- Caller decides reallocation; no automatic re-claim.
- Progress report shows `unknown_after_crash` explicitly as percentage.

## Deterministic Selection
```
uncovered = full_range \ (claimed U completed U aborted)
total_uncovered = sum(uncovered.length)
offset = FNV1a64(seed + "|" + nonce) % total_uncovered
claim = interval at offset in uncovered
```
- Seed chosen by caller (e.g., `target_pubkey_hash + "|" + algorithm + "|" + backend`).
- Nonce increments per claim (0, 1, 2...).
- `max_len` caps interval length (0 = no cap).

## Progress Report
```
Progress {
    covered: u64,              // sum(completed.length)
    uncovered: u64,            // sum(uncovered.length)
    unknown_after_crash: u64,  // sum(claimed.length)
    total_range: u64,          // end - start of full_range
    pct_covered: f64,          // covered / total_range * 100
    pct_unknown: f64,          // unknown_after_crash / total_range * 100
    last_checkpoint_ts: u64    // epoch ms of last journal write
}
```

## Tests
- `range_progress_selftest.cpp`: basic claim/complete, resume after crash, abort returns to uncovered, job mismatch rejection, deterministic selection, exhaustion, max_len cap.
- CI: `.github/workflows/range-progress-selftest.yml` runs on push to tracked branches.

## Files
- `Rotor-Cuda/progress/RangeProgress.h` — public API
- `Rotor-Cuda/progress/RangeProgress.cpp` — implementation
- `Rotor-Cuda/progress/range_progress_selftest.cpp` — standalone tests

## Non-goals (per proposal)
- No multi-worker/SQLite in this change.
- No CLI wiring; separate change after tests accepted.