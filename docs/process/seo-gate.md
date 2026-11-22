# SEO gate for the chain directory

`scripts/check-seo.mjs` reads the built `web/dist` tree and fails when a
prerendered `/private-keys/<chain>` page breaks the contract measured in the
SEO audit. It is wired into `.github/workflows/rust.yml` as the `web-seo` job
and needs no dependencies or network.

## Rules

| Detector | Rule |
|---|---|
| `seo-page-set` | Exactly the 18 mainnet slugs from `data/chains.json` are built; no missing or extra page. |
| `seo-metadata-bounds` | Title 50–60 characters, chain name first and `\| Crypto` last; description 120–160 characters with at least one digit. |
| `seo-canonical-robots` | Canonical is the page's own `https://rotor.pxbt.app/private-keys/<slug>` URL and robots is `index,follow`. |
| `seo-duplicate-metadata` | No two chain pages share a title or a description. |
| `seo-hidden-heading` | One visible H1, exactly `<Chain> private keys`; no visually-hidden H1; at least two visible content H2s inside `data-seo-prose`. |
| `seo-rendered-rows` | At least 40 `<tr data-key>` rows are present in the initial HTML, not built by JavaScript. |
| `seo-prose-uniqueness` | At least 120 unique prose words per page, and 5-gram Jaccard similarity below 0.50 between every pair of chain pages. The shared safety block is outside `data-seo-prose` and is not part of the comparison. |
| `seo-structured-data` | JSON-LD contains both `CollectionPage` and `BreadcrumbList`. |
| `seo-og-image-alt` | `og:image` is present and `og:image:alt` / `twitter:image:alt` name the chain. |

## Usage

```sh
npm --prefix web run build
node scripts/check-seo.mjs
node scripts/check-seo.mjs --dist path/to/other/dist --json report.json
```

Exit codes: `0` pass, `1` violations, `2` harness error (for example a missing
build tree).

## Mutation check

The gate is only useful if it fails. To prove a rule locally, copy
`web/dist/private-keys` to a temporary directory, mutate one file, and run the
gate against the copy with `--dist`:

```sh
cp -r web/dist /tmp/rotor-seo-mutated
# remove a heading, shrink a title, duplicate two rows, or copy one page's prose
node scripts/check-seo.mjs --dist /tmp/rotor-seo-mutated
```

A mutation that removes the H1, truncates a title below 50 characters, deletes
the rendered rows, or copies one chain's prose into another must make the gate
exit `1` with the matching detector id. The PR records at least three such
mutations and their output.

## Scope

This gate covers page 1 of the chain directory only. Pages 2+ remain noindex
and are served on demand, as `data/routes.json` records. The pages are built in
`web/dist` but are not routed through the coordinator until the
frontend-platform cutover.
