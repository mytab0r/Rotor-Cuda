# wallet delta

## ADDED Requirements

### Requirement: WalletConnect connection handoff

The cabinet MUST build the WalletConnect provider with `showQrModal: false`,
subscribe to `display_uri` and render its own panel. The panel MUST expose the
connection URI, a QR code, a copy action and deep links for MetaMask
(`https://metamask.app.link/wc?uri=`), Trust Wallet
(`https://link.trustwallet.com/wc?uri=`), Rainbow
(`https://rainbow.me/wc?uri=`) and Coinbase Wallet
(`https://go.cb-w.com/wc?uri=`), plus the generic `wc:` URI. Every link
builder MUST accept only a string that starts with `wc:`; an empty, non-string
or differently-schemed value MUST produce no link. On an
`Android|iPhone|iPad` user agent the panel MUST open the selected wallet deep
link instead of showing the QR code.

The required chain MUST stay `1`; `optionalChains` MUST cover 1, 56, 137,
42161, 10, 8453, 43114 and 324. After `connect()` the page MUST expose the
returned EVM accounts as-is and MUST NOT invent per-chain addresses.

#### Scenario: desktop QR and deep link
- GIVEN WalletConnect is configured and the visitor clicks the WalletConnect card on a desktop
- WHEN the relay emits `display_uri`
- THEN the panel shows a QR code, the URI with a copy action and four wallet deep links
- AND selecting a link opens that wallet app with the encoded URI

#### Scenario: mobile handoff
- GIVEN the visitor uses an Android, iPhone or iPad
- WHEN the URI arrives
- THEN the panel opens the selected wallet deep link automatically
- AND the QR code is not shown
- AND the audit proves this with an Android Chrome user agent, not only a narrow viewport

#### Scenario: expired URI
- GIVEN the panel has been waiting for about five minutes
- WHEN the URI expires without an approval
- THEN the panel says the URI expired and offers Regenerate
- AND the dead URI, QR code and wallet-link controls MUST be cleared
- AND Regenerate abandons the pending connection and shows a fresh URI
- AND the fresh URI restores the QR (desktop) or the wallet chooser (mobile)

#### Scenario: superseded connection attempt
- GIVEN `create()` is still resolving
- WHEN the visitor closes the panel, presses Regenerate or the URI expires
- THEN the provider created by the superseded attempt MUST be disconnected
- AND the relay socket MUST NOT be left open

#### Scenario: unexpected URI scheme
- GIVEN a caller passes `javascript:`, `data:`, an `http(s):` URL or a
  non-`wc:` string to a link builder
- WHEN the links are rendered
- THEN no anchor or navigation target is produced for that value

#### Scenario: rejected or failed request
- GIVEN a connected session or a relay failure
- WHEN the wallet rejects `personal_sign`
- THEN the page says the request was rejected and stores no token
- AND a relay or project-verification error is shown with its original message
