# Coordinator: compact progress storage and randomized chunk order

## Goal

Make the coordinator usable for large jobs: store completed chunks compactly,
lease chunks in a scattered order (small randomization without losing coverage),
and prove that progress survives restarts without the state file ballooning.

## Why

Today the state keeps a `Chunk` record per chunk and rewrites the whole JSON on
every lease. A 2^48 range at 2^28 chunks (2^20 chunks) produces a huge file and
a rewrite per request; puzzle-scale ranges are worse. Scanning in ascending
order also concentrates work in one region.

## Scope

- State format v2:
  - chunk ranges are derived from `job.start/end/chunk_width/index` (no per-chunk
    record);
  - completed chunks are a packed bitmap serialized as hex (2 hex chars per
    byte, `ceil(chunks_total/8)` bytes);
  - `scanned` is aggregated per job; active leases stay a small list;
  - a `version` field rejects older/unknown state loudly.
- Randomized but complete order: each job stores a full-cycle permutation
  `index(cursor) = (seed + cursor * step) mod chunks_total` with `gcd(step,total)=1`;
  leasing advances the cursor, skips done/leased indices, wraps once; after a
  full cycle with no free chunk the job is finished. Coverage is exact, order is
  scattered.
- API/dashboard keep the same views (`chunks_total`, `chunks_done`, `scanned`,
  leases); no protocol change.
- Acceptance test: simulate 1,000,000 chunk completions in-process, reload the
  state, and assert (a) every bit survives, (b) the serialized file is
  < 400 KiB, (c) leasing still finds the remaining free chunks.

## Out of scope

- Per-client auth/challenges (next change), deploy packaging.
- Storage on disk other than the single atomic JSON file.
