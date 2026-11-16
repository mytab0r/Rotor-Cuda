# Tasks: private-key explorer

## 1. WASM derivation core (blocked by: —)
- [x] `derive_report(priv32, curve)` JSON ABI per design D3; keep the scan ABI
      untouched and the artifact under ~2 MB.
- [x] bech32 + bech32m (BIP173/BIP350), P2SH-P2WPKH, P2WPKH, taproot tweak
      (BIP341), TRON, EIP-55; reuse `base58::encode_check`/`wif_encode`.
- [x] ed25519-dalek (no default features) and Solana base58 address.
- [x] Fixtures: key 1 (P2PKH compressed/uncompressed, WIF, P2SH-P2WPKH,
      P2WPKH), BIP350/BIP341 vectors, EVM/TRON fixtures, ed25519/Solana
      fixture, 0 and n rejection. `cargo test -p rotor-wasm`, wasm build,
      Node smoke of `derive_report`.

## 2. Page and interaction (blocked by: 1)
- [x] `web/key.html` + `web/key.js`: input (hex/dec/WIF), random,
      curve select, wallet presets, rows with copy/details, WIF/hex/dec/bin.
- [x] Details per row: pubkey, hash160/keccak, payload, checksum, encoding,
      taproot internal/tweak/output, with short explanations.
- [x] Curve plot: small-field illustration with slider, real point hex, honest
      caption; responsive 375/768/1280.
- [x] Balances: offline by default; explicit check; mempool.space, EVM JSON-RPC
      (publicnode → dRPC → 1rpc fallback),
      Tronscan; per-row loading/error/empty; no key in any request.

## 3. Serving, docs and gates (blocked by: 2)
- [x] Embed `/key`, `/key.js`; nav link on all pages; content-type and asset
      tests.
- [x] README and `/docs` section: what is computed, privacy model, providers,
      "not a wallet, no sweeping", key handling advice.
- [x] Tests: Node page test with mocked providers; live browser check; 
      `impeccable detect` clean; fmt/clippy/test/CI green.
- [x] PR, merge, deploy via Watchtower, verify the live page.

## Out of scope
- Mnemonic/BIP32 paths, secp256r1/Cardano/Stellar, LTC/DOGE/BCH/XRP, "browse
  all keys" indexing, any signing/sweeping.

## Verification notes
- Host tests: 23 passed in `rotor-wasm`; independent bitcoinjs-lib/Python checks
  for key-1 addresses and taproot for keys 6 and 11 (odd-y lift).
- Browser: key 1/6/11 fixtures, WIF/decimal/0X input, +/-/random/clear, curve
  switch re-parses the field, presets list paths, 375/768/1280 with no
  overflow, no key in URL/storage/logs, balances opt-in and per-row.
- `impeccable detect --json` on `/key` and `/`: no findings.
