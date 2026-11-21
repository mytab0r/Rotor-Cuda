# Tasks

## 1. Page and controls

- [x] Add the "Generate a seed phrase" block to the import card: 12/24
      `.segmented` control, Generate, visible phrase field, strength line, info
      control, Add and the privacy/path help text.
- [x] Reuse `.field`, `.segmented`, `.chip`/button and `.icon-button` grammar;
      no page-local sizes or styles.

## 2. Strength and generation

- [x] Entropy from `32 x words / 3`, checksum/wordlist from the seed stack.
- [x] Recompute on input/paste; name a bad count, unknown word or bad checksum
      and disable Add.
- [x] Lazy-load `/seed.js` + `/seed-crypto.js`; generate only with
      `RotorSeedCrypto.generateBip39`; focus the field after generation.
- [x] Show the brute-force estimate as visible text; the shared tooltip carries
      the compact figure.

## 3. Derive into the vault

- [x] Chain -> BIP44 preset table for every supported wallet chain (15 slugs).
- [x] Refuse Zcash, Solana, Sui and TON with a message and a WIF/hex suggestion.
- [x] Derive key via `bip39Seed` + `bip32PrivateKey` with a wasm
      `derive_report` pubkey lookup; store the 64-hex key through one shared
      vault function used by both the WIF/hex form and the phrase action.
- [x] Clear the phrase and strength line on lock and after a successful add.

## 4. Tests, detector and docs

- [x] `apps/site/wallet-seed-test.mjs`: entropy table, 24-word generation and
      freshness, checksum validation and the exact chain -> path set.
- [x] Add the test to `projects.json`.
- [x] `wallet-seed-strength` detector in `scripts/ui-audit.mjs` plus the
      `wallet-seed-no-strength` ledger entry.
- [x] Site-map note, this change and the asset version bump.

## 5. Verification

- [x] `node --check` on `wallet.js` and `seed-crypto.js`.
- [x] New and existing wallet tests green.
- [x] Vectors: Ethereum `0x9858EfFD232B4033E47d90003D41EC34EcaEda94`,
      Bitcoin `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu`.
- [x] `node scripts/ui-audit.mjs --serve` at 0 violations.
- [x] Asset version, defect ledger, projects and site-map checks green.
- [x] `cargo test --release` (lib + coordinator_api).
