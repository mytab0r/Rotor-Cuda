# Design: compact coordinator state

## D1. State v2

```rust
struct StateFile { version: u32, jobs: Vec<Job>, leases: Vec<Lease>, results: Vec<ResultRecord>, bsgs: Vec<BsgsState> }
struct Job {
    id, target, targets, mode, coin, comp_mode,
    start_hex, end_hex, chunk_width, lease_ttl, created_at,
    chunks_total: u64, done_bits: String,   // hex, ceil(total/8) bytes
    scanned: u64, order_seed: u64, order_step: u64, order_cursor: u64,
    found: bool, found_key: Option<String>,
}
```

- `chunk_range(i) = [start + i*width, min(start + (i+1)*width - 1, end)]`
  computed with the existing 256-bit helpers.
- Bitmap helpers: `is_done`, `mark_done` (grows lazily on load/creation),
  `count_done`.
- Serialization: `done_bits` is lowercase hex; `Vec<u8>` serde arrays would blow
  up the JSON, so manual hex encode/decode in `State::load/save_atomic`.
- `version: 2`; a missing/older version is rejected with a message telling the
  operator to start a new state file (no silent migration).
- `JobView` keeps exposing `chunks_total`, `chunks_done`, `leases`, `scanned`,
  so dashboard/API stay compatible.

## D2. Scattered order

At job creation pick `order_seed` and `order_step` (random odd, incremented until
`gcd(step, chunks_total) == 1`; `u128` arithmetic). Leasing:

```
for _ in 0..chunks_total {
    let idx = (seed + cursor*step) % total;
    cursor += 1;
    if !done(idx) && !leased(idx) { lease(idx); return; }
}
-> 204 / retry
```

The cursor is persisted, so the scatter continues across restarts. `total == 1`
and degenerate totals fall back to step 1.

## D3. Save size and frequency

One JSON rewrite per mutation, as today; the bitmap keeps the file small:
1M chunks → 125 KiB raw → ~250 KiB hex + metadata (< 400 KiB total). The test
measures the serialized length directly.

## D4. Tests

- Permutation: for totals 1, 7, 1000 and a seed, the first `total` cursors visit
  every index exactly once.
- Bitmap: mark a random subset of 1,000,000, save/load a temp file, every bit
  survives, `len(serialized) < 400 KiB`.
- Leasing: skips done and leased, wraps once, returns 204 when exhausted;
  `scanned` aggregates on completion.
- Restart: reload a state with many done chunks and lease the remaining ones.
- Existing coordinator API/client tests keep passing (views unchanged).
