# Mnemonic utilities and bounded weak-entropy audit

## Goal

Add BIP39/BIP32 tooling: derive keys/addresses from mnemonics, and audit a
small, user-specified entropy space (for education and authorized recovery),
with honest performance and scope limits.

## Why

The user asked about mnemonic-based generation inspired by the Milk Sad class of
bugs. BIP39 phrases encode 128–256 bits of entropy; deriving keys from them is
one-way, so mnemonics cannot be steered into a puzzle bit range. The only
meaningful use is auditing a *known-small* entropy space (a broken RNG or a
short user-chosen counter), which is a different, sensitive workflow.

## Scope

- `--mnemonic-derive` utilities:
  - `--mnemonic "<phrase>" [--mnemonic-passphrase P] [--mnemonic-path m/44'/0'/0'/0/0]`
    → prints the seed's first account key, address (BTC P2PKH compressed),
    and the derived path key.
  - `--mnemonic-from-entropy HEX` → prints the BIP39 phrase (checksum included).
- Bounded audit mode:
  - `--mnemonic-audit --entropy-bits N --counter START:END` (or a prefix),
    deriving entropy = counter encoded in N bits, mnemonic, seed with optional
    passphrase, path (default m/44'/0'/0'/0/0), address; check against
    `--targets-text`/`-i`; report matches.
  - Hard limits: N ∈ {128,160,192,224,256}; audit refuses ranges larger than
    2^32 candidates per run and prints the estimated time at the measured rate.
  - A loud warning: PBKDF2 costs milliseconds per candidate; this is for tiny
    spaces/authorized audits only. No Libbitcoin-specific RNG reconstruction is
    included.
- Wordlist/derivation: use the `bip39` crate (pure Rust, English wordlist) for
  entropy↔phrase↔seed; implement BIP32 HMAC-SHA512 derivation with our own
  scalar arithmetic (no k256), verified against BIP32 test vectors.

## Out of scope

- Puzzle-range generation from mnemonics (mathematically ineffective; rejected
  sampling would need ~2^(256−n) attempts).
- Specific vulnerable-RNG reproductions and mass wallet-sweeping.
- GPU PBKDF2 acceleration (future work; document the CPU rate).

## Acceptance

- BIP39 vectors: entropy all-zero and all-0xff produce the canonical phrases;
  mnemonic→seed matches the standard vectors.
- BIP32 vectors: chain m and account paths match the published test vectors;
  derived addresses match known fixtures.
- Audit: a mnemonic generated for a counter in a small range is found; the
  range/size limits and rate warning work; no target → error.
- Disclaimer in the output and README: authorized data only.
