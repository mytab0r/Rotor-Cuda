# Wallet prose: progressive disclosure on /cabinet/wallet

## Why

Owner feedback: on the functional wallet page (`/cabinet/wallet`) walls of
explanatory prose sit between the user and the controls; on a phone the buttons
are several screens down. The design system already has the primitives for
progressive disclosure (`.popover` §3.14, `.tooltip`, `.icon-button` §3.2,
`<details>` on the key page) but no rule said when prose must move behind them.
DESIGN-SYSTEM.md now has that rule (§3.19 Progressive disclosure); this change
applies it to the wallet page.

## Rule being applied (DESIGN-SYSTEM.md §3.19)

- An Operate surface shows at most one inline guidance sentence of ≤140
  characters per card.
- Longer explanation goes into a `<details><summary>` below the card's
  controls, or a `.popover` anchored to an info `.icon-button`
  (`aria-label` required, `data-tooltip` optional, no native `title`).
- Safety-critical text stays inline: the mainnet arm label ("cannot be
  reversed"), "losing the passphrase loses the keys", "importing replaces this
  browser's vault".
- At 375px the first interactive control of a card is reachable without
  scrolling past more than one line of prose.
- `<summary>` keeps a visible focus ring and a 44px touch target.

## Inventory (current state, measured on `apps/site/wallet.html`)

Text length in characters after tag stripping and whitespace folding.
"Destination" is per §3.19: `inline` = rewrite to a ≤140-char one-liner,
`details` = move the body into a `<details>` below the card's controls,
`popover` = move behind the info `.icon-button`.

| Block (card / id) | Before | After | Destination |
| --- | --- | --- | --- |
| Top notice (`p.notice role=note`) | 1044 | 88 inline + `details` | safety sentence inline ("Losing the passphrase loses the keys…"), rest → `details` under the notice |
| Restore onboarding (`#wallet-onboard-help`) | 336 | 85 | inline one-liner + `details` |
| Create-vault help (`#wallet-pass-help`) | 157 | 130 | inline, shortened to ≤140 |
| Unlock card trailing note | 134 | 134 | inline already (≤140, auto-lock safety) |
| Assets help (`#wallet-assets-help`) | 518 | 95 | inline one-liner + `details` |
| Import help (`#wallet-import-help`) | 549 | 75 | inline one-liner + `details` |
| Seed strength popover body (`#wallet-seed-estimate`) | 192 | 0 | `popover` on the existing `#wallet-seed-info` icon-button |
| Seed help (`#wallet-seed-help`) | 295 | 110 | inline one-liner + `details` |
| Lookup note (`#wallet-lookup-note`) | 376 | 85 | inline one-liner + `details` |
| Summary help (`#wallet-summary-help`) | 344 | 80 | inline one-liner + `details` |
| History help (`#wallet-history-help`) | 533 | 105 | inline one-liner + `details` |
| Sign-in help (`#wallet-signin-help`) | 509 | 100 | inline one-liner + `details` |
| Security help (`#wallet-security-help`) | 401 | 95 | inline one-liner + `details` |
| Send intro (after "Send an EVM transaction") | 336 | 120 | inline one-liner + `details` |
| Network/arm/token paragraph (`p.muted` "Sepolia is the default…") | 873 | 95 | arm checkbox label stays inline verbatim (safety), paragraph → one-liner + `details` |
| Gas/fee paragraph ("Empty gas limit uses…") | 451 | 0 | `details` |
| Review note ("Confirm signs these exact reviewed values…") | 86 | 86 | inline already (≤140) |
| Approvals intro (after "ERC-20 approvals") | 782 | 115 | inline one-liner (danger sentence) + `details` |
| Approvals validation paragraph | 288 | 0 | `details` |
| Grant intro ("This gives another address permission…") | 428 | 110 | safety sentence inline + `details` |
| Grant constraints ("A zero allowance is refused…") | 181 | 0 | `details` |
| BTC intro (after "Send a Bitcoin testnet transaction") | 327 | 90 | inline one-liner + `details` |
| BTC parsing paragraph | 319 | 0 | `details` |
| Restore note ("Importing replaces this browser's vault…") | 91 | 91 | inline already (safety) |
| "What is stored" (`#wallet-btc` backup column) | 291 | 0 | `details` in the backup card |
| "What this page signs" | 349 | 0 | `details` in the backup card |
| **Total** | **10190** | **~1890** | ≈81% of prose leaves the direct path to controls |

## Out of scope

- `apps/site/wallet.js` text injected at runtime (`role="status"` lines,
  warnings) — status lines are not guidance prose.
- Any other page; other surfaces adopt §3.19 via `docs/design-system/plan.md`.
- The `prose-before-control` detector named in §3.19 — a separate change once a
  vault-session hook lands in `scripts/ui-audit.mjs`.

## Risks

- Rewrites must not weaken a safety statement: the arm label, passphrase-loss
  and import-replace sentences move verbatim or not at all.
- `<details>` content stays in the accessibility tree and searchable; only the
  default-open state changes.
