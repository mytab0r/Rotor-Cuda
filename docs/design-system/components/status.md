# Status

Status: stable · Version: 0.1.0 · Owner: site-ui (design system).
Source of truth: `design/components/status.json` · Gallery: `/cabinet/admin/design` (family
`status`).

## Purpose

A compact, non-interactive state label: settled/failed, a chain status, a count
or a puzzle state. Use it inside a table cell, card header or meta row. Do not
use it as a button or as the only signal of a state; pair the colour with text,
an icon or a labelled dot.

## Anatomy and slots

The normalized family is one geometry shared by the alias classes that pages
already render: `.badge` (neutral), `.monitor-chain` and `.ws-chain-status`
(chain), `.balance-refresh-count` (count, mono digits), `.pz-pill` and
`.pz-pill.solved` (puzzle), and the `span` inside `.key-badges`. There is no
`.status` class in `apps/site/site.css` yet and no `.status--ok/--warn/--err`
tone set; §3.5 of `DESIGN-SYSTEM.md` describes the target grammar, while this
manifest and the gallery describe what production actually renders.

All aliases get 20px min-height, `2px --space-2` padding, pill radius, 12px
text, weight 600, no tracking and no uppercase from the shared block at the end
of `site.css`. Tones stay on the existing semantic colours. An optional dot is
8px and `aria-hidden` when the text already names the state.

## API

- Element: `span` (the count badge uses the same element inside a button).
- Variants: `badge`, `chain`, `count`, `puzzle`, `puzzle-solved`.
- Sizes: default (20px pill). No required attributes.
- Not interactive: there is no disabled, focus or busy state.

## State matrix

| State | Evidence in `site.css` | Rendered in `/cabinet/admin/design` |
|---|---|---|
| Neutral | `.badge`: `--border` + `--muted` | yes |
| Chain | `.monitor-chain`: `--border` + `--muted`; page-specific chain colours | yes |
| Count | `.balance-refresh-count`: accent tint, mono tabular digits | yes |
| Puzzle open | `.pz-pill`: `--warn` border/text | yes |
| Puzzle solved | `.pz-pill.solved`: `--ok` border/text | yes |
| Hover/focus/disabled | none; the pill is not a control | n/a |

## Motion and reduced motion

No transition or animation on the pill. A checking dot may pulse only while the
surface is checking; the reduced-motion rule in the owning component must stop
that pulse. `.skeleton`-style shimmer is never combined with the pill.

## Accessibility

- Role: none (inline text). The text carries the state; colour is redundant.
- Name/description: the visible text is the name. A dot is `aria-hidden`.
- Live region: if the state changes asynchronously, the owning surface puts it
  in a `role="status"` region; the pill itself does not announce.
- Contrast: every tone uses a semantic role that passes 4.5:1 in both themes
  (`--muted`, `--warn`, `--ok`).
- Text size: 12px minimum; the shared block enforces it.

## Copy rules

- One or two words, sentence case: "Settled", "Checking", "Unsolved".
- Counts are bare numbers with tabular digits: "12".
- Do not put a sentence or a path in a pill.

## Do / don't

- Do use a pill for a state that fits in a table row or meta line.
- Don't use a pill as a filter or a button; use a chip.
- Don't add a page-local pill or a second tracking value.
- Don't encode success/failure by colour alone.

## Detectors

`status-pill-geometry` (12px text, 18–32px height, pill radius, inline padding
6/8/10/12). The tone contrast is covered by the token contrast table in
`DESIGN-SYSTEM.md` §2.3 and the route-wide text contrast checks.

## Owner and changelog

- Owner: site-ui.
- 0.1.0 (2026-11-21): declared the shared geometry over the existing alias
  classes; no `.status` class or new tone was added.
