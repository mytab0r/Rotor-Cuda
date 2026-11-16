# Design: GPU clients for the coordinator

## D1. Generic chunk loop

Add `src/coordinator/chunk_loop.rs`:

```rust
pub struct ScanOutcome { pub scanned: u64, pub found: Option<Scalar> }

pub trait ChunkScanner {
    fn scan(&mut self, start: &Scalar, end: &Scalar) -> Result<ScanOutcome, String>;
}

pub fn run_leases(
    client: &CoordinatorClient,
    job: &JobRequest,          // target/mode/coin/range, serialized to the lease
    scanner: &mut dyn ChunkScanner,
) -> Result<(u64, Option<Scalar>), String>
```

The loop mirrors `engine::run_coordinator`: lease → scan → heartbeat (5 s) →
submit on found with the key hex → re-lease; 204 ends. Coordinator/auth/lost-lease
errors abort; no CPU fallback. The CPU coordinator path is left as is (it keeps
its parallel workers); only the GPU client uses the new loop in this change.

## D2. GPU scanner

Refactor `gpu_search::run` so the existing batch loop is callable for one
`[start,end]` window with an already-created `gpu::AddrEngine`:
`scan_window(engine, plan/pieces, window, target, modes, coin) -> ScanOutcome`.
The device and generator table are created once; each lease only rebuilds the
key plan/window and sets keys. The existing found/verify/output path is reused
(`Found.txt` written by the same helper).

## D3. Client wiring

`gpu_search::run` branches: with `config.coordinator`, build
`CoordinatorClient::new`, collect the job parameters from `Config`
(mode/coin/comp/start/end/target), and call `run_leases` with the GPU scanner.
The CLI currently rejects `config.gpu && coordinator`; change that rejection to
allow address/xpoint/ETH and keep rejecting BSGS (`-m bsgs --coordinator -g`:
CPU coordinator BSGS is the documented path).

## D4. Lease, heartbeat, result

Reuse `CoordinatorClient::{lease,heartbeat,submit_result}` and the existing
`JobInfo`/`Lease` structs. Heartbeat carries the cumulative scanned count and
rate; result carries the key hex whose proof the server re-verifies. A lease
lost (409 on heartbeat) aborts with a clear error; 204 ends the run normally.

## D5. Tests

- `tests/gpu_coordinator.rs`: a stub scanner (no GPU) plus an in-process
  coordinator: two clients lease different chunks; a found key is accepted with
  a valid proof; an invalid proof is rejected; 204 ends; lost lease aborts.
- Device verification (manual/container): build with `ROTOR_CUDA_ARCHS=120` in
  the CUDA devel image, run a coordinator on localhost and one GPU client over a
  small range; record the command and result in the change.
- CI compiles the feature; no device required for the tests above.
