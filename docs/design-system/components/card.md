# Card

Status: stable · Version: 0.2.0 · Owner: site-ui (design system).
Source of truth: `design/components/card.json` · Gallery: `/cabinet/admin/design` (family
`card`).

## Purpose

A bordered surface that groups one task or summary: a form, a stats block, a
table header with its actions. Use it for a section that needs a visual boundary.
Do not use a card as a grid of navigation links when a compact row list is
denser, and do not use it as a decorative wrapper around a single paragraph.

## Anatomy and slots

`<section class="card"><h2>Title</h2><p>Body</p></section>`. The title is an
`h2` (20px/600) and the body is normal copy. One primary action is allowed; put
secondary actions in a quieter control. The named card surfaces that pages
already render (`.chain-card`, `.tool-card`, `.tool-family`,
`.address-db-card`, `.tool-index-card`, `.pz-picker-card`) share the padding and
radius scale. `.card--flat` and `.card--stat` exist in CSS but no page renders
them; they are reserved and not in the manifest.

A repeated navigation directory is not a card grid. `.chain-row` inside
`.chain-grid--rows` is the compact one-line form (44px control floor,
`--radius-m`) and `.address-db-links` is an inline list of destinations; the
landing renders both. The browsing directories keep `.chain-card`, and the
`/wallets` storefront keeps `.address-db-card` because each card carries its
own download actions.

## API

- Element: `section` (or `div` when the card is not a landmark).
- Variants: default. Sizes: default (padding 20, radius 16).
- No required attributes; the heading supplies the section name.
- Stamp: the card uses `--surface-1`, `--line-subtle`, `--elev-1`.

## State matrix

| State | Evidence in `site.css` | Rendered in `/cabinet/admin/design` |
|---|---|---|
| Default | `--surface-1`, `--line-subtle`, radius `--radius-xl`, `--elev-1` | yes |
| Hover | none on the card itself; a card link may use the shared focus/hover ring | n/a |
| Focus-visible | the card is not focusable; its links and buttons are | live in their own families |
| Selected | no card-level selected state; use a row state inside the card | n/a |
| Loading | no card-level loading state; compose a `.skeleton` block | n/a |

## Motion and reduced motion

No transition, hover transform or entrance animation on `.card`. The shared
reduced-motion rule covers child primitives. Do not add a translateY hover.

## Accessibility

- Role: `section` needs an accessible name to become a landmark, which the `h2`
  provides. A `div` card is presentational.
- Heading: exactly one heading at the top; no decorative icon in the title.
- Focus: the card itself is not focusable; every action inside keeps its own
  44px target and ring.
- Contrast: `--ink-1` heading and `--ink-2` body on `--surface-1`.
- Space: no fixed height; `mostly-empty-block` reports a section or card taller
  than 220px with less than 55% of its box covered by visible children.
  `card-dead-space` reports a landing directory container with six or more
  links where one renders taller than 64px or reserves more than 12px above its
  content.

## Copy rules

- Title: sentence case noun phrase, 2–4 words: "Global stats", "Leaderboard".
- Body: one short paragraph or the actual content; no marketing filler.
- One primary action; its label follows the button copy rules.

## Do / don't

- Do use a card for a task or summary that needs a boundary.
- Do use named card surfaces instead of page-scoped overrides.
- Don't add `.key-page > .card` or another page-local padding/radius.
- Don't put a grid of explanatory cards on a data-heavy page.

## Detectors

`card-padding-scale` (padding 16/20/24, radius 12/16; `.card--flat` and the
boxless strip cells are the documented exceptions) and `mostly-empty-block`.
`card-dead-space` keeps a repeated landing directory on `.chain-row` /
`.address-db-links` instead of a card grid. The named card surfaces share the
same detectors.

## Owner and changelog

- Owner: site-ui.
- 0.2.0 (2026-11-25): the landing chain and address-database directories moved
  to `.chain-row` / `.address-db-links`; the shared `.chain-card` min-height
  reservation was removed. Added `card-dead-space`.
- 0.1.0 (2026-11-21): normalized the batch-4 card surface. `.card--flat` and
  `.card--stat` are reserved CSS with no page consumer.
