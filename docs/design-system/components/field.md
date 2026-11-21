# Field

Status: stable · Version: 0.1.0 · Owner: site-ui (design system).
Source of truth: `design/components/field.json` · Gallery: `/design` (family
`field`).

## Purpose

A labelled text input, select or textarea. Use it when the user types or chooses
a value that will be submitted. Do not use it for a read-only fact; use a fact
row or a stat.

## Anatomy and slots

`<label class="field"><span class="field__label">…</span><input
class="field__control" aria-describedby="hint"><span class="field__hint"
id="hint">…</span><span class="field__error" role="alert" hidden>…</span>
</label>`. The label, control and hint are required; the error slot is required
but hidden until `[aria-invalid="true"]`. The bare `input`/`select`/`textarea`
and `label` selectors in `site.css` are the migration alias until every page
uses the classes.

## API

- Element: `label.field` wrapping the control.
- Sizes: `default` (44px, radius 10) and `hero` (`.field--hero`, 56px, radius
  16). The hero is a named size, not a page override.
- Required attribute on the control: `aria-describedby` pointing at the hint
  (and the error id when it is visible).
- State attributes: `aria-invalid="true"`, `disabled`.

## State matrix

| State | Evidence in `site.css` | Rendered in `/design` |
|---|---|---|
| Default | `--surface-0`, `--line-strong`, radius `--radius-control` | yes (both sizes) |
| Hover | border `--line-strong` | live |
| Focus | border `--signal` + 3px `--signal-soft` ring (`:focus`) | live (tab); `field-geometry` focuses every control |
| Invalid | `--state-err` border; error ring on focus | yes |
| Disabled | `opacity:.55`, `cursor:not-allowed` | yes |
| Loading | not a field state; use a skeleton or disable the control | n/a |

## Motion and reduced motion

Border, shadow and background transition at `--duration-fast` with
`--ease-standard`. The reduced-motion block removes the transition from inputs,
selects, textareas and `.field__control`.

## Accessibility

- Name: a visible `<label>` (wrapping or `for`), or `aria-label` /
  `aria-labelledby`. `field-geometry` fails a visible control with no label.
- Description: wire the hint with `aria-describedby`; add the error id only
  while the error is visible.
- Error: `aria-invalid="true"` on the control and `role="alert"` on the error
  text.
- Focus: never remove the focus ring; the ring is the only signal that keyboard
  focus is in the field.
- Contrast: `--ink-1` on `--surface-0`; labels use `--ink-3` at 12px.
- Touch: 44px minimum; the hero is 56px.

## Copy rules

- Label: sentence case noun phrase, 12px, no trailing colon: "Private key".
- Hint: one sentence, says the accepted formats; do not repeat the label.
- Error: say what failed and what to do: "Enter a 64-character hex key or a WIF."

## Do / don't

- Do keep the label visible; a placeholder is not a label.
- Do use the hero size only for the page-primary key/search input.
- Don't add a page-local radius, height or focus style.
- Don't use a select with a fixed arrow offset; the shared arrow follows the
  control height.

## Detectors

`control-height-scale` (28/36/44/56; textareas keep the 44 floor),
`field-geometry` (radius 10/16, label ≥12px, focus ring), `clipped-control`.
The described-by/error wiring is checked by the rendered focus pass and the
manifest's required attribute, not by a separate detector.

## Owner and changelog

- Owner: site-ui.
- 0.1.0 (2026-11-21): normalized the batch-3 field grammar; the hero size is the
  only shared modifier and the error slot is hidden by default.
