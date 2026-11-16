# Design: mnemonic utilities and bounded audit

## D1. Dependencies

`bip39 = "2"` (pure Rust, English wordlist, handles entropy↔mnemonic and
PBKDF2-HMAC-SHA512 seed). Everything else is implemented locally: HMAC-SHA512
over `sha2::Sha512` (manual ipad/opad), BIP32 CKDpriv with our `scalar`/`secp`.
No `bip32`/`k256` dependency.

## D2. Derivation pipeline

`entropy → bip39::Mnemonic::from_entropy → to_seed(passphrase) → BIP32 master
(HMAC-SHA512 "Bitcoin seed") → CKDpriv(path) → Scalar → pubkey/address`.
Paths: default `m/44'/0'/0'/0/0`; `m/0'/0` and `m/0` accepted; hardened/normal
indices parsed strictly. Address modes: compressed P2PKH and a raw hash160/xpoint
for target checks.

## D3. CLI

- `--mnemonic <phrase>`, `--mnemonic-passphrase P`, `--mnemonic-path PATH`,
  `--mnemonic-derive` → human output of phrase/seed id/key/address/path.
- `--mnemonic-from-entropy HEX` → phrase.
- `--mnemonic-audit --entropy-bits N --counter START:END [--targets-text FILE]`
  → iterate counters, derive, check membership, print matches, rate, ETA.
- Limits/validation: N in {128,160,192,224,256}; range ≤ 2^32; `--mnemonic-audit`
  without a target list is an error; the audit prints a cost warning and the
  "authorized data only" disclaimer.

## D4. Performance

PBKDF2-HMAC-SHA512 (2048 iterations) plus EC derivation: measure and print
keys/s; document in README. No GPU path in this change.

## D5. Tests

- BIP39: zero entropy → `abandon ... about`; 0xff entropy → `zoo ... vote`;
  seed vectors with/without passphrase.
- BIP32: chain m, m/0', m/0'/0 and m/44'/0'/0'/0/0 against the published
  test vectors; address fixtures for a known phrase.
- Audit: derive for a counter in [0,8), target its address, sweep and find;
  limit/validation/disclaimer tests.
