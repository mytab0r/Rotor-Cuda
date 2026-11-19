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

- [x] Network selector with Sepolia and public RPC; chain-id guard.
- [x] Nonce, fee and balance fetch directly from the RPC with CORS.
- [x] Builder form (to, value, data, gas limit), review screen and raw hex.
- [x] Local sign, `eth_sendRawTransaction`, explorer link and error states.
- [ ] Test with a funded testnet key; document the provider and CORS behavior.
  - Providers verified with a real Chrome page (Origin `http://127.0.0.1:18321`
    and `18322`) on 2026-11-19: `ethereum-sepolia-rpc.publicnode.com`,
    `1rpc.io/sepolia` and `sepolia.gateway.tenderly.co` all answer
    `eth_chainId` with `0xaa36a7` and allow CORS. `rpc.sepolia.org` returns
    HTTP 404 and `sepolia.drpc.org` refuses Sepolia on its free plan, so neither
    is offered.
  - Read path (chain id, nonce, balance, `eth_feeHistory`,
    `eth_maxPriorityFeePerGas`, `eth_estimateGas`) verified through
    `wallet-evm.js` in the browser against the live providers.
  - Unsigned vector (also in `evm.rs`, `lib.rs` and `smoke.mjs`):
    `0x02f183aa36a780843b9aca00847735940082520894353535353535353535353535353535353535353587038d7ea4c6800080c0`.
  - Signed broadcast from a fresh random unfunded key was rejected by
    publicnode with the exact error
    `insufficient funds for gas * price + value: have 0 want 525000`.
  - Not tested: a funded broadcast and explorer confirmation, because no funded
    Sepolia key is available here. Mainnet signing remains disabled.

## 4. Bitcoin send flow (testnet first)

- [ ] UTXO fetch from mempool.space testnet and coin selection with change.
- [ ] P2WPKH builder, BIP143 sign, review screen and raw hex.
- [ ] Direct `POST /api/tx` broadcast; explorer link and error states.
- [ ] Test with a funded testnet key; dust/change/fee edge cases.

## 5. Gate and rollout

- [x] UI gate 375/768/1280, light/dark, keyboard, reduced motion.
  - Verified in headless Chrome via playwright-core against the built
    coordinator: 32 checks (layout overflow at 375/768/1280 in both themes,
    Tab order, focus on Confirm after review, field and CORS errors, review and
    broadcast result, no reduced-motion animations in the send UI).
- [ ] Vault tests: wrong passphrase, tampered ciphertext, lock clears, export.
- [ ] Server log review: no secret material.
- [ ] Mainnet switch stays off until testnet evidence is recorded.
