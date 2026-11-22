# Chip

Status: stable · Version: 0.1.0 · Owner: site-ui (design system).
Source of truth: `design/components/chip.json` · Gallery: `/cabinet/admin/design` (family
`chip`).

## Purpose

A compact filter, preset or chain tab. Chips narrow a result set, choose a
preset value or navigate a directory; they do not submit a form. Use a
segmented control for exclusive modes and a select for a long list.

## Anatomy and slots

`<button type="button" class="chip" aria-pressed="true">Bitcoin</button>` or
`<a class="chip" href="/private-keys/btc" aria-current="page">Bitcoin</a>`. The
label is the only required slot. An optional `.icon` is 16px and sits before the
label with an 8px gap. `.chip--primary` is the one filled chip and is reserved
for the cabinet navigation action.

## API

- Element: `button` or `a`.
- Variants: `default`, `primary`. Sizes: default (44px, pill radius).
- Required attribute: `type="button"` for a button chip.
- State attributes: `aria-pressed`, `aria-current="page"`, `disabled` /
  `aria-disabled="true"`.

## State matrix

| State | Evidence in `site.css` | Rendered in `/cabinet/admin/design` |
|---|---|---|
| Default | `--surface-2`, `--line-subtle`, pill radius | yes |
| Hover | `--surface-3`, `--line-strong`, `--ink-1` | live |
| Focus-visible | 2px `--signal` outline, offset 2 | live (tab) |
| Pressed | `--signal-soft` + `--signal` border/text | yes |
| Current page | `aria-current="page"` uses the same selected tone | yes |
| Disabled | `opacity:.42`, `cursor:not-allowed` | yes |

## Motion and reduced motion

Border, background and colour transition at `--duration-fast` with
`--ease-standard`. The reduced-motion block removes the transition.

## Accessibility

- Role: native button or link.
- Selection: `aria-pressed` for a toggle, `aria-current="page"` for navigation;
  do not use both on one chip.
- Name: the visible label; an icon never replaces it.
- Touch: 44px high and at least 44px wide; adjacent chips keep the 8px gap.
- Contrast: `--ink-2` on `--surface-2`; selected uses `--signal` on
  `--signal-soft`. The light accent has no headroom.

## Copy rules

- One or two words, sentence case: "Bitcoin", "All chains", "Unsolved".
- A chain chip keeps the chain name; the chain colour stays a small swatch, not
  a chip fill.
- Do not use a verb in a filter chip.

## Do / don't

- Do use chips for combinable filters and presets.
- Do keep one row of chips; let it wrap at narrow widths.
- Don't duplicate the same filter with a select or a second chip toolbar.
- Don't use `.chip--primary` for a filter.
- Don't add a page-local chip size.

## Detectors

`control-height-scale` (44px), `small-touch-target`, `clipped-control`. The
selected/current tone and the one-control-per-purpose rule are checked by
`duplicate-preset-control` only on `/key`; other routes rely on review.

## Owner and changelog

- Owner: site-ui.
- 0.1.0 (2026-11-21): normalized the batch-3 chip grammar; primary is the one
  filled chip.
