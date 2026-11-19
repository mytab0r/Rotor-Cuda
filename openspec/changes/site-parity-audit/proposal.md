# Site parity audit and rollout

## Summary

The site grew feature by feature without a template-level comparison with the
donors. This change records the page-by-page audit, the feature matrix and the
ordered rollout so a page is either at parity or explicitly partial/missing.

## Sources

- `ref-site-a/sitemap.xml` (58 routes) and live pages.
- `ref-site-b` navigation and its transaction/tool pages.
- Our route inventory and live pages.
- Interactive map: `/site-map` (route ↔ route, feature matrix).

## P0 gaps

1. `/brainwallet/<chain>` is a single calculator; the donor is a 60×315
   directory with auto-derived addresses/balances and per-row copy.
2. `/mnemonic-seeds/<chain>` rows omit the private key/WIF and copy actions.
3. `/bitcoin-puzzle` has no 160-row table with All/Solved/Unsolved filters and
   no Community Hunt results on `/random`.
4. No `/richest` or `/richest/<chain>` interactive top-100 pages.
5. No BTC/EVM transaction decoders and no top-level send pages; send exists
   only inside the cabinet.
6. `/key` requires buttons instead of debounced auto-derive; formats and
   aggregate counters are incomplete.
7. Global search redirects to `/key` instead of showing an in-place result
   table with 1/3/5/10 addresses and export.

## P1 gaps

- Multiple address types for BCH/TON/DOGE/ZEC.
- Header overflow at ≤860 px without a More/drawer.
- `/tools` 26 cards instead of 8 families with aliases.
- Inconsistent breadcrumbs, duplicated preset controls, three separate filter
  panels, missing skeleton/empty/error primitives.
- Seed converter: live word counter, 20 addresses, Load next 5, Copy All.
- Vanity: threads/ETA/difficulty/save; pubkey-add: P−Q and scalar multiply.

## Rules

- Do not copy donor text or dark patterns (bulk key export, server-side key
  search, account walls, gamified key theft).
- Every new page gets a row in `/site-map` and an honest status.
- A page is `parity` only when its interaction model, empty/loading/error states,
  mobile layout and icon/action grammar match or beat the donor.

## Out of scope

- Paid datasets, Cloudflare migration, full admin/CMS.
