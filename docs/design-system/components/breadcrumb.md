# Breadcrumb

Status: stable · Version: 0.1.0 · Owner: site-ui (design system), coordinator
(server-rendered trails).
Source of truth: `design/components/breadcrumb.json` · Gallery: `/cabinet/admin/design`
(family `breadcrumb`).

## Purpose

One trail from the home page to the current content page. Use it on every public
content page. Do not render a trail on `/`, `/app`, `/run`, `/me`, `/cabinet` or
`/cabinet/wallet`.

## Anatomy and slots

`<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> <span
class="breadcrumbs__sep" aria-hidden="true">/</span> <span
aria-current="page">Design</span></nav>`. Each link is a 44px target. Exactly
one item is `aria-current="page"` at `--ink-2`/600. The separator is never a bare
text slash or a blank gap. Server-rendered pages call `breadcrumb_nav` in
`src/coordinator/mod.rs`; client-filled trails use `RotorBreadcrumbs` in
`site.js`.

The gallery's own trail above the title is the live `default` specimen; the page
does not render a second `<nav class="breadcrumbs">` because the audit expects
exactly one trail per content page.

## API

- Element: `nav.breadcrumbs` with `aria-label="Breadcrumb"`.
- Variants: default. Sizes: default (44px links).
- Required attribute: `aria-label="Breadcrumb"` on the nav.
- The current item is a `span` with `aria-current="page"`; links are `<a>`.

## State matrix

| State | Evidence in `site.css` | Rendered in `/cabinet/admin/design` |
|---|---|---|
| Default link | `--ink-3`, 44px box, radius `--radius-s` | yes (the page trail) |
| Hover | `--ink-1` | live |
| Focus-visible | browser default outline; the shared nav focus rule does not target `.breadcrumbs` | live (tab), not separately machine-checked |
| Current page | `--ink-2`, weight 600, one `aria-current` | yes |
| Disabled/loading | none; the trail is static | n/a |

## Motion and reduced motion

No transition or animation. Long labels wrap or truncate through `title` /
`aria-label`; no motion is involved.

## Accessibility

- Landmark: one `nav` with the exact name "Breadcrumb".
- Current item: exactly one `aria-current="page"`; its visible text is human
  label text, not a raw path.
- Separators: `aria-hidden="true"` and the text "/"; the number of separators
  matches the number of links.
- Touch: every link is at least 44px high.
- Reflow: the trail wraps without horizontal overflow at 375px.

## Copy rules

- Home, Directory, Bitcoin, Design: use the page title, not the URL.
- Long page titles truncate in the visible label but keep the full title in the
  `title` attribute.
- Do not put the current page in a link.

## Do / don't

- Do render exactly one trail per content page.
- Do keep the current page as the last item.
- Don't use a bare slash between items.
- Don't show a raw path as the current label.
- Don't add a trail to a shell route.

## Detectors

`breadcrumb-grammar` (one landmark, one separator per link, `/` text,
`aria-hidden`, 44px links, human labels) and `breadcrumb-current` (one current
item, no raw path). The focus ring on a breadcrumb link is not separately
checked.

## Owner and changelog

- Owner: site-ui; server markup by coordinator.
- 0.1.0 (2026-11-21): declared the batch-6 breadcrumb grammar; the gallery uses
  its own page trail as the specimen.
