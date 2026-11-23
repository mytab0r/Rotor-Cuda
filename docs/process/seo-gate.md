# SEO gate for the chain directories, their hubs, the presentation pages and the 404 page

`scripts/check-seo.mjs` reads the built `web/dist` tree and fails when a
prerendered directory page or hub breaks the contract measured in the SEO
audit:

- the `/private-keys` hub and its 18 `/private-keys/<chain>` pages;
- the `/mnemonic-seeds` hub and its 18 `/mnemonic-seeds/<chain>` pages;
- the `/docs` and `/tools` presentation pages;
- the root `404.html`.

It is wired into `.github/workflows/rust.yml` as the `web-seo` job and needs no
dependencies or network.

## Rules

| Detector | Rule |
|---|---|
| `seo-page-set` | Exactly the 18 mainnet slugs from `data/chains.json` are built in each family; both hubs, `/docs` and `/tools` are present; no missing or extra chain page. |
| `seo-metadata-bounds` | Title 50–60 characters ending in `\| Crypto`; description 120–160 characters. Directory chain titles start with the chain name and descriptions carry at least one digit. A private-key hub title is at most 60 and starts with “Private keys by chain”; a seed hub title starts with “Mnemonic seeds by chain”; each hub description names the 18 chains. |
| `seo-canonical-robots` | Canonical is the page's own `https://rotor.pxbt.app` URL (`/private-keys`, `/private-keys/<slug>`, `/mnemonic-seeds`, `/mnemonic-seeds/<slug>`, `/docs` or `/tools`) and robots is `index,follow`. |
| `seo-duplicate-metadata` | No two checked pages (either family's chain pages, either hub, `/docs`, `/tools`) share a title or a description. |
| `seo-hidden-heading` | One visible H1 and no visually-hidden H1. A private-key page's H1 is exactly `<Chain> private keys`; a seed page's is `<Chain> seed phrases`; the private-key hub's is `Private keys by chain`; the seed hub's is `Mnemonic seeds by chain`. A directory chain page or hub needs at least two visible content H2s inside `data-seo-prose`; `/docs` needs at least three; `/tools` at least two. |
| `seo-toc-anchor` | On `/docs`: the `data-docs-toc` TOC exists, every TOC href resolves to an existing id, every content H2 has an id and an entry, ids are unique, and there are at least three TOC anchors. Any `#fragment` link on either presentation page must resolve. |
| `seo-internal-link` | Every root-relative `<a href>` in a directory page's or hub's main content targets a page or file that exists in `dist`, an entry in the explicit `pendingCutover` map, or one of the two pending chain prefixes (the key calculator `/key/<hex>` and directory page 2+, both still served by the coordinator). `/docs` and `/tools` use the same contract without the chain prefixes. |
| `seo-pending-cutover` | Every `pendingCutover` and `pendingChainPrefixes` entry carries a non-empty reason; an exact `pendingCutover` target that now exists in `dist` fails until it is removed. |
| `seo-hub-links` | Each hub is built, links all 18 chain pages from `data/chains.json`, and every internal link in its main content resolves to a built file in `web/dist`. |
| `seo-rendered-rows` | At least 40 rendered chain rows are present in a chain page's initial HTML, not built by JavaScript: `<tr data-key>` on `/private-keys`, `<tr data-seed>` on `/mnemonic-seeds`. |
| `seo-prose-uniqueness` | At least 120 unique prose words per chain page, and 5-gram Jaccard similarity below 0.50 between every pair of chain pages in the same family. The shared safety block is outside `data-seo-prose` and is not part of the comparison. |
| `seo-structured-data` | Every `application/ld+json` block parses. Both families' chain pages contain `CollectionPage` + `BreadcrumbList`; each hub adds an `ItemList` whose `numberOfItems` is the 18-chain count; `/docs` contains `TechArticle` + `BreadcrumbList`; `/tools` contains `CollectionPage` + `BreadcrumbList`. |
| `seo-og-image-alt` | `og:image` is present. Directory chain pages name the chain in `og:image:alt` / `twitter:image:alt`; each hub describes itself and its chain count; `/docs` and `/tools` carry both alt values. |
| `seo-not-found` | The deploy root ships `404.html` with `noindex`, no hidden H1 and exactly one visible H1. Without the file Cloudflare Pages answers 200 with the landing page for an unknown path. |

## The pendingCutover allowlist

`/docs` and `/tools` are the first presentation pages in the static build. Most
of the tools they link to are still served by the Rust coordinator, so the
checker keeps those exact paths in one in-file `pendingCutover` map with a
written reason and the frontend-platform phase that owns the move. The map is
shrink-only: a route whose page is now built fails as a stale entry until it is
removed. Do not add a path without a reason, and do not replace the list with a
wildcard or a "skip external" rule.

Directory chain pages also link to two coordinator families the static build
cannot enumerate: the key calculator (`/key/<hex>`) and directory page 2+.
Those live in the separate `pendingChainPrefixes` map, each with a reason. A
single built chain route is never treated as pending: `/private-keys/<slug>`
and `/mnemonic-seeds/<slug>` are checked normally, so a typo in a chain link
still fails.

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
duplicates a title or description, or corrupts JSON-LD must make the gate exit
`1` with the matching detector id. The PR records at least three such mutations
and their output.

## Scope

This gate covers both hubs and page 1 of both directories, the `/docs` and
`/tools` presentation pages, and the root 404 document. Pages 2+ remain
noindex and are served on demand, as `data/routes.json` records. The pages are
built in `web/dist` but are not routed through the coordinator until the
frontend-platform cutover.
