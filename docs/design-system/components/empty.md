# Empty state

Status: stable · Version: 0.1.0 · Owner: site-ui (design system).
Source of truth: `design/components/empty.json` · Gallery: `/cabinet/admin/design` (family
`empty`).

## Purpose

The first async state: there is nothing to show yet, or a filter matched no
rows. Use it inside the surface that owns the data. Do not leave a blank card or
a bare table body with no explanation.

## Anatomy and slots

`<div class="empty-state"><span class="empty-state__title">No rows
yet</span><p>Change the filter or run a scan to fill this table.</p></div>`.
The title and body are optional but the text is required. `.empty-state__action`
is the one optional action slot. In a table, put the empty state on an inner
`div` inside the spanning `td` so the cell keeps its table context.

## API

- Element: `div` (a `p` or `section` is allowed when the semantics fit).
- Variants: default. Sizes: default (padding 20, radius 12).
- No required attributes; the text is the content.
- The action slot uses the shared `.btn` or `.icon-button` grammar.

## State matrix

| State | Evidence in `site.css` | Rendered in `/cabinet/admin/design` |
|---|---|---|
| Default | dashed `--line-subtle`, radius 12, padding 20, centred `--ink-3` | yes |
| With action | `.empty-state__action` adds a 12px top margin | composition, no separate state |
| Loading | use a `.skeleton`, not an empty state | see the `skeleton` family |
| Error | use the `error` family, not an empty state | see the `error` family |

## Motion and reduced motion

No transition or animation. The empty state appears and disappears with the
owning surface; do not animate it in.

## Accessibility

- Role: none; the text is read in place. If the surface changes asynchronously,
  announce the change in the owning `role="status"` region.
- The action has a visible label and the shared 44px target.
- Contrast: `--ink-3` body and `--ink-2` title on the surface role.
- The dashed border is not the only signal; the text says there is no data.

## Copy rules

- Title: sentence case, says the state: "No rows yet".
- Body: one sentence, says what to do: "Change the filter or run a scan."
- Do not use "Oops", "Nothing here" or an exclamation mark.

## Do / don't

- Do ship loading → empty → error → success on every async surface.
- Do keep the empty state inside the table/card context.
- Don't use an empty state where an error belongs.
- Don't add a page-local dashed box.

## Detectors

`empty-state-grammar` (dashed border, radius 12, padding 20, plus the error-box
margin rule in the same detector).

## Owner and changelog

- Owner: site-ui.
- 0.1.0 (2026-11-21): declared the shared async empty state.
