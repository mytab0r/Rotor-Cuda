# GPU clients for the coordinator

## Goal

Let a `--features gpu` build lease chunks from `rotor-coord` and search them on
the GPU. Today `-g --coordinator` is rejected, so distributed runs are CPU-only.

## Why

GPU is the primary backend; the coordinator exists to pool machines over puzzle
ranges. Leasing chunks to GPU clients is the main use case of the server.

## Scope

- `gpu_search` accepts a coordinator client for address/xpoint/ETH modes:
  lease a chunk, scan it on the device, heartbeat every 5 s, submit a found key
  with the existing proof, re-lease until 204, stop on Ctrl-C.
- The engine/device is created once and reused across leases.
- `-g --coordinator` is allowed; `-m bsgs --coordinator -g` stays rejected
  (CPU coordinator BSGS only) with a clear message.
- Multi-GPU scheduling stays deferred.

## Out of scope

- Multi-GPU, GPU random mode/checkpoints, coordinator accounts.
- Changes to the coordinator protocol.

## Acceptance

- Two clients (one GPU, one CPU or both GPU if available) lease disjoint chunks
  of the same job and both progress; a stopped client's chunk is re-leased.
- A GPU hit is submitted with a proof the server accepts and is written to
  `Found.txt`.
- Coordinator errors (auth, lost lease, 4xx) abort loudly; no CPU fallback.
- Host-loop tests use a stub scanner against an in-process coordinator (no GPU);
  device execution is verified on an NVIDIA host with the documented command.
- `cargo build --features gpu` stays green in CI; default build unchanged.
