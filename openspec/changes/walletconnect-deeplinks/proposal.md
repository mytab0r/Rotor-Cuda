# WalletConnect sign-in: own panel and wallet deep links

## Summary

Replace the built-in WalletConnect modal on the `/cabinet` sign-in card with an
explicit panel. The panel always exposes the connection URI (`display_uri`), a
QR code, a copy action and "Open in <wallet>" deep links, and opens the selected
wallet app directly on mobile instead of asking the visitor to paste the URI
into the wallet's dapp browser.

The SIWE flow after `connect()` stays unchanged: request a challenge, sign it
with `personal_sign`, exchange it for a session token.

## Why

On the cabinet sign-in card, choosing a wallet in the built-in modal did not
open the wallet app. The visitor had to discover the wallet's dapp browser and
paste the URI by hand, which is not how other dapps behave. The built-in modal
also hid relay and project-verification errors behind its own UI.

## Goals

1. Build the provider with `showQrModal: false`, subscribe to `display_uri` and
   render an own panel: QR code, copy button, MetaMask / Trust Wallet / Rainbow
   / Coinbase Wallet deep links and a generic `wc:` link.
2. On a mobile user agent (`/Android|iPhone|iPad/`) navigate to the selected
   wallet deep link instead of showing the QR code.
3. Panel states: loading, ready, error (relay/verify messages shown verbatim)
   and expired URI (about five minutes) with a Regenerate action.
4. Keep the SIWE steps unchanged; expose the connected EVM account list without
   inventing per-chain addresses.
5. Expand `optionalChains` to every EVM chain the site supports (1, 56, 137,
   42161, 10, 8453, 43114, 324) and keep `chains: [1]` required.
6. Put the deep-link builder and mobile detection in a pure
   `apps/site/wc-links.js` with unit tests, served by the coordinator and loaded
   before the bundle.
7. Rebuild the committed `apps/site/walletconnect.js` with
   `sh scripts/build-walletconnect.sh`.

## Non-goals

- Driving a real wallet from the headless UI audit. A browser cannot approve a
  WalletConnect session, so the handoff and signature stay a human check.
- Solana, TRON, Bitcoin or account abstraction over WalletConnect. EVM only.
- Persisting the WalletConnect session across page reloads.
- Any new provider, RPC endpoint or key pair; no secret enters the page.

## Areas

`site`, `coordinator`, `ops` (docs, projects map, spec).

## Acceptance

- Desktop: QR plus a working deep link for every listed wallet.
- Mobile: choosing a wallet opens its app with the connection request.
- Expired URI: the panel says so and regenerates a fresh URI.
- Rejected signature: a friendly message; no token is stored.
- Relay/verify errors: shown unchanged.
- `node apps/site/wc-links-test.mjs`, `cargo test --release --test
  coordinator_api`, `check-projects`, `check-ssot`, `check-defect-ledger` and
  `ui-audit --serve` pass.
