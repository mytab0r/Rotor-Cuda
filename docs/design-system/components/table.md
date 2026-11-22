# Table

Status: stable · Version: 0.1.0 · Owner: site-ui (design system).
Source of truth: `design/components/table.json` · Gallery: `/cabinet/admin/design` (family
`table`).

## Purpose

A data table: derived addresses, puzzle rows, key ranges, leaderboards. Use a
table when rows share columns and the user compares values. Use a row list for a
directory when the fields differ per row. Do not use cards for a data-heavy
grid.

## Anatomy and slots

`<div class="table-scroll" tabindex="0" aria-label="…"><table
class="data-table"><caption class="visually-hidden">…</caption><thead>…</thead>
<tbody>…</tbody></table></div>`. The wrapper owns the horizontal scroll, the
hairline and radius 12; the table owns the column grammar. Header cells are
12px/600 sentence case; body cells have 8/12 padding and a 44px row height;
numbers use tabular digits and align right. Row actions sit at the trailing edge
and use the shared `.icon-button` at 44px.

## API

- Element: `div.table-scroll` wrapping `table.data-table`.
- Variants: `default`, `key` (`.key-addr-tbl`), `puzzle` (`.pz-table`), `range`
  (`.range-table`) — the variant only changes the minimum table width.
- Sizes: default (row min-height 44).
- Required attributes on the wrapper: `tabindex="0"` and `aria-label`.
- Row state classes: `has-balance`, `is-active`, `key-row-focus`.

## State matrix

| State | Evidence in `site.css` | Rendered in `/cabinet/admin/design` |
|---|---|---|
| Default row | transparent; hairline bottom | yes (all four variants) |
| Hover | `--row-hover` | live |
| Has balance | 6% `--state-ok` tint | yes |
| Active | `--signal-soft` | yes |
| Key-row focus | `--signal-soft` + inset `--signal` hairline | yes |
| Loading | a `.skeleton`/`.cell-skeleton` inside the cell | n/a in the table family |
| Empty | `.empty-state` inside the spanning `td` | see the `empty` family |

## Motion and reduced motion

No transition on rows. The shared reduced-motion rule covers the skeleton and
icon-button primitives. Do not animate row backgrounds.

## Accessibility

- The wrapper is a focusable scroll region with a name, so keyboard users can
  scroll it horizontally.
- The table has a `caption` (visually hidden is allowed) and `scope="col"` on
  header cells.
- Row actions have an accessible name and a `data-tooltip`; the row is not the
  only target unless the row itself is 44px.
- Numeric columns use tabular digits; do not show a raw path where a label
  belongs.
- Mobile keeps the scroll wrapper and all columns; the table never turns into
  cards.

## Copy rules

- Header: one or two words, sentence case: "Chain", "Address", "Balance".
- Cells: human labels and formatted numbers with thousands separators.
- Empty cell: an em dash, never a blank that could be a loading state.

## Do / don't

- Do wrap every table in `.table-scroll`.
- Do keep one action grammar at the trailing edge.
- Don't add a page-local row height, cell padding or header style.
- Don't hide columns below 768px; keep the scroll wrapper.

## Detectors

`table-grammar` (`.data-table` inside `.table-scroll`, 8/12 cell padding,
uniform header height), `table-header-style` (12px, weight ≤600, no transform,
no tracking), `table-row-height` (≥44px or a 44px action), `row-action-geometry`
(44px box, radius 10, name), `raw-path-text` (no raw path in a cell).

## Owner and changelog

- Owner: site-ui.
- 0.1.0 (2026-11-21): normalized the batch-5 table shell and the three
  width variants that pages already render.
