# Pager

Status: stable · Version: 0.1.0 · Owner: site-ui (design system).
Source of truth: `design/components/pager.json` · Gallery: `/cabinet/admin/design` (family
`pager`).

## Purpose

Pagination for a long table or directory: First/Previous/Next/Last plus one
optional Random action, and a numeric page jump. Use one pager per table. Do not
duplicate the pager or mix a second pagination toolbar into the same table.

## Anatomy and slots

`<nav class="pager" aria-label="Key pages"><a class="pager-btn" href="#"
aria-disabled="false">First</a>…</nav>`. Every direct child is a `.pager-btn`.
Unavailable directions keep `aria-disabled="true"` and stay focusable; the
click handler prevents the jump. The numeric jump is one `.page-jump` form with
a label, a 44px input and a 44px submit. `.pager-btn--random` is the one signal
tone action.

## API

- Element: `nav.pager` (or `form.page-jump` for the numeric jump).
- Variants: `default`, `jump`.
- Sizes: default (44px box, radius 10, 16px icon).
- Required attribute: `aria-label` on the pager.
- Every `.pager-btn` carries `aria-disabled`.

## State matrix

| State | Evidence in `site.css` | Rendered in `/cabinet/admin/design` |
|---|---|---|
| Default | `--surface-2`, `--line-strong`, radius `--radius-control` | yes |
| Hover | signal border, `--ink-1` | live |
| Focus-visible | 2px `--signal` outline, offset 2 | live (tab) |
| Unavailable direction | `aria-disabled="true"`; the box stays in place | yes |
| Random | `--signal-soft` background, signal border/text | yes (the Random slot) |
| Disabled class | not allowed; `.disabled` is a legacy pattern | n/a |

## Motion and reduced motion

No transition on the pager buttons. The random action does not pulse. The shared
reduced-motion rule covers any inherited transition.

## Accessibility

- Role: `nav` with a name; the numeric jump is a labelled form.
- Buttons: 44px boxes, radius 10, 16px icons; `pager-geometry` checks each one.
- Unavailable: `aria-disabled="true"`, not `disabled`, so the anchor remains
  focusable and the state is announced.
- The range ("1–60 of 18,890") is a `.page-info-text` status line, not a button.
- Keyboard: native anchors/buttons; no roving tabindex.

## Copy rules

- Direction labels: First, Previous, Next, Last; one optional "Random".
- Numeric jump: a label ("Page") plus a submit label ("Go").
- The range is text with thousands separators and an en dash.

## Do / don't

- Do keep exactly one `.pager` per table.
- Do use `aria-disabled` for an unavailable direction.
- Don't use `.random`; use `.pager-btn--random`.
- Don't use a `.disabled` class or a second jump control.
- Don't clip the pager at 375px; let it wrap.

## Detectors

`pager-grammar` (structure, label, ≥4 buttons, `aria-disabled`, no legacy
modifiers, labelled 44px jump controls) and `pager-geometry` (44px box,
radius 10, 16px icon), plus `small-touch-target`.

## Owner and changelog

- Owner: site-ui.
- 0.1.0 (2026-11-21): normalized the batch-6 pager and the numeric jump.
