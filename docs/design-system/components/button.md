# Button

Status: stable · Version: 0.1.0 · Owner: site-ui (design system).
Source of truth: `design/components/button.json` · Gallery: `/cabinet/admin/design` (family
`button`).

## Purpose

The one action control on a surface: submit a form, search, copy a payload or
remove a record. Use it when the user commits an action. Do not use it for
navigation between pages or for a filter that can be toggled; use a link or a
chip (§3.4).

## Anatomy and slots

`<button class="btn">Label</button>` is the contract; a bare `<button>` is the
migration alias and maps to the same geometry. `.primary` is the filled variant
(`--accent` background, `--accent-ink` text). The label is the only required
slot. Optional leading/trailing icons use `.icon` at 16–18px and the same 8px
gap as the text.

There is no `--ghost`, `--danger`, `--lg` or `--sm` modifier in
`apps/site/site.css`; do not add one without a manifest change and a detector.
The `.btn` class is the future contract, `button`/`a.button` remain aliases.

## API

- Element: `button` (or `a.button` for a link that behaves like an action).
- Variants: `default`, `primary`. Sizes: default (44px).
- Required attribute: `type="button"` for a standalone action so a surrounding
  form does not submit implicitly.
- Disabled: native `disabled`. There is no loading state in the button grammar.

## State matrix

| State | Evidence in `site.css` | Rendered in `/cabinet/admin/design` |
|---|---|---|
| Default | `--panel-2` surface, `--border-strong` border, radius `--radius-sm` | yes |
| Hover | `--panel-3` surface; `.primary` uses the brighter accent gradient | live (hover the example) |
| Focus-visible | no explicit `.btn:focus-visible` rule; the browser default outline remains | live (tab to the example), not machine-checked |
| Active/pressed | not styled separately from hover | not machine-checked |
| Disabled | `opacity:.42`, `pointer-events:none`, no shadow | yes |
| Loading | not implemented for `.btn`; keep the label and disable the control | n/a |

## Motion and reduced motion

`transition: background .16s, border-color .16s, transform .16s, color .16s` on
the base rule. There is no button-specific reduced-motion override because the
transition is short and non-essential; the global `prefers-reduced-motion` block
covers the animated primitives (skeleton, spinner, drawer).

## Accessibility

- Role: native `button` (or link when `href` is present). The accessible name is
  the visible label.
- Keyboard: Enter/Space activate the native control; the tab order follows the
  DOM.
- Focus: keep the browser outline; do not set `outline:none` without a
  replacement.
- Contrast: `--accent-ink` on `--accent` and `--text` on `--panel-2` pass 4.5:1
  in dark; the light accent has no headroom (4.52:1), so do not lighten it.
- Touch: the control is 44px high. `small-touch-target` fails a visible button
  below 44×44.

## Copy rules

- Sentence case, verb first: "Search", "Copy all", "Remove".
- One primary action per card or section; secondary actions use the default
  variant.
- No trailing punctuation in a button label.

## Do / don't

- Do use `type="button"` outside a form submit.
- Do keep one `.primary` per surface.
- Don't build a spinner into the button; the grammar has no loading state.
- Don't add a page-local height, radius or gradient.

## Detectors

`small-touch-target`, `clipped-control`, `horizontal-overflow` in
`scripts/ui-audit.mjs`. The hover/focus visuals and the absence of a loading
state are not machine-checkable beyond those route-wide checks.

## Owner and changelog

- Owner: site-ui.
- 0.1.0 (2026-11-21): normalized the current `button`/`.btn`/`.primary` CSS into
  a manifest and a gallery family. No visual change.
