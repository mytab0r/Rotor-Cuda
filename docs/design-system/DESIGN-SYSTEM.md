# Rotor Design System

Version: 0.1 (foundation). Date: 2026-11-21.
Status: normative for new UI; existing pages migrate batch by batch through
`docs/design-system/plan.md`. The inventory that this system replaces is
`docs/design-system/inventory.md`.

## 0. Scope and non-goals

In scope: every visible element on the coordinator-served site — controls,
fields, cards, stats, tables, status, navigation, overlays, empty/loading/error
states. The system is plain CSS custom properties and class contracts; token
values are generated from `design/tokens/tokens.json` by
`scripts/build-tokens.mjs`, and there is no framework.

Out of scope for v0.1: changing behaviour, renaming routes, restructuring page
content, new imagery, coordinator/Rust changes, wasm.

## 1. Direction

Derived with `unslop`, `impeccable`, `ui-checklist` and `ui-ux-pro-max`, and
aligned with the existing dark theme.

- **Product.** A local-first key and puzzle explorer for people who inspect
  private keys, addresses, transactions and balances without sending secrets to
  a server.
- **Character.** Exact, quiet, instrument-like. Trust comes from legible
  numbers, stable rows and obvious state, not decoration.
- **World.** A lab bench at night: graphite surfaces, hairlines, one amber
  signal, green/red only where they mean settled/failed.
- **Moments.** The derived-address table and the balance/status dots carry the
  colour; the chrome stays neutral.
- **Signature.** The 8px status dot plus a hairline row state (`has-balance`,
  `is-active`, `key-row-focus`) used the same way everywhere.

Consequences: no hue gradients on surfaces, no glows, no gradient text, no
uppercase tracked labels as a default, no decorative icons in card titles. The
brand mark is the one permitted gradient moment; it is not a pattern for
components.

### Reference methodologies (not skins)

| Source | What we take |
|---|---|
| Google Material 3 | Three token layers (primitive → semantic → component), state layers, explicit default/hover/focus/pressed/disabled/loading states. We use 44 CSS px as the touch floor (WCAG 2.5.8 and the repo gate), not Material's 48dp. |
| Cloudflare dashboard density | 12–14px UI type, 8–12px cell padding, compact data rows, tables before cards on data-heavy pages. |
| GitHub Primer (donor) | Neutral surface ramp separated by hairlines; colour reserved for state and the primary action. |
| `unslop` | 4px spacing grid, quiet chrome, one accent, no uppercase tracked labels, no looping/entrance decoration. |
| `impeccable` (Operate mode) | Precision and restraint; verify the rendered result at 375/768/1280 in both themes. |
| `ui-ux-pro-max` | ≥8px gap between adjacent touch targets; tables inside an overflow wrapper or a card layout at narrow widths; fluid, content-driven heights. |

## 2. Token architecture

Three layers, declared in `design/tokens/tokens.json` and generated into
`apps/site/site.css`:

1. **Primitive** — the raw scales below (space, radius, type, weight, motion,
   elevation, z-index).
2. **Semantic** — roles that components consume: `--surface-*`, `--line-*`,
   `--ink-*`, `--signal-*`, `--state-*`.
3. **Component** — per-family aliases if a component needs a local value; the
   value must resolve to a primitive or semantic token.

The existing names (`--bg`, `--panel`, `--text`, `--accent`, `--radius`,
`--radius-sm`) stay as aliases; the legacy duplicate root above them was deleted
in batch 7, so there is one `:root` source of truth. New code must use the
canonical names. The light theme overrides the palette through
`html[data-theme="light"]`, never a second `:root`; `scripts/ui-audit.mjs`
enforces this with the `legacy-token` detector.

### 2.1 Primitive tokens (added in batch 1)

```css
/* Spacing: 4px base. Use these steps, not literals. */
--space-1: 4px;   --space-2: 8px;   --space-3: 12px;  --space-4: 16px;
--space-5: 20px;  --space-6: 24px;  --space-7: 32px;  --space-8: 40px;
--space-9: 48px;  --space-10: 56px;

/* Radii: control 10, panel 12, card 16, modal 20, pill 999. */
--radius-xs: 4px;  --radius-s: 8px;   --radius-m: 10px;  --radius-l: 12px;
--radius-xl: 16px; --radius-2xl: 20px; --radius-pill: 999px;
--radius-control: var(--radius-m);

/* Control heights. 44 is the touch floor and the default; 28 is reserved for
   dense table rows whose row is the target; 36 is a compact desktop toolbar;
   56 is the hero input. */
--control-h-sm: 28px; --control-h-md: 36px; --control-h-lg: 44px;
--control-h-xl: 56px; --control-h: 44px;

/* Icons pair with the control heights. */
--icon-size-sm: 14px; --icon-size-md: 16px; --icon-size-lg: 18px;

/* Type scale. 12 is the minimum visible size. */
--text-xs: 12px; --text-sm: 13px; --text-md: 14px; --text-lg: 16px;
--text-xl: 20px; --text-2xl: 24px; --text-3xl: 32px; --text-4xl: 40px;

/* Weights. 650 is the control label; 700+ is deprecated. */
--weight-regular: 400; --weight-medium: 500; --weight-semibold: 600;
--weight-bold: 650;

/* Motion. */
--duration-fast: 120ms; --duration-base: 160ms; --duration-slow: 240ms;
--ease-standard: cubic-bezier(.2, .7, .2, 1);

/* Elevation: dark theme uses surface steps + hairlines; shadows are overlays. */
--elev-1: 0 1px 0 rgba(255, 255, 255, .025) inset;
--elev-2: 0 8px 20px rgba(0, 0, 0, .34);
--elev-3: 0 20px 55px rgba(0, 0, 0, .38);

/* Stacking. */
--z-nav: 60; --z-popover: 30; --z-modal: 100;
```

Light theme must override only semantic colour roles. Geometry, type, motion
and elevation are shared; if a light-mode value differs, it is a semantic colour
token, not a new literal.

### 2.2 Semantic roles

| Role | Dark value | Light value | Use |
|---|---|---|---|
| `--surface-0` | `var(--bg)` `#07090e` | `#f5f7fa` | Page |
| `--surface-1` | `var(--panel)` `#0d121a` | `#ffffff` | Card/panel |
| `--surface-2` | `var(--panel-2)` `#121924` | `#f2f5f9` | Raised control/row |
| `--surface-3` | `var(--panel-3)` `#18212e` | `#e8edf4` | Hover/pressed |
| `--line-subtle` | `var(--border)` `#1f2a38` | `#d5dde8` | Hairline |
| `--line-strong` | `var(--border-strong)` `#2f3e52` | `#b9c6d8` | Control border |
| `--ink-1` | `var(--text)` `#f3f7fc` | `#0f1720` | Primary text |
| `--ink-2` | `var(--text-2)` `#c8d3e1` | `#283442` | Secondary text |
| `--ink-3` | `var(--muted)` `#8d9bb0` | `#5a6b80` | Muted/helper |
| `--signal` | `var(--accent)` `#f5b544` | `#a86800` | Primary action/selection |
| `--signal-soft` | `var(--accent-soft)` | `rgba(168,104,0,.10)` | Selected surface |
| `--signal-ink` | `var(--accent-ink)` `#171004` | `#ffffff` | Text on signal |
| `--state-ok` | `var(--ok)` `#45d6a0` | `#0b7a4d` | Settled/success |
| `--state-warn` | `var(--warn)` `#f5b544` | `#8a6400` | Warning |
| `--state-err` | `var(--err)` `#ff7070` | `#b3261e` | Failure/destructive |

Rules: one accent in the chrome; semantic colours only carry meaning; never
encode meaning by colour alone (pair with text, icon or a labelled dot). Raw hex
belongs only in the root token blocks. Async states consume the semantic roles
in §3.13: `.empty-state` uses `--line-subtle`/`--ink-3`, `.error` uses the
failure palette, and `.skeleton` uses `--surface-2`→`--surface-3`.

### 2.3 Contrast

Measured on the current root (`inventory.md` §1.2): primary/secondary/muted
text, accent, `--signal-ink` on accent, and status colours all pass 4.5:1 in
dark. Light `--accent` on white is 4.52:1 — it has no headroom, so do not
lighten it or reduce its size below 14px for text use. UI borders and icons need
3:1.

## 3. Component grammar

Every component API lists anatomy, sizes, states and accessibility. State names
are stable: `default`, `hover`, `focus-visible`, `active` (pressed/selected),
`disabled`, `loading`, `copied` where relevant.

### 3.0 Component contracts and the live gallery

`design/components/<name>.json` is the machine contract for each normalized
family: `name`, `version`, `status`, `element`, closed `variants` and `sizes`,
`states`, `requiredAttrs`, `forbidden`, `slots`, `tokens`, `detectors`, `docs`.
The human contract is `docs/design-system/components/<name>.md`; the rendered
evidence is the generated `/cabinet/admin/design` gallery (`apps/site/design.html`, produced by
`scripts/build-gallery.mjs` from the manifests and the production markup). The
gallery is internal and noindex, and it is audited at 375/768/1280 in both
themes like any other route.

Gates: `node scripts/build-gallery.mjs --check` proves the committed page is not
stale; `node scripts/check-components.mjs` fails on a manifest class with no rule
in `site.css`, a variant/size/state missing from the gallery, a required
attribute missing on an example, and a page-local `<style>` rule that targets a
shared family.

The prose in §3.1–§3.16 is the target grammar. Where a variant, size or alias is
listed there but absent from the matching manifest, it is not rendered by any
page today and is either reserved CSS (documented on the component page) or not
implemented; the manifest and the gallery are the current contract.

Component pages: [button](components/button.md),
[icon-button](components/icon-button.md), [field](components/field.md),
[segmented](components/segmented.md), [chip](components/chip.md),
[status](components/status.md), [card](components/card.md),
[stat](components/stat.md), [table](components/table.md),
[nav](components/nav.md), [breadcrumb](components/breadcrumb.md),
[pager](components/pager.md), [empty](components/empty.md),
[error](components/error.md), [skeleton](components/skeleton.md).

### 3.1 Button

```html
<button class="btn btn--primary">Search</button>
<button class="btn">Cancel</button>
<button class="btn btn--ghost">Copy all</button>
<button class="btn btn--danger">Remove</button>
```

- Base `.btn`: inline-flex, gap `--space-2`, min-height `--control-h`, padding
  `--space-2 --space-4`, radius `--radius-m`, border `--line-strong`,
  background `--surface-2`, font `--text-md`/`--weight-bold`.
- Variants: `.btn--primary` (signal fill), `.btn--secondary` (default),
  `.btn--ghost` (transparent, text/border only), `.btn--danger` (error tone).
- Sizes: `.btn--lg` min-height `--control-h-xl`; `.btn--sm` min-height
  `--control-h-sm` only inside dense desktop toolbars, never as the only action
  on a touch surface.
- States: hover `--surface-3` or signal hover; focus-visible 2px signal outline
  offset 2px; active pressed surface; disabled opacity .42 +
  `pointer-events:none` + `aria-disabled`; loading keeps the label, adds a
  16px spinner and `aria-busy="true"`, and disables the control.
- One primary action per card/section. No gradient except the legacy brand mark.
- Migration alias: `.primary` maps to `.btn--primary` until batches 2–4.

### 3.2 Icon button

```html
<button class="icon-button icon-button--quiet icon-button--lg"
        aria-label="Copy address" data-tooltip="Copy address"
        data-copy-state="idle">…</button>
```

- One grammar: `.icon-button` plus exactly one variant and one size.
- Variants: `.icon-button--quiet` (transparent, no border; the default row
  action), `.icon-button--outline` (1px `--line-strong`; a toolbar action beside
  a field), `.icon-button--solid` (signal fill; one primary icon action). Do not
  invent a fourth.
- Sizes: `.icon-button--sm` (`--control-h-sm` 28, `--icon-size-sm` 14) is
  reserved for dense table rows whose row is the target; `.icon-button--md`
  (`--control-h-md` 36, `--icon-size-md` 16) is a compact desktop toolbar;
  `.icon-button--lg` (`--control-h-lg` 44, `--icon-size-lg` 18) is the default
  and the touch floor. Use `--lg` on any standalone control and at 375px.
- Geometry: square box, radius `--radius-control`, icon size follows the box.
- Required: `aria-label` (the accessible name, never the tooltip) plus
  `data-tooltip` from the shared primitive. Do not add a native `title`
  alongside `data-tooltip`. `.is-copied` turns the text/border `--state-ok` for
  1.2s, swaps to the check glyph and announces via `aria-label`.
- States: hover surface (`--surface-2`/`--surface-3`), active `--surface-3`,
  focus-visible 2px signal outline offset 2, disabled opacity .42,
  `aria-busy="true"` keeps the box and swaps the glyph for a spinner.
- Adjacent icon buttons keep ≥8px gap. Do not place two unlabeled icon-only
  controls side by side without distinct labels.
- Reduced motion disables the hover transition and the busy spin.
- Migration: `.icon-btn`, `.key-icon-btn`, `.global-search-icon-btn`,
  `.pz-icon`, `.key-copy-icon`, `.browse-balance-retry` map here; page-local
  copies are deleted in the same batch.

### 3.3 Segmented control

```html
<div class="segmented" role="group" aria-label="Curve">
  <button type="button" class="segmented__item" aria-pressed="true">secp256k1</button>
  <button type="button" class="segmented__item" aria-pressed="false">ed25519</button>
</div>
```

- Track: padding `--space-1` (4), radius `--radius-l` (12), background
  `--surface-0`, border `--line-subtle`, gap `--space-1`.
- Item: min-height `--control-h` (44), padding `0 --space-4`, radius
  `--radius-s` (8), font `--text-sm`/`--weight-bold`.
- Selected: `aria-pressed="true"` (or `.is-selected`) uses signal fill +
  signal-ink. Hover: `--surface-2`. Focus-visible: 2px signal outline offset 2px.
  Disabled: opacity .42.
- Use for 2–4 mutually exclusive modes. For filters that can combine, use chips;
  for navigation, use links. One control per purpose — never a segmented control
  plus an equivalent select.
- Enforced by `scripts/ui-audit.mjs` `segmented-geometry`: one track padding and
  radius, 44-high items, exactly one selected item per group.

### 3.4 Chip

```html
<button type="button" class="chip" aria-pressed="true">Bitcoin</button>
<a class="chip" href="/private-keys/btc" aria-current="page">Bitcoin</a>
```

- `.chip`: min-height `--control-h` (44), padding `0 --space-3`, radius
  `--radius-pill`, border `--line-subtle`, background `--surface-2`, font
  `--text-xs`/600, gap `--space-1` for an icon.
- Selected: `aria-pressed="true"`, `aria-current="page"` or `.is-selected` uses
  `--signal-soft` + signal border/text. Hover: `--surface-3`. Focus-visible:
  2px signal outline offset 2px. Disabled: opacity .42.
- Chips filter a result set, choose a preset or navigate a directory. They do
  not submit. A row of chips must not duplicate a select or a second toolbar.
- `.chip--primary` (signal fill, signal text) is the one filled chip and is
  reserved for the cabinet navigation action; do not use it for filters.
- The chain dot stays a small colour swatch (`--chain`); the chip surface itself
  uses the signal role, not a per-chain fill.

### 3.5 Badge / status pill

```html
<span class="status status--ok">Settled</span>
<span class="status status--warn">Checking</span>
<span class="status status--err">Failed</span>
```

- One geometry: min-height 20, padding `2px --space-2`, radius `--radius-pill`,
  font `--text-xs`/600, line-height 1.2, no tracking, sentence case.
- Tones: `.status--neutral` (surface-2/ink-2), `.status--info` (signal-soft),
  `.status--ok`, `.status--warn`, `.status--err` (tinted border + text).
- Optional `.status__dot` 8px, `aria-hidden` when the text already names the
  state.
- Lives inside a table cell, card header or meta row; it is not a button. The
  count badge (`.balance-refresh-count`) is the same geometry with mono digits.
- Legacy aliases (`.badge`, `.key-badges span`, `.puzzle-badge`,
  `.puzzle-status`, `.pz-pill`, `.ws-chain-status`, `.monitor-chain`) map to
  this geometry in batch 1.

### 3.6 Inline message

```html
<p class="message message--warn" role="status">Balances load automatically.</p>
<p class="message message--err" role="alert">The RPC rejected the request.</p>
```

- Padding `--space-3 --space-4`, radius `--radius-l`, 1px tinted border, tinted
  surface, `--text-sm`, line-height 1.45.
- Tones: `--info`, `--ok`, `--warn`, `--err`. Use `role="status"` for progress
  and `role="alert"` only for errors that need immediate attention.
- No 11px padding and no raw `#e3b341`; the legacy `.notice`/`.error` blocks
  migrate in batch 3.
- Status lines (`.status-line`) are the text-only sibling: font `--text-xs`,
  line-height 1.45, margin `--space-2 0 0`, colour `--ink-3` or the state tone.

### 3.7 Field

```html
<label class="field">
  <span class="field__label">Private key</span>
  <input class="field__control" aria-invalid="false" aria-describedby="key-hint">
  <span class="field__hint" id="key-hint">Hex, WIF or brainwallet text.</span>
  <span class="field__error" role="alert" hidden></span>
</label>
```

- Control: min-height `--control-h` (44), padding `--space-2 --space-3`, radius
  `--radius-control` (10), border `--line-strong`, background `--surface-0`,
  font `--text-md`.
- Focus: `:focus` border signal + 3px `--signal-soft` ring. Invalid:
  `[aria-invalid="true"]` error border + error ring; never remove the focus
  ring. Disabled: opacity .55, not-allowed cursor.
- Label 12/600 (`--text-xs`/`--weight-semibold`), hint 12/400 `--ink-3`, error
  12/600 `--state-err`.
- Selects keep the custom arrow but the arrow position is centred, so it follows
  the control height instead of a fixed 18px.
- Hero input exception: `--control-h-xl` height, radius `--radius-xl`, font
  `--text-md`; this is a named size (`.field--hero`), not a page override.
- The bare `input, select, textarea` and `label` selectors are the migration
  alias until every page has the classes. Enforced by `scripts/ui-audit.mjs`
  `control-height-scale` (28/36/44/56; textareas keep the 44 floor) and
  `field-geometry` (radius 10/16, label >=12, focus ring).

### 3.8 Card

- `.card`: padding `--space-5`, radius `--radius-xl`, 1px `--line-subtle`,
  background `--surface-1`, `--elev-1`.
- `.card--flat`: no border/shadow, padding 0 (for a section inside a card).
- `.card--stat`: padding `--space-4 --space-5`, radius 0, no border, used only
  inside a stat strip.
- Header `h2`: `--text-xl`, weight 600. One primary action; secondary actions
  quieter.
- No fixed heights that leave empty space; the audit's `mostly-empty-block`
  check applies.
- Page-scoped overrides (`.key-page > .card`) are deleted; use a named variant.
- Named card surfaces share the scale: `.chain-card` (20/16, no translateY
  hover), `.tool-card`/`.address-db-card` (16/12), `.tool-index-card`,
  `.tool-family` and `.pz-picker-card` (16/16). Enforced by
  `scripts/ui-audit.mjs` `card-padding-scale`: padding in {16,20,24}, radius in
  {12,16}; `.card--flat` and the boxless `.stat-card`/`.card--stat` strip cell
  are the documented exceptions.

### 3.9 Stat

- `.stat`: padding `--space-4`, radius `--radius-l`, border `--line-subtle`,
  background `--surface-2`.
- `.stat-label`/`.stat__label` (also `.stat-card .stat-label`,
  `.key-stat-label`, `.pz-stat-label`): `--text-xs`, 600, `--ink-3`, sentence
  case (no uppercase, no tracking). `.stat-value`/`.stat__value` (also the
  card/key/puzzle variants): 24 (`--text-2xl`), 600, tabular-nums, `--ink-1`.
  `.stat__meta`: `--text-xs`, `--ink-3`, includes units and timeframe.
- Values align right in a row; labels start on one line; no sparkline or icon
  used as filler. Small values use `.stat--sm` or `.stat-value.small`
  (`--text-xl`); `.key-stat-value` uses the small size. `.stat-card` is the
  boxless cell inside `.balance-summary`.
- `.balance-summary--browse` (the private-key listing strip) lays each
  `.stat-card` out as one label/value line and keeps the refresh control and
  the balance note on that same row. Padding, label and value sizes are the
  shared ones; the three-card (UTXO) browse strip uses the `--text-xl` (20px)
  value step so three cards end level on one line at 1440 and 1280, and the
  note is 200px so a long balance never breaks mid-value. Only the layout is
  inline. Other summaries keep the stacked cards.
- Enforced by `scripts/ui-audit.mjs` `stat-geometry`: label >=12 and no
  `text-transform`, value in {20,24,28} with tabular digits; `browse-stat-level`
  requires the three browse cards to end within 2px.

### 3.10 Data table

```html
<div class="table-scroll" role="region" aria-label="Derived addresses" tabindex="0">
  <table class="data-table">
    <caption class="visually-hidden">…</caption>
    <thead><tr><th scope="col">Chain</th>…</tr></thead>
    <tbody>…</tbody>
  </table>
</div>
```

- Wrapper: `.table-scroll` (`overflow-x:auto`, `overscroll-behavior-x:contain`,
  border `--line-subtle`, radius `--radius-l`, no padding), `tabindex="0"`,
  accessible name. Every table carries `.data-table`; a table never forces the
  page wider.
- Header: `--text-xs`, 600, `--ink-3`, sentence case; no uppercase tracking;
  header row height `--control-h` (44).
- Cell padding `--space-2 --space-3`; body row min-height 44; long values wrap
  with `overflow-wrap:anywhere`; numeric columns use tabular-nums and align
  right.
- Row states: hover `--row-hover`; `has-balance` tinted ok; `is-active` tinted
  signal; `key-row-focus` signal hairline + surface. States are independent and
  must be recognisable apart; the div-based directory/seed rows use the same
  tokens.
- Actions: one icon-button grammar at the trailing edge (44×44, radius
  `--radius-control`, labelled).
- Listing rows (`.key-row`) show every address form of a key immediately: a
  legacy Bitcoin key is two 44px `.addr-line`s (`(c)`/`(u)`), each with its
  explorer link (title carries the full address) and 44px copy action; there is
  no disclosure or hidden line. The balance cell has one `.balance-info` per
  address: the balance plus separate `.badge` TX and received pills with
  accessible names; a zero received amount and relative-age labels are not
  rendered. The key-cell copy is a real 44px `.icon-button` with
  `aria-label`/`data-tooltip`, never a `display:none` button. The page declares
  its total (`data-addresses-per-page`: 120 for legacy BTC, 60 for a
  single-address chain) and the visible counter must match it. Enforced by
  `browse-row-address-count`, `browse-row-balance-lines`,
  `browse-row-key-copy` and `browse-row-height` (stable row height, <=120px
  desktop).
- Mobile: tables keep the horizontal scroll wrapper and all columns; they do
  not turn into cards. Directory/seed row lists may stack, but keep their
  labels. Enforced by `scripts/ui-audit.mjs` `table-grammar`,
  `table-header-style`, `table-row-height` and `row-action-geometry`.

### 3.11 Pagination

- One pager per table: `<nav class="pager" aria-label="Key pages">` with
  `.pager-btn` anchors for First/Previous/Next/Last and one optional
  `.pager-btn--random` action.
- `.pager` flex, `gap --space-2`; `.pager-btn` min 44×44, padding
  `0 --space-3`, radius `--radius-control` (10), font `--text-sm`/650, icon 16.
- `aria-current="page"` for the current page; `aria-disabled="true"` for an
  unavailable direction (the anchor stays focusable, click is prevented). Do
  not use a `.disabled` class or the legacy `.random` modifier.
- The numeric jump is one `.page-jump` form: label, 44px input and 44px submit;
  the range ("1–60 of 18,890") stays a `.page-info-text` status line.
- Enforced by `scripts/ui-audit.mjs` `pager-grammar` (structure, label,
  `aria-disabled`, no legacy modifiers) and `pager-geometry` (44px box,
  radius 10, 16px icon).

### 3.12 Breadcrumbs

- `<nav class="breadcrumbs" aria-label="Breadcrumb">` with one
  `<span class="breadcrumbs__sep" aria-hidden="true">/</span>` between items;
  never a bare text slash or a blank gap.
- Each link is a 44px target; the current page is exactly one
  `[aria-current="page"]` at `--ink-2`, and its visible label is human text,
  not a raw path. Long labels truncate via `title`/`aria-label`.
- Every public content page renders one trail. The landing page and the
  `/app`, `/run`, `/me`, `/cabinet` and `/cabinet/wallet` shells intentionally
  render none.
- Server-rendered pages use `breadcrumb_nav` in `src/coordinator/mod.rs`;
  client-filled trails use the shared `RotorBreadcrumbs` helper in `site.js`.
- Enforced by `scripts/ui-audit.mjs` `breadcrumb-grammar` (one separator
  marker, one landmark, 44px links) and `breadcrumb-current` (one human
  current label).

### 3.13 Empty, loading and error states

- `.empty-state`: dashed `--line-subtle`, radius `--radius-l`, padding
  `--space-5`, centred `--ink-3` text, optional `.empty-state__title` and one
  `.empty-state__action` slot. In a table use it on an inner `<div>` inside the
  spanning `<td>` so the cell keeps its table context.
- `.skeleton`: one implementation, `--surface-2` to `--surface-3` shimmer,
  radius `--radius-xs`, height 10–12px, `aria-hidden`, animation off under
  reduced motion. `.cell-skeleton` remains the text-placeholder variant.
- `.error`: tinted failure box (border, background and text), actionable text,
  retry button; never a blank card. Top margin is `--space-3` (12); field-level
  errors may use `--space-2` (8). The page modifiers `.key-error`/
  `.range-error`/`.monitor-status` add no geometry of their own.
- Every async surface ships loading → empty → error → success. A failed fetch
  says what failed and what to do. Enforced by `scripts/ui-audit.mjs`
  `empty-state-grammar` (static class/token scan plus rendered geometry).

### 3.14 Dialog, popover and tooltip

- **Dialog** (`.dialog` / native `<dialog>`): width `min(660px, 100vw-28px)`,
  radius `--radius-2xl`, `--elev-4`, backdrop `rgba(3,5,9,.72)` + 4px blur.
  Focus trap, Esc closes, focus returns to the trigger, `aria-modal="true"`,
  labelled by the title.
- **Popover** (`.popover`): anchored, offset `--space-2`, width
  `min(430px, 100vw-40px)`, radius `--radius-l`, padding
  `--space-3 --space-4`, `--elev-3`, `role="dialog"` with
  `aria-modal="false"`, Esc and outside click close, `aria-expanded` on the
  trigger.
- **Tooltip** (`.tooltip`): text only, 12px, radius `--radius-s`, padding
  `--space-1 --space-2`, delay 400ms on hover and focus, dismissed on Esc,
  referenced by `aria-describedby`; never the only source of a control's name.
- Native `title` is a fallback, not the system. The tooltip primitive is owned
  by the in-flight PR; batch 2 adopts it and removes page-local variants.

### 3.15 Navigation shell

- `.site-nav`: sticky, min-height 70, horizontal padding
  `max(--space-5, (100vw - var(--maxw)) / 2)`, background `--nav-bg`, 16px
  blur, hairline bottom, z-index `--z-nav`.
- Links: min-height 44, padding `0 --space-3`, radius `--radius-pill`, font
  `--text-md`/600, 18px icon. Active uses `aria-current="page"` with
  `--signal-soft` + signal text + signal hairline; `.active` remains a legacy
  alias for the same state. Focus-visible is the 2px signal ring.
- Utility cluster: exactly three controls — search (`.icon-button
  .icon-button--quiet .icon-button--lg` with `aria-label` + `data-tooltip`),
  theme (the same icon-button, injected by `theme.js`) and cabinet
  (`.chip .chip--primary`). No `.nav-pill` or one-off icon wrapper.
- Below 860px the primary links collapse into one More chip; the remaining
  links keep 44px targets and their accessible names. The brand mark is the
  only gradient.
- Enforced by `scripts/ui-audit.mjs` `nav-link-height` (44px box, 18px icon,
  44px utility controls).

### 3.16 Dropzone

```html
<div class="dropzone">
  <label class="dropzone__file-label">Choose a file
    <input class="visually-hidden" type="file" accept=".json,application/json,text/plain">
  </label>
  <p class="dropzone__hint">…or drop a file here. Max 64 KiB.</p>
  <p class="dropzone__name" role="status">Loaded file: name.json</p>
</div>
```

- Container: dashed 1px `--line-strong`, `--radius-l`, padding `--space-3`,
  background `--surface-0`, gap `--space-2`. It is a drop target and a layout
  wrapper, not a button.
- File control: `.dropzone__file-label` is a label wrapping a visually hidden
  but focusable native `<input type="file">`; min-height `--control-h`, padding
  `0 --space-4`, `--radius-m`, `--surface-2`, font `--text-md`/`--weight-bold`.
  Click and keyboard both open the picker; the label shows the focus ring
  through `:focus-within` (2px `--signal`, offset 2).
- States: default, hover `--surface-3`, drag-over `.is-dragover` (`--signal`
  border + `--signal-soft` surface), focus-visible ring; size/parse errors use
  the inline error message (§3.6), never colour alone.
- `.dropzone__hint` is `--text-xs`/`--ink-3`; `.dropzone__name` reports the
  loaded file at `--text-sm`/`--ink-2` with `role="status"`. Reduced motion
  removes the border/background transition.

### 3.17 Footer

- One `<footer class="site-footer">` on every public content page, rendered by
  `site_footer()` in `src/coordinator/mod.rs` (and inserted once into static
  HTML at serve time). It carries FAQ, Disclaimer, Donate, Docs and GitHub
  links, the copyright line and the current build id.
- Links are 44px targets; the row wraps without overflow at 375px.
- The app and cabinet shells (`/app`, `/run`, `/me`, `/cabinet`,
  `/cabinet/wallet`) intentionally render no footer.
- HTML responses are served with `Cache-Control: no-store`, so a cache cannot
  keep an older shell without the footer. Every first-party asset is referenced
  as `/a/<build>/<path>` and served `public, max-age=31536000, immutable`; bare
  asset paths keep `no-cache` with an `ETag` for old links.
- Enforced by `scripts/ui-audit.mjs` `footer-presence` per route and by
  `tests/coordinator_api.rs::every_public_content_route_renders_exactly_one_footer`
  across the coordinator's public content route list.

## 4. State matrix

| Component | Default | Hover | Focus-visible | Active/Selected | Disabled | Loading |
|---|---|---|---|---|---|---|
| Button | surface-2 + line-strong | surface-3 | 2px signal outline, offset 2 | pressed surface / signal fill for primary | opacity .42, no pointer | spinner + `aria-busy`, label kept |
| Icon button | quiet/outline/solid at 28/36/44 | surface-2/3 | same ring | `.is-copied` ok tone | opacity .42 | spinner in the same box |
| Segmented item | transparent | surface-2 | ring offset 2 | signal fill + signal-ink | opacity .42 | n/a |
| Chip | surface-2 | surface-3 | ring offset 2 | signal-soft + signal text | opacity .42 | n/a |
| Status pill | tone | n/a | n/a | tone | n/a | dot pulse only while checking |
| Field | surface-0 + line-strong | line-strong | signal border + 3px ring | n/a | opacity .55 | skeleton/disabled |
| Card | surface-1 + line-subtle | optional surface step | ring on the card link | selected row uses signal-soft | n/a | skeleton block |
| Table row | transparent | row-hover | key-row-focus | has-balance / is-active | n/a | skeleton cell |
| Nav link | ink-2 | surface-3 | ring | signal-soft + signal | n/a | n/a |

Motion: 120ms feedback, 160ms standard, 240ms enter; one easing
(`--ease-standard`). Never animate width/height/top/left; reduced motion turns
off shimmer/spin/entrance.

## 5. Accessibility contract

1. **Touch targets.** Every standalone control is ≥44×44 CSS px; adjacent
   targets keep ≥8px gap. The measured box is the control itself, not a
   `::before` overlay.
2. **Focus.** `:focus-visible` always visible: 2px `--signal` outline, offset
   2px (3px for inputs as a ring). Never `outline:none` without a replacement.
3. **Contrast.** Text ≥4.5:1; UI borders/icons ≥3:1. Light accent is 4.52:1 —
   do not lighten it.
4. **Text size.** No visible text below 12px. Status pills are 12px minimum.
5. **Names.** Icon-only controls have `aria-label`; the visible tooltip is
   `data-tooltip` from the shared primitive, which must never be the only source
   of the name. Inputs have a visible `<label>`; hints/errors are wired with
   `aria-describedby` and `aria-invalid`.
6. **Live regions.** Async progress uses `role="status"`/`aria-live="polite"`;
   errors use `role="alert"`. Copied state is announced.
7. **Keyboard.** Native elements first; no positive `tabindex`; dialogs trap
   focus, Esc closes, focus returns.
8. **No colour-only meaning.** Pair colour with text, icon or a labelled dot.
9. **Reflow.** Long addresses/keys wrap; tables scroll or become labelled
   blocks; no horizontal page overflow at 375px.
10. **Reduced motion.** `@media (prefers-reduced-motion: reduce)` disables
    shimmer, spin, pulse, drawer and entrance animations.

## 6. Naming rules

- Tokens: `--<category>-<role>-<variant>`, e.g. `--space-4`,
  `--radius-control` (alias), `--state-err`, `--duration-fast`.
- Components: `.block`, `.block__element`, `.block--variant` for new code.
  State: `.is-*` (transient) and `[aria-*]`/`[data-state]` (semantic). Data
  state: `has-*` (e.g. `has-balance`).
- No page prefix on a shared component. Page prefixes (`.key-page`,
  `.send-page`) are allowed only for layout scope and must not restyle a shared
  primitive.
- No element selectors when a class exists (`button {}` is legacy only).
- No raw hex outside the two root blocks; no `!important` except the
  reduced-motion override; no inline `style` except a documented CSS variable
  (`style="--chain:#f7931a"`).
- One control per purpose: no chips + select for the same filter, no two
  toolbars of the same action, no duplicate pager.

## 7. Migration rules

1. Add tokens and aliases first; no visual change is required in a token-only
   step.
2. One family per PR. Each PR names the family, the files, the detector, and
   the acceptance commands.
3. Move page-local CSS into the shared file in the batch that owns the family;
   delete the local rule in the same PR.
4. Never weaken an audit check or add a page-local bypass. If a check is noisy,
   change the threshold with a comment and a ledger entry.
5. Every defect gets a detector before its fix (`docs/process/defects.json`,
   `scripts/check-defect-ledger.mjs`).
6. Never add a `?v=` cache token: HTML is served with `no-store` and references
   assets as `/a/<build>/<path>` (immutable); bare asset paths revalidate by
   `ETag`.
7. The author never signs off their own UI PR; a different agent reviews
   screenshots and computed geometry at 375/768/1280 in both themes.

## 8. Gate coverage

The automated gate is `scripts/ui-audit.mjs` (CI: `.github/workflows/ui.yml`).
It checks overflow, small text/targets, unlabeled icon controls, duplicated
address-type components, half-empty blocks, manual balance controls, route row
counts and HTTP errors. The static gates `scripts/check-token-usage.mjs`,
`scripts/check-components.mjs`, `scripts/check-projects.mjs`,
`scripts/check-ssot.mjs` and the area test suites add the detectors below.

`data/detectors.json` is the single detector registry: `id`, `rule`, `batch`,
`implemented_in` (file), `doc_anchor` and `status`. `scripts/check-ssot.mjs`
fails when an id emitted by `scripts/ui-audit.mjs` is missing from the registry,
when a `docs/process/defects.json` detector has no implemented entry, or when
the three generated tables drift. `scripts/gen-detector-docs.mjs --check` is the
standalone freshness gate.

<!-- BEGIN GENERATED detectors:design-system -->
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
| `wallet-portfolio-summary` | The wallet summary counts only loaded balances, shows an explicit empty state instead of $0.00, names unpriced chains, hides stale/offline fiat, and keeps a 44px refresh control with the shared stat grammar. | phase 4 | implemented |
| `search-xrp-secret-routing` | XRP family seeds and secrets route to /key instead of a brainwallet hash. | phase 4 | implemented |
| `search-short-hex-padding` | 1-63 hex characters stay brainwallet text; exactly 64 hex is a key. | phase 4 | implemented |
| `mnemonic-solana-balances` | The Solana directory fetches every row with one batched getMultipleAccounts call. | phase 4 | implemented |
| `mnemonic-bch-balances` | The BCH directory batches every address through the Haskoin endpoint. | phase 4 | implemented |
| `bch-directory-provider` | The private-key BCH directory wires the batched Haskoin provider instead of per-row lookups. | phase 4 | implemented |
| `mnemonic-tron-xrp-sui-balances` | The TRON, XRP and SUI directories fetch balances for every row. | phase 4 | implemented |
| `mnemonic-xrp-redirect` | XRPScan is called with redirect: error so a cross-origin hop fails loud. | phase 4 | implemented |
| `mnemonic-sochain-quota-storm` | The first SoChain 429 stops the rest of a directory page instead of firing 60 retries. | phase 4 | implemented |
| `mnemonic-ltc-sochain-fallback` | A SoChain 429 serves the whole Litecoin directory page from the SSOT litecoinspace Esplora provider; DOGE and ZEC stay SoChain-only. | phase 4 | implemented |
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
<!-- END GENERATED detectors:design-system -->

Known debt that needs a design decision is listed in
`design/tokens/token-usage-baseline.json`; the baseline is shrink-only and
every entry carries an exact file:line and a reason. The human checklist is
`apps/site/UI-CHECKLIST.md` and the project skill
`.claude/skills/ui-self-review/SKILL.md`.

## 9. Versioning

- `0.x` — foundation and migration. Tokens may be added; values may change
  only with a batch and a changelog line here.
- Adding a component variant requires an entry in §3 and a detector or an
  explicit "not machine-checkable" note.
- Removing a legacy alias requires the batch that migrated the last usage.
- Batch 7 (2026-11-21): deleted the duplicate legacy `:root`, the overridden
  control/nav/breadcrumb rules and the dead page selectors; moved the four
  inline page `<style>` blocks into `site.css`; moved the brainwallet status
  badge, address-type and retry controls onto the shared status/chip/icon-button
  grammar; added the `legacy-token` detector.
- Phase 0-1 (2026-11-21): froze the 95 root names in
  `design/tokens/tokens.contract.json`; `design/tokens/tokens.json` is the
  source and `scripts/build-tokens.mjs` generates the marked `site.css` regions
  and `design/generated/tokens.ts`. No token value changed.
- Phase 2 (2026-11-21): added `scripts/check-token-usage.mjs` with the
  `token-contract`, `orphan-token`, `theme-parity`, `radius-scale`,
  `raw-hex-outside-root` and `legacy-selector` detectors. Replaced 64 in-scale
  `border-radius` literals with `var(--radius-*)` and three raw colours that had
  an exact token; marked the 14 unused tokens `reserved`; declared the 15
  semantic colour roles explicitly in the light block. Off-scale radii (21),
  raw colours without an exact token (106) and page-scoped shared-family
  overrides (6) are listed in `design/tokens/token-usage-baseline.json`.
- Phase 3 (2026-11-21): added manifests and component pages for the 15
  normalized families, `scripts/build-gallery.mjs` and the generated internal
  `/cabinet/admin/design` gallery, and `scripts/check-components.mjs` (manifest shape,
  unknown class, missing variant/size/state, required attribute, page-local
  style). No production component was restyled; reserved CSS with no page
  consumer (`.card--flat`, `.card--stat`, `.stat--sm`, `.icon-button--solid`,
  28/36 icon sizes) is documented but not in a manifest. Independent review
  found the field hero rule was dead: the base input selector outranked
  `.field--hero`, so `/key` and the gallery rendered 44px against the
  documented 56px. The type exclusions now use `:where()` and the new
  `field-hero-height` detector guards the size; `legacy-selector` now lists
  each baselined page-scoped override with its reason.
- Slice 4a (2026-11-22): added `data/detectors.json` as the one detector
  registry and generated the tables in this section, `plan.md` §3 and the UI
  skill; tightened `status-pill-geometry` to the documented 20px minimum and
  reconciled `control-height-scale`, `table-grammar` and `field-hero-height`
  across the docs and the gate.

## 10. Page-scoped CSS exceptions

Cleanup rule: a page-local rule survives only when it describes a layout that
has no shared component; everything else consumes a shared component or token.
The surviving exceptions, by file:

- `apps/site/site.css` — the "Page-scoped rules (batch 7)" section. Wallet vault
  rows/split/review grid, send form/review/hex blocks, the `.wallet-check`
  checkbox row (44px through `--control-h`, 18px box), the tools family grid
  and the mnemonic seed row grid. These are page-only layouts; they use
  `--space-*`, `--text-*`, `--radius-*` and the semantic colours.
- `apps/site/brainwallet.css` — the directory row grid (`bw-rows-header`/
  `bw-row`), key/phrase/address line layout, the generator form grid, the
  checkbox row and the balance cell. The badge box comes from the shared status
  grammar; the type tabs are `.chip`; the explorer action is `.icon-button`.
  The light-theme warning and address-link literals (`#d6a13a`, `#fff7e6`,
  `#7a4b00`, `#1f5f9e`) are theme-specific, not component tokens.
- `apps/site/seed-studio.css` — the seed form grid, the count row and the
  checkbox row. Count buttons are `.chip`, the retry action is `.icon-button`,
  and fields follow the shared control tokens.

Documented component APIs that no current route uses yet are reserved, not dead
CSS: `.field__*`, `.stat__*`, `.card--flat`, `.card--stat`, `.stat--sm`, the
`.icon-button--sm/--md/--solid` variants, `.empty-state__title`/`__action` and
the `.is-*` state classes.
