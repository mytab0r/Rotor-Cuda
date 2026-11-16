# Multi-GPU address/xpoint search

## Goal

`-g --gpui 0,1,...` must split the requested range across the listed CUDA
devices (one engine per device, disjoint subranges, shared hit output) and in
coordinator mode lease chunks independently per device. Today the Rust binary
rejects more than one GPU id.

## Why

The C++ tool supports it and the README examples use `--gpui 0,1,2`; this is the
last functional GPU parity gap in the Rust port.

## Scope

- Address/addresses/xpoint/xpoints/ETH: partition `[start,end]` into N contiguous
  chunks (ceil, last clipped), one thread + one `AddrEngine` per device id.
- Shared: stop flag, found counter, target/compression modes, output file behind
  one mutex so blocks never interleave; per-device progress lines.
- Single-target modes stop all devices after the first accepted hit (existing
  `stop_after` semantics); multi-target modes stop when the set is found.
- Coordinator: one lease loop per device, client id suffixed with the device
  index, so chunks remain disjoint server-side.
- Validation: duplicate or negative ids, invalid ids, and `--gpux` pairs per GPU
  as today.

## Out of scope

- Multi-GPU BSGS (one device per coordinator job stays), GPU `-r`/`-n`,
  per-device grid auto-tuning beyond the existing `--gpux`.

## Acceptance

- Range partition covers `[start,end]` exactly once with no overlap for any N.
- A hit on one device stops the others promptly and writes exactly one block.
- Output blocks from concurrent devices never interleave.
- Coordinator mode with N devices leases from N independent client ids.
- Single-GPU output/behavior is unchanged; host orchestration is unit-tested
  with stub devices; real multi-GPU execution is documented as pending a
  multi-GPU host (this machine has one RTX 5070).
- `cargo test`/clippy/fmt green; `--features gpu` compiles in CI.
