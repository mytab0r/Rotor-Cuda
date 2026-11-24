# Baseline: P0 capture on main

- Commit: `f5941ae2` (`fix(site): preload the webfont on every site.css document (ROT-501)`)
- Captured: 2026-11-24
- Artifact: `apps/site/rotor_wasm.wasm`
- Size: 501 119 bytes
- SHA-256: `68d99e442e0ce9837b3102842a89822a9ebe67d7f9bcbbd323a6b0f1c5a0afdf`
- Wasm imports: 0
- Wasm exports: 24 functions plus the `memory` export

Function export names: `alloc`, `dealloc`, `set_job`, `scan`, `samples`,
`derive_report`, `derive_report_network`, `public_key_report`,
`public_key_add`, `public_key_subtract`, `public_key_mul`, `keystore_decrypt`,
`evm_sign_tx`, `evm_unsigned_tx`, `evm_sign_message`, `btc_sign_tx`,
`btc_unsigned_tx`, `tron_sign_tx`, `tron_unsigned_tx`, `result_ptr`,
`result_len`, `clear_result`, `error_ptr`, `error_len`.

## Rust tests

- `cargo test --release` (root package `rotor`): 455 passed, 0 failed,
  1 ignored across 23 test binaries; 42 s wall clock on the capture machine with
  a warm target directory. This command does not run the `rotor-wasm` package.
- `cargo test -p rotor-wasm`: 83 passed, 0 failed, 0 ignored (78 existing plus
  the 5 P0 vector tests); 3 s wall clock.

## Vector coverage

Root public API, asserted by `tests/golden_vectors.rs`:

- secp256k1 key `0x…01`: Bitcoin P2PKH compressed/uncompressed and WIF, EVM
  EIP-55, TRON, Solana, Sui, TON v4R2.
- ed25519 seed 1 and RFC8032 TEST 1: public key, Solana, Sui, TON v4R2.
- EIP-191 `"Hello World"` signature: the recorded signer recovers to the key-1
  EVM address through `monitor::auth::recover_address`.

Wasm-only on this commit, asserted by
`crates/rotor-wasm/src/golden_vectors.rs` (`cargo test -p rotor-wasm`):

- `derive_report` and `public_key_report` for key `0x…01`: BTC P2PKH,
  P2WPKH, P2SH-P2WPKH, P2TR, EVM, TRON, compressed WIF.
- TON W5 for ed25519 seed 1 and RFC8032 TEST 1.
- Keystore scrypt frame (16-byte legacy MAC) and PBKDF2 frame: private key and
  derived EVM address.
- BIP143 P2WPKH unsigned/signed hex; TRON TransferContract unsigned JSON,
  `txID`, `raw_data_hex` and signature.
- One fixed scan job (Bitcoin address mode, compressed, key 1): `scan` and
  `samples` result blobs.

## Gaps

- RFC8032 signature: no public signing API on current main; key derivation
  vector captured, signature not.
- Keystore, BIP143, TRON transaction signing and `scan`/`samples` are not
  reachable through the root crate's public API. They are reproduced from the
  same deterministic JSON in `cargo test -p rotor-wasm`, not from
  `tests/golden_vectors.rs`; no production API was added to move them.
- `apps/site/seed-crypto.js` BIP32/SLIP-0010 parity remains an open item from
  the P0 evidence section and is not claimed by this baseline.
