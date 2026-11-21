# Stat

Status: stable · Version: 0.1.0 · Owner: site-ui (design system).
Source of truth: `design/components/stat.json` · Gallery: `/design` (family
`stat`).

## Purpose

One number with a label and optional unit/timeframe: scanned keys, a balance, a
puzzle count. Use it inside a stat row or a summary strip. Do not use a stat for
a sentence or for a value that needs no label.

## Anatomy and slots

`<div class="stat"><span class="stat__label">Keys scanned</span><span
class="stat__value">18,890</span><span class="stat__meta">last 24
hours</span></div>`. The label is 12px sentence case with no tracking; the value
is 24px, weight 600, tabular digits; the meta is 12px `--ink-3` and carries the
unit or timeframe. `.key-stat` and `.stat-card` are the two rendered surfaces
besides `.stat`; `.stat-card` is the boxless cell inside a summary strip.

## API

- Element: `div` (a `strong` value is allowed).
- Variants: `stat`, `key`, `card`. Sizes: default (24px value).
- No required attributes.
- `.stat--sm` and the `.stat-value.small` alias exist in CSS but no page renders
  them; they are reserved and not in the manifest.

## State matrix

| State | Evidence in `site.css` | Rendered in `/design` |
|---|---|---|
| Default | `--surface-2`, `--line-subtle`, radius `--radius-l`, padding 16 | yes (all three variants) |
| Hover/focus/active | none; the stat is not a control | n/a |
| Disabled | none | n/a |
| Loading | compose a `.skeleton` in place of the value | n/a |
| Small width | `.stat-card .stat-value` drops to 20px below 560px | live at 375 |

## Motion and reduced motion

No transition or counting animation in the shared grammar. A page script that
animates a number must stop under `prefers-reduced-motion`.

## Accessibility

- Role: none; the label and value are plain text in reading order.
- Values use `font-variant-numeric: tabular-nums` so columns line up.
- Labels are sentence case, 12px, no uppercase and no tracking.
- Contrast: `--ink-1` value and `--ink-3` label/meta on the surface role.
- Async values that change need a `role="status"` region on the owning surface,
  not on every stat.

## Copy rules

- Label: sentence case noun phrase: "Keys scanned", "Total value".
- Value: numbers with thousands separators; keep the currency/unit in the meta.
- Meta: "last 24 hours", "across 18 chains", not a sentence.
- Use an em dash, not 0, when a value is unavailable.

## Do / don't

- Do align values right within a row and start labels on one line.
- Do use `.stat-card` only inside a summary strip, never as a standalone card.
- Don't add a sparkline, icon or decorative glyph as filler.
- Don't use uppercase tracked labels.

## Detectors

`stat-geometry` (label ≥12px, no text-transform, tracking ≤0.5px, value in
20/24/28 with tabular digits) and `card-padding-scale` (padding 16/20/24, radius
12/16; `.stat-card` is a documented boxless exception).

## Owner and changelog

- Owner: site-ui.
- 0.1.0 (2026-11-21): normalized the batch-4 stat geometry; `.stat--sm` is
  reserved CSS with no page consumer.
