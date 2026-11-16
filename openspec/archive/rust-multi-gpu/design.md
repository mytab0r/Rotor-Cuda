# Design: multi-GPU address/xpoint search

## D1. Range partition

`fn split_ranges(start: Split, end: Split, devices: usize) -> Vec<(Split, Split)>`
in `engine` (reuse the existing `Split` arithmetic): `total = end-start+1`,
`chunk = ceil(total/devices)`, chunks are contiguous, the last is clipped at
`end`. N=1 returns the whole range. Unit tests cover several spans/device counts
for exact-once coverage and ordering.

## D2. Output sink

Introduce `struct OutputSink { file: Mutex<File> }` in `gpu_search` (or share
`engine`'s hit writer): `write_block(&self, ...)` locks and writes the C++ block;
progress prints also go through the lock so concurrent devices cannot interleave
lines. `scan_window` takes `&OutputSink` instead of `&mut File`.

## D3. Device driver

```rust
struct DeviceJob { device_id: i32, start: Split, end: Split }
trait DeviceRunner { fn run(&mut self, stop: &AtomicBool) -> Result<DeviceOutcome, String>; }
fn drive(runners: Vec<Box<dyn DeviceRunner>>, stop: &AtomicBool, found: &AtomicU64,
         stop_after: u64) -> Result<u64 /*scanned*/, String>
```

- `drive` spawns one thread per runner, joins all, aborts on the first error
  (other threads see `stop`).
- Production runner owns an `AddrEngine`, the plan and shared target/modes; its
  `run` calls `scan_window` with the shared stop flag; on an accepted hit it
  increments `found`, and once `found >= stop_after` the driver sets the shared
  stop so other devices finish the current batch and exit.
- `scan_window` checks `engine::stop_requested() || shared stop`.

## D4. Coordinator

For `--coordinator` with N devices, spawn N independent `run_coordinator` loops,
each with its own engine and `CoordinatorClient` whose client id is
`<base>-gpu<index>`; chunks stay disjoint server-side. Join and sum scanned
counts. A found key by one device does not stop the others (the server marks the
job found; subsequent leases return 204).

## D5. Single-GPU path

When `gpu_ids.len() == 1`, keep today's code path (same output, same counters)
to avoid regressions. The multi path only activates for >1 ids.

## D6. Validation

Reject duplicate ids, negative ids and more than the device count at engine
creation (the existing launcher error), with a clear message. `--gpux` already
requires two values per id.

## D7. Tests

- `split_ranges`: exact-once coverage, N=1 identity, last-chunk clipping.
- `drive` with stub runners: a found runner stops the other; scanned sums;
  an error in one runner aborts; `stop_after` honored.
- Output sink: two threads writing blocks produce non-interleaved blocks (write
  a small stress test with a stub writer? The sink wraps a file; test by writing
  blocks from threads and parsing the result).
- CLI: `--gpui 0,1` accepted; duplicates rejected.
- Real multi-GPU execution is pending a multi-GPU host; document in the change.
