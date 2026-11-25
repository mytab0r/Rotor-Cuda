# What's new for users

The human-readable changelog. `CHANGELOG.md` is the technical history generated
from commits; this page answers two questions: what can a visitor or wallet
user do now that they could not before, and what changed in the interface.
Every release adds a section here, filled from the `## For users` line of each
pull request (the PR template asks for it; "No user-visible change" is a valid
answer).

## Unreleased

Nothing yet.

## 2.7.0 — 2026-11-25

### Wallet

- **Swap on TRON mainnet** from the cabinet wallet: pick TRX, USDT or USDC in
  and out, get a SunSwap V2 quote with the route, the expected and minimum
  amount at your slippage, then review and sign. A token-in swap asks you to
  approve the router first and says so on the review screen. (ROT-520)

## 2.6.0 — 2026-11-25

### Site

- The documentation page is split into sections with a table of contents, so a
  long page can be scanned instead of scrolled.
- The puzzle hub no longer carries the team console: `/run` owns token issuance,
  the CLI walkthrough and the job board, and the hub links there.

## 2.5.0 — 2026-11-25

### Site

- The landing page has one Contribute entry and the real tool cards (Milk Sad,
  seed phrase, vanity, brainwallet, security advisories) instead of a row of
  unrelated links.

## 2.4.0 — 2026-11-25

### Wallet

- Send **TRX and USDT (TRC-20) on TRON mainnet** from a key imported into the
  cabinet vault, with the same review screen and mainnet arm checkbox as EVM.
  The Nile testnet route stays available without arming. The key never leaves
  the browser; the page reads the latest block from TronGrid (publicnode as
  failover) and broadcasts once. (ROT-513)

### Site

- The landing "Puzzles" card no longer reserves empty space: the status line,
  the buttons and the caption now sit together instead of leaving a 66px gap.
  (ROT-533)

## 2.3.1 — 2026-11-24

No user-visible change. Board automation, the work-claim protocol and CI gate
fixes.

## 2.3.0 — 2026-11-24

No user-visible change. Board field hygiene and the product-split milestone.
