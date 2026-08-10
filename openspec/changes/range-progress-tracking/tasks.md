# Tasks: Range Progress Tracking

## Implementation
- [x] Define `JobIdentity`, `Interval`, `EventType`, `JournalEntry`, `Progress` in `RangeProgress.h`
- [x] Implement `RangeTracker::open()` with journal replay and job identity validation
- [x] Implement `RangeTracker::set_full_range()` to establish search space
- [x] Implement deterministic claim: `claim(max_len, seed, nonce)` using FNV-1a64
- [x] Implement `complete(interval, aborted, keys_found)` with exact match requirement
- [x] Implement `progress()` returning covered/uncovered/unknown/total/pct metrics
- [x] Implement `uncovered()` returning sorted disjoint intervals
- [x] Implement append-only JSONL journal with fsync
- [x] Implement `rebuild_uncovered()`: full_range \ (claimed U completed U aborted)
- [x] Handle crash semantics: `CLAIM` without `COMPLETE`/`ABORT` → `unknown_after_crash`

## Testing
- [x] `range_progress_selftest.cpp`: basic claim/complete
- [x] `range_progress_selftest.cpp`: resume after crash (unknown_after_crash)
- [x] `range_progress_selftest.cpp`: abort returns interval to uncovered
- [x] `range_progress_selftest.cpp`: job identity mismatch rejection
- [x] `range_progress_selftest.cpp`: deterministic selection (same seed+nonce → same interval)
- [x] `range_progress_selftest.cpp`: exhaustion handling
- [x] `range_progress_selftest.cpp`: max_len cap
- [x] CI workflow: `.github/workflows/range-progress-selftest.yml`

## Integration (future change)
- [ ] Wire into CLI `--mode bsgs -g` as range provider
- [ ] PowerShell launcher replacement (systemic solution when justified)
- [ ] Multi-worker SQLite upgrade (when requirements exist)

## Documentation
- [x] OpenSpec proposal.md, design.md, tasks.md updated
- [ ] README update for range progress tracking (future, with CLI integration)