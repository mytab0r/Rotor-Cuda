# Design: WalletConnect panel and deep links

## Bundle boundary

`scripts/build-walletconnect.sh` builds `apps/site/walletconnect.js` from
`@walletconnect/ethereum-provider@2.26.0` plus `qrcode@1.5.4` (bundled, no
network at runtime). The entry exports three functions:

| Export | Purpose |
| --- | --- |
| `create({projectId, metadata})` | `EthereumProvider.init` with `showQrModal: false`, `chains: [1]` and the eight-chain `optionalChains`. Returns the provider before `connect()`. |
| `connect(provider)` | `provider.connect()`; rejects on relay/verify failure. |
| `toCanvas(canvas, uri)` | Paints the connection URI as a QR code into the panel canvas. |

Returning the provider before `connect()` is what lets monitor.js subscribe to
`display_uri` first. With `showQrModal: true` the modal owns that event and the
page never sees the URI.

## Pure helpers

`apps/site/wc-links.js` has no DOM or network access:

- `wallets` - `[{id, name}]` for MetaMask, Trust Wallet, Rainbow and Coinbase
  Wallet.
- `deepLink(id, uri)` - the documented prefix plus `encodeURIComponent(uri)`;
  an empty string for an unknown id or a missing URI.
- `genericLink(uri)` - the bare `wc:` URI, handled by the OS or an installed
  wallet.
- `isMobile(userAgent)` - `/Android|iPhone|iPad/`.

Both link builders funnel through one `uriText()` guard that accepts only a
string starting with `wc:`. `javascript:`, `data:`, `http(s):` or any other
scheme produces an empty link, so a caller cannot turn an unexpected value into
an anchor href or a `location.href` target. Empty and non-string input stays
empty as before.

The coordinator embeds and serves the file at `/wc-links.js`; `monitor.html`
loads it before `/cabinet.js`, and `apps/site/wc-links-test.mjs` unit-tests the
four helpers.

## Panel states

| State | Visible | Action |
| --- | --- | --- |
| loading | status line | none; the WalletConnect card is busy |
| ready | QR (desktop) or wallet chooser (mobile), links, URI, copy, expiry note | scan, copy, or open a wallet |
| expired | status line + Regenerate | abandons the pending connect and starts a new one |
| error | status line + the relay/verify message verbatim | close and retry |
| connected | status line + the EVM account list | the wallet signs the SIWE challenge |

The expiry delay comes from `expiryTimestamp` in the URI, falling back to five
minutes. Expiry disconnects the pending provider, invalidates that run with a
generation counter, clears `wcFlow.uri`, empties the URI text and hides the QR,
wallet-link and mobile-chooser blocks; Regenerate reopens the panel and a fresh
`display_uri` restores them. Closing the panel does the same without showing an
error.

Every disconnect path (close, regenerate, expiry, finalizer) goes through one
`wcDisconnect()` helper. When an attempt is invalidated while `create()` is
still resolving, the provider is not yet reachable through `wcFlow.provider`,
so the finalizer disconnects it explicitly instead of leaking the relay
socket.

Mobile auto-navigation happens once, when the URI arrives: the panel reads the
selected wallet from its chooser and assigns `location.href`. Selecting another
wallet later navigates too. Desktop never navigates; it shows the QR and links.

## Accounts and SIWE

`provider.accounts` is read after `connect()` and filtered to non-empty strings.
The list is rendered as-is: EVM has one address for all namespaces, so no
per-chain account is derived. The existing challenge / `personal_sign` / login
calls are unchanged; the panel only displays progress.

## Errors

Rejections and timeouts keep the friendly "nothing was sent to Crypto" copy.
Every other error (relay unreachable, project id rejected, origin not
allowlisted) is rendered with its original message because it is the operator's
diagnostic.

## Evidence

A headless browser cannot approve a WalletConnect session. The UI audit stubs
`create`/`connect`, emits a real `display_uri` and the bundled QR renderer, then
asserts the desktop QR/links, the copy and regenerate geometry, the expired
state, and the URI/control cleanup. The 375 run of `/cabinet` swaps the user
agent to Android Chrome so the mobile chooser, its 44px targets and the
MetaMask deep-link navigation are exercised, and a controlled `create` proves
that aborting a superseded attempt disconnects its provider. A real-wallet
approval and signature stay manual checks, recorded in
`docs/ops/admin-cabinet.md` and the PR.
