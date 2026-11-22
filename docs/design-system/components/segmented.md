# Segmented control

Status: stable · Version: 0.1.0 · Owner: site-ui (design system).
Source of truth: `design/components/segmented.json` · Gallery: `/cabinet/admin/design`
(family `segmented`).

## Purpose

Two to four mutually exclusive modes in one track, where the choice changes the
form or the derived output immediately (curve, seed length). Use chips when the
choices can combine, links when they navigate, and a native select when the list
is long.

## Anatomy and slots

`<div class="segmented" role="group" aria-label="Curve"><button type="button"
class="segmented__item" aria-pressed="true">secp256k1</button>…</div>`. The track
owns the group role and the name; each item is a native button. The optional
`<span>` inside an item carries a count and uses tabular digits at 72% opacity.

## API

- Element: `div.segmented` with `role="group"` and `aria-label`.
- Items: `button.segmented__item`; exactly one `aria-pressed="true"` (or
  `.is-selected`).
- Variants: default. Sizes: default (44px items).
- State attributes: `aria-pressed`, `disabled`.

## State matrix

| State | Evidence in `site.css` | Rendered in `/cabinet/admin/design` |
|---|---|---|
| Default | transparent item on `--surface-0` track | yes |
| Hover | `--surface-2` background, `--ink-1` text | live |
| Focus-visible | 2px `--signal` outline, offset 2 | live (tab) |
| Selected | signal fill + `--signal-ink` | yes (second item selected) |
| Disabled | `opacity:.42`, `cursor:not-allowed` | yes |

## Motion and reduced motion

Items do not transition; the reduced-motion block still removes the shared
`input/select/textarea/.segmented__item/.chip` transition so a future transition
cannot animate. The selected fill switches instantly.

## Accessibility

- Role: `group` with a name on the track; native buttons inside.
- Selection: `aria-pressed` on each item; exactly one true. `segmented-geometry`
  fails a group with zero or two selected items.
- Keyboard: Tab reaches the group; each item is a native button. There is no
  roving tabindex in the shared grammar; do not add one without a page script
  contract.
- Touch: 44px item height; the track padding is 4px.
- Contrast: `--signal-ink` on `--signal` passes in dark; the light accent has no
  headroom.

## Copy rules

- Item labels are short mode names: "secp256k1", "ed25519", "12 words".
- No sentence punctuation and no verbs; the group name explains the choice.
- Do not use a segmented control for an on/off setting; use a checkbox or a
  switch.

## Do / don't

- Do use it for 2–4 exclusive modes on the same form.
- Don't render a segmented control plus an equivalent select for the same input.
- Don't add a page-local item height or track radius.
- Don't use it for navigation.

## Detectors

`segmented-geometry` (track padding 4, radius 12, ≥2 items, exactly one
selected, item height ≥44, item radius 8–10), `control-height-scale`,
`small-touch-target`.

## Owner and changelog

- Owner: site-ui.
- 0.1.0 (2026-11-21): normalized the batch-3 segmented grammar. No visual change.
