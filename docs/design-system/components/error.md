# Error

Status: stable · Version: 0.1.0 · Owner: site-ui (design system).
Source of truth: `design/components/error.json` · Gallery: `/cabinet/admin/design` (family
`error`).

## Purpose

A failed operation that needs the user's attention: a rejected RPC, an invalid
file, a failed fetch. Use the shared error box inside the surface that owns the
operation. Do not leave a blank card or a silent console error.

## Anatomy and slots

`<p class="error" role="alert">The RPC rejected the request. Retry in a
moment.</p>`. The box is one tinted failure surface (border, background and
text) with actionable copy and, where possible, a retry action. `.key-error`,
`.range-error` and `.monitor-status` are the page modifiers that add no geometry
of their own; the top margin is 12px (8px for a field-level error).

## API

- Element: `p` (or `div`/`section` when the error contains an action).
- Variants: `default`, `key`, `range`.
- Sizes: default. Required attribute: `role="alert"`.
- A retry action uses the shared `.btn` or `.icon-button` grammar.

## State matrix

| State | Evidence in `site.css` | Rendered in `/cabinet/admin/design` |
|---|---|---|
| Default | 1px failure border, 10% failure surface, failure text, radius 12, padding 11/14 | yes |
| Progress → error | progress uses `role="status"`; only a failure uses `role="alert"` | composition |
| Empty → error | the error replaces the empty state, never overlays it | composition |
| Loading | a retry in flight disables its control; the error text stays until the request settles | composition |

## Motion and reduced motion

No transition or animation. An error appearing asynchronously is announced by
`role="alert"`; do not add an entrance animation.

## Accessibility

- Live region: `role="alert"` for a failure that needs immediate attention;
  `role="status"` for progress. Do not use `alert` for ordinary progress.
- The text names what failed and what to do; a retry control has a visible label
  and a 44px target.
- Contrast: the failure palette passes 4.5:1 in both themes.
- Colour is not the only signal; the text states the failure.
- Focus: do not move focus to the error unless the failure blocks the form; if
  you do, move it to the message or the first invalid field.

## Copy rules

- State the failure: "The RPC rejected the request."
- State the next step: "Retry in a moment." / "Choose a JSON keystore file."
- No stack trace, no internal path, no "Something went wrong" alone.
- No exclamation mark.

## Do / don't

- Do use the shared error box for every failed async operation.
- Do keep the retry action inside the box.
- Don't use the error style for a warning or a hint.
- Don't add a page-local error box with its own geometry.
- Don't hide the error after a timeout without a retry path.

## Detectors

`empty-state-grammar` checks `.error` top margin (8/12) alongside the empty
state. The `role="alert"` requirement is in the manifest and checked by
`scripts/check-components.mjs` on the gallery; legacy instances without it are
migration debt, not a second contract.

## Owner and changelog

- Owner: site-ui.
- 0.1.0 (2026-11-21): declared the shared error box; the raw rgba values in
  `site.css` are token-migration debt recorded in the token baseline.
