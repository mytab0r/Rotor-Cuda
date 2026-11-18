# Full Rust desktop and all networks

## Summary

Move the desktop search tool to a Rust-only build and extend it from BTC/ETH to
every network the public site exposes. The host application, CLI, coordinator
client, BSGS and address logic are already Rust; the remaining non-Rust code is
the CUDA kernel set (`Rotor-Cuda/GPU/*.h`, `*.cu`) compiled by `build.rs` with
`nvcc`. "Rust-only" means that build path must go, not just the legacy C++
application that was already removed.

## Goals

1. Every chain on `apps/site` works in the desktop tool: BTC, ETH, BNB,
   Arbitrum, Optimism, Base, Polygon, Avalanche, zkSync, SOL, TRON, XRP, LTC,
   DOGE, BCH, ZEC, SUI, TON.
2. `cargo build --release` (and `--features gpu`) needs no C/C++ compiler,
   `nvcc`, CUDA toolkit or `.cu` file.
3. Address encoding, target parsing, WIF/secret export, explorer links and
   fixtures are shared conceptually with the site; no second, drifting chain
   list.
4. CPU and GPU produce identical results on published fixtures for every
   supported family.
5. Coordinator jobs, leases and proofs carry an explicit chain identifier and
   work for all families.

## Chain families, not 18 separate engines

| family | chains | search primitive | target |
|---|---|---|---|
| secp-hash160 | BTC, LTC, DOGE, BCH, ZEC, XRP | `k*G` → SHA256/RIPEMD160 | 20-byte hash160 |
| evm-keccak | ETH, BNB, Arbitrum, Optimism, Base, Polygon, Avalanche, zkSync | `k*G` → keccak256 → last 20 | 20-byte account |
| tron-keccak | TRON | same keccak path, 0x41 prefix for display | 20-byte account |
| ed25519 | SOL, SUI | seed → ed25519 public key (SUI: BLAKE2b-256) | 32-byte key / 32-byte account |
| ton-v4 | TON | seed → ed25519 key → wallet v4R2 StateInit hash | 32-byte address hash |

The secp-hash160 family shares one kernel and differs only in the output/compare
encoding; EVM and TRON share the keccak target. SOL/SUI need an ed25519 point
engine, not secp arithmetic. TON adds contract-cell serialization after the
ed25519 key and may ship CPU-first.

## GPU migration options (decision in design.md)

- `wgpu` + WGSL compute: cross-vendor, Rust host, but WGSL has no u64 and
  256-bit modular arithmetic must be 8×u32; performance and code size risk.
- `rust-gpu`/SPIR-V: kernels in Rust; toolchain maturity and driver support
  risk; needs a pinned nightly.
- OpenCL via `opencl3`: host Rust, kernels in OpenCL C (still not Rust).
- CPU-only AVX2/AVX-512: fully portable Rust, loses GPU throughput.
- NVRTC strings: still CUDA C, rejected by the "no C/C++" goal.

Recommendation: time-boxed spike of `wgpu` WGSL and `rust-gpu` against the
current CUDA secp kernel; choose the one within an agreed performance floor
(proposal: ≥70% of CUDA keys/s on the same GPU). Keep the existing CUDA path
behind a temporary feature only until the winner passes correctness and
performance gates, then delete it.

## Non-goals

- No address scanning or fund movement; search is still puzzle/target based.
- TON/SOL/SUI brute force may be CPU-only in the first release if the GPU
  kernel misses the floor; that is surfaced, never silently CPU.
- No coordinator protocol break without a version bump and migration.
- No CUDA deletion before the benchmark gate; GitHub language percentages are
  not a reason to remove a faster backend.
- `BinSort/BinSort.cpp` is the only non-CUDA C++ file (252 lines, archival
  utility); it is ported or removed separately from the CUDA decision.

## Success criteria

- `git ls-files` has no `.cu`, `.cpp`, `.h` search kernels; `build.rs` has no
  `nvcc` branch.
- `rotor --chain <all 18>` parses targets and produces the same address as the
  site fixture.
- GPU and CPU find the same fixture scalar for secp, evm/keccak, ed25519 and
  TON post-hash; release benchmarks recorded.
- Coordinator accepts jobs with `chain` for every family and rejects unknown
  chains loudly.
