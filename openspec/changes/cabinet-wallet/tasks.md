# Tasks

## 1. Vault and watch-only wallet

- [x] `/cabinet/wallet` page and nav entry; empty state and import dialog.
- [x] IndexedDB vault with PBKDF2-SHA256 600k + AES-GCM-256, random salt/IV.
- [x] Import WIF/hex, validate via WASM, auto-map WIF networks, label and remove.
- [x] Lock/unlock, idle auto-lock, pagehide cleanup, encrypted export/import.
- [x] Address list grouped by chain with balance, explorer link and copy.
- [x] No secret in URL, localStorage, logs or network; tests for the vault codec.

## 2. WASM signing core

- [x] secp256k1 deterministic ECDSA (RFC6979) sign/recover in `rotor-wasm`.
- [x] RLP encoder and EVM type-2 unsigned/signed serialization.
- [ ] Bitcoin P2WPKH BIP143 sighash, DER with low-R, transaction serialization.
- [x] Unit tests with published vectors; no network in the crate.

## 3. EVM send flow (testnet first)

- [ ] Network selector with Sepolia and public RPC; chain-id guard.
- [ ] Nonce, fee and balance fetch directly from the RPC with CORS.
- [ ] Builder form (to, value, data, gas limit), review screen and raw hex.
- [ ] Local sign, `eth_sendRawTransaction`, explorer link and error states.
- [ ] Test with a funded testnet key; document the provider and CORS behavior.

## 4. Bitcoin send flow (testnet first)

- [ ] UTXO fetch from mempool.space testnet and coin selection with change.
- [ ] P2WPKH builder, BIP143 sign, review screen and raw hex.
- [ ] Direct `POST /api/tx` broadcast; explorer link and error states.
- [ ] Test with a funded testnet key; dust/change/fee edge cases.

## 5. Gate and rollout

- [ ] UI gate 375/768/1280, light/dark, keyboard, reduced motion.
- [ ] Vault tests: wrong passphrase, tampered ciphertext, lock clears, export.
- [ ] Server log review: no secret material.
- [ ] Mainnet switch stays off until testnet evidence is recorded.
