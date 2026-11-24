# What's new for users

The human-readable changelog. `CHANGELOG.md` is the technical history generated
from commits; this page answers two questions: what can a visitor or wallet
user do now that they could not before, and what changed in the interface.
Every release adds a section here, filled from the `## For users` line of each
pull request (the PR template asks for it; "No user-visible change" is a valid
answer).

## Unreleased

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
