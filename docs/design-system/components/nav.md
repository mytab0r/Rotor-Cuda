# Navigation shell

Status: stable · Version: 0.1.0 · Owner: site-ui (design system).
Source of truth: `design/components/nav.json` · Gallery: `/design` (family
`nav`).

## Purpose

The sticky site header: brand, primary destinations, and exactly three utility
controls (search icon-button, theme icon-button injected by `theme.js`, cabinet
chip). Use one header per public page. Do not add a second navigation toolbar
for the same destinations.

## Anatomy and slots

`<header class="site-nav">` with `.brand`, `<nav aria-label="Main">` links, and
`.nav-tools`. Links are 44px high with 18px icons and 12px horizontal padding;
the active item uses `aria-current="page"` (or the legacy `.active` alias) with
`--signal-soft` + signal text. The brand mark is the one permitted gradient.
Below 860px `site.js` moves the overflow links into a `.nav-drawer` under one
More control; without JS every link stays visible.

The gallery renders the real header from `apps/site/docs.html` as the live
`site` specimen; there is no hand-written copy. The drawer is a runtime surface
created by `site.js`, not a separately rendered manifest variant.

## API

- Element: `header.site-nav`.
- Variants: `site` (the header shell). Sizes: default (min-height 70).
- No required attributes on the header; the `nav` child needs
  `aria-label="Main"`.
- Utility controls are the shared `.icon-button` and `.chip` components.

## State matrix

| State | Evidence in `site.css` | Rendered in `/design` |
|---|---|---|
| Default | `--nav-bg`, hairline bottom, 16px blur, `--z-nav` | yes (the live header) |
| Hover | `--hover` background, `--ink-1` text | live |
| Focus-visible | 2px `--signal` outline, offset 2 | live (tab) |
| Current page | `aria-current="page"` / `.active`: `--signal-soft`, signal text and hairline | live on routes where a destination is active |
| More drawer | `.nav-drawer` under 860px with the same link grammar | runtime; open the header More control |
| Disabled/loading | n/a | n/a |

## Motion and reduced motion

The drawer enters with a 120ms opacity/translate animation. The reduced-motion
block removes the animation. The header itself does not animate.

## Accessibility

- One `<nav aria-label="Main">`; every link has a visible label or a labelled
  icon and a 44px box.
- The Seeds destination must point at `/mnemonic-seeds` (the directory), not the
  `/seed` studio; `nav-destination` enforces it.
- The theme control is injected by `theme.js` as the shared icon-button with an
  `aria-label` and `data-tooltip`.
- The drawer closes on Escape and outside click; focus returns to the trigger.
- Reflow: the header wraps to its own row below 860px; no horizontal overflow at
  375px.

## Copy rules

- Destination labels are one word where possible: Home, Directory, Seeds,
  Puzzle, Vanity, Milk Sad, Tools, Docs.
- The cabinet chip label is "Cabinet"; the search icon is named "Search wallet".
- Do not put a tagline or a count in the header.

## Do / don't

- Do keep exactly three utility controls.
- Do use the shared icon-button and chip components.
- Don't add `.nav-pill` or a page-local one-off icon wrapper.
- Don't hide a destination without keeping it reachable in the More drawer.
- Don't add a second header or a second nav toolbar.

## Detectors

`nav-link-height` (44px box, 18px icon, 44px utility controls),
`nav-destination` (Seeds → `/mnemonic-seeds`, active state),
`small-touch-target`, `icon-button-scale` for the utility controls.

## Owner and changelog

- Owner: site-ui.
- 0.1.0 (2026-11-21): declared the batch-6 nav shell; the gallery uses the real
  header as its specimen.
