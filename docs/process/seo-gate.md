# SEO gate for the chain directory, its hub, the presentation pages and the 404 page

`scripts/check-seo.mjs` reads the built `web/dist` tree and fails when the
prerendered `/private-keys` hub, a `/private-keys/<chain>` page, one of the
presentation pages (`/docs`, `/tools`, `/faq`, `/disclaimer`, `/donate`), or the
root `404.html` breaks the contract measured in the SEO audit. It is wired into
`.github/workflows/rust.yml` as the `web-seo` job and needs no dependencies or
network.

## Rules

| Detector | Rule |
|---|---|
| `seo-page-set` | Exactly the 18 mainnet slugs from `data/chains.json` are built; the `/private-keys` hub and the five presentation pages are present; no missing or extra chain page. |
| `seo-metadata-bounds` | Title 50–60 characters ending in `\| Crypto`; description 120–160 characters. Chain titles start with the chain name and chain descriptions carry at least one digit. The hub title is at most 60 and starts with “Private keys by chain”; its description names the 18 chains. Presentation pages share the 50–60 title and 120–160 description bounds. |
| `seo-canonical-robots` | Canonical is the page's own `https://rotor.pxbt.app` URL (`/private-keys`, `/private-keys/<slug>`, `/docs`, `/tools`, `/faq`, `/disclaimer` or `/donate`) and robots is `index,follow`. |
| `seo-duplicate-metadata` | No two checked pages (chain pages, the hub and every presentation page) share a title or a description. |
| `seo-hidden-heading` | One visible H1 and no visually-hidden H1. A chain page's H1 is exactly `<Chain> private keys`; the hub's is `Private keys by chain`. A chain page or the hub needs at least two visible content H2s inside `data-seo-prose`; `/docs` needs at least three content H2s; `/tools`, `/faq`, `/disclaimer` and `/donate` at least two. |
| `seo-toc-anchor` | On `/docs`: the `data-docs-toc` TOC exists, every TOC href resolves to an existing id, every content H2 has an id and an entry, ids are unique, and there are at least three TOC anchors. Any `#fragment` link on a presentation page must resolve. |
| `seo-internal-link` | Every root-relative `<a href>` on a presentation page targets a page or file that exists in `dist`, or an entry in the checker's explicit `pendingCutover` allowlist. |
| `seo-pending-cutover` | Every `pendingCutover` entry carries a non-empty reason and is not stale (a target that now exists in `dist` fails until it is removed). |
| `seo-hub-links` | The hub is built, links all 18 chain pages from `data/chains.json`, and every internal link in its main content resolves to a built file in `web/dist`. |
| `seo-rendered-rows` | At least 40 `<tr data-key>` rows are present in a chain page's initial HTML, not built by JavaScript. |
| `seo-prose-uniqueness` | At least 120 unique prose words per chain page, and 5-gram Jaccard similarity below 0.50 between every pair of chain pages. The shared safety block is outside `data-seo-prose` and is not part of the comparison. |
| `seo-structured-data` | Every `application/ld+json` block parses. Chain pages contain `CollectionPage` + `BreadcrumbList`; the hub adds an `ItemList` whose `numberOfItems` is the 18-chain count; `/docs` contains `TechArticle` + `BreadcrumbList`; `/tools` contains `CollectionPage` + `BreadcrumbList`; `/faq` contains `FAQPage` + `BreadcrumbList`; `/disclaimer` and `/donate` contain `BreadcrumbList`. |
| `seo-og-image-alt` | `og:image` is present. Chain pages name the chain in `og:image:alt` / `twitter:image:alt`; the hub describes itself and its chain count; every presentation page carries both alt values. |
| `seo-not-found` | The deploy root ships `404.html` with `noindex`, no hidden H1 and exactly one visible H1. Without the file Cloudflare Pages answers 200 with the landing page for an unknown path. |

## The pendingCutover allowlist

`/docs`, `/tools`, `/faq`, `/disclaimer` and `/donate` are the presentation
pages in the static build. Some routes they link to are still served by the Rust
coordinator (the key explorer, seed tools, brainwallet and the remaining
calculators), so the checker keeps those exact paths in one in-file
`pendingCutover` map with a written reason and the frontend-platform phase that
owns the move. The map is shrink-only: a route whose page is now built fails as
a stale entry until it is removed. Do not add a path without a reason, and do not
replace the list with a wildcard or a "skip external" rule.

## Usage

```sh
npm --prefix web run build
node scripts/check-seo.mjs
node scripts/check-seo.mjs --dist path/to/other/dist --json report.json
```

Exit codes: `0` pass, `1` violations, `2` harness error (for example a missing
build tree).

## Mutation check

The gate is only useful if it fails. To prove a rule locally, copy `web/dist` to
a temporary directory, mutate one file, and run the gate against the copy with
`--dist`:

```sh
cp -r web/dist /tmp/rotor-seo-mutated
# remove a heading, shrink a title, break a TOC href, add an unknown internal
# link, duplicate two pages' metadata, or corrupt a JSON-LD block
node scripts/check-seo.mjs --dist /tmp/rotor-seo-mutated
```

A mutation that removes the H1, truncates a title below 50 characters, deletes
the rendered rows, copies one chain's prose into another, points a docs TOC
anchor at a missing id, links to an unbuilt route that is not allowlisted,
duplicates a title or description, drops the `FAQPage` node from `/faq`, or
corrupts JSON-LD must make the gate exit `1` with the matching detector id. The
PR records at least three such mutations and their output.

## Scope

This gate covers the `/private-keys` hub, page 1 of the chain directory, the
`/docs`, `/tools`, `/faq`, `/disclaimer` and `/donate` presentation pages, and
the root 404 document. Pages 2+ remain noindex and are served on demand, as
`data/routes.json` records. The pages are built in `web/dist` but are not routed
through the coordinator until the frontend-platform cutover.
