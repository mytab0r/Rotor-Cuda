# Density parity: the BTC legacy listing row

Rework of the `/private-keys/bitcoin` row after the owner's screenshot review:
both address forms must be visible at once, the `received` noise replaced by
the donor's balance + TX model, and the layout made explicit rather than
cramped. Measured on 2026-11-22 with `scripts/density-parity.mjs` (headless
Chrome 131, DevTools protocol, one page load per viewport).

- Donor: <https://privatekeyfinder.io/private-keys/bitcoin>
- Ours: `http://127.0.0.1:7915/private-keys/bitcoin` (`target/release/rotor-coord`)
- Branch: `parity/btc-legacy-row-r28` from `origin/main` (`2877bdc`)
- Raw reports:
  [`density-bitcoin-row-before.json`](density-bitcoin-row-before.json) and
  [`density-bitcoin-row-after.json`](density-bitcoin-row-after.json)
- Command (same for both runs; only the served revision differs):

  ```sh
  node scripts/density-parity.mjs \
    --donor https://privatekeyfinder.io/private-keys/bitcoin \
    --ours http://127.0.0.1:7915/private-keys/bitcoin \
    --json docs/donor-parity/density-bitcoin-row-after.json
  ```

## Donor accessibility and row model

The donor loaded and resolved on this run. The density script measured
`rowH 96` at 1440/1280 and `226` at 375. A separate headless Chrome DOM dump
(`--virtual-time-budget=20000`) confirmed the resolved state: **60 `.key-row`**,
**120 `.address-item`**, **120 `.balance-info`**, zero `Calculating...`.

| aspect | donor measurement / source |
|---|---|
| keys per page | **60** (`KEYS_PER_PAGE=0x3c` in `app.obf.js`; 60 `.key-row` in the served HTML) |
| addresses per legacy BTC key | **2** — the compressed and uncompressed P2PKH address |
| addresses per page (legacy BTC) | **120** (60 × 2; verified in the resolved DOM) |
| columns | `.col-key` 1.6fr, `.col-address` 0.9fr, `.col-balance` `minmax(200px,auto)` on `.key-row` (the header uses 180px); `gap: 1rem` |
| row height | 96px at 1440×900 and 1280×800; 226px at 375×812 |
| address cell | both addresses visible at once as `.address-item` `(c)`/`(u)`, each with an explorer `.address-link` and a `copy-btn`; no `<details>`, `summary`, `aria-expanded` or second row |
| key cell | hex key plus `(c)`/`(u)` WIF lines, each with a copy action (WIF stays key-level) |
| balance cell | one `.balance-info` line per address, `<br>`-separated; balance `.bal`, TX count `.tx`, received `.recv` |
| balance emphasis | `.bal.has-balance`: amber `#d97706`, white, 600; `.tx.has-tx`: blue `rgba(59,130,246,.9)`, 500; `.recv.has-recv`: green `rgba(34,197,94,.9)`, 500. Pills are `border-radius:.2rem`, `padding:.1rem .35rem`, 12px text |
| received | rendered **only when the amount is non-zero**; no zero received figure, no relative-age label |
| TX counts | **one** count (`n_tx` from blockchain.info /balance). The donor has no separate incoming/outgoing counts; it uses the exchange-icon count with the received amount |
| copy actions | 12px icon, `opacity:0` until row hover; the key-cell copy is the same |

The donor's "incoming/outgoing transaction counts" in the owner's description
is one TX badge with the exchange icon; the per-address received amount is the
green down-arrow badge and appears only above zero. The implementation follows
the measured DOM, not a guessed two-count model.

## Before / after (ours) and donor column

`rowH` is the script's median across all 60 rows. "Addresses above the fold" is
`visible rows × addresses per row` (2 for legacy BTC).

| viewport | side | rowH | chrome | visible rows | addresses above fold | document height | density ratio |
|---|---|---:|---:|---:|---:|---:|---:|
| 1440×900 | donor | 96 | 836 | 1 | 2 | 6942 | 1.00 |
| 1440×900 | ours before | 61 | 746 | 3 | 3 | 4754 | 3.36 |
| 1440×900 | ours after | **110** | **746** | **2** | **4** | **7657** | **2.24** |
| 1280×800 | donor | 96 | 885 | 0 | 0 | 6991 | - |
| 1280×800 | ours before | 61 | 746 | 1 | 1 | 4754 | - |
| 1280×800 | ours after | **110** | **746** | **1** | **2** | **7657** | - |
| 375×812 | donor | 226 | 1321 | 0 | 0 | 15411 | - |
| 375×812 | ours before | 146 | 1394 | 0 | 0 | 10527 | - |
| 375×812 | ours after | **238** | **1422** | 0 | 0 | **15949** | - |

Rows are 14px taller than the donor's at desktop because each of the two
address lines keeps the project's 44px touch floor (the donor's copy icon is
12px and hover-revealed). The page still shows **more** addresses above the
fold than the donor at 1440 (4 vs 2) and 1280 (2 vs 0). Document height is
now 10% above the donor's, from 32% below before: the information that used to
be hidden is in the document.

## Row model after

- 60 keys per page (unchanged, matching the donor). A legacy BTC page declares
  and renders **120 addresses** (`data-addresses-per-page="120"`,
  `data-addresses-per-key="2"`); a single-address chain declares and renders
  **60**.
- Both addresses render on first paint: `.col-address > .addr-line`, each with
  `(c)`/`(u)`, `a.address-link[title]` and a 44×44 `Copy compressed address` /
  `Copy uncompressed address` action. No disclosure, no `aria-expanded`, no
  hidden copy.
- Balance cell: one `.balance-info` per address, in the same order. Balance is
  bold/tabular; the TX count is a shared `.badge` with `aria-label="N
  transactions"`; received is a `.badge` with `aria-label="Received …"` and is
  omitted at zero. The relative-age label is removed.
- Grid: `minmax(0,2.2fr) minmax(0,1.9fr) minmax(240px,auto)`, one 16px gap;
  address column 425-428px at 1280, enough for a 34-char base58 address plus
  the label and action. Numbers are tabular; the action sits at the trailing
  edge of each line.
- The page counter now reads `Bitcoin keys page #1 out of #… · 120 addresses`;
  `browse.js` updates both the label and `data-addresses-per-page` from the
  rendered lines.

## Change list

| # | change | evidence | risk / re-check |
|---:|---|---|---|
| 1 | Both legacy addresses visible immediately; disclosure removed. | Resolved donor DOM: 120 `.address-item` across 60 rows, no `aria-expanded`. Detector `browse-row-address-count`; static guard in `check-token-usage.mjs`. | Rows are 110px, not 61; 4 addresses above the fold at 1440 vs 3 before. |
| 2 | Balance cell: balance + TX badge + received badge (only >0); zero received and relative age removed. | Donor `app.obf.js` `balance-info` template and CSS `.bal.has-balance` / `.tx.has-tx` / `.recv.has-recv`; `balanceLine()` in `browse.js`. Detector `browse-row-balance-lines`. | Provider failure still renders `unavailable` + retry; no invented zero. |
| 3 | Explicit grid columns, one gap, title on the address link, tabular numbers, trailing actions. | `site.css` `grid-template-columns` and `.addr-label` / `.addr-line`; measured widths 425-428px at 1280, no overflow at 375/768. | Audit PASS at 375/768/1280 both themes. |
| 4 | Page total declared and honest: 120 addresses for legacy BTC, 60 for one-address chains. | `data-addresses-per-page`, `#page-address-count`; rendered counter assertion in `ui-audit.mjs`; Rust route test. | Last finite-chain page computes the real row count server-side. |
| 5 | Detectors: disclosure-specific rule replaced by the visible-address model; balance-split replaced by balance-lines; height ceiling 120 with a <=2px spread. | `scripts/ui-audit.mjs`; ledger entry updated; `browse-row-address-count` static guard. | This is a model change, not a threshold weakening: the new rule checks 2 visible lines, labels, links, titles, two 44px copies and the page total. |

## Deviations and not copied

- Rows are 110px vs the donor's 96px: our address and key copy actions stay at
  the 44px touch floor; the donor uses a 12px icon revealed on row hover.
- The listing key cell is HEX + copy only; WIF stays on `/key/<hex>` (existing
  project deviation, guarded by `browse-row-wif`).
- The donor has one TX count, not separate incoming/outgoing counts. We match
  that and label the pill for assistive tech instead of inventing a fourth
  figure.
- The donor's pills are 3.2px-radius neutral chips; ours use the shared
  `.badge` status grammar (20px high, pill radius, 12px text) with semantic
  colours, per the design system.
- Accent colours are deliberately swapped from the donor: the donor paints the
  balance amber and the TX count blue; ours paints a positive balance with the
  semantic `--ok` (green) and the TX badge with the single project signal colour
  (`--signal`, amber). This is the design-system semantics (positive = ok, one
  signal colour for the badge), not a bug.
- The donor's mobile row is 226px; ours is 238px for the same 44px-floor
  reason. `browse-row-height` is a desktop-only check (`innerWidth >= 1000`);
  mobile rows vary 219–238 because the two 44px action lines stack and the
  detector intentionally does not apply a desktop ceiling there.

## Verification

- `node scripts/ui-audit.mjs --base http://127.0.0.1:7915 --routes private-keys/bitcoin --viewports 375,768,1280 --themes dark,light`
  -> `ui-audit PASS: 6 page runs across 1 route(s), no violations.`
- Full `node scripts/ui-audit.mjs --serve` ->
  `ui-audit PASS: 234 page runs across 39 route(s), no violations.`
- Site suites: `search-test`, `worker-test`, `puzzle-worker-test`,
  `key-tools-test`, `keystore-parser-test`, `address-codecs-test`, `seed-test`,
  `mnemonic-seeds-test`, `balance-cache-test`, `brainwallet-test`,
  `wallet-vault-test`, `wallet-evm-test`, `wallet-mainnet-test`,
  `wallet-btc-test`, `wallet-seed-test`, `send-test`, `tx-test`, `amount-test`,
  `vanity-test`, `qr-test`, `site-nav-test` all pass.
- `cargo test --release --test coordinator_api` -> 33 passed, 0 failed.
- `node scripts/check-token-usage.mjs`, `node scripts/check-defect-ledger.mjs`,
  `node scripts/check-projects.mjs`, `node scripts/check-ssot.mjs`,
  `node scripts/build-tokens.mjs --check`, `node scripts/gen-ssot.mjs --check`
  -> pass.
- Evidence: screenshots are produced by the PR's `ui-audit` CI run and attached
  as the `ui-audit-report-<run id>` artifact; they are never committed. A
  before/after pair is attached to the same PR when the audit is run against
  both revisions.
