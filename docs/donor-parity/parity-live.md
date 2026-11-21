# Live parity: rotor.pxbt.app vs privatekeyfinder.io and secretscan.org

2026-11-21. Method: live `curl` for status/title/markup and headless Chrome 157
over CDP for rendered DOM. Cloudflare reset headless Chrome on rotor.pxbt.app
and stalled the donor's CDN scripts, so our JS pages were rendered from the
shipped binary (`target/release/rotor-coord.exe`, built 02:35 from `324ac26`)
on `http://127.0.0.1:7879`; route status/server HTML are live, donor values are
live DOM or captured HTML. Public pages only; no forms submitted.

## Matrix

| Donor route | Ours | Status | Missing pieces (concrete) | Evidence |
|---|---|---|---|---|
| PKF `/key/<64-hex>` | `/key/<64-hex>` | partial | 8 key facts (HEX, Decimal, WIF, WIF (u), Keypair (SOL), Secret (XRP), PubKey, Page) and 30 address rows match. But only 10 of 18 chain groups are checkable (BTC, 8 EVM, TRON); XRP/SOL/TON/SUI/LTC/BCH/DOGE/ZEC show `—`, so `Checked` peaks at 10/18 (observed 4/18 after 26 s) vs donor 18/18; `Total value` is always `—` vs donor `$3,339.72` for key 1. Ours adds curve/path/±1 controls and 4 point facts (intentional). | live curls; local render 30 rows; `apps/site/key.js:2102-2108`; `key-page.md` |
| PKF `/key/<decimal>`, `/key/0x…`, `/key/<text>` (donor renders 200 and auto-detects) | same path | partial | `/key/1`, `/key/0x1`, `/key/hello world`, `/key/0x<64hex>` return 404 on rotor.pxbt.app; donor returns 200 and renders (1 → full page, text → client "Invalid Key" 200). WIF and 64-hex work. | `curl -o /dev/null -w %{http_code}`: 404 vs 200 |
| PKF `/private-keys` | `/private-keys` | same | 18 chain links; ours adds BCH and TON to the hub (donor hub links 16, both pages exist). | live HTML |
| PKF `/private-keys/<chain>` | same | partial | 60 rows, 18 tabs, pager + jump, 4 BTC type cards, 60 hex + 120 WIF `(c)/(u)` links match. Gaps: LTC has 3 type cards (legacy/nested/native) vs donor 4 (adds Taproot `ltc1p`); ETH/TRON cards say `Balance/Received/TX` vs donor `Balance/Active`; `?key=` only pre-fills — `?key=0xdeadbeef` highlighted 0 rows on page 1, donor jumps to page 62,265,476. | local render; `apps/site/browse.js:1080-1118,376-380` |
| PKF `/private-keys/<chain>/<page>` | same | same | 60 keys/page, page N = keys (N−1)·60+1…N·60, same pager. | live 200 for `/private-keys/bitcoin/2` |
| PKF `/mnemonic-seeds` | `/mnemonic-seeds` | same | 18 chain cards. | live HTML |
| PKF `/mnemonic-seeds/<chain>` | same | partial | 60 rows, 5 presets, 4 BTC type cards, `bits`/`path` controls, header `Private Key / Mnemonic | Address | BTC Balance` match. Row prints only first two + last words with expand/title (donor prints the full phrase by default). | local render; `apps/site/mnemonic-seeds.js:223-229` |
| PKF `/brainwallet` | `/brainwallet` | same | 18,890 passphrases · 315 pages · 60 rows/chain — identical counts to donor. | live title/HTML; `src/coordinator/mod.rs:2665` |
| PKF `/brainwallet/<chain>` | same | same | 60 rows, 18 tabs, pager. Ours adds Legacy/SegWit/Nested/Taproot tabs and 4 stats (superset). | local render |
| PKF `/brainwallet-generator` | same | same | Passphrase → SHA-256 → address, 18-chain selector (donor network dropdown). | live 200; local render |
| PKF `/bitcoin-puzzle` | `/bitcoin-puzzle` | partial | 160 rows, columns `# Status Address Range Balance TX Actions`, filters All 160 / Solved 83 / Unsolved 77, search, Detail/Random all match. Defaults to `Unsolved` like the donor (77 visible). | local render 160 rows; donor static filters |
| PKF `/bitcoin-puzzle/<n>` | `/bitcoin-puzzle/<n>` (canonical; `/detail` 301s here) | partial | Target, range, status, difficulty, keyspace, mempool links match; ours is richer. Missing: donor prints `Solution` (solved private key, e.g. #66 `000…2832ed74f2b5e35ee`) and a `Discuss` link; ours has neither. | donor capture `8b6bba26.html`; our `/bitcoin-puzzle/66` |
| PKF `/bitcoin-puzzle/<n>/random` | same | same | Random/sequential local search over the puzzle range; donor also scans in-page. | local render; live 200 |
| PKF `/richest/<chain>` | — | missing | No route: `/richest/bitcoin` and `/richest/ethereum` are 404. Donor has 100 rows, columns `Rank/Address/Label/Type/Balance/Actions`, summary `0 Exchanges, 0 Contracts, 100 Unknown`, filters All/Exchanges/Contracts/Unknown, `#addressSearch`. | live 404 vs donor 200, 100 rows |
| PKF `/downloads` | `/wallets` | missing | `/downloads` is 404. `/wallets` lists 6 per-chain rich-address datasets (BTC, ETH, LTC, DOGE, BCH, DASH) with `Download dataset` + `Request access`; donor lists 10 combined files (`.bin/.blf/.hex/.tsv`, Blockchair dump, brainwallet list) totalling 15.30 GB. | live 404; donor table 10 rows; local `/wallets` |
| PKF `/vanity-generator` | `/vanity` | partial | Ours is a superset (6 chain/address types incl. Taproot/EVM/TRON/SOL, prefix + suffix, stats, recent matches) but the donor URL is 404 here; `/vanity` is our only path. | live 404 for `/vanity-generator`; local `/vanity` |
| PKF `/milk-sad` | `/milk-sad` | partial | Ours is a 10.5 KB explainer. Donor index has 18 chain cards and each child is a 60-row directory. | live HTML both |
| PKF `/milk-sad/<chain>` | — | missing | `/milk-sad/bitcoin` and `/milk-sad/ethereum` are 404; donor serves 60 key rows/page per chain. | live 404 vs donor 200, 60 rows |
| PKF `/tools` | `/tools` | ours-only | Donor `/tools` renders a 404 page inside 200; ours is a real calculator index. | live 200 donor body "404 Page not found" |
| PKF global search (Ctrl+K) | Ctrl+K dialog | same | 18 chain cards, per-address rows, HEX/WIF/Keypair/XRP/Mnemonic/Brainwallet chips, BIP39 passphrase + 1/3/5/10, Copy All + CSV, `N active chains • M active addresses`. Ours has an extra Auto-detect chip. | `apps/site/site.js:305-430`; local modal present on every page |
| PKF shell | shell | partial | Nav, breadcrumbs, theme toggle (injected) and search modal match. Footer added in batch 6: FAQ/Disclaimer/Donate/Docs/GitHub/copyright/version on every public content page (app/cabinet shells intentionally omit it). Nav differs: ours `Home/Directory/Seeds/Puzzle/More` + search/Cabinet vs donor `Directory/Seed Phrases/BTC Puzzle/Mnemonic/Vanity/Milk Sad` + search, and donor has a full-width search trigger above content. | rendered local pages: one `.site-footer` on content routes, none on `/app`, `/run`, `/me`, `/cabinet`, `/cabinet/wallet` |
| secretscan `/Bitcoin_puzzle` | `/bitcoin-puzzle` | partial | Ours matches PKF's 7 columns; secretscan's table has `# Range Address Private key (Hex) Public key Solve date Balance` — missing solve date, published private key and public key columns on ours. | donor HTML `th` list; local puzzle table |
| secretscan `/Easy_bitcoin_transaction_online`, `/Easy_ethereum_transaction_online`, `/Easy_tron_trx_transaction_online`, `/Easy_bnb_transaction_online` | `/send`, `/send/bitcoin`, `/send/ethereum`, `/send/bnb`, `/send/tron` | partial | Ours supports BTC/ETH/BNB/TRON + ERC-20, but testnet only (Bitcoin testnet, Sepolia, Chapel, Nile; mainnet rejected in code). Donor sends mainnet and adds USDT BEP20/TRC20/ERC20 and USDC ERC20. No USDT/USDC routes here. | local `/send`; donor menu |
| secretscan `/Transaction_decoded_Bitcoin`, `/decode_ethereum_transaction` | `/tx/bitcoin`, `/tx/ethereum` | partial | Decode matches (legacy/SegWit; type 0/1/2). Donor also encodes and broadcasts and shows a mempool panel; ours is decode + JSON only. | local `/tx`; donor H1s |
| secretscan `/wallets` | `/wallets` | partial | Donor: 45 asset rows / 42 groups, columns `Rank/Pic/Ticker/Coin/Price $/24h volume/Address dump/Market Cap`, sortable, 25/50/100/105 select. Ours: 6 dataset cards only. | donor capture; local `/wallets` |
| secretscan `/scaner`, `/rent`, `/results` | — | missing | 404 on ours. No public server-side scanner, rental checkout or account found-key results; ours offers local `/bitcoin-puzzle` scans, `/run` leases and `/cabinet`. | live 404s |
| secretscan calculator family (`/PrivateKeyHex`, `/PrivateKeyWif`, …23 pills) | `/key/hex`, `/key/wif`, `/key/decimal`, `/hex-dec-bin`, `/public-key`, `/pubkey-add`, `/reconstruction`, `/keystore-parser`, `/tools` | partial | Same operations, one-shot results. Missing donor's 7 numbered intermediate steps per pipeline, per-field char counters, and the 360-coin `legacy_coins.json` prefix catalogue. | local `/tools`; donor docs §5 |

## Ranked backlog

1. **Key-page chain providers + USD total** — S/M. Wire the providers already in
   `apps/site/site.js:587-780` into `apps/site/key.js` for LTC/DOGE/BCH/XRP/SOL/
   SUI/TON, and add a price source for `Total value`. Decision: USD feed
   (Binance/CoinGecko) and cache TTL.
2. **`/richest/<chain>`** — L. New `apps/site/richest.js`, route + render in
   `src/coordinator/mod.rs`, top-100 ingestion. Decision: address dataset and
   labels (donor shows 100 "Unknown").
3. **`/milk-sad/<chain>` directory** — M/L. Extend `apps/site/milk-sad.js` and
   `src/coordinator/mod.rs`; 60 rows/page × 18 chains. Decision: generate the
   MT19937 corpus locally vs ship a list.
4. **`/downloads` + combined datasets** — M. Alias in `src/coordinator/mod.rs`,
   extend `src/coordinator/wallets.rs` and `apps/site/wallets` copy. Decision:
   bandwidth, mirror size (donor 15.30 GB), licences.
5. **Puzzle data: solution key, solve date, pubkey, Discuss, default Unsolved** —
   S/M. `src/coordinator/puzzles.rs` (currently `solved: bool` only) and
   `apps/site/puzzle-browser.js:244`. Decision: publish solved private keys/dates.
6. **Accept donor key URL forms** — S. `normalized_key_hex`/`is_key_value` in
   `src/coordinator/mod.rs:1630-1742`; pad 1–64 hex, accept `0x`, text; return
   200 with a client-side invalid state instead of 404.
7. **`?key=` jump to containing page** — S. `apps/site/browse.js:1094-1118`:
   compute `(BigInt(key)-1n)/60n+1n`, clamp, navigate with `type`.
8. **Site footer** — DONE (batch 6). `site_footer()` in
   `src/coordinator/mod.rs` renders FAQ/Disclaimer/Donate/Docs/GitHub,
   copyright and the asset version on every public content page; the
   app/cabinet shells stay footer-free; styles in `apps/site/site.css`;
   detector `footer-presence`.
9. **LTC Taproot card + account-chain stats** — S. `CHAINS`/browse render in
   `src/coordinator/mod.rs`; `setSummary` in `apps/site/browse.js:376`.
10. **Route aliases** — XS. `/vanity-generator` → `/vanity` and `/downloads` →
    `/wallets` in `src/coordinator/mod.rs` (permanent redirect).
11. **Secretscan transaction encode/broadcast + mainnet send** — L. Deliberately
    out of scope: mainnet signing is rejected by design. Only add decode-side
    mempool/encode if the product decision changes.
12. **Nav/search placement parity** — XS. Add a Milk Sad link and a full-width
    search trigger; `src/coordinator/mod.rs` nav + `apps/site/site.js`/
    `site.css`.

## Verdict

By route, 16 of PKF's 19 compared surfaces exist (84%), but only 9 are
substantively 1:1 (47%); 7 more are partial. The catalogue core — directory
paging, mnemonic seeds, brainwallet corpus, puzzle list, global search — is
1:1, sometimes a superset (derivation controls, type tabs, local scanner,
extra calculators). Gaps: richest lists, downloads/combined
datasets, Milk Sad chain directories and puzzle solution data are absent or
thin; the key page has the right anatomy but covers 10 of 18 chain groups and
never computes USD value; the shell lacks a footer. Intentional differences are
the derivation controls on `/key`, testnet-only sends, no mainnet signing and
the local-first model. What remains is mostly data and owner decisions
(rich-list labels, 15 GB mirrors, Milk Sad corpus, solved-puzzle keys, price
feed), not rendering code; the code-only items (aliases, key URL forms,
`?key=` jump, footer, LTC card) are small and independent.
