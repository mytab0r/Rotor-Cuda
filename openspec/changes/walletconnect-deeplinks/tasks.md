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
