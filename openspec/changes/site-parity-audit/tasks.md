# Tasks

## P0 — interaction parity

- [ ] Brainwallet directory: `/brainwallet` index + 18 chain listings, 60 rows
  × 315 pages, auto addresses/balances, two copy icons per row, BTC type tabs,
  First/Prev/Random/Next/Last + Jump.
- [ ] Brainwallet single calculator on `/brainwallet-generator` with network,
  passphrase, 1/3/5/10 addresses, Copy All/CSV.
- [ ] Seed rows: private key/WIF + copy icons; compact reveal for the phrase.
- [ ] Puzzle home: 160-row table, All/Solved/Unsolved filters, search,
  Balance/TX/Actions.
- [ ] Puzzle random: Community Hunt counters and a live result table.
- [ ] `/richest` + `/richest/<chain>` top-100 with type filter, search, copy and
  explorer.
- [ ] BTC/EVM transaction decoders (`/tx/bitcoin`, `/tx/ethereum`).
- [ ] Top-level `/send/<chain>` for BTC/ETH testnet, reusing the cabinet signing
  core; mainnet stays gated.
- [ ] `/key` debounced auto-derive, icon-only utility actions, full formats and
  counters.
- [ ] Global search results in place: interpret-as, 1/3/5/10 addresses, table,
  Copy All/CSV.

## P1 — shell and templates

- [ ] One filter bar (search + type + chain chips + reset), pager separate,
  stats in the table footer.
- [ ] Reusable icon-button (28/36/44, copied state), compact-row and
  skeleton/empty/error primitives.
- [ ] Header: 4 primary links + More/drawer at ≤860 px; icon-only search/theme.
- [ ] Tools index: 8 families with alias rows.
- [ ] Address types for BCH (legacy/CashAddr), TON (v4R2/W5), DOGE/ZEC
  compressed/uncompressed.
- [ ] Breadcrumbs on every page; consistent `aria-current`.
- [ ] Seed converter: live word counter, 20 addresses, Load next 5, Copy All.
- [ ] Vanity: threads/ETA/difficulty/save/recent; pubkey-add: P−Q and scalar
  multiply.

## Verification

- [ ] `docs/site-map/index.html` updated for every completed row; no false parity.
- [ ] UI gate 375/768/1280, light/dark, keyboard, reduced motion.
- [ ] `node scripts/check-projects.mjs`, site tests, cargo tests, clippy.

## Relocation to internal docs (done)

- [x] Move the parity map from the public site to `docs/site-map/`
  (`index.html`, `site-map.css`, `site-map.js`, `site-map-data.js`,
  `site-map-test.mjs`, local `icons.svg` and `theme.js`); relative assets only.
- [x] Drop `/site-map`, `/site-map.css`, `/site-map.js` and `/site-map-data.js`
  from the coordinator routes, embedded assets and sitemap; route tests and
  `/docs`/`/tools` links no longer reference the public path.
- [x] Run the data test from `docs/`: `node docs/site-map/site-map-test.mjs`.
