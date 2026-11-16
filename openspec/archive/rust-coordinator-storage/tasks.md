# Tasks: compact coordinator state

## 1. State v2  (blocked by: —)
- [x] Replace per-chunk records with derived ranges + hex bitmap + aggregate
      `scanned`; `version=2` rejection for old files.
- [x] Bitmap/hex helpers; `JobView` unchanged; state load/save tests.

## 2. Scattered order  (blocked by: 1)
- [x] Full-cycle permutation (`gcd(step,total)=1`), persisted cursor; leasing
      skips done/leased and wraps once.
- [x] Tests: permutation coverage, scattered order, exhaustion, restart.

## 3. Size/persistence acceptance
- [x] 1M-chunk simulation: mark/save/load; file < 400 KiB; lease remaining.
- [x] fmt/clippy/test; README note on state size.
- [x] archive; PR #14 merged; CI green.
