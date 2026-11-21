# Tasks: Rust-only desktop, all chains

## 1. Inventory and GPU ADR [desktop]
- [x] Write `openspec/changes/rust-desktop-all-chains/gpu-spike.md` with the
      current CUDA kernel inventory (`Rotor-Cuda/GPU/*`, `bsgs/*`), measured
      keys/s baseline, and the two candidate ports. (blocked by: -)
- [x] Time-boxed `wgpu` WGSL secp kernel spike; record keys/s, build size,
      Windows/Linux status.
- [x] Time-boxed `rust-gpu` SPIR-V spike; record toolchain pin, driver status,
      keys/s.
- [x] Decide: port winner, or keep CUDA feature-gated and mark Rust-only
      blocked. Record the verdict and the 98% floor in `design.md`.

## 2. Chain descriptors and CLI [desktop]
- [x] Add `src/chain.rs`: a `ChainDescriptor` registry covering all 18 site
      slugs (id, display name, family, curve, address encoding, default HD
      path, explorer URL template, enabled flag).
- [x] Family dispatch (`SecpHash160`, `EvmKeccak`, `TronKeccak`, `Ed25519`,
      `Ton`) for address derivation, wired into the desktop key report
      (`engine::emit_hit`); BTC/ETH output is unchanged.
- [x] Descriptor/family tests: 18 unique ids, family mapping, key-1 BTC/ETH
      and secp/ed25519 fixtures from the site, TON v4R2 vectors
      (`tests/chain.rs`).
- [x] Replace `enum Coin` with the `Chain` descriptor table covering all 18
      slugs; keep `--coin` as an alias. (blocked by: 1 for GPU phase; CPU work
      may start)
- [x] Add `--chain`, `--list-chains`, target aliases; reject unsupported
      mode/chain pairs loudly.
- [x] Move address encoders into `src/address/` with per-chain fixtures from
      the WASM report (key 1 and an ed25519 seed).
- [x] `Found.txt` writes chain-specific WIF/secret only where defined; tests
      for BTC, LTC, DOGE, BCH, ZEC, XRP, ETH, TRON.
- [ ] Port `BinSort/BinSort.cpp` to a Rust subcommand/helper or delete it if
      the Rust sorter already covers it; remove the `.vcxproj`/Makefile.
      Evaluate `rust-anything` (record/diff) for this non-GPU port. This is
      independent of the CUDA gate.
- [x] CLI help/docs updated; deprecated `--coin` emits a warning, not an error.

## 3. secp-hash160 family [desktop]
- [x] CPU engine supports BTC, LTC, DOGE, BCH, ZEC, XRP targets by hash160
      with chain-specific display. (blocked by: 2)
- [x] Target loaders accept `.bin` 20-byte records and text addresses for each
      chain; mixed chains in one file are rejected.
- [ ] Compressed/uncompressed modes and address types remain explicit; tests
      use published vectors.
- [ ] Coordinator job creation accepts chain; public JSON exposes it.

## 4. EVM and TRON [desktop]
- [ ] ETH, BNB, Arbitrum, Optimism, Base, Polygon, Avalanche, zkSync map to the
      EVM family; TRON to its display encoder. (blocked by: 2)
- [ ] Same keccak target path; no per-chain kernel duplication.
- [ ] GPU plan groups these chains into the existing EVM kernel.
- [ ] Explorer/network metadata shared with the site descriptor fixture.

## 5. Ed25519 family [desktop+wasm]
- [ ] New CPU engine for 32-byte seed ranges: ed25519 public key; SOL base58,
      SUI BLAKE2b-256 account. (blocked by: 2)
- [ ] Target parsing and `Found.txt` for both; xpoint/BSGS rejected.
- [ ] Fixtures from `derive_report` curve=1; test seed 1 and a random seed.
- [ ] GPU ed25519 kernel spike; enable only if it passes the same 98% floor.

## 6. TON v4 [desktop]
- [x] TON v4R2 derivation in the chain descriptor (`enabled: true`): pinned
      v4R2 code-cell hash/depth with provenance, data cell (seqno 0,
      subwallet 698983191, ed25519 key, empty plugins dict), StateInit
      SHA-256, user-friendly base64url/CRC16 address.
- [x] Port v4R2 StateInit serialization and CRC16/base64url display; fixture
      against the site's tonweb output for the RFC8032 seed and ed25519 seed 1,
      cross-checked with `@ton/ton` 16.3.0 (`tests/chain.rs`).
- [ ] CPU search over seed ranges; address hash compare.
- [ ] GPU post-hash only after correctness; otherwise TON stays CPU-only and
      the CLI says so.

## 7. Coordinator and worker capabilities [desktop+coordinator]
- [ ] Add `chain` to job/lease/result/proof payloads with a protocol version
      bump and legacy default `bitcoin`. (blocked by: 3)
- [ ] Validate target length/type per chain; unknown chain returns 400.
- [ ] Worker advertises families; scheduler never sends ed25519/TON jobs to a
      secp-only worker.
- [ ] End-to-end test: one job per family, lease → result → accepted proof.

## 8. Rust GPU backend and CUDA removal [desktop+ops]
- [ ] Implement the chosen backend (WGSL or SPIR-V) for secp, EVM/keccak,
      ed25519 if gated; keep CPU fallback explicit. (blocked by: 1, 5)
- [ ] After the gate passes: delete `Rotor-Cuda/` CUDA sources, `build.rs`
      `nvcc` branch, CUDA workflow steps and docs; update `projects.json` and
      `PROJECTS.md`. If the gate fails, keep CUDA feature-gated and mark the
      Rust-only goal blocked instead of removing it.
- [ ] CI builds with no CUDA toolkit on ubuntu/windows; release artifact
      contains no C/C++ compiled objects.
- [ ] Performance report vs the recorded CUDA baseline; same fixtures found.

## 9. QA and release [qa]
- [ ] `cargo test --release` and `--features gpu`; fixture matrix for 18 chains.
- [ ] GPU/CPU equivalence on a real NVIDIA host; Windows smoke.
- [ ] `git ls-files` check: no `.cu`, `.cpp`, `.h` kernels; `build.rs` no
      `nvcc`.
- [ ] Update README, docs and release notes; archive this change.
