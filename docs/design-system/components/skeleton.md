# Skeleton

Status: stable · Version: 0.1.0 · Owner: site-ui (design system).
Source of truth: `design/components/skeleton.json` · Gallery: `/design` (family
`skeleton`).

## Purpose

A placeholder for content that is loading: a shimmer block or a text-cell
placeholder that preserves the layout until the async data lands. Use it in the
loading state of every async surface. Do not use it as decoration or as a
permanent empty state.

## Anatomy and slots

`<span class="skeleton" aria-hidden="true"></span>` is the block. It is 12px
high, radius 4, and shimmers from `--surface-2` to `--surface-3`. The
`.cell-skeleton` variant is the text placeholder used inside a table cell; it
keeps the cell's line height and shows a neutral placeholder string. The owning
surface carries the real status text in a `role="status"` region; the skeleton
is decorative.

## API

- Element: `span` (a `div` is allowed).
- Variants: `default`, `cell`. Sizes: default (12px high).
- Required attribute: `aria-hidden="true"`.
- No text content except the cell placeholder.

## State matrix

| State | Evidence in `site.css` | Rendered in `/design` |
|---|---|---|
| Default block | gradient `--surface-2` → `--surface-3`, 200% background, 1.2s shimmer | yes |
| Cell placeholder | `.cell-skeleton` text at 12.5px | yes |
| Reduced motion | animation off under `prefers-reduced-motion` | verified by the media query, not by the gallery |
| Error/empty | the skeleton is replaced by the error/empty family | composition |

## Motion and reduced motion

The shimmer is a 1.2s ease-in-out infinite background-position animation.
`@media (prefers-reduced-motion: reduce)` sets `.skeleton { animation: none; }`,
leaving the static surface step.

## Accessibility

- The skeleton is `aria-hidden="true"`; it never carries the loading message.
- The owning surface announces loading with `role="status"` /
  `aria-live="polite"` and replaces the message when data arrives.
- Do not put a focusable control inside a skeleton.
- Contrast: the skeleton is a surface, not text; it never needs a text contrast
  ratio. The placeholder cell text stays at the 12px floor.

## Copy rules

- No visible sentence in the block; the status region owns the words
  ("Loading balances…").
- The cell placeholder is a neutral value, not a fake result.

## Do / don't

- Do keep the skeleton's height equal to the content it replaces.
- Do use one skeleton implementation; do not add a page-local shimmer.
- Don't animate the shimmer after the data arrives.
- Don't use a skeleton as an empty state or as an error.

## Detectors

None. Skeleton geometry, the 12px height and the reduced-motion override are not
machine-checkable in the current audit; `scripts/check-components.mjs` only
verifies that the declared variants and the required `aria-hidden` attribute are
rendered.

## Owner and changelog

- Owner: site-ui.
- 0.1.0 (2026-11-21): declared the batch-1 skeleton and the cell placeholder.
