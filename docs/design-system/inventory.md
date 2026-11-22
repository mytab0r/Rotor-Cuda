# Rotor UI inventory — baseline (read-only)

Date: 2026-11-21. Scope: `apps/site/*.html|css|js` and the coordinator-rendered
pages that reuse those assets (`/key`, `/private-keys/*`, `/seed`,
`/mnemonic-seeds/*`, `/brainwallet/*`, `/bitcoin-puzzle`, `/tools`, `/send`,
`/cabinet/wallet`).

Method: a line-aware CSS parser over `apps/site/site.css`,
`apps/site/brainwallet.css` and `apps/site/seed-studio.css`, plus a class-usage
scan over every `apps/site/*.html|js`. Geometry below is the declared CSS at the
cited line (including the page-local `<style>` blocks); it is the design intent
that renders. The automated gate (`scripts/ui-audit.mjs`) is the authority for
computed geometry at 375/768/1280; the acceptance commands in
`docs/design-system/plan.md` record those runs.

Limitations: this pass did not screenshot every route. The batch acceptance in
`plan.md` adds computed geometry and screenshots per family. Line numbers are
from the baseline commit and will move as batches land.

## 1. Token layer

### 1.1 Two competing roots

| What | Evidence | Consequence |
|---|---|---|
| Legacy root: blue accent, `--radius: 10px`, no `--panel-2`, no `--text-2` | `apps/site/site.css:2-17` | If the later root is removed or reordered, the whole site flips to a GitHub-blue skin. |
| Current root: amber accent, `--radius: 16px`, `--radius-sm: 10px`, full surface/text ramp | `apps/site/site.css:998-1031` | The current look depends on cascade order, not on one source of truth. |
| Light theme overrides colours but not the geometry/type/font tokens | `apps/site/site.css:3653-3683` | Light mode is a colour swap; any new token added only to the dark root silently misses light. |
| Component values are literals in the rules | radii `6,7,8,9,10,11,12,14,16,20,999`; heights `38,40,44,46,52,56,58,66`; font sizes `10.5–46`; weights `500,550,600,650,700,750,800` | Every page invents its own nearest value; no scale exists to review against. |
| Motion values are literals | `.12s`, `.16s`, `.18s`, `.4s`, `900ms`, `1.1s`, `1.2s`, `1.4s`; easings `ease`, `linear`, `cubic-bezier(.2,.7,.2,1)` | No single duration/easing set; reduced-motion blocks are page-specific (`site.css:741,1580,1911,2443,3029,3443,3636,3818,4093`). |

### 1.2 Text roles and contrast (measured, dark theme)

Pairs computed from the current root (`site.css:998-1031`):

| Pair | Ratio | Verdict |
|---|---|---|
| `--text` `#f3f7fc` on `--panel` `#0d121a` | 17.45:1 | AAA |
| `--text-2` `#c8d3e1` on `--panel` | 12.39:1 | AAA |
| `--muted` `#8d9bb0` on `--panel` | 6.66:1 | AA normal text |
| `--accent` `#f5b544` on `--bg` | 10.98:1 | AAA |
| `--accent-ink` `#171004` on `--accent` | 10.41:1 | AAA |
| `--ok` / `--err` on `--panel` | 10.17:1 / 6.98:1 | AA+ |
| Light: `--muted` `#5a6b80` on `#ffffff` | 5.46:1 | AA |
| Light: `--accent` `#a86800` on `#ffffff` | 4.52:1 | AA, no headroom |

Conclusion: contrast is not the primary defect. The defect is that the same role
is spelled with different tokens and raw hex values (`#e3b341` in the legacy
notice, `var(--state-err)` in errors, `#8494a9` in placeholders, chain colours in
`site.css:910-916` and inline `style="--chain:#..."`).

## 2. Component families

Each row cites the declaration that defines the look and a representative usage.

### 2.1 Buttons

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| Base `button, a.button, .btn` | min-h 44, pad 8/15, radius `var(--radius-sm)` = 10, font 14/650, gap 8 (`site.css:1215-1244`) | 21 files use `.primary`; e.g. `app.html:35`, `landing.html:44`, `wallet.html:87` | Legacy duplicate at `site.css:126-140` (pad 7/9, radius 6); both apply by cascade order. |
| Primary | gradient `#ffcb6f → var(--accent)`, ink text, shadow (`site.css:1236-1245`) | `landing.html:49,175`; `key`/`seed`/`send` submits | Light theme replaces the gradient with flat accent (`site.css:3692-3703`). |
| Secondary / default | `--panel-2` + `--border-strong` (`site.css:1215-1235`) | Most forms | Same element as primary minus `.primary`; there is no named secondary class. |
| Ghost/compact text action | `.key-copy` min-h 44, pad 8/12 or 0/9 or 0/12, font 12, radius 7/8 (`site.css:421,1819,2260,2475`) | Key rows, exports | Three paddings and two radii for the same action. |
| Small ghost | `.key-copy-sm` min-w 54, min-h 44, pad 2/7, font 12, radius 6 (`site.css:320-331`) | Key summary rows | A fourth copy grammar. |
| Pager action | `.pager-btn` min-h 44, pad 0/12, font 13/650, radius 9 (`site.css:1477-1493`) | `mnemonic-seeds.html:223-228` | Different font/radius from base; mobile override 12px (`site.css:1902`). |
| Search result action | `.global-search-action` min-h 44, pad 0/14, font 12/700, radius 9 (`site.css:3532-3543`) | Global search dialog | Another radius/weight/font. |
| Destructive/remove | `.monitor-remove` min-h 38, pad 5/10, font 12 (`site.css:549,586-593`) | `monitor.js:520` watchlist rows | Below the 44px touch target; compact exception is not defined. |
| 46px actions | `.global-search-submit` min-h 46 (`site.css:2892`); `.puzzle-cta .btn` min-h 46 (`site.css:3112`) | Search dialog, puzzle CTA | Height outside any scale (44/48/56). |
| Nav action | `.nav-pill` h 44, pad 0/14, radius 999, font 13.5/650 (`site.css:1133-1151`) | Every header | A pill action that is visually a different component from `.btn`. |

### 2.2 Icon buttons

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| `.icon-btn` | 44×44, radius 7, transparent border/bg, icon 14 (`site.css:1657-1670`) | `browse.js`, `send.html:175,239,254`, `tx-bitcoin.html:70` | Lowest radius, smallest icon. |
| `.key-icon-btn` | 44×44, radius 11, bordered `--panel-2`, icon 18 (`site.css:3774-3792`) | `key.html:53,56,77` | Highest radius, largest icon; this is the tooltip PR's area (`#key-info-btn`). |
| `.global-search-icon-btn` | 44 wide × min-h 44, radius 9, bordered `--panel-2`, icon 15 (`site.css:3517-3530`) | Global search results | Third border/bg/icon combination. |
| `.pz-icon` | 44×44, radius 10, transparent border, icon 16 (`site.css:3241-3256`) | Puzzle browser rows | Fourth radius/icon pair; copied state `.is-copied`. |
| `.key-copy-icon` | 44 wide × min-h 44, radius inherited, icon 14/15 (`site.css:2755-2756,2785-2786`) | Brainwallet / seed rows | Width is a box, not a square in the declaration. |
| `.browse-balance-retry` | 44×44, `::before` inset 0, radius 12 on the pseudo (`site.css:1673-1681`) | Browse rows | Hit box is 44 but the visible shape is the pseudo. |

### 2.3 Segmented controls

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| `.key-segmented` | track pad 4, radius 12; button min-h 44, pad 0/16, font 13/650, radius 9 (`site.css:2093-2113`) | `key.html:58` curve switch | Track padding/radius differs from the compact variant. |
| `.key-input-card .key-segmented` | track pad 2, radius 10; button pad 0/12, font 12.5, radius 8 (`site.css:3900-3901`) | Same page, key input card | A second size of the same component defined by page context. |
| `.pz-seg-btn` | min-h 44, pad 0/14, font 13/650, radius 9; no track (`site.css:3143-3155`) | Puzzle browser | Same look without the track container. |
| Chip tabs (`.chain-tab`, `.puzzle-tab`, `.key-chain`) | pill 999, min-h 44, pad 0/13 or 6/11 or 7/13, font 12–13.5 (`site.css:340,1436,2929`) | `mnemonic-seeds.html:158-176`; key filters; puzzle tabs | Three active treatments: accent fill, `color-mix`, `--accent-soft`. |

### 2.4 Chips and filter pills

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| `.key-preset-chips button` | min-h 44, pad 0/14, font 12.5, radius 999 (`site.css:2222-2234`) | `key.html` wallet presets | Pad 14. |
| `.puzzle-presets button` | min-h 44, pad 6/11, font 12.5, radius 999 (`site.css:2961-2970`) | Puzzle presets | Pad 11 + vertical 6. |
| `.pz-presets button` | min-h 44, min-w 44, pad 5/12, font 12.5, radius 999 (`site.css:3336-3346`) | Puzzle browser | Pad 12 + vertical 5. |
| `.global-search-chip` | min-h 44, pad 0/12, font 12/650, radius 999 (`site.css:3576-3589`) | Global search "Interpret as" | Pad 12, weight 650. |
| `.key-chain` | min-h 44, pad 6/11, font 12, radius 999 (`site.css:340-360,1806-1816`) | Key chain filters | Per-chain active colours; pad 11. |
| `.chain-tab` | min-h 44, pad 0/13, font 13.5/650, radius 999 (`site.css:1436-1457`) | Mnemonic chain navigation | Pad 13, largest font. |

### 2.5 Badges and status pills

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| `.badge` | pad 1/9, font 12, radius 999, muted (`site.css:189-190`) | `app.html:200-202`, `me.html:121` | 1px vertical padding; the smallest pill. |
| `.key-badges span` | pad 5/10, font 12/650, radius 999 (`site.css:2054-2062`) | 15+ key-family pages | 5px vertical padding; largest pill. |
| `.puzzle-badge` | pad 3/10, font 12/700, uppercase, tracking .08em (`site.css:2901-2912`) | Puzzle pages | Uppercase + tracking. |
| `.puzzle-status` | pad 1/8, font 12, uppercase, tracking .5px (`site.css:945-956`) | Puzzle table | Another uppercase pill. |
| `.pz-pill` | pad 2/9, font 12/700, uppercase, tracking .05em (`site.css:3229-3240`) | Puzzle browser | Fourth uppercase pill. |
| `.ws-chain-status` | pad 2/7, font 10.5/700, uppercase, tracking .04em (`site.css:3605-3615`) | Global search result cards | Text below the 12px minimum; smallest padding. |
| `.monitor-chain` | pad 1/8, font 12, tracking .6px (`site.css:555-563`) | Monitor rows | Chain-coloured border/text variants. |
| `.balance-refresh-count` | min-w 22, pad 2/7, font 12 mono, radius 999 (`site.css:1568-1577`) | Key/browse balance refresh | Count badge uses a different padding. |

### 2.6 Status lines and inline messages

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| `.notice` (current) | pad 11/14, radius 12, amber tint, `#f2cf8f` (`site.css:1273-1280`) | `run.html:38,45`, `mnemonic-seeds.html:188`, 11 files | 11px padding is off the 4px grid. |
| `.notice` (legacy) | pad 10/14, radius 8, `#e3b341` (`site.css:164-170`) | Leftover cascade | Duplicate definition with different radius/colour. |
| `.error` | pad 11/14, radius 12, red tint, `var(--state-err)` (`site.css:1272-1280`) | Wallet/send/monitor error slots | Same 11px padding; token-level text (light mode now AA). |
| `.edu-note` | pad 15/18, radius 12, amber tint, `#e8cf9f`, font 13.5 (`site.css:1409-1417`) | Educational callouts | A third amber message style. |
| `.monitor-status` | margin 10/0/0, font 12; `.ok`/`.err` (`site.css:541-543`) | `monitor.html:41,83,101,124` | Margin 10. |
| `.range-status` | margin 8/0/0, font 12 muted (`site.css:706`) | `range.html` | Margin 8. |
| `.key-input-status` | min-h 20, font 12, line-height 1.45, dot states (`site.css:3727-3764`) | `key.html:67` | The only status with a dot grammar. |
| `.key-exposure-status` | font 12, line-height 1.25, max-w 34ch, ellipsis (`site.css:3941-3954`) | `key.html:76` | Different line-height and truncation. |
| `.send-status` | min-h 20, margin 12/0/0, font 12.5 (`send.html:108`) | `send.html:233` | Page-local style, 12.5px. |
| `.wallet-status` | margin 8/0/0, font 13 (`wallet.html:25`) | `wallet.html:115` | Page-local style, 13px. |
| `.global-search-hint` / `.global-search-error` | font 12, muted / `var(--state-err)` (`site.css:2578-2579`) | Global search dialog | No `role` on the hint; error has `role="alert"` in markup. |

### 2.7 Inputs, selects and fields

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| Base `input, select, textarea` | min-h 44, pad 9/12, radius 10, `--input-bg`, focus ring 3px amber (`site.css:1189-1210`) | Every form | Legacy duplicate at `site.css:126-140` (pad 7/9, radius 6, raw `#0d1117`). |
| Key hero input | min-h 56, pad 14/16, font 14, radius 14, border-strong (`site.css:2075-2087`) | `key.html:49` | 56/14 vs base 44/10. |
| Key input card input | min-h 44, pad 9/12, font 13, radius 10 (`site.css:3893-3897`) | `key.html` compact card | Back to 44/10 with a smaller font. |
| Directory search | min-h 46, font 13.5, border 0 (`site.css:1343-1352`) | Directory pages | 46 is off the scale; the wrapper is 14px radius. |
| Global search field | wrapper min-h 56, pad 0/13, radius 14; inner input min-h 52, font 13.5 (`site.css:2548-2568`) | `site.js:357-404` | 56/52/14; inner height is not a control size. |
| Puzzle search | min-h 44, pad 0/12, radius 12, inner font 13 (`site.css:3160-3185`) | Puzzle browser | Radius 12, unlike base 10. |
| Wallet label input | pad 7/9, radius 7, `--panel-2` (`wallet.html:17`) | `wallet.html` vault rows | Page-local; no label/hint grammar. |
| Select | appearance none, custom arrow, padding-right 34 (`site.css:1207-1213`) | Forms | Arrow position hard-coded at 18px from top. |

### 2.8 Cards, panels and stat blocks

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| `.card` | radius 16, 1px border, gradient + panel, inset hairline, pad 20 (`site.css:1257-1273`) | 23 files, e.g. `app.html:29,42,52`; `landing.html:55` | `key-page > .card` pad 24 (`site.css:2063`) then pad 12/16 (`site.css:3839`) — two page overrides. |
| `.hero` | radius 16, pad from base? (`site.css:89-97,1257`) | Landing/utility heroes | Legacy radius 10 at `site.css:89`; newer shell at 1257. |
| `.stat` | pad 14/15, radius 11, 1px border, pad-2 (`site.css:1778-1781`) | `app.html:45-48`, `me.html:55-58`, `run.html:79-82` | Radius 11; value 23/750. |
| `.stat-card` | pad 18/20, radius 0, no border (`site.css:1521-1531`) | `mnemonic-seeds.html:243` | A flat stat inside a bordered panel; label uppercase .09em. |
| `.key-stat` | pad 10/12, radius 12, bordered (`site.css:2487-2490`) | `key.html:104-119` | Page override pad 4/10, value 16px (`site.css:3846-3847`). |
| `.pz-stat` | pad 14/16, radius 12, bordered (`site.css:3060-3084`) | Puzzle browser | Value clamp 20–27/750; label uppercase .06em. |
| `.vanity-stat` | font 26/750; group pad 12/14 (`site.css:2589-2595`) | Vanity page | Another value size/weight. |
| `.tool-card` | pad 12/13 radius 8 (`site.css:963-973`); pad 16 radius 12 (`site.css:1774-1777`) | Landing/tool index | Two definitions for the same card. |
| `.chain-card` | min-h 132, radius? (`site.css:882,1361-1400,1756-1758`) | Landing/private keys | Three definitions; icon wrap 52/60. |
| `.address-db-card` | pad 14/15, radius 12 (`site.css:2858-2868`) | Landing address DB | Another card size. |
| `.tool-index-card` | pad 16, radius 16, lift on hover (`site.css:2631-2645`) | Tool index | Only card with a translateY hover. |
| `.address-type-card` | min-h 66, pad 11/14, radius 11 (`site.css:1587-1611`) | Key/seed filters | A control styled as a card. |
| `.monitor-provider` | min-h 58, pad 9/12, radius 8 (`site.css:487-504`; redefined `1825,1996`) | Monitor | Three definitions. |
| `.ws-chain-card` | radius 14 (`site.css:3596-3604`) | Global search results | Radius 14 is unique. |

### 2.9 Tables and rows

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| `.key-addr-tbl` | fixed layout, cell pad 8, header 12/700 uppercase .07em, row states (`site.css:2320-2360`) | `key.html:205-215` | No horizontal wrapper; relies on fixed widths. |
| `.pz-table` | font 12.5, cell pad 8/10, header 12/700 uppercase .05em, mobile block layout (`site.css:3199-3216,3404-3443`) | Puzzle browser | Transforms to cards below a breakpoint. |
| `.global-search-table` | font 12.5, header pad 4/6, cell pad 8/6, uppercase .05em, mobile block layout (`site.css:3502-3560`) | Global search results | Different header padding from the other tables. |
| `.range-table` | min-width 620, vertical-align top; wrapper scrolls (`site.css:709-720`) | `range.html` | Horizontal scroll only; no mobile card layout. |
| `.table-scroll` | overflow auto, radius 11, pad 6 (`site.css:1787,2025`) | `app.html`, `landing.html`, `me.html` | Two definitions, radius 11. |
| `.ws-address-item` | grid 28/82/1fr/auto, pad 4/0 (`site.css:3616-3626`) | Global search cards | A row grammar inside the card, not the table. |
| `.bw-row` | row grid, padding 7/0 (`brainwallet.css:56-84`) | Brainwallet directory | A third row grammar in a separate stylesheet. |
| `.monitor-watch` | pad 12/0, bottom border (`site.css:551-559`) | Monitor | A fourth row grammar. |

### 2.10 Pagination

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| `.pager` / `.pager-btn` | flex gap 7; min-h 44, pad 0/12, font 13/650, radius 9; random variant amber (`site.css:1476-1493`) | `mnemonic-seeds.html:223-228` | One family, but no shared `aria-current` or page-size grammar. |
| `.milk-pager` | No CSS rule found | `milk-sad.html:109` | Class exists with no component definition (inherits the page layout). |

### 2.11 Breadcrumbs

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| `.breadcrumbs` | flex gap 7, font 13, muted; links min-h 44/min-w 44 (`site.css:65-77,1169-1181`) | 18 pages, e.g. `docs.html`, `key.html`, `range.html` | Two definitions; current-page selector is `span[aria-current]` in one block and `[aria-current]` in another; no separator glyph, no truncation. |

### 2.12 Empty, loading and error states

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| `.key-empty` | pad 18, dashed border, radius 12, centre (`site.css:2483`) | `key.html:123,218` | A boxed empty state. |
| `.pz-empty` | margin 12, pad 14, dashed, radius 10, font 12.5 (`site.css:3257-3264`) | Puzzle browser | A second boxed empty state with a different radius/font. |
| `.range-empty` | pad 14/10, muted cell (`site.css:725`) | `range.html:83` | A table-cell message, not a box. |
| `.monitor-empty` | No CSS rule found | `monitor.html:93,99,131,164` | Unstyled empty copy. |
| `.cell-skeleton` | font 12.5, pulse animation (`site.css:1689-1691`) | Browse/key rows | Text skeleton. |
| `.range-skeleton` | 12px high, radius 4, shimmer (`site.css:726-742`) | Range table | Block skeleton. |
| `.key-status-skeleton` | 72×10, radius 4, shimmer (`site.css:3755-3764`) | Key status line | Third skeleton. |
| Errors | `.error`, `.key-error` (`site.css:158,278,1282`), `.range-error` (`705`), `.wallet-field-error` (`wallet.html:34`), `.puzzle-state.err` (`941`), `.brainwallet-error` (`785`), `.bw-row-error` (`brainwallet.css:178`) | Across pages | Seven error grammars; some are full boxes, some are inline text. |

### 2.13 Dialogs, popovers and tooltips

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| Global search dialog | `width: min(660px, 100vw-28)`, radius 20, border-strong, shadow 30/80, backdrop blur (`site.css:2537-2546`; markup `site.js:357-404`) | Every page | Only true modal; focus handled by native `<dialog>`. |
| Key info popover | absolute, `top:100%+6`, right 0, `min(430px, 100vw-40)`, radius 12, pad 12/14, max-h 60vh/360 (`site.css:3956-3975`; markup `key.html:77-85`) | Key page | Different radius/padding from the modal; owned by the tooltip PR. |
| Native tooltips | 32 `title="..."` attributes across `apps/site/*.html` | Icon buttons, truncated facts | No hover/focus tooltip primitive; OS tooltip only. `aria-label` is present on 107 controls, so names are not lost. |

### 2.14 Navigation and shell

| Variant | Geometry (file:line) | Used on | Inconsistency |
|---|---|---|---|
| Legacy `.site-nav` | sticky, gap 14, pad 12/20, bg `#161b22`, blur 6, links min-h 38 pad 8/11 radius 6 (`site.css:31-62`) | Still in the cascade | Overridden by the newer block but not deleted. |
| Current `.site-nav` | min-h 70, inline pad `max(22px, (100vw-1320)/2)`, nav-bg, blur 16, links min-h 44 pad 0/12 radius 999 font 14/600 (`site.css:1069-1151`) | Every page | The real shell; brand mark uses a three-stop gradient (`1096-1105`), a slop tell. |
| `.nav-pill` | h 44, pad 0/14, radius 999, font 13.5/650 (`site.css:1133-1151`) | Search, theme, cabinet | `.nav-cabinet` is a primary-coloured pill, not `.btn.primary`. |
| `.nav-icon-pill` | width 40 but `min-width: 44` from `.nav-pill` (`site.css:2873`) | Search/theme icons | Two rules cooperate to reach 44; fragile. |
| Mobile drawer | `.nav-more-btn` and drawer rules (`site.css:4093+`) | Below 860px | Split nav via JS; no shared shell component. |

## 3. Page-local implementations (bypassing the system)

| File | Evidence | What it re-implements |
|---|---|---|
| `apps/site/wallet.html` | `<style>` at lines 11-40 | Vault rows, label inputs (pad 7/9, radius 7), status (13px), field errors, review grid, hex block. |
| `apps/site/send.html` | `<style>` at lines 11-114 | Chain tabs, status (12.5px), error slots, review/step layout. |
| `apps/site/tools.html` | `<style>` at lines 11-74 | Tool families/index layout. |
| `apps/site/mnemonic-seeds.html` | `<style>` at lines 11-133 | Directory layout, chain tabs, pager, stat cards. |
| `apps/site/brainwallet.css` | 312 lines | Row grid, badges, copy buttons, balances, empty/error states. |
| `apps/site/seed-studio.css` | 109 lines | Seed form, controls, checks, results. |

These files are loaded **after** `site.css` in each page head, so they win ties
without a token layer. Any shared component change has to be repeated here or
overridden with page-specific selectors — the exact failure mode this design
system removes.

## 4. Top 10 measured inconsistencies

1. **Two token roots with different accents and radii** —
   `site.css:2-17` (blue, radius 10) vs `site.css:998-1031` (amber, radius 16).
   The current UI is an accident of cascade order.
2. **Base controls are declared twice** — `site.css:126-140` (pad 7/9,
   radius 6, raw `#0d1117`) and `site.css:1189-1247` (pad 9/12, radius 10,
   44px). Every page inherits whichever declaration wins.
3. **Control heights are off-scale** — 38px `.monitor-remove`
   (`site.css:549`), 46px `.global-search-submit` (`2892`) and
   `.puzzle-cta .btn` (`3112`), 52px inner search input (`2559`), 56px hero
   input (`2075`), 58px monitor provider (`487`).
4. **Twelve radius values** — 0, 4, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 999.
   The same icon button is 7px (`1657`), 9px (`3517`), 10px (`3241`) and 11px
   (`3774`).
5. **Four icon-button grammars** — `.icon-btn` (transparent, 14px icon),
   `.key-icon-btn` (filled, 18px), `.global-search-icon-btn` (filled, 15px),
   `.pz-icon` (transparent, 16px). All are 44×44, but they read as different
   products.
6. **Six chip/tab grammars** — pad 0/12, 0/13, 0/14, 0/16, 5/12, 6/11; font
   12, 12.5, 13, 13.5; three active fills (accent, color-mix, accent-soft).
7. **Eight badge/status-pill variants** — font 10.5–12, padding 1/7 through
   5/10, uppercase tracking .04–.6em. `.ws-chain-status` (`3605`) is below the
   12px text floor.
8. **Cards and stats have no common padding/radius/value scale** — card pad
   12/13, 14/15, 16, 18/20, 20, 24; radius 0, 8, 11, 12, 14, 16; stat values
   16, 18, 23, 24, 26, 27, 28px; weights 700/750. The key page overrides its
   own card padding twice (`2063` then `3839`).
9. **Four table implementations plus two mobile transforms** — `.key-addr-tbl`
   (`2320`), `.pz-table` (`3199`), `.global-search-table` (`3502`),
   `.range-table` (`714`); header padding 4/6 vs 8/10; uppercase tracking .05
   vs .07; one table scrolls, one is fixed, two collapse to cards.
10. **Page-local CSS is a parallel design system** — four inline `<style>`
    blocks (`wallet`, `send`, `tools`, `mnemonic-seeds`) plus
    `brainwallet.css` and `seed-studio.css`. Example: the vault label input is
    pad 7/9/radius 7 (`wallet.html:17`) while the base input is pad 9/12/radius
    10 (`site.css:1189`); the send status is 12.5px (`send.html:108`) while
    the shared status line is 12px.

## 5. What the current gate already catches

`scripts/ui-audit.mjs` checks: horizontal overflow, clipped controls, raw path
text, text below 12px, targets below 44×44, unlabeled icon controls, duplicate
address-type families, address-type width spread, mostly-empty blocks, manual
balance controls, key auto-derive, seed form width, directory row counts, HTTP
errors, and `/site-map` 404. At this baseline it does **not** check token scale,
control height scale, radius scale, status-pill geometry, or adjacent
icon-button spacing. Batch 1 adds `status-pill-geometry`; the remaining
detectors are assigned to the batches that normalize each family
(`docs/design-system/plan.md` §3).
