# Live parity: rotor.pxbt.app vs ref-site-a and ref-site-b

2026-11-21. Method: live `curl` for status/title/markup and headless Chrome 157
over CDP for rendered DOM. Cloudflare reset headless Chrome on rotor.pxbt.app
and stalled the donor's CDN scripts, so our JS pages were rendered from the
shipped binary (`target/release/rotor-coord.exe`, built 02:35 from `324ac26`)
on `http://127.0.0.1:7879`; route status/server HTML are live, donor values are
live DOM or captured HTML. Public pages only; no forms submitted. Matrix rows
were re-checked against the code at `c46b4f1` on 2026-11-21 and updated where a
later PR had closed an earlier gap; each edited row cites `file:line`.

## Matrix

| Donor route | Ours | Status | Missing pieces (concrete) | Evidence |
|---|---|---|---|---|
| PKF `/key/<64-hex>` | `/key/<64-hex>` | partial | 8 key facts (HEX, Decimal, WIF, WIF (u), Keypair (SOL), Secret (XRP), PubKey, Page) and 30 address rows match. 16 of 18 chain groups now have a balance provider (BTC, 8 EVM, TRON, XRP, SOL, SUI, TON, LTC and DOGE via BlockCypher); BCH/ZEC still show `—` and count as done immediately, so `Checked` can reach 18/18. `Total value` is computed from a public Binance ticker and shows `—` only when no price source is reachable or no loaded balance is priced (donor showed `$3,339.72` for key 1). Ours adds curve/path/±1 controls and 4 point facts (intentional). | local render 30 rows; `apps/site/key.js:2295-2302,2304-2474`; `apps/site/key-tools.js:967-1011`; `key-page.md` |
| PKF `/key/<decimal>`, `/key/0x…`, `/key/<text>` (donor renders 200 and auto-detects) | same path | partial | 1..64 hex digits with an optional `0x` are left-padded to 32 bytes, so `/key/1`, `/key/0x1` and `/key/0x<64hex>` now render 200; WIF, XRP secrets and keypair JSON also render. Deliberate deviation: free text (`/key/hello world`) stays a real 404 instead of the donor's 200 soft-404 that renders a client-side "Invalid Key"; this is an intentional product decision, not an open gap. | `src/coordinator/mod.rs:1659-1677,1685-1740` |
| PKF `/private-keys` | `/private-keys` | same | 18 chain links; ours adds BCH and TON to the hub (donor hub links 16, both pages exist). | live HTML |
| PKF `/private-keys/<chain>` | same | same | A re-check against the live donor found no remaining donor gap: 60 rows, 18 tabs, pager + jump, `?key=` page jump, 4 BTC and 4 LTC type cards (legacy/nested/native/Taproot `ltc1p`), 60 hex + 120 WIF `(c)/(u)` links and the chain-shaped stats all match, and `/key` derives every shipped type. The donor has no CSV export and no balance sorting, so neither is a gap. Ours adds the LTC Taproot card. `?key=` jumps to the containing page: `?key=0xdeadbeef` computes page 62,265,476. Stats are chain-shaped: Balance/Received/TX on UTXO chains, Balance/Active on account chains (`src/coordinator/mod.rs:1272,3336-3349,3382-3384`; `apps/site/site.css:1517-1519,1898-1901`; `apps/site/browse.js:156,411-416,578-602,906-945`; test `tests/coordinator_api.rs:1218`; detector `summary-grid-orphan` in `scripts/ui-audit.mjs`). Active counts addresses with balance, a completed tx, or a non-zero EVM nonce; Solana/Sui/Ton count only funded addresses. | local render; `src/coordinator/mod.rs:1181-1206`; `apps/site/browse.js:81-95,1105-1135`; `crates/rotor-wasm/src/derive.rs:466,579-591` |
| PKF `/private-keys/<chain>/<page>` | same | same | 60 keys/page, page N = keys (N−1)·60+1…N·60, same pager. | live 200 for `/private-keys/bitcoin/2` |
| PKF `/mnemonic-seeds` | `/mnemonic-seeds` | same | 18 chain cards. | live HTML |
| PKF `/mnemonic-seeds/<chain>` | same | same | 60 rows, 5 presets, 4 BTC type cards, `bits`/`path` controls, header `Private Key / Mnemonic \| Address \| BTC Balance` match. The row prints the full phrase (mono, ellipsis with the phrase in `title`) plus a 44px Copy mnemonic button, matching the donor's full-phrase layout; ours adds hex private-key copy. | local render; `apps/site/mnemonic-seeds.js:675-705` |
| PKF `/brainwallet` | `/brainwallet` | same | 18,890 passphrases · 315 pages · 60 rows/chain — identical counts to donor. | live title/HTML; `src/coordinator/mod.rs:2665` |
| PKF `/brainwallet/<chain>` | same | same | 60 rows, 18 tabs, pager. Ours adds Legacy/SegWit/Nested/Taproot tabs and 4 stats (superset). | local render |
| PKF `/brainwallet-generator` | same | same | Passphrase → SHA-256 → address, 18-chain selector (donor network dropdown), 1/3/5/10 addresses, Copy all and CSV — the donor calculator requirement is met. | live 200; local render; `src/coordinator/mod.rs:2944-3017`; `apps/site/brainwallet.js:380-503` |
| PKF `/bitcoin-puzzle` | `/bitcoin-puzzle` | partial | 160 rows, columns `# Status Address Range Balance TX Actions`, filters All 160 / Solved 83 / Unsolved 77, search, Detail/Random all match. Defaults to `Unsolved` like the donor (77 visible). | local render 160 rows; donor static filters |
| PKF `/bitcoin-puzzle/<n>` | `/bitcoin-puzzle/<n>` (canonical; `/detail` 301s here) | partial | Target, range, status, difficulty, keyspace, mempool links match; ours is richer. Missing: donor prints `Solution` (solved private key, e.g. #66 `000…2832ed74f2b5e35ee`) and a `Discuss` link; ours has neither. | donor capture `8b6bba26.html`; our `/bitcoin-puzzle/66` |
| PKF `/bitcoin-puzzle/<n>/random` | same | same | Random/sequential local search over the puzzle range; donor also scans in-page. | local render; live 200 |
| PKF `/richest/<chain>` | — | missing | No route: `/richest/bitcoin` and `/richest/ethereum` are 404. Donor has 100 rows, columns `Rank/Address/Label/Type/Balance/Actions`, summary `0 Exchanges, 0 Contracts, 100 Unknown`, filters All/Exchanges/Contracts/Unknown, `#addressSearch`. | live 404 vs donor 200, 100 rows |
| PKF `/downloads` | `/wallets` | partial | `/downloads` permanently redirects to `/wallets`. `/wallets` lists 6 per-chain rich-address datasets (BTC, ETH, LTC, DOGE, BCH, DASH) with `Download dataset` + `Request access`; donor lists 10 combined files (`.bin/.blf/.hex/.tsv`, Blockchair dump, brainwallet list) totalling 15.30 GB. | `src/coordinator/mod.rs:1072-1081`; donor table 10 rows; local `/wallets` |
| PKF `/vanity-generator` | `/vanity` | partial | Ours is a superset (6 chain/address types incl. Taproot/EVM/TRON/SOL, prefix + suffix, stats, recent matches); `/vanity-generator` permanently redirects to `/vanity`. | `src/coordinator/mod.rs:1072-1081`; local `/vanity` |
| PKF `/milk-sad` | `/milk-sad` | partial | Ours is a 10.5 KB explainer. Donor index has 18 chain cards and each child is a 60-row directory. | live HTML both |
| PKF `/milk-sad/<chain>` | — | missing | `/milk-sad/bitcoin` and `/milk-sad/ethereum` are 404; donor serves 60 key rows/page per chain. | live 404 vs donor 200, 60 rows |
| PKF `/tools` | `/tools` | ours-only | Donor `/tools` renders a 404 page inside 200; ours is a real calculator index. | live 200 donor body "404 Page not found" |
| PKF global search (Ctrl+K) | Ctrl+K dialog | same | 18 chain cards, per-address rows, HEX/WIF/Keypair/XRP/Mnemonic/Brainwallet chips, BIP39 passphrase + 1/3/5/10, Copy All + CSV, `N active chains • M active addresses`. Ours has an extra Auto-detect chip. | `apps/site/site.js:305-430`; local modal present on every page |
| PKF shell | shell | partial | Nav, breadcrumbs, theme toggle (injected) and search modal match. Footer added in batch 6: FAQ/Disclaimer/Donate/Docs/GitHub/copyright/version on every public content page (app/cabinet shells intentionally omit it). Nav differs: ours `Home/Directory/Seeds/Puzzle` inline with `Vanity/Milk Sad/Tools/Docs` behind More (Milk Sad is in the nav since the 2026-11-21 header patch) vs donor inline `Directory/Seed Phrases/BTC Puzzle/Mnemonic/Vanity/Milk Sad`; donor also has a full-width search trigger above content where ours opens the icon search dialog. | rendered local pages: one `.site-footer` on content routes, none on `/app`, `/run`, `/me`, `/cabinet`, `/cabinet/wallet` |
| secretscan `/Bitcoin_puzzle` | `/bitcoin-puzzle` | partial | Ours matches PKF's 7 columns; secretscan's table has `# Range Address Private key (Hex) Public key Solve date Balance` — missing solve date, published private key and public key columns on ours. | donor HTML `th` list; local puzzle table |
| secretscan `/Easy_bitcoin_transaction_online`, `/Easy_ethereum_transaction_online`, `/Easy_tron_trx_transaction_online`, `/Easy_bnb_transaction_online` | `/send`, `/send/bitcoin`, `/send/ethereum`, `/send/bnb`, `/send/usdt`, `/send/tron` | partial | Ours supports BTC/ETH/BNB/TRON + ERC-20, but testnet only (Bitcoin testnet, Sepolia, Chapel, Nile; mainnet rejected in code). Donor sends mainnet and adds USDT BEP20/TRC20/ERC20 and USDC ERC20. `/send/usdt` is a generic ERC-20 transfer builder on Ethereum Sepolia (the token contract is supplied by the user), not the donor's USDT presets; there is no USDC route. | `apps/site/send.js:6-9,82-103`; donor menu; local `/send` |
| secretscan `/Transaction_decoded_Bitcoin`, `/decode_ethereum_transaction` | `/tx/bitcoin`, `/tx/ethereum` | partial | Decode matches (legacy/SegWit; type 0/1/2). Donor also encodes and broadcasts and shows a mempool panel; ours is decode + JSON only. | local `/tx`; donor H1s |
| secretscan `/wallets` | `/wallets` | partial | Donor: 45 asset rows / 42 groups, columns `Rank/Pic/Ticker/Coin/Price $/24h volume/Address dump/Market Cap`, sortable, 25/50/100/105 select. Ours: 6 dataset cards only. | donor capture; local `/wallets` |
| secretscan `/scaner`, `/rent`, `/results` | — | missing | 404 on ours. No public server-side scanner, rental checkout or account found-key results; ours offers local `/bitcoin-puzzle` scans, `/run` leases and `/cabinet`. | live 404s |
| secretscan calculator family (`/PrivateKeyHex`, `/PrivateKeyWif`, …23 pills) | `/key/hex`, `/key/wif`, `/key/decimal`, `/hex-dec-bin`, `/public-key`, `/pubkey-add`, `/reconstruction`, `/keystore-parser`, `/tools` | partial | Same operations, one-shot results. Missing donor's 7 numbered intermediate steps per pipeline, per-field char counters, and the 360-coin `legacy_coins.json` prefix catalogue. | local `/tools`; donor docs §5 |

## Ranked backlog

1. **Key-page chain providers + USD total** — mostly DONE. XRP/SOL/SUI/TON and
   the Binance USD total are wired (`apps/site/key.js:2295-2302,2304-2474`);
   remaining: BCH/ZEC providers (Blockchair answers 430 without a key) from
   `apps/site/site.js:735-788`. Decision: whether those two stay explorer-only.
2. **`/richest/<chain>`** — L. New `apps/site/richest.js`, route + render in
   `src/coordinator/mod.rs`, top-100 ingestion. Decision: address dataset and
   labels (donor shows 100 "Unknown").
3. **`/milk-sad/<chain>` directory** — M/L. Extend `apps/site/milk-sad.js` and
   `src/coordinator/mod.rs`; 60 rows/page × 18 chains. Decision: generate the
   MT19937 corpus locally vs ship a list.
4. **`/downloads` combined datasets** — M. The `/downloads` → `/wallets` alias
   is DONE (`src/coordinator/mod.rs:1079-1081`); still to do: the combined files,
   `src/coordinator/wallets.rs` and `apps/site/wallets` copy. Decision:
   bandwidth, mirror size (donor 15.30 GB), licences.
5. **Puzzle data: solution key, solve date, pubkey, Discuss, default Unsolved** —
   S/M. `src/coordinator/puzzles.rs` (currently `solved: bool` only) and
   `apps/site/puzzle-browser.js:244`. Decision: publish solved private keys/dates.
6. **Accept donor key URL forms** — S, mostly DONE. 1–64 hex with an optional
   `0x` is padded to 32 bytes, and WIF/XRP/keypair forms return 200
   (`normalized_key_hex`/`is_key_value`, `src/coordinator/mod.rs:1659-1740`);
   remaining: free text should return 200 with a client-side invalid state.
7. **`?key=` jump to containing page** — DONE. `pageForHexKey`/`jumpToKeyPage`
   in `apps/site/browse.js:81-95,1105-1135` compute
   `(BigInt(key)-1n)/60n+1n`, clamp and navigate with `type`.
8. **Site footer** — DONE (batch 6). `site_footer()` in
   `src/coordinator/mod.rs` renders FAQ/Disclaimer/Donate/Docs/GitHub,
   copyright and the asset version on every public content page; the
   app/cabinet shells stay footer-free; styles in `apps/site/site.css`;
   detector `footer-presence`.
9. **LTC Taproot card** — DONE. `LTC_TYPES` now has four cards incl. Taproot
   (`src/coordinator/mod.rs:1181-1206`) and `ltc_p2tr` derives the bech32m
   `ltc1p` address (`crates/rotor-wasm/src/derive.rs:466,579-591`). The
   account-chain stats part is unchanged.
10. **Route aliases** — DONE. `/vanity-generator` → `/vanity` and `/downloads` →
    `/wallets` are permanent redirects in `redirect_target`,
    `src/coordinator/mod.rs:1072-1081` (unit-tested at 5737-5746).
11. **Secretscan transaction encode/broadcast + mainnet send** — L. Deliberately
    out of scope: mainnet signing is rejected by design. Only add decode-side
    mempool/encode if the product decision changes.
12. **Nav/search placement parity** — Milk Sad DONE (2026-11-21): every static
    header and `site_header()` carry `data-nav="milk-sad"` and
    `markNavigation()` maps the route, pinned by `site-nav-test.mjs`. The
    donor's full-width search trigger above content is deliberately not copied:
    our icon opens the same global-search dialog and the utility cluster is
    fixed at three controls (`docs/design-system/DESIGN-SYSTEM.md` §3.15).

## Verdict

By route, 19 of PKF's 21 compared rows resolve; 10 are substantively 1:1, 8 are
partial, 2 are missing and one (`/tools`) is ours-only. The catalogue core — directory
paging, mnemonic seeds, brainwallet corpus, puzzle list, global search — is
1:1, sometimes a superset (derivation controls, type tabs, local scanner,
extra calculators). Gaps: richest lists, combined download datasets, Milk Sad
chain directories and puzzle solution data are absent or thin; the key page
has the right anatomy and checks 14 of 18 chain groups with a USD total, but
LTC/BCH/DOGE/ZEC balances still show `—`. Intentional differences are
the derivation controls on `/key`, testnet-only sends, no mainnet signing and
the local-first model. What remains is mostly data and owner decisions
(rich-list labels, 15 GB mirrors, Milk Sad corpus, solved-puzzle keys), not
rendering code; the code-only items (the two route aliases, `0x`/short key
URLs, `?key=` jump, footer, LTC card) have shipped; keeping free-text key URLs
a 404 is a deliberate deviation, not open rendering work.
