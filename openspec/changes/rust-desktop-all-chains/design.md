# Design: Rust-only desktop, all chains

## D1. Chain model

Replace `enum Coin { Btc, Eth }` with a data-driven `Chain` descriptor:

```rust
struct Chain {
    slug: &'static str,          // "bitcoin", "ethereum", ...
    family: Family,              // SecpHash160, Evm, Tron, Ed25519, Ton
    curve: Curve,                // Secp256k1, Ed25519
    address_kind: AddressKind,   // P2PKH, P2WPKH, P2SH, P2TR, Evm, Tron, Base58, Sui, Ton
    version: VersionBytes,       // BTC 0x00/0x05, LTC 0x30/0x32, DOGE 0x1e, ZEC 0x1cb8
    hrp: Option<&'static str>,   // bc, ltc
    target_len: usize,           // 20, 32
    explorers: &'static [&'static str],
}
```

The descriptor table is the single source for CLI parsing, target loaders,
`Found.txt`, coordinator job validation and the site's chain metadata. Site and
desktop must be generated from or checked against the same table; a fixture test
asserts the 18 slugs and target lengths match `apps/site` route output.

## D2. Search modes per family

- `secp-hash160` (BTC/LTC/DOGE/BCH/ZEC/XRP): scalar → point → SHA256 →
  RIPEMD160; target is the 20-byte hash. Address type only changes the payload
  and encoding at display; compressed/uncompressed P2PKH remain separate
  targets.
- `evm`/`tron` (ETH/BNB/ARB/OP/BASE/POL/AVAX/ZK/TRON): scalar → point →
  keccak256 → last 20 bytes. No new GPU matching logic; the chain selects the
  display encoder and coordinator metadata.
- `ed25519` (SOL/SUI): the search input is a 32-byte **seed**, not a secp
  scalar. Derivation is SHA-512 → clamp → ed25519 base multiplication; SUI
  hashes the 0x00-flagged public key with BLAKE2b-256. XPoint mode does not
  apply. BSGS does not apply to ed25519.
- `ton` (TON): ed25519 key → v4R2 StateInit cell (code + seqno + subwallet +
  public key) → SHA-256 address hash, then user-friendly base64url/CRC16 for
  display. TON is CPU-first until a GPU post-hash kernel passes the floor.

## D3. Range and target semantics

- secp ranges keep the current 256-bit interval over scalars `1..n-1`.
- ed25519 ranges are intervals over the 32-byte seed interpreted big-endian;
  every seed is valid. Hashing/clamping happens inside the kernel.
- TON range is the same ed25519 seed interval; the address hash is computed
  after key derivation.
- A chain declares `supports_bsgs`, `supports_xpoint`, `supports_gpu`; the CLI
  rejects unsupported combinations loudly (no silent CPU fallback).
- `--coin` stays as a deprecated alias for `--chain`; `--coin btc` → bitcoin.

## D4. Address encoders and fixtures

One `address` module with encoders shared by CPU/GPU result formatting, target
parsing and tests:

- Base58Check with per-chain version; Bech32/Bech32m HRP; CashAddr; Ripple
  alphabet; EIP-55; TRON base58; Solana base58; Sui `0x`; TON user-friendly.
- WIF only for Bitcoin-family secp chains; Ed25519 uses raw seed/hex; XRP uses
  the family seed/secret format only if implemented explicitly.
- Fixtures: key 1 (and an ed25519 seed) for all 18 chains, cross-checked against
  the WASM `derive_report` output; a test fails if desktop and site disagree.

## D5. GPU backend (ADR)

Decision: run a 2-week spike with the secp kernel on one NVIDIA GPU:

1. `wgpu` WGSL implementation: 8×u32 limbs, modular add/sub/mul/inverse, point
   add/double, SHA256/RIPEMD160. Risks: WGSL lacks u64, code size, no
   subgroup ops; benchmark both dispatch and arithmetic.
2. `rust-gpu` SPIR-V implementation: same kernels in Rust; pin nightly; check
   NVIDIA driver path and CI reproducibility.
3. If neither reaches 70% of CUDA keys/s, keep CUDA as a **feature-gated
   backend** and declare the Rust-only goal blocked; if one reaches it, delete
   CUDA after parity.

Gate: same fixture speed measured over ≥30s, same results, Windows + Linux.
Shaders remain source in the repository; no generated artifacts.

## D6. Coordinator protocol

Add optional `chain` to job creation, lease and result payloads:

- Missing chain on legacy jobs means `bitcoin` for compatibility; new jobs
  always set it.
- The server validates chain against the descriptor table and rejects targets
  of the wrong length/type with 400.
- Public job JSON includes `chain` and family; worker capabilities advertise
  supported families.
- Proof sampling remains over the job's key space; for ed25519 it samples seed
  offsets, not secp scalars.
- A protocol version bump is required before any client enforces the field.

## D7. Rollout

1. Inventory and ADR spike (no behavior change).
2. Chain descriptors + secp-hash160 family + EVM/TRON aliases on CPU; CLI,
   targets, Found.txt, tests.
3. Ed25519 CPU engine for SOL/SUI; TON v4 CPU.
4. Coordinator chain field + worker capability gating.
5. GPU port and performance gate; remove CUDA/nvcc.
6. Delete legacy `Rotor-Cuda/*`, update CI, release notes.

## D8. Risks

- WGSL/rust-gpu performance or toolchain dead end → documented fallback and
  explicit "Rust-only blocked" status rather than a silent mixed build.
- TON StateInit serialization is easy to get wrong → fixture against tonweb and
  the site output before enabling GPU.
- Ed25519 brute force changes the security/performance model; benchmark before
  promising parity.
- Coordinator proof compatibility can strand old clients → protocol version and
  migration tests.
