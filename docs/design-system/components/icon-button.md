# Icon button

Status: stable · Version: 0.1.0 · Owner: site-ui (design system).
Source of truth: `design/components/icon-button.json` · Gallery: `/design`
(family `icon-button`).

## Purpose

The one control for an icon-only action: copy, retry, open a detail, refresh.
Use it when the action has no room for a text label and the icon is understood
with the shared tooltip. Do not use it for navigation that already has a visible
label, and do not invent a page-local icon wrapper.

## Anatomy and slots

`<button class="icon-button icon-button--quiet icon-button--lg" aria-label="…"
data-tooltip="…"><svg class="icon">…</svg></button>`. Exactly one variant and
one size class. The icon slot is required; the glyph is 18px in the 44px box.
The quiet variant is transparent with no border (row actions); the outline
variant has a `--line-strong` border and `--surface-2` fill (toolbar beside a
field). The CSS also implements `--solid` (one primary icon action), but no page
renders it yet; it is reserved and not part of the gallery contract. The CSS
implements 28/36/44 sizes, but no page renders 28 or 36 and the audit's
`small-touch-target` rule rejects a standalone control below 44; only `lg` is in
the manifest.

## API

- Element: `button` (an `a.icon-button` is allowed for a link action).
- Variants: `quiet`, `outline`. Size: `lg` (44px, 18px icon).
- Required attributes: `aria-label` (the accessible name), `data-tooltip` (the
  visible hint), `type="button"`.
- State attributes: `disabled`, `aria-disabled="true"`, `aria-busy="true"`,
  `.is-copied`.

## State matrix

| State | Evidence in `site.css` | Rendered in `/design` |
|---|---|---|
| Default | quiet: transparent; outline: `--surface-2` + `--line-strong` | yes (both variants) |
| Hover | `--surface-2` (quiet) / `--surface-3` (outline) | live |
| Focus-visible | 2px `--signal` outline, offset 2 | live (tab) |
| Active/pressed | `--surface-3`; solid brightens `filter` | live |
| Disabled | `opacity:.42`, `cursor:not-allowed` | yes |
| Copied | `.is-copied` sets `--state-ok`; opacity stays 1 when disabled | yes |
| Busy | `[aria-busy="true"]` hides the glyph and shows a 2px spinner in the same box | yes |

## Motion and reduced motion

Background, border and colour transition at `--duration-fast` with
`--ease-standard`; the icon transforms on the same duration. The busy spinner is
a 700ms linear rotation. `@media (prefers-reduced-motion: reduce)` removes the
transitions and the spinner animation.

## Accessibility

- Role: native `button`/link.
- Name: `aria-label` is the name; `data-tooltip` is the visible hint and must
  never be the only source of the name.
- Do not add a native `title` beside `data-tooltip`; the tooltip primitive and
  the audit both reject the duplicate.
- Busy: `aria-busy="true"` keeps the box; the accessible name stays.
- Copied: the visible check glyph is accompanied by an updated `aria-label` on
  the live surface (for example "Copied").
- Touch: 44×44 standalone; adjacent icon buttons keep at least 8px gap.
- Contrast: the quiet icon uses `--ink-3` on the surface; hover raises it to
  `--ink-1`. The icon needs 3:1, the name is announced.

## Copy rules

- Tooltip and `aria-label` name the action, not the glyph: "Copy address",
  "Refresh balances", "Open transaction".
- Keep the tooltip under 40 characters (the audit enforces the limit).
- Do not label two different actions with the same text in one toolbar.

## Do / don't

- Do use the quiet variant for table/directory row actions.
- Do use the outline variant beside a field or in a toolbar.
- Don't use an unlabeled `<button>` with an SVG; `icon-only-shared-component`
  reports it.
- Don't use the 28px size outside a dense row whose row is the target, and do not
  add a page-local size at all.

## Detectors

`icon-button-scale` (28/36/44 box, 14/16/18 icon, name pair, no native `title`),
`tooltip-primitive`, `row-action-geometry`, `small-touch-target`. The copied
colour change and the busy spinner are rendered evidence, not separate detector
IDs.

## Owner and changelog

- Owner: site-ui.
- 0.1.0 (2026-11-21): normalized batch-2 icon buttons; quiet and outline are
  the rendered variants, solid/28/36 are reserved CSS.
