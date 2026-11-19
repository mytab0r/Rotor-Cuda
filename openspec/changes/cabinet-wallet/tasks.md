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
- [x] Bitcoin P2WPKH BIP143 sighash, DER with low-R, transaction serialization.
  - Published BIP143 Example 1 P2WPKH sighash
    `c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670` is a
    unit test; the unsigned serialization matches the BIP's transaction hex.
  - Two-input/one-input testnet signed and unsigned vectors were reproduced
    with bitcoinjs-lib 6 and pinned in `btc.rs` and `smoke.mjs`; every input
    signature verifies with the existing ECDSA verify and is low-S.
  - DER integers are minimal and low-S as produced by RFC6979. There is no
    low-R nonce grinding: RFC6979 fixes `r`, so grinding would break
    determinism and the published vectors.
  - Testnet derivation vectors for key 1 (P2PKH 0x6f, P2SH-P2WPKH 0xc4, P2WPKH
    and Taproot hrp `tb`, WIF 0xef) come from bitcoinjs-lib 6;
    `derive_report` mainnet output is pinned byte-identical by SHA-256.
  - ABI: `derive_report_network(ptr,len,curve,network)`, `btc_unsigned_tx`
    and `btc_sign_tx` (unprefixed lower-case hex); the uploaded request and
    the parsed key are wiped.
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

## 4. Bitcoin testnet (watch-only and send, testnet first)

- [x] `bitcoin-testnet` chain (label "Bitcoin testnet", curve 0, `btc_p2wpkh`,
      testnet explorer and API base); testnet WIF 0xef maps to it and derives
      through `derive_report_network(..., network=1)`; hex keys select it
      explicitly; mainnet WIF mappings are unchanged.
  - Groups, explorer links and opt-in balance use
    `https://mempool.space/testnet/api/address/<tb1>`; only the public address
    is sent.
- [x] UTXO fetch from mempool.space testnet and coin selection with change.
  - CORS verified on 2026-11-19 with `Origin: http://127.0.0.1:18321`:
    `GET /testnet/api/address/<tb1>/utxo` answers 200 with
    `access-control-allow-origin: *`; `GET /testnet/api/v1/fees/recommended`
    answers 200 with `*`; `POST /testnet/api/tx` with
    `Content-Type: text/plain;charset=UTF-8` (a safelisted type, so no
    preflight) answers 400 for a garbage body and still sends `*`, so the
    browser can read the provider error. No proxy and no Origin spoofing.
- [x] P2WPKH builder, BIP143 sign, review screen and raw hex.
  - Destination must decode as testnet v0 P2WPKH (`tb1q`, 20-byte program);
    bech32m/v1 and mainnet `bc1` are refused before any network read.
  - BTC is parsed to sats exactly (BigInt); fee rate is sat/vB; the default
    comes from `/api/v1/fees/recommended` (`halfHourFee`, falling back to
    `fastestFee`/`economyFee`/`minimumFee`) with a manual override.
  - Deterministic largest-first selection; P2WPKH vsize
    (110/141/178/209/277 vB for 1-2 inputs and 1-2 outputs); change back to
    the signing address; change below the 294-sat P2WPKH dust limit is not
    created and is added to the fee.
  - Review shows every input (txid:vout, value), every output, fee, fee rate,
    change, total input/spent and the exact unsigned hex from
    `btc_unsigned_tx`; the confirm step calls `btc_sign_tx` with exactly the
    reviewed request.
- [x] Direct `POST /api/tx` broadcast; explorer link and error states.
  - Signed raw hex is posted as text; the txid is validated and the result
    links to `https://mempool.space/testnet/tx/<txid>`; one send in flight,
    review invalidated on edits, wasm request buffers wiped.
- [ ] Test with a funded testnet key; dust/change/fee edge cases.
  - Not tested: a funded testnet broadcast and explorer confirmation, because
    no funded testnet key is available here. UTXO fetch and broadcast are
    mocked in `apps/site/wallet-btc-test.mjs`; the real unsigned/signed
    vectors run against the committed `apps/site/rotor_wasm.wasm` in
    `crates/rotor-wasm/smoke.mjs`.
  - Edge cases covered by unit tests: dust change to fee, no-change exact
    amounts, insufficient funds, largest-first ties, unconfirmed inputs,
    malformed UTXO responses and fee-rate parsing.
  - UI gate: headless Chrome at 375/768/1280 in light/dark against the built
    coordinator. No horizontal overflow (document or the BTC card), inputs
    labeled, tap targets >= 36 px, reduced motion 0 s, no console or network
    errors; the page loaded `wallet-btc.js` and parsed 0.0005 BTC as 50000
    sats. The live UTXO/broadcast calls were not exercised from the page
    because the vault was empty (no funded key).

## 5. Gate and rollout

- [x] UI gate 375/768/1280, light/dark, keyboard, reduced motion.
  - Verified in headless Chrome via playwright-core against the built
    coordinator: 32 checks (layout overflow at 375/768/1280 in both themes,
    Tab order, focus on Confirm after review, field and CORS errors, review and
    broadcast result, no reduced-motion animations in the send UI).
- [ ] Vault tests: wrong passphrase, tampered ciphertext, lock clears, export.
- [ ] Server log review: no secret material.
- [ ] Mainnet switch stays off until testnet evidence is recorded.
