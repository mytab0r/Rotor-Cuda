# Tasks

## 1. Pure helpers and tests

- [x] `apps/site/wc-links.js`: `wallets`, `deepLink(id, uri)`,
      `genericLink(uri)` and `isMobile(userAgent)` with no DOM or network
      access.
- [x] `apps/site/wc-links-test.mjs`: wallet prefixes, URI encoding, empty and
      unknown inputs, generic link, Android/iPhone/iPad and desktop agents.
- [x] Register the script in `projects.json` (`node --check` and the unit test)
      and embed/serve it from the coordinator at `/wc-links.js`.

## 2. Bundle

- [x] `scripts/build-walletconnect.sh`: `showQrModal: false`, export `create`,
      `connect` and `toCanvas`, add `qrcode@1.5.4`, expand `optionalChains` to
      1, 56, 137, 42161, 10, 8453, 43114, 324 with `chains: [1]`.
- [x] Rebuild and commit `apps/site/walletconnect.js`.

## 3. Cabinet panel

- [x] `monitor.html`: WalletConnect panel with status, error, QR canvas,
      mobile wallet chooser, desktop deep links, URI copy and Regenerate.
- [x] `monitor.js`: `create()` then `display_uri`, own QR paint, deep links,
      mobile auto-navigation, accounts list, expiry timer, regenerate, close.
- [x] Keep the SIWE challenge / `personal_sign` / login flow unchanged; surface
      relay and verify errors verbatim.
- [x] `site.css`: panel uses the token scales, 44px controls, `.chip` links and
      the shared `.icon-button` copy action.

## 4. Docs and verification

- [x] `docs/ops/admin-cabinet.md`: project allowlist, chains, manual tests.
- [x] `node apps/site/wc-links-test.mjs` and `node --check` on changed files.
- [x] `cargo test --release --test coordinator_api` (37 passed).
- [x] `node scripts/check-projects.mjs`, `node scripts/check-ssot.mjs`,
      `node scripts/check-defect-ledger.mjs`.
- [x] `node scripts/ui-audit.mjs` PASS with `/cabinet` in the audited routes
      (full suite: 288 page runs across 48 routes; final `/cabinet` 6/6). The
      detector now captures the ready and expired panel screenshots as CI
      artifacts.

## 5. Independent-review follow-ups

- [x] `wc-links.js`: one `uriText()` scheme guard; `deepLink` and
      `genericLink` accept only strings starting with `wc:`; tests cover
      `javascript:`, `data:`, `http(s):`, uppercase `WC:` and non-string input.
- [x] `monitor.js`: one `wcDisconnect()` helper for every abort path, and the
      generation-mismatch finalizer disconnects a provider created while the
      attempt was being invalidated.
- [x] `monitor.js`: expiry clears `wcFlow.uri`, the URI text, the QR block and
      the wallet-link/mobile blocks; Regenerate restores a fresh ready state.
- [x] `ui-audit.mjs`: the `walletconnect-handoff` detector runs `/cabinet` at
      375 with an Android Chrome UA, asserts the 44px mobile chooser and the
      MetaMask deep-link navigation, asserts desktop still shows a QR with no
      navigation, asserts expiry clears the URI/QR/links, and asserts an
      aborted `create()` disconnects its provider. Verified by mutation:
      forcing the mobile branch off fails the audit, restoring it passes.
