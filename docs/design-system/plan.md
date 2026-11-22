# Design-system implementation plan

Version: 1.0. Date: 2026-11-21.
Inputs: `docs/design-system/inventory.md`, `docs/design-system/DESIGN-SYSTEM.md`.
Rule for every batch: **no behaviour change**. A batch may normalise geometry,
colour, type and states; it may not change what a control does, what data is
shown, or which routes exist.

## 0. How a batch runs

1. **Owner** (one agent, one worktree) edits only the family's files. The main
   session does not hand-code; it assigns, reads evidence and commits.
2. **Detector first.** Add or extend the check in `scripts/ui-audit.mjs` (or
   another gate), add the entry to `docs/process/defects.json`, and run
   `node scripts/check-defect-ledger.mjs`.
3. **Owner verification.** Run the family routes in `scripts/ui-audit.mjs` at
   375/768/1280 in dark and light. Paste the command and the result, not a
   claim.
4. **Independent review.** A **different** agent (`critic`) opens the built
   pages, screenshots the affected blocks at 375/768/1280 in both themes, and
   pastes computed geometry: control sizes, radii, paddings, overflow
   (`scrollWidth`/`clientWidth`), column spreads, and remaining violation IDs.
   The author never approves their own UI PR.
5. **Area checks.** Run the `site` build/test commands from `projects.json`,
   then `node scripts/check-projects.mjs`. Never add a `?v=` cache token: HTML
   references assets as `/a/<build>/<path>` (immutable).
6. **Commit/PR.** One family per PR. The PR body names the family, the files,
   the detector, the audit command and the reviewer's geometry. No attribution
   trailers.

Definition of done for a batch:

- [ ] The family uses only the tokens in `DESIGN-SYSTEM.md` §2 (or a documented
      component alias).
- [ ] No old selector for the family remains in the audited routes; page-local
      CSS for the family is deleted in the same PR.
- [ ] The new detector exists, the ledger entry exists, and both pass on the
      route set.
- [ ] `ui-audit` exits 0 for the family routes at 375/768/1280 dark/light, or
      the PR names every pre-existing violation outside the family.
- [ ] Reviewer screenshots + computed geometry are in the PR.
- [ ] `node --check`, site tests, `check-defect-ledger`, `check-projects` pass.
- [ ] Asset version bumped once, everywhere.

## 1. Ordered batches

| # | Family | Owner | Reviewer | Depends on | Detector(s) |
|---|---|---|---|---|---|
| 0 | Foundation docs (this run) | design-system lead | `critic` | — | — |
| 1 | Tokens + status/badges + status lines (this run) | design-system lead | `critic` | tooltip PR not touched | `status-pill-geometry` |
| 2 | Icon buttons + tooltip primitive | `developer` | `critic` | tooltip PR merged; `#key-info-btn` area excluded | `icon-button-scale`, `adjacent-icon-gap`, `tooltip-naming` |
| 3 | Forms, fields, segmented controls, chips | `developer` | `critic` | batch 1 tokens | `control-height-scale`, `field-geometry`, `segmented-geometry` |
| 4 | Cards and stat blocks | `developer` | `critic` | batch 1 tokens | `stat-geometry`, `card-padding-scale` |
| 5 | Tables and rows | `developer` | `critic` | batch 1 tokens | `table-header-style`, `table-row-height`, `row-action-geometry` |
| 6 | Navigation, breadcrumbs, pagination, footer | `developer` | `critic` | batches 2–5 (shared link/button grammar) | `nav-link-height`, `breadcrumb-grammar`, `breadcrumb-current`, `pager-grammar`, `pager-geometry`, `footer-presence` |
| 7 | Cleanup and final sweep | design-system lead + `developer` | `critic` | batches 1–6 | `radius-scale`, `raw-hex-outside-root`, `legacy-selector` |

Ordering rationale: tokens first; then the smallest self-contained family
(status/badges); then the highest-risk shared primitives (icon buttons,
tooltips); then forms; then the page-shaping families (cards, tables); then the
shell; cleanup last so every legacy selector has a replacement.

### Batch 0 — foundation docs (delivered in this run)

Files: `docs/design-system/inventory.md`, `docs/design-system/DESIGN-SYSTEM.md`,
`docs/design-system/plan.md`.

Acceptance: docs committed; inventory has file:line evidence; design system has
tokens/APIs/states/a11y/naming; this plan has owner + reviewer per batch.

Review: `critic` checks that every inventory claim has a citation and that no
batch requires a behaviour change.

### Batch 1 — tokens, status/badges, status lines (delivered in this run)

Files:

- `apps/site/site.css`: add the primitive/semantic tokens to the current root
  (`site.css:998-1031`) and the status/badge geometry section. No tooltip or
  `#key-info-btn` rules.
- `apps/site/*.html`: asset-version bump only (24 files).
- `projects.json`: `asset_version`.
- `scripts/ui-audit.mjs`: `status-pill-geometry` detector.
- `docs/process/defects.json`: one ledger entry for that detector.
- `AGENTS.md`, `apps/site/UI-CHECKLIST.md`: the component rules and the new
  check in the UI gate text.

Scope: `.badge`, `.key-badges span`, `.puzzle-badge`, `.puzzle-status`,
`.pz-pill`, `.ws-chain-status`, `.monitor-chain`, `.balance-refresh-count`, and
the text-only status lines in `site.css` (`.monitor-status`, `.range-status`,
`.key-input-status`, `.key-export-status`, `.global-search-hint`,
`.global-search-error`). Page-local `.send-status`/`.wallet-status` wait for
batch 3 so their files are not touched here.

Acceptance:

```sh
node scripts/check-defect-ledger.mjs
node scripts/ui-audit.mjs --base http://127.0.0.1:7879 \
  --routes /,/key,/key/0000000000000000000000000000000000000000000000000000000000000001,/seed,/mnemonic-seeds/bitcoin,/bitcoin-puzzle,/tools \
  --viewports 375,768,1280 --themes dark,light
node --check apps/site/site.js
node apps/site/site-nav-test.mjs
node scripts/check-projects.mjs
```

Review: `critic` measures every pill: height 20–32, padding-inline 8, radius
pill, font ≥12; confirms no non-status layout changed in the screenshots.

Non-goals: uppercase copy removal (the underlying strings stay; only CSS
tracking/transform is reset), page-local status styles, tooltips.

### Batch 2 — icon buttons + tooltip primitive

Files: `apps/site/site.css` (icon-button + tooltip/popover sections),
`apps/site/site.js` (one tooltip helper), `apps/site/key.html`,
`apps/site/send.html`, `apps/site/tx-bitcoin.html`, `apps/site/tx-ethereum.html`,
`apps/site/monitor.html`, `apps/site/browse.js`, `apps/site/puzzle-browser.js`,
`apps/site/brainwallet.css`, `apps/site/seed-studio.css`.

Work: collapse `.icon-btn`, `.key-icon-btn`, `.global-search-icon-btn`,
`.pz-icon`, `.key-copy-icon`, `.browse-balance-retry` into
`.icon-button--quiet`/`--outline`/`--solid` at 44×44 (`--lg`), radius
`--radius-control`, icon 18. The same component also ships `--sm` (28, dense
table rows only) and `--md` (36, compact desktop toolbars). Adopt the tooltip
primitive from the in-flight PR; do not edit `#key-info-btn` or its popover.
Replace page-local copied states with `.is-copied`.

Detectors:

- `icon-button-scale`: every `.icon-button` is 28/36/44 square, radius
  `--radius-control`, icon 14/16/18 matching the box, and carries both
  `aria-label` and `data-tooltip` (no native `title`). 28 is allowed only for a
  dense table row whose row is the target; all standalone and 375px actions use
  44.
- `adjacent-icon-gap`: adjacent visible icon-only controls have ≥8px gap and
  distinct labels.
- `tooltip-naming`: an element with a tooltip has an accessible name that does
  not depend on the tooltip; `aria-describedby` points to an existing node.

Acceptance routes: `/send`, `/send/bnb`, `/tx`, `/tx/bitcoin`, `/tx/ethereum`,
`/key`, `/bitcoin-puzzle`, `/cabinet/wallet`, `/private-keys/bitcoin`.
Review: `critic` screenshots every toolbar and the tooltip at hover and focus.

### Batch 3 — forms, fields, segmented controls, chips

Files: `apps/site/site.css` (controls section), `apps/site/key.html`,
`apps/site/key.js`, `apps/site/seed.html`, `apps/site/seed-page.js`,
`apps/site/mnemonic-seeds.html`, `apps/site/wallet.html` (move inline `<style>`
to shared CSS), `apps/site/send.html` (same), `apps/site/range.html`,
`apps/site/vanity.html`, `apps/site/pubkey-add.html`, `apps/site/public-key.html`,
`apps/site/reconstruction.html`, `apps/site/keystore-parser.html`,
`apps/site/hex-dec-bin.html`.

Work: one `.field` grammar (44px control, 10px radius, 12px label, focus ring);
hero input as `.field--hero` (56/14); selects use a height-derived arrow; one
`.segmented` and one `.chip`; delete the legacy control block at
`site.css:126-140`; remove page-local input/status overrides. Merge the two
`key-segmented` sizes into one.

Detectors:

- `control-height-scale`: visible controls have height in {28, 36, 44, 56} ±1 (28
  only in dense table rows); no 38/46/52/58.
- `field-geometry`: input/select/textarea radius in {10, 16 for hero}, label
  size ≥12, focus ring present.
- `segmented-geometry`: track pad 4/radius 12, item min-h 44/radius 8–10, one
  selected item per group.

Acceptance routes: `/key`, `/seed`, `/mnemonic-seeds/bitcoin`,
`/cabinet/wallet`, `/send`, `/keys/<chain>/<start>-<end>` (the range page;
`/range` is not a served route), `/vanity`, `/pubkey-add`, `/public-key`,
`/reconstruction`, `/keystore-parser`, `/hex-dec-bin`.
Review: `critic` fills every form from the keyboard, checks empty/error states,
and measures the 375px layout.

### Batch 4 — cards and stat blocks

Files: `apps/site/site.css` (card/stat sections), `apps/site/landing.html`,
`apps/site/app.html`, `apps/site/me.html`, `apps/site/run.html`,
`apps/site/key.html`, `apps/site/mnemonic-seeds.html`,
`apps/site/tools.html`, `apps/site/puzzle-browser.js`, `apps/site/site.js`
(global-search cards), `apps/site/brainwallet.css`.

Work: `.card` pad 20/radius 16; `.card--flat`; `.stat` pad 16/radius 12/label 12
sentence case/value 24/600; `.stat--sm`; remove `.key-page > .card` double
override; one `.tool-card`/`.chain-card`/`.address-db-card` padding; no
translateY hover on cards (keep colour/border). Keep the data-heavy pages on
tables; cards remain for navigation, empty states and summaries.

Detectors:

- `stat-geometry`: label ≥12 and sentence case (no `text-transform:uppercase`),
  value size in {20, 24, 28}, tabular-nums, no fixed empty height.
- `card-padding-scale`: card padding in {16, 20, 24}; radius in {12, 16}; no
  card under 220px with >45% empty (existing check).

Acceptance routes: `/`, `/app`, `/me`, `/run`, `/key`, `/tools`,
`/mnemonic-seeds/bitcoin`, `/bitcoin-puzzle`.
Review: `critic` screenshots card rows at 375/768/1280 and measures padding,
radius and column bottoms (±2px).

### Batch 5 — tables and rows

Files: `apps/site/site.css` (table sections), `apps/site/key.html`,
`apps/site/key.js`, `apps/site/range.html`, `apps/site/range.js`,
`apps/site/puzzle-browser.js`, `apps/site/site.js` (global search results),
`apps/site/brainwallet.css`, `apps/site/monitor.html`, `apps/site/monitor.js`,
`apps/site/mnemonic-seeds.html`/`.js`.

Work: one `.data-table` + `.table-scroll`; header 12/600 sentence case, cell pad
8/12, row min-height 44; four mobile behaviours collapse to two (scroll or
labelled blocks); row states `has-balance`/`is-active`/`key-row-focus` use the
same tokens; one row-action icon grammar.

Detectors:

- `table-header-style`: header font-size 12, weight ≤600, no uppercase
  transform, letter-spacing 0.
- `table-row-height`: interactive rows ≥44 or the row has a 44px action.
- `row-action-geometry`: row actions 44×44, radius 10, icon 16, labelled.

Acceptance routes: `/key`, `/range`, `/bitcoin-puzzle`, global search (open the
dialog), `/brainwallet/bitcoin`, `/cabinet`, `/mnemonic-seeds/bitcoin`.
Review: `critic` pages real and zero data, measures header/cell padding, and
checks the mobile transform preserves labels.

### Batch 6 — navigation, breadcrumbs, pagination

Files: `apps/site/site.css` (nav/breadcrumb/pager sections), `apps/site/site.js`
(drawer), `apps/site/theme.js` (toggle markup), all `apps/site/*.html` header
blocks, `apps/site/mnemonic-seeds.html`/`.js` (pager).

Work: delete the legacy nav at `site.css:31-62`; one 70px shell, 44px links,
pill active state; `.nav-icon-pill` sized 44 explicitly (not via min-width
coincidence); one breadcrumb grammar with separator and current page; one pager
with range status. The brand mark keeps the single gradient.

Detectors:

- `nav-link-height`: every nav/breadcrumb link ≥44×44.
- `breadcrumb-current`: exactly one `aria-current="page"`; no raw path as the
  visible label.
- `pager-geometry`: buttons 44, radius 10, `aria-disabled` for unavailable
  directions.

Acceptance routes: every default route at 375 (drawer open/closed), 768, 1280,
dark/light.
Review: `critic` opens the drawer at 375, tab-walks the shell, and screenshots
the active/current states.

### Batch 7 — cleanup and final sweep

Files: `apps/site/site.css`, all page-local `<style>` blocks,
`apps/site/brainwallet.css`, `apps/site/seed-studio.css`,
`.impeccable/config.json`, `docs/process/defects.json`.

Work: delete the legacy root (`site.css:2-17`), the duplicate control block
(`126-140`), the legacy `.notice`/`.badge`/nav/breadcrumb definitions; move the
last page-local rules into shared CSS; remove `.impeccable` ignore entries that
existed only because of the old detector; run the full audit on every default
route in both themes.

Detectors:

- `radius-scale`: component radii in {4, 8, 10, 12, 16, 20, 999}.
- `raw-hex-outside-root`: no hex colours outside the two root blocks.
- `legacy-selector`: no `.key-page > .card`-style override for a shared family.

Acceptance: full `node scripts/ui-audit.mjs --serve` green; all area tests;
`check-projects`; docs updated (`docs/site-map` if a route/feature status
changed; no route changes here).

## 2. Per-batch route matrix

| Batch | Routes |
|---|---|
| 1 | `/`, `/key`, `/key/1`, `/seed`, `/mnemonic-seeds/bitcoin`, `/bitcoin-puzzle`, `/tools` |
| 2 | `/key`, `/send`, `/send/bnb`, `/tx`, `/tx/bitcoin`, `/tx/ethereum`, `/bitcoin-puzzle`, `/cabinet/wallet`, `/private-keys/bitcoin` |
| 3 | `/key`, `/seed`, `/mnemonic-seeds/bitcoin`, `/cabinet/wallet`, `/send`, `/range`, `/vanity`, `/pubkey-add`, `/public-key`, `/reconstruction`, `/keystore-parser`, `/hex-dec-bin` |
| 4 | `/`, `/app`, `/me`, `/run`, `/key`, `/tools`, `/mnemonic-seeds/bitcoin`, `/bitcoin-puzzle` |
| 5 | `/key`, `/range`, `/bitcoin-puzzle`, `/brainwallet/bitcoin`, `/cabinet`, `/mnemonic-seeds/bitcoin` + open global search |
| 6 | all default routes at 375 (drawer), 768, 1280 |
| 7 | all default routes |

On Git Bash, omit the leading slash in `--routes` (MSYS path rewriting), or pass
`--routes=key,seed`.

## 3. Detector backlog

`data/detectors.json` is the single detector registry; this table is generated
by `scripts/gen-detector-docs.mjs`. A detector is added only when the family is
normalised, so the gate does not fail on known legacy debt without an owner.
Every `docs/process/defects.json` entry names an implemented registry entry, and
the `status` column distinguishes an implemented rule from a planned one.

<!-- BEGIN GENERATED detectors:plan -->
| ID | Rule | Batch | Status |
|---|---|---|---|
| `status-pill-geometry` | Status/badge pill: text >=12px, height 20-32px, pill radius, inline padding 6/8/10/12. | 1 | implemented |
| `icon-button-scale` | Icon button box 28/36/44, icon 14/16/18, aria-label plus data-tooltip, no native title. | 2 | implemented |
| `icon-only-shared-component` | Icon-only action uses the shared .icon-button component, not a page-local button. | 2 | implemented |
| `look-alike-icon-button` | A quiet icon control must not render as a full bordered 44px button. | 2 | implemented |
| `quiet-icon-hover-border` | Quiet icon buttons gain no hover border; outline buttons keep their strong line. | 2 | implemented |
| `tooltip-primitive` | data-tooltip target: non-empty text <=40 chars, no native title, accessible name. | 2 | implemented |
| `tooltip-behaviour` | Tooltip appears within 300ms, hides on Escape, and the popover keeps row geometry. | 2 | implemented |
| `key-meta-row` | The /key input meta row is one 40px line with the info control centred. | 2 | implemented |
| `control-height-scale` | Input/select/chip/segmented height in {28,36,44,56}; 28 is reserved for dense table rows. | 3 | implemented |
| `field-geometry` | Field radius 10/16, label >=12px, visible focus ring. | 3 | implemented |
| `segmented-geometry` | One track grammar (4px padding, radius 12), 44px items, exactly one selected. | 3 | implemented |
| `key-input-type` | The /key private-key field renders as plain text, not type=password. | 3 | implemented |
| `key-auto-derive` | /key derives rows from the input without an explicit action. | 3 | implemented |
| `key-calculate-button` | /key exposes no Calculate button; the form input is the only control. | 3 | implemented |
| `duplicate-preset-control` | /key renders one preset control, not chips and an equivalent select. | 3 | implemented |
| `seed-form-narrow` | The /seed form uses more than 80% of the card width. | 3 | implemented |
| `ragged-summary-columns` | Multi-column summary lists end within 2px of each other. | 3 | implemented |
| `summary-grid-orphan` | At <=560px the summary grid leaves no empty trailing cell. | 3 | implemented |
| `card-padding-scale` | Card padding 16/20/24 and radius 12/16; no page-local card override. | 4 | implemented |
| `stat-geometry` | Stat label >=12px sentence case; value 20/24/28 with tabular digits. | 4 | implemented |
| `table-grammar` | Every table is .data-table inside .table-scroll with 8/12 cell padding and even headers. | 5 | implemented |
| `table-header-style` | Table header is 12px/600 sentence case with no uppercase or tracking. | 5 | implemented |
| `table-row-height` | Every table row is at least 44px tall or carries a 44px action. | 5 | implemented |
| `row-action-geometry` | Row actions are 44x44, radius 10, with an accessible name. | 5 | implemented |
| `nav-link-height` | Nav links are at least 44x44 with 18px icons. | 6 | implemented |
| `nav-destination` | The Seeds nav points at /mnemonic-seeds and is active there. | 6 | implemented |
| `nav-keystore-highlight` | /keystore-parser highlights Tools, not Search. | 6 | implemented |
| `chain-tab-color` | Directory chain tabs read --chain from data/chains.json, not a page-local colour table. | phase 4 | implemented |
| `breadcrumb-grammar` | One labelled breadcrumb trail with shared separators and a sensible depth. | 6 | implemented |
| `breadcrumb-current` | Exactly one aria-current crumb and never a raw path label. | 6 | implemented |
| `pager-grammar` | One labelled pager structure with the jump control and no legacy random modifier. | 6 | implemented |
| `pager-geometry` | Pager buttons are 44px, radius 10, aria-disabled and 16px icons. | 6 | implemented |
| `footer-presence` | Exactly one footer with the donor links, copyright and build id. | 6 | implemented |
| `legacy-token` | One :root token block; light overrides only through html[data-theme]. | 7 | implemented |
| `radius-scale` | border-radius uses var(--radius-*), never an off-scale literal. | 7 | implemented |
| `raw-hex-outside-root` | No raw colour outside the generated token regions (CSS or inline style). | 7 | implemented |
| `legacy-selector` | No page-scoped selector overrides a shared component family. | 7 | implemented |
| `empty-state-grammar` | Empty and error states share one grammar (dashed, radius 12, 20px padding). | 7 | implemented |
| `token-contract` | tokens.json, the generated region and the frozen contract agree and every var() resolves. | phase 2 | implemented |
| `orphan-token` | A declared token has a first-party consumer or is marked reserved. | phase 2 | implemented |
| `theme-parity` | Every colour token declared in :root has a light-theme declaration. | phase 2 | implemented |
| `lossy-amount-formatter` | No local amount formatter, Number amount math or 10n amount scale outside amount.js. | 2 | implemented |
| `aggregateText` | The seed aggregate line includes the BTC lifetime received total. | 2 | implemented |
| `field-hero-height` | Every rendered .field--hero control is at least 56px high. | phase 3 | implemented |
| `manifest-shape` | Component manifests carry the contract fields, a semver version and unique ids. | phase 3 | implemented |
| `unknown-variant` | Every manifest variant and size class has a rule in site.css. | phase 3 | implemented |
| `gallery-variant` | Every manifest variant, size and state renders in the generated gallery. | phase 3 | implemented |
| `gallery-missing` | The generated /cabinet/admin/design gallery exists and is current. | phase 3 | implemented |
| `required-attribute` | Every gallery example carries its declared required attributes. | phase 3 | implemented |
| `page-local-family` | A page <style> block does not restyle a shared component family. | phase 3 | implemented |
| `browse-row-address-count` | A BTC legacy listing row renders both address forms without a disclosure. | phase 4 | implemented |
| `browse-row-balance-lines` | One balance line per address, received only when non-zero, and a named TX pill. | phase 4 | implemented |
| `browse-row-key-copy` | Each listing row has one visible, labelled key copy action. | phase 4 | implemented |
| `browse-row-height` | Listing rows keep one stable height under the two-address ceiling. | phase 4 | implemented |
| `browse-stat-level` | Browse stat cards end within 2px of each other. | phase 4 | implemented |
| `browse-row-wif` | A listing row is HEX plus copy, address and balance; the WIF stays on /key. | phase 4 | implemented |
| `balance-consistency` | A balance row text agrees with its title amount and TX count. | phase 4 | implemented |
| `key-zec-provider` | Every /key ZEC row has a balance provider. | phase 4 | implemented |
| `key-utxo-provider` | Every /key LTC and DOGE row names sochain as its balance provider, not a rate-limited fallback. | phase 4 | implemented |
| `wallet-seed-strength` | The wallet seed block shows computed strength and uses shared 44px controls. | phase 4 | implemented |
| `wallet-mainnet-arm` | A mainnet send requires an explicit 44px risk arm with the full warning. | phase 4 | implemented |
| `wallet-approvals-surface` | The approvals table uses the shared table shell, 44px labelled icon actions, Unlimited/Contract/EOA labels and the truncated warning without overflow; the grant form has labelled 44px fields, its own unlimited warning line, a visible zero-amount error state and a rendered unlimited review. | phase 4 | implemented |
| `wallet-history-surface` | The wallet history panel uses the shared table shell and a 44px labelled action, renders time/direction/amount/counterparty/status with a truncated counterparty title, and shows loading, empty, error and the honest EVM-unavailable state without overflow or a provider call. | phase 4 | implemented |
| `walletconnect-handoff` | The cabinet WalletConnect panel exposes the connection URI with a 44px labelled copy action, a QR code on desktop, deep links for MetaMask/Trust/Rainbow/Coinbase Wallet plus the generic wc: link carrying the encoded URI, and the expired-URI state with a 44px regenerate action, without horizontal overflow; every link builder accepts only wc: URIs, an Android user agent gets a 44px wallet chooser and a MetaMask deep-link navigation instead of a QR, expiry clears the dead URI and hides the QR/link blocks until Regenerate restores them, and aborting during create() disconnects the new provider. | phase 4 | implemented |
| `wallet-portfolio-summary` | The wallet summary counts only loaded balances, shows an explicit empty state instead of $0.00, names unpriced chains, hides stale/offline fiat, and keeps a 44px refresh control with the shared stat grammar. | phase 4 | implemented |
| `wallet-top-assets-surface` | The top-10 asset table uses .data-table inside .table-scroll, lists every asset network once in rank order, prices only rows whose balance loaded, prints — instead of $0.00 with nothing loaded, and names a failed row instead of counting it as zero. | phase 4 | implemented |
| `wallet-onboarding-key-entry` | The onboarding screen offers a seed-phrase and a private-key/WIF entry as shared 44px chips next to each other; the key choice focuses the import form and both a WIF and a 64-hex key reach the vault from there. | phase 4 | implemented |
| `search-xrp-secret-routing` | XRP family seeds and secrets route to /key instead of a brainwallet hash. | phase 4 | implemented |
| `search-short-hex-padding` | 1-63 hex characters stay brainwallet text; exactly 64 hex is a key. | phase 4 | implemented |
| `mnemonic-solana-balances` | The Solana directory fetches every row with one batched getMultipleAccounts call. | phase 4 | implemented |
| `mnemonic-bch-balances` | The BCH directory batches every address through the Haskoin endpoint. | phase 4 | implemented |
| `bch-directory-provider` | The private-key BCH directory wires the batched Haskoin provider instead of per-row lookups. | phase 4 | implemented |
| `mnemonic-tron-xrp-sui-balances` | The TRON, XRP and SUI directories fetch balances for every row. | phase 4 | implemented |
| `mnemonic-xrp-redirect` | XRPScan is called with redirect: error so a cross-origin hop fails loud. | phase 4 | implemented |
| `mnemonic-sochain-quota-storm` | The first SoChain 429 stops the rest of a directory page instead of firing 60 retries. | phase 4 | implemented |
| `mnemonic-ltc-sochain-fallback` | A SoChain 429 serves the whole Litecoin directory page from the SSOT litecoinspace Esplora provider and the whole Dogecoin page from one SSOT BlockCypher batch; ZEC stays SoChain-only with no fallback. | phase 4 | implemented |
| `balance-state-attribute` | Every balance row sets data-balance-state and data-balance-at on the row. | phase 4 | implemented |
| `horizontal-overflow` | The page scrollWidth does not exceed clientWidth. | all | implemented |
| `clipped-control` | A control does not spill outside its card padding box without a scrollable ancestor. | all | implemented |
| `raw-path-text` | A table cell renders a human label, never a raw path. | all | implemented |
| `small-text` | Visible text is at least 12px; hidden and aria-hidden text is exempt. | all | implemented |
| `small-touch-target` | Visible controls are at least 44x44; inline prose links are exempt. | all | implemented |
| `unlabeled-icon-control` | An icon-only button or link carries an accessible name. | all | implemented |
| `address-type-width-spread` | Address-type cards in one visual row differ by at most 15%. | all | implemented |
| `duplicate-address-type-implementation` | One address-type component family is used, not two competing ones. | all | implemented |
| `mostly-empty-block` | A block taller than 220px is not more than 45% empty. | all | implemented |
| `manual-balance-control` | No visible manual balance button or checkbox; balances load automatically. | all | implemented |
| `brainwallet-row-count` | /brainwallet/<chain> renders 60 .bw-row entries. | all | implemented |
| `puzzle-row-count` | /bitcoin-puzzle renders 160 data-puzzle rows. | all | implemented |
| `site-map-still-served` | /site-map answers 404 after the docs move. | all | implemented |
| `http-error` | A same-origin HTTP error response fails the route. | all | implemented |
| `asset-fingerprint` | Every asset reference uses the /a/<build>/ prefix. | all | implemented |
| `route-coverage` | Every public page route in the coordinator map is audited by DEFAULT_ROUTES. | all | implemented |
| `cache-token` | No ?v= cache token; assets revalidate by content ETag. | all | implemented |
| `cramped-padding` | Impeccable ignores exist only with measured evidence, never to hide a real defect. | all | implemented |
| `selector_matched_nothing` | A density-parity selector that matches nothing reports selector_matched_nothing, not a silent zero. | all | implemented |
| `head_mirrors_get_for_public_resources` | HEAD mirrors GET for every public page and asset. | coordinator | implemented |
| `vendor-lock-digest` | Every data/vendor.lock.json entry matches both files byte for byte and every web/public file is locked. | 4a | implemented |
| `detector-registry` | Every ui-audit id and every defect-ledger detector resolves to one implemented registry entry. | 4a | implemented |
| `detector-docs-fresh` | The generated detector tables in SKILL.md, DESIGN-SYSTEM.md and plan.md match data/detectors.json. | 4a | implemented |
| `adjacent-icon-gap` | Adjacent icon-only controls keep at least 8px between them and distinct labels. | 2 | planned |
| `tooltip-naming` | The accessible name is independent of the tooltip and aria-describedby resolves. | 2 | planned |
| `tooltip-timing` | Tooltip shows after a 400ms delay and Escape dismisses it. | 2 | planned |
| `status-line-margin` | Text-only status lines use a top margin in {8,12}. | 1/3 | planned |
| `error-message-contrast` | Every visible error message uses the semantic --state-err text colour and keeps at least 4.5:1 contrast against its effective background; an invalid field's border uses --state-err. | phase 4 | implemented |
| `screenshots-in-repo` | No tracked image under docs/: UI evidence is uploaded by the ui-audit CI run as an artifact and linked from the PR. | 4a | implemented |
| `mnemonic-doge-blockcypher-batch` | Both DOGE directories fetch all addresses in one batched BlockCypher request and map the reply by index. | phase 4 | implemented |
| `puzzle-detail-discussion-link` | The puzzle detail page renders the donor Discussion action with its recorded target. | phase 4 | implemented |
<!-- END GENERATED detectors:plan -->

Every added detector gets a ledger entry in the same PR.

## 4. Risk register

| Risk | Mitigation |
|---|---|
| Tooltip PR touches `site.css`/`site.js` and `key.html` | Batch 1 does not touch `#key-info-btn`, the popover, or tooltip rules. Batch 2 starts only after that PR merges. |
| Light theme regressions | Every batch runs dark **and** light; new tokens are semantic, geometry is shared. |
| Mobile tables collapse differently | Batch 5 standardises two behaviours (scroll or labelled blocks) and tests 375 with zero data. |
| Audit false positives | `.impeccable/config.json` ignores are allowed only with measured evidence; remove them in batch 7 when the detector is fixed. |
| Behaviour creep | Every batch's acceptance includes a route/feature parity check and a diff review that rejects JS/DOM-behaviour changes. |
| Visual change without review | The reviewer is a different agent and must paste computed geometry; self-reported "audit passed" is not evidence. |
| Merge queue stalls | Batches are small and one-family; the tooltip dependency is explicit; no batch waits on another except batch 7. |

## 5. Current status (this run)

- Batch 0: docs written.
- Batch 1: tokens and status/badge grammar implemented; `status-pill-geometry`
  detector and ledger entry added; `AGENTS.md`, `apps/site/UI-CHECKLIST.md` and
  the `ui-self-review` skill updated; asset version bumped to `20261127c` in
  all 24 site HTML files, `site.js`, `src/coordinator/mod.rs` and
  `tests/coordinator_api.rs`.
- Evidence:
  - `node scripts/ui-audit.mjs --base http://127.0.0.1:7879` on the batch-1
    routes: **PASS, 36 page runs, 0 violations**.
  - The same audit on the full default route set (19 routes): **PASS, 114 page
    runs, 0 violations**.
  - `node scripts/check-defect-ledger.mjs`: 8 entries, all detectors present.
  - `node scripts/check-projects.mjs`: 393/394 tracked paths covered.
  - All site area build/test commands from `projects.json`: pass.
  - `cargo test --test coordinator_api --test coordinator_client`:
    18 + 3 tests pass.
- Note for later batches: the coordinator embeds `site.css` with
  `include_str!`, so the debug binary must be rebuilt after every CSS change
  before running `ui-audit` against it. A stale binary silently audits the old
  stylesheet.
- Batch 2: one `.icon-button` component (variants `--quiet`/`--outline`/
  `--solid`; sizes `--sm` 28 / `--md` 36 / `--lg` 44 with icons 14/16/18;
  radius `--radius-control`) replaced `.icon-btn`, `.key-icon-btn`,
  `.global-search-icon-btn`, `.pz-icon`, `.key-copy-icon` and
  `.browse-balance-retry` in `site.css`, the static pages, the runtime JS and
  the coordinator templates. Icon-only actions carry `aria-label` +
  `data-tooltip` and copied states use `.is-copied`. Control-height tokens are
  now 28/36/44 plus a 56 hero step; asset version `20261127c`.
  `icon-button-scale` detector and ledger entry added.
- Batch 2 evidence:
  - `node scripts/ui-audit.mjs --serve`: **PASS, 192 page runs across 32
    routes, 0 violations**; every `.icon-button` in 28/36/44 with a 14/16/18
    icon, every tooltip target valid, no small targets.
  - `/key`, `/key/<hex>`, `/private-keys/bitcoin`, `/cabinet/wallet`, `/tools`
    and `/bitcoin-puzzle` at 375/768/1280 dark/light: metrics show 0 overflow,
    0 small targets, 0 unlabeled icons, 0 icon-button issues. Screenshots:
    `%TEMP%/rotor-ui-audit-5JN4mf/screenshots`.
  - `check-projects`, `check-defect-ledger`, all site
    area tests and `cargo test --test coordinator_api --test coordinator_client`
    pass.
- Batch 3: one `.field` grammar (44x44 control, radius 10; `.field--hero`
  56x56/radius 16; 12px label; focus ring; error/disabled), one `.segmented`
  (4px track, radius 12, 44px items, radius 8, one selected) and one `.chip`
  (44px pill, `aria-pressed`/`aria-current`). Migrated the key curve and
  filters/presets, send chain tabs and fields, mnemonic chain tabs/presets,
  puzzle filters/modes/presets, tx chain tabs, tools links, private-keys and
  brainwallet chain tabs, wallet label inputs and the send/wallet status lines.
  Deleted the legacy control block and the page-local control overrides.
  Asset version `20261127d`; detectors `control-height-scale`,
  `field-geometry`, `segmented-geometry` and ledger entries added.
- Batch 3 evidence:
  - `node scripts/ui-audit.mjs --serve`: **PASS, 192 page runs across 32
    routes, 0 violations**.
  - Batch-3 route set (13 routes, including the real range route
    `/keys/tron/<start>-<end>`) at 375/768/1280 dark/light: **PASS, 78 page
    runs, 0 violations**; 0 overflow, 0 off-scale controls, 0 field issues,
    0 segmented issues.
  - Screenshots: `%TEMP%/rotor-ui-audit-qgvMTp/screenshots`.
  - `check-projects`, `check-defect-ledger`, all site
    area tests and `cargo test --test coordinator_api --test coordinator_client`
    pass.
  - The audit harness now starts its temporary coordinator with a 3600s monitor
    interval; the old 300s interval made it poll the unreachable test RPC and
    exit before the last routes of a full 192-run pass.
- Batch 4: one card grammar (`.card` pad 20, radius 16; `.card--flat`,
  `.card--stat`), one stat grammar (12px sentence-case label, 24px 600
  tabular value; `.stat--sm`/`.stat-value.small` 20), and the named card
  surfaces `.chain-card` (20/16, translateY hover removed), `.tool-card`/
  `.address-db-card` (16/12), `.tool-index-card`/`.tool-family`/
  `.pz-picker-card` (16/16), `.ws-chain-card` radius 12. Removed the
  `.key-page > .card` and `.key-page .card` overrides and the
  `.mnemonic-controls` card padding. Asset version `20261127f`; detectors
  `card-padding-scale`, `stat-geometry` and ledger entries added.
- Batch 4 evidence:
  - Full default route set: **PASS, 192 page runs across 32 routes, 0
    violations** (`target/full-batch4b.log`).
  - Acceptance routes `/`, `/app`, `/me`, `/run`, `/key`, `/tools`,
    `/mnemonic-seeds/bitcoin`, `/bitcoin-puzzle` at 375/768/1280 dark/light:
    **PASS** — 42 targeted runs (the seven non-default routes) plus the six
    root runs in the full set; 0 card issues, 0 stat issues, 0 overflow.
  - Screenshots: `%TEMP%/rotor-ui-audit-blUaQl/screenshots`.
  - `check-projects`, `check-defect-ledger`, all site
    area tests and `cargo test --test coordinator_api --test coordinator_client`
    pass.
- Batch 5: one `.data-table` inside `.table-scroll`; header 12/600 sentence
  case, header/body row height 44, cell padding 8/12, token row states and
  trailing icon actions. Migrated `.key-addr-tbl`, `.pz-table`, `.range-table`
  and the landing/app/me leaderboards; removed the dead global-search table;
  the puzzle/global-search mobile card transforms were removed, so tables now
  keep one behaviour (horizontal scroll with all columns). Div rows
  (`.keys-header`, `.key-row`, `.bw-row`, `.seed-row`) share the same rhythm and
  states. Asset version `20261127g`; detectors `table-grammar`,
  `table-header-style`, `table-row-height`, `row-action-geometry` and ledger
  entries added.
- Batch 5 key-row bugfix (same PR): the balance line now comes from one
  formatter (`formatAtomic` + `balanceLine` in `key-tools.js`) using the
  provider summary's decimals/symbol and the summary’s tx count, nonce,
  last-tx time and note. The TRON row and title both render
  `10343.145665 TRX · 1122 tx · last 2h ago`; the old 18-decimal display was
  `0.000000010343145665 TRX`. On the same run the TRX price was 0.3004 and the
  page total moved from `$1.31` (TRX at 18 decimals) to `$3,105.29` (TRX at 6
  decimals), matching the row sum (310,529 cents from 8 priced rows). `#priv`
  is now `type="text"` and shows the key; cache keys are v2 so old cached
  lines cannot resurface. Detectors `balance-consistency` and `key-input-type`
  added; unit coverage in `key-tools-test.mjs`.
- Batch 5 evidence:
  - Full default route set: **PASS, 192 page runs across 32 routes, 0
    violations** (`target/full-batch5b.log`).
  - Table routes (key, key row data, real range, puzzle list/results,
    brainwallet, cabinet, mnemonic seeds, app, me, run) at 375/768/1280
    dark/light: **PASS, 66 page runs, 0 violations**.
  - CDP: key table header 44, cell padding 8/12, rows 44–69, overflow 0;
    puzzle table header 44, padding 8/12, rows 115, overflow 0; directory rows
    176–265, overflow 0.
  - TRON row/input screenshots: `target/key-tron-row.png`,
    `target/key-input-field.png`; CDP JSON `target/key-cdp-check.json`.
  - Screenshots: `%TEMP%/rotor-ui-audit-ijvZOa/screenshots`.
  - `check-projects`, `check-defect-ledger`, all site
    area tests and `cargo test --test coordinator_api --test coordinator_client`
    pass.
- Batch 7: one `:root` token block (the legacy blue root, the overridden
  control/nav/breadcrumb rules and the dead legacy page selectors — 191 rule
  blocks deleted); the four inline page `<style>` blocks moved into
  `site.css`; `brainwallet.css` and `seed-studio.css` reduced to page-specific
  layout, with status badges, address-type/count chips and explorer/retry
  actions on the shared status/chip/icon-button grammar; `legacy-token` detector
  and ledger entry added; asset version `20261127i`. Surviving page-scoped rules
  are listed in `DESIGN-SYSTEM.md` §10.
- Batch 7 evidence:
  - Full default route set: **PASS, 198 page runs across 33 routes, 0
    violations** (`target/audit-batch7-final.json`); 33 routes × 3 viewports
    (375/768/1280) × 2 themes (dark/light).
  - Style equivalence: a fixed sample (body, header, nav link, card, table,
    header cell, body row, input, select, button, primary, chip, segmented,
    stat, status, icon button, footer) was captured on all 33 routes at
    375/768/1280 dark/light before and after the cleanup: 198 runs, 1,494
    sample elements compared. No computed-style property changed. The only
    geometry deltas are intentional: the seed count buttons now match `.chip`
    (`chip` sample appears; the page label/row width moves by 11px at 1280),
    the brainwallet type tabs use the same chip grammar (the control row loses
    51px at 375/768), and async balance content changed between runs
    (`0 BTC` vs `—` on /private-keys/bitcoin; balance rows on
    /mnemonic-seeds/bitcoin). Evidence: `target/style-before.json`,
    `target/style-after.json`, comparison in `target/compare-styles.mjs`.
    Review caught one legacy label-direction dependency (the wallet file
    input); it is preserved by the kept `label` migration alias, so the wallet
    body height matches exactly.
  - `check-projects`, `check-defect-ledger`,
    `git diff --check`, all 50 site build/test commands and
    `cargo test --test coordinator_api --test coordinator_client` (18 + 3)
    pass.
- Batch 7 follow-up (2026-11-21): the last open P1 shell row, one shared
  async-state grammar. Added `.empty-state` (dashed `--line-subtle`, radius
  `--radius-l`, padding `--space-5`, `__title`/`__action` slots), promoted
  `.skeleton` to the block primitive (tokens `--surface-2`/`--surface-3`,
  radius `--radius-xs`, 10–12px high, `aria-hidden`), and documented `.error`
  as the shipped error box. Migrated `.key-empty` (both definitions),
  `.range-empty` and `.monitor-empty` in `key.html`, `key.js`, `range.html`,
  `range.js` and `monitor.html`; table empties keep the `<td>` and use an inner
  `<div>`. The range/key-status skeletons now consume `.skeleton`. One error
  margin (`--space-3`) is declared once for `.error`/`.key-error`/
  `.range-error`/`.monitor-status`; field-level errors use `--space-2`.
  Asset version `20261127j`; detector `empty-state-grammar` (static class/token
  scan plus rendered dashed/radius-12/padding-20 and error-margin geometry) and
  ledger entry added.
- Batch 7 follow-up evidence:
  - Full default route set (release coordinator on `127.0.0.1:7900`; `:7899`
    was contended during the run): **PASS, 198 page runs across 33 routes, 0
    violations** (`target/audit-state-primitives.json`).
  - DOM half on `/cabinet` (the route that renders visible empty states; the
    key-page boxes sit in cards that stay hidden until derivation): **PASS, 6
    page runs at 375/768/1280 dark/light**, 4 `.empty-state` boxes measured per
    run, 0 geometry issues (`target/audit-empty-state-dom.json`).
  - `check-projects` 405/406, `check-defect-ledger`
    (31 entries), `site-map-test`, all 19 site test commands and
    `cargo test --release --test coordinator_api --test coordinator_client`
    (19 + 3) pass.
- Batch 2 follow-up: the `/key` info affordance moved from the page-local
  `button.key-info-btn` (deleted from `site.css`) to
  `.icon-button icon-button--quiet`, closing the one control batch 2 excluded.
  Detector `icon-only-shared-component` fails any rendered interactive element
  that has an icon and no visible text without `.icon-button`; ledger entry
  `key-info-page-local-button`. Asset version `20261128a`; full default route
  set (release coordinator on `127.0.0.1:7900`, `:7899` contended): **PASS, 204
  page runs across 34 routes, 0 violations**.
