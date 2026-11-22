# Tasks: WIF keys on the EVM and TRON testnet send routes

Legend: `[ ]` pending, `[x]` done. One writer (developer) owns the keys parser,
the page copy and the send test; no other area changes.

## 1. Key parser (`apps/site/send.js`)

- [x] `parseSecret` for `isEvmChain`/`isTronChain`: 64-hex first, then a
      Bitcoin WIF (`0x80`/`0xef`, compressed or uncompressed, checksum
      verified); same `{chain, keyBytes, keyHex}` shape; other versions
      rejected. Evidence: `apps/site/send.js`.
- [x] Factor `deriveAddress(wasm, keyBytes, chain)` out of `init` and use it in
      the page so the Node test runs the same derive. Evidence:
      `apps/site/send.js`.
- [x] `keyLooksComplete` recognises a WIF on every send route. Evidence:
      `apps/site/send.js`.

## 2. Page copy (`apps/site/send.html`, `apps/site/send.js`)

- [x] Label `Testnet WIF or 64-hex key` on every route; helper text lists WIF
      first. Evidence: `apps/site/send.html`, `CHAINS[*].keyLabel`.
- [x] One-line notice when a WIF is accepted on EVM/TRON, hidden otherwise and
      cleared with the key. Evidence: `#send-wif-notice`, `setWifNotice`.

## 3. Tests (`apps/site/send-test.mjs`)

- [x] Published WIF vectors (mainnet/testnet, compressed/uncompressed), bad
      checksum, foreign version. Evidence: send-test output.
- [x] Hex/WIF parity for EVM and TRON through the real WASM derive; TRON
      vector `TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC`. Evidence: send-test output.
- [x] `keyLooksComplete` and the unchanged Bitcoin testnet-only rule; TRON
      signing review from a WIF-parsed key. Evidence: send-test output.

## 4. Docs and gates

- [x] Update the `docs/site-map` notes. Evidence: `docs/site-map/site-map-data.js`.
- [x] Bump `asset_version` and every `?v=` token. Evidence:
      `node scripts/check-asset-version.mjs`.
- [x] `node --check apps/site/send.js`; all site suites (including
      `send-test`); `cargo test --test coordinator_api --test coordinator_client`;
      `node scripts/ui-audit.mjs --serve`; `node scripts/check-projects.mjs`;
      `node scripts/check-defect-ledger.mjs`; screenshots of `/send/tron` with
      a WIF pasted. Evidence: commands and the PR.
