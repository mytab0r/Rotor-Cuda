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
   then `node scripts/check-projects.mjs`. Bump `?v=` in every
   `apps/site/*.html` and `projects.json.asset_version` for any `site.css`,
   `site.js`, `theme.js` or `key.js` change.
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
| 6 | Navigation, breadcrumbs, pagination | `developer` | `critic` | batches 2–5 (shared link/button grammar) | `nav-link-height`, `breadcrumb-current`, `pager-geometry` |
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

Review: `critic` measures every pill: height 18–32, padding-inline 8, radius
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

- `control-height-scale`: visible controls have height in {40, 44, 56} ±1; no
  38/46/52/58.
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

| ID | Rule | Batch | Checkable |
|---|---|---|---|
| `status-pill-geometry` | pills: height 18–32, padding-inline 8, pill radius, font ≥12 | 1 | yes |
| `icon-button-scale` | box 28/36/44, icon 14/16/18, `aria-label` + `data-tooltip` | 2 | yes |
| `adjacent-icon-gap` | ≥8px between adjacent icon-only controls, distinct labels | 2 | yes |
| `tooltip-naming` | accessible name independent of the tooltip; `aria-describedby` resolves | 2 | yes |
| `control-height-scale` | heights in {28, 36, 44, 56} ±1 (28 dense rows only) | 3 | yes |
| `field-geometry` | control radius/size/label/focus ring | 3 | yes |
| `segmented-geometry` | one track grammar, one selected item | 3 | yes |
| `stat-geometry` | label ≥12 sentence case; value in {20,24,28} | 4 | yes |
| `card-padding-scale` | padding {16,20,24}, radius {12,16} | 4 | yes |
| `table-header-style` | 12/600, no uppercase, no tracking | 5 | yes |
| `table-row-height` | interactive rows ≥44 or 44px action | 5 | yes |
| `row-action-geometry` | 44×44, radius 10, icon 16, labelled | 5 | yes |
| `nav-link-height` | nav/breadcrumb links ≥44×44 | 6 | yes |
| `breadcrumb-current` | one `aria-current`, no raw path | 6 | yes |
| `pager-geometry` | 44, radius 10, disabled semantics | 6 | yes |
| `radius-scale` | component radii in the scale | 7 | yes |
| `raw-hex-outside-root` | no hex outside root blocks | 7 | yes |
| `legacy-selector` | no shared-family page override | 7 | yes |
| `tooltip-timing` | 400ms delay, Esc dismiss | 2 | partial (DOM events; manual evidence) |
| `status-line-margin` | margin top in {8,12} | 1/3 | yes (proposed) |

A detector is added only when the family is normalised, so the gate does not
fail on known legacy debt without an owner. Every added detector gets a ledger
entry in the same PR.

## 4. Risk register

| Risk | Mitigation |
|---|---|
| Tooltip PR touches `site.css`/`site.js` and `key.html` | Batch 1 does not touch `#key-info-btn`, the popover, or tooltip rules. Batch 2 starts only after that PR merges. Version-bump conflicts are mechanical; rebase and keep one version. |
| Asset-version collision with other open PRs | One version per landing; rebase and re-bump to the next value, never merge two different `?v=` values. |
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
  - `check-projects`, `check-asset-version`, `check-defect-ledger`, all site
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
  - `check-projects`, `check-asset-version`, `check-defect-ledger`, all site
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
  - `check-projects`, `check-asset-version`, `check-defect-ledger`, all site
    area tests and `cargo test --test coordinator_api --test coordinator_client`
    pass.
- Batches 5–7: not started; owners/reviewers assigned above.
