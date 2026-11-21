# Rotor Design System

Version: 0.1 (foundation). Date: 2026-11-21.
Status: normative for new UI; existing pages migrate batch by batch through
`docs/design-system/plan.md`. The inventory that this system replaces is
`docs/design-system/inventory.md`.

## 0. Scope and non-goals

In scope: every visible element on the coordinator-served site — controls,
fields, cards, stats, tables, status, navigation, overlays, empty/loading/error
states. The system is plain CSS custom properties and class contracts; there is
no build step and no framework.

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

Three layers, all in `apps/site/site.css`:

1. **Primitive** — the raw scales below (space, radius, type, weight, motion,
   elevation, z-index).
2. **Semantic** — roles that components consume: `--surface-*`, `--line-*`,
   `--ink-*`, `--signal-*`, `--state-*`.
3. **Component** — per-family aliases if a component needs a local value; the
   value must resolve to a primitive or semantic token.

The existing names (`--bg`, `--panel`, `--text`, `--accent`, `--radius`,
`--radius-sm`) stay as aliases until the migration batches delete the legacy
root at `site.css:2-17`. New code must use the canonical names.

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
belongs only in the root token blocks.

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

- Track: padding `--space-1`, radius `--radius-l`, background `--surface-0`,
  border `--line-subtle`, gap `--space-1`.
- Item: min-height 44, padding `0 --space-4`, radius `--radius-s`, font
  `--text-sm`/`--weight-bold`.
- Selected: signal fill + signal-ink. Hover: `--surface-2`. Focus-visible:
  2px signal outline offset 2px.
- Use for 2–4 mutually exclusive modes. For filters that can combine, use chips;
  for navigation, use links. One control per purpose — never a segmented control
  plus an equivalent select.

### 3.4 Chip

- `.chip`: min-height 44, padding `0 --space-3`, radius `--radius-pill`, border
  `--line-subtle`, background `--surface-2`, font `--text-xs`/600.
- `aria-pressed="true"` uses `--signal-soft` + signal text.
- Chips filter a result set; they do not navigate and do not submit. A row of
  chips must not duplicate a select or a second toolbar.

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

- Control: min-height 44, padding `--space-2 --space-3`, radius `--radius-m`,
  border `--line-strong`, background `--surface-0`, font `--text-md`.
- Focus: border signal + 3px signal ring at 15% opacity. Invalid: error border
  + error ring; never remove the focus ring.
- Label 12/600, hint 12/400 `--ink-3`, error 12/600 `--state-err`.
- Selects keep the custom arrow but the arrow position comes from the control
  height, not a fixed 18px.
- Hero input exception: `--control-h-xl` height, radius `--radius-xl`, font
  `--text-md`; this is a named size (`.field--hero`), not a page override.

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
- Page-scoped overrides (`.key-page > .card`) are deprecated; replace with a
  documented size in the batch that touches the page.

### 3.9 Stat

- `.stat`: padding `--space-4`, radius `--radius-l`, border `--line-subtle`,
  background `--surface-2`.
- `.stat__label`: `--text-xs`, 600, `--ink-3`, sentence case (no uppercase, no
  tracking). `.stat__value`: `--text-2xl`, 600, tabular-nums, `--ink-1`.
  `.stat__meta`: `--text-xs`, `--ink-3`, includes units and timeframe.
- Values align right in a row; labels start on one line; no sparkline or icon
  used as filler. Small values use `.stat--sm` (`--text-xl`).

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

- Wrapper: `overflow-x:auto`, border `--line-subtle`, radius `--radius-l`,
  `tabindex="0"`, accessible name. A table never forces the page wider.
- Header: `--text-xs`, 600, `--ink-3`, sentence case; no uppercase tracking.
  Cell padding `--space-2 --space-3`; row min-height 44.
- Row states: hover `--row-hover`; `has-balance` tinted ok; `is-active` tinted
  signal; `key-row-focus` signal hairline + surface. States are independent and
  must be recognisable apart.
- Actions: one icon-button grammar (44×44); long values wrap with
  `overflow-wrap:anywhere`; numeric columns use tabular-nums and align right.
- At ≤720px, either keep the scroll wrapper or transform to labelled blocks with
  `data-label`; do not hide columns without an alternative view.

### 3.11 Pagination

- `.pager` flex gap `--space-2`; `.pager__btn` min-height 44, padding
  `0 --space-3`, radius `--radius-m`, font `--text-sm`/650.
- `aria-current="page"` for the current page; `aria-disabled="true"` for
  unavailable directions. Show the range ("1–60 of 18,890") as a status line.
- One pager per table; do not add a second pager in the toolbar.

### 3.12 Breadcrumbs

- `<nav class="breadcrumbs" aria-label="Breadcrumb">` with a list; each link
  min-height 44 and min-width 44. Current page uses `aria-current="page"` and
  `--ink-2`.
- Separator is a hairline chevron or `/` from the icon set; not a blank gap.
- Long crumb labels truncate with `title`/`aria-label`; no raw path as the
  visible label.

### 3.13 Empty, loading and error states

- `.empty-state`: dashed `--line-subtle`, radius `--radius-l`, padding
  `--space-5`, centred `--ink-3` text, one next action.
- `.skeleton`: one implementation, `--surface-2` to `--surface-3` shimmer,
  radius `--radius-xs`, height 10–12px, `aria-hidden`, animation off under
  reduced motion.
- `.error-state`: message tone `--err`, actionable text, retry button; never a
  blank card.
- Every async surface ships loading → empty → error → success. A failed fetch
  says what failed and what to do.

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
  blur, hairline bottom.
- Links: min-height 44, padding `0 --space-3`, radius `--radius-pill`, font
  `--text-md`/600. Active: `--signal-soft` + signal text + hairline.
- `.nav-pill`: 44 height, radius pill, one primary action (`.nav-cabinet` uses
  the signal fill).
- Below 860px the primary links collapse into one menu button; nothing is
  hidden without a reachable equivalent. The brand mark is the only gradient.

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
6. Bump `?v=` in every `apps/site/*.html` and `projects.json.asset_version`
   when `site.css`, `site.js`, `theme.js` or `key.js` changes.
7. The author never signs off their own UI PR; a different agent reviews
   screenshots and computed geometry at 375/768/1280 in both themes.

## 8. Gate coverage

The automated gate is `scripts/ui-audit.mjs` (CI: `.github/workflows/ui.yml`).
It already checks overflow, small text/targets, unlabeled icon controls,
duplicate address-type components, half-empty blocks, manual balance controls,
route row counts and HTTP errors. Batch 1 adds `status-pill-geometry`; batch 2
adds `icon-button-scale` (box 28/36/44, icon 14/16/18, `aria-label` plus
`data-tooltip`); later batches add the detectors listed in `plan.md` §3. The
human checklist is `apps/site/UI-CHECKLIST.md` and the project skill
`.claude/skills/ui-self-review/SKILL.md`.

## 9. Versioning

- `0.x` — foundation and migration. Tokens may be added; values may change
  only with a batch and a changelog line here.
- Adding a component variant requires an entry in §3 and a detector or an
  explicit "not machine-checkable" note.
- Removing a legacy alias requires the batch that migrated the last usage.
