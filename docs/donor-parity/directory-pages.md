# Donor parity: directory pages (`ref-site-a`)

2026-11-20. Method: `curl -sL -A "Mozilla/5.0"` for raw HTML, headless Chrome (`--dump-dom`, CDP for interaction/layout). `/key/<value>` is in `key-page.md`.

## 1. `/private-keys` and `/private-keys/<chain>`

**Overview** — HTTP 200, `<h1>Private Keys Directory</h1>`, no stats row. 18 `a.chain-card` in `div.row.g-3` (`col-6 col-md-4 col-lg-3 col-xl-2`), icon + name, href `/private-keys/<slug>`; SEO says "pages of 60 keys each".

**Per-chain shell** — 18 `.chain-tab`; `.page-info-text` = `Bitcoin keys page #1 out of #1.93E+75`, `.progress-bar` `0.0000%`. `.nav-bar` = First, Previous, Random, Next, Last. Random is an anchor to a random 78-digit page (`/private-keys/bitcoin/666514231444154769404630429259917136182736638744040330406431255634329758868`). `.page-jump` = Page + `#pageInput` (value 1) + Jump; Enter jumps. `jumpToPage()` strips non-digits, uses `BigInt`, clamps to `1..TOTAL_PAGE`.

**Pagination** — 60 rows/page; page *N* holds keys `(N-1)*60+1 … N*60`. `/private-keys/<chain>/<n>` (page 1 = `/private-keys/<chain>`); page count is a BigInt (BTC `1.93E+75`), Last/Random print full decimals.

**Table** — `div.keys-table` > `.keys-header` + `#keysContainer` with 60 `.key-row` (no `<table>`). Headers `Private Key | Address | BTC Balance` (chain icon before balance). Key cell: hex `a.private-key[href="/key/<64hex>"]` + copy. BTC/LTC/DOGE also render `.key-wif` lines `(c)` and `(u)`, each `a.wif-value[href="/key/<WIF>"]` + copy — 3 `/key/` links/row (180/page). ETH/TRON have one `/key/<hex>` link (60/page), no WIF. Address cell: `.address-item` explorer anchors + copy; UTXO `(c)/(u)`, account chains one. Explorers: blockchain.com, blockchair.com/{litecoin,dogecoin}, etherscan.io, tronscan.org. `.balance-info > .bal` gets `has-balance` plus a status icon.

**Chain differences**

| Chain | Stats | Type cards | Search placeholder | Rows |
|---|---|---|---|---|
| Bitcoin | `0 BTC`, `9.31234053 BTC`, `2273` | 4 | `HEX, WIF (5/K/L), or Brainwallet` | 2 addr + 2 WIF + hex |
| Litecoin | `0 LTC`, `3.57294396 LTC`, `55` | 4 (L/ltc1q/M/ltc1p) | `HEX, WIF (6/T), …` | 2 + 2 WIF |
| Dogecoin | `0 DOGE`, `74473.63638112 DOGE`, `117` | none | `HEX, WIF (Q/6), …` | 2 + 2 WIF |
| Ethereum | `0 ETH`, `Active 60` | none | `HEX or Brainwallet` | 1, no WIF |
| Tron | `10462.871291 TRX`, `Active 18` | none | `HEX or Brainwallet` | 1, no WIF |

Stats labels are Balance/Received/TX on UTXO chains and Balance/Active on ETH/TRON.

**Address types** — BTC/LTC only: `.address-type-selector` with four `.address-type-card` — `Legacy P2PKH · 1...`, `SegWit P2WPKH · bc1q...`, `Nested SegWit P2SH · 3...`, `Taproot P2TR · bc1p...` (LTC: L/M/ltc1q/ltc1p). `PKF.changeAddressType('segwit')` navigates `?type=segwit`, swaps rows (`1BgGZ9…` → `bc1qw508…`), toggles `active`, syncs `#searchType`. DOGE has no selector.

**Search bar** — `.search-bar` with `#searchInput`, optional `#searchType` select (BTC/LTC), button → `PKF.searchKey()`. Hint "Supports 64-char HEX, WIF (5.../K.../L...), or any text as brainwallet". Decoder: optional `0x` + 1–64 hex → pad 64; WIF `^[5KLT6Q][1-9A-HJ-NP-Za-km-z]{50,51}$`; Solana keypair; XRP secret; JSON byte array 32/64 → first 32 bytes hex; else SHA-256 of text. It does not open `/key/`: it navigates to the same path with `?key=<64hex>[&type=<non-default>]`. `?key=` jumps to the containing page: key 1 → `#1`, `0xdeadbeef` → `Bitcoin key page #62265476` (first row `…deadbeb5`), `hello world` → `?key=b94d27b9…`. No banner/highlight.

## 2. `/mnemonic-seeds/<chain>`

Controls: `#bitsSelect` `12 words (128 bits)` / `18` / `24` + Apply; `#pathInput` placeholder `m (master key)` + Apply; preset `.preset-btn[data-path]`. BTC presets: Master `m`, BIP44 `m/44'/0'/0'/0/0`, BIP84 `m/84'/0'/0'/0/0`, BIP49 `m/49'/0'/0'/0/0`, BIP86 `m/86'/0'/0'/0/0`. ETH adds MEW/Trezor `m/44'/60'/0'/0`; TRON only BIP44 `m/44'/195'/0'/0/0`. BTC has the four address-type cards; ETH/TRON none. Apply rewrites URL: `?bits=192`, `?preset=bip84`, `?type=segwit&preset=bip84`.

Table: header `Private Key / Mnemonic | Address | BTC Balance`, 60 `.key-row`/page (capture: 59 on BTC/ETH while one row derived, 60 on TRON). Rows carry `data-entropy/mnemonic/privatekey/address`; key cell = `Seed #N`, hex link `/key/<hex>`, full mnemonic; address `(c)/(u)` for BTC, one for ETH/TRON; lazy balance. Pagination as above; Last `5671372782015641057722910123862803525` (≈5.67E+36), Random is a JS button.

Sparse chain (Sui/XRP/Zcash): still 60 local rows, no empty state/banner; stats `Balance 0` + `Active 0` (Zcash also `Received 0 zat`, `TX 0`); an info alert says derivation is 100% in-browser.

## 3. Global search (`Ctrl+K`)

Trigger `.global-search-trigger`, `#walletSearchModal` (`modal-lg modal-dialog-scrollable`), 4-row textarea, placeholder "Enter private key, mnemonic, or any text (brainwallet)...". `INTERPRET AS` over six radio/label chips: Private Key (HEX), WIF Format, Keypair, XRP Secret, Mnemonic, Brainwallet. Mnemonic-only `#walletSearchMnemonicOptions` (hidden otherwise): BIP39 passphrase + select 1/3/5/10 (default 1). "Search All Chains" runs detection; results stay `d-none` until pressed.

Detection link: hex/WIF/keypair/XRP secret → `Key Details` → `/key/<value>` (hex lowercased); mnemonic → `Mnemonic Converter` → `/mnemonic-converter`; other text → `Brainwallet Generator` → `/brainwallet` (+ "Did you mean Private Key HEX?" for near-hex).

Inline results (key 1, ~12 s): 18 `.ws-chain-card[data-chain]`, 29 `.ws-address-item`. Card header: icon, `.ws-chain-name`, symbol, `.ws-chain-balance` (`0.00000000 BTC`), `.ws-chain-status` `Active`. Address rows: `#0`, type (`SEGWIT/LEGACY-C/LEGACY-U/TAPROOT`), explorer link, copy, balance, and `KEY` → `/key/<hex>`. Badge `HEX Private Key`; summary `17 active chains • 27 active addresses`. `Copy All` writes `=== Chain ===` blocks of `address<TAB>key`; `CSV` exports chain, index, address, privateKey, path.

## 4. `/bitcoin-puzzle` and `/bitcoin-puzzle/<n>`

List: `#puzzleTable.puzzle-table` with 160 `tr.puzzle-row[data-status][data-puzzle]`, all in DOM, no pagination. Columns `# | Status | Address | Range | Balance | TX | Actions`; range `2^0 → 2^1`. Filters `All 160 / Solved 83 / Unsolved 77`, **Unsolved active by default** (77 visible). `#puzzleSearch` "Search #, address..." filters client-side. Actions: Detail → `/bitcoin-puzzle/<n>`, Random → `/bitcoin-puzzle/<n>/random`; balances lazy (`data-address`).

Detail #66: `<h1>Bitcoin Puzzle Solved</h1>`; prev #65 + "Select Puzzle" dropdown #1–#160 with solved badges. `.puzzle-info-section`: Range Start, Range End, Target, Blockchain (Mempool), Solution (solved only). Actions: Browse Keys in Range → `/private-keys/bitcoin?key=<range start>`, Random Keys → `/bitcoin-puzzle/66/random`, Discussion. `/random` is a page (`<h1>Random Keys Solved</h1>`) with `#rangeStartInput`/`#rangeEndInput` prefilled.

## 5. `/richest/<chain>` and `/brainwallet/<chain>`

**Richest** — `<h1>Bitcoin Rich List</h1>`, "Top 100 richest BTC addresses"; 100 `tr.richest-row`, no pagination. Columns `Rank | Address | Label | Type | Balance | Actions`. Summary `0 Exchanges, 0 Contracts, 100 Unknown`; filters All/Exchanges/Contracts/Unknown; `#addressSearch` filters address/label client-side (`34xp` → 1 row). No sorting. Balance is lazy: raw `.balance-cell[data-address]` spinner → `248.60K BTC`; action is an explorer link, not `/key/`. Footer "Updated: 2025-12-15 | Source: bitinfocharts.com".

**Brainwallet** — `<title>Bitcoin Brain Wallets…`, no `<h1>`; page info `Bitcoin Brain Wallet page #1 out of #315 (18,890 passphrases)`. 18 chain tabs, 60 `.key-row`/page, no search; First/Prev/Random/Next/Last + jump (`/brainwallet/<chain>/<n>`). Stats Balance/Received/TX. Key cell: `HEX` + `/key/<hex>`, `Passphrase`, `WIF(c)`, `WIF(u)` (3 links); address `(c)/(u)`; lazy balances.

## 6. Mobile at 375px

`/private-keys/bitcoin`: `innerWidth=375`, `scrollWidth=367` (no overflow). Navbar collapses; `.keys-header` `display:none`; `.key-row` becomes `display:grid`, `grid-template-columns:309px`, `gap:4px` — key/address/balance stack. Stats 343px full-width; type cards 309px; search 343px; pager wraps. Overview: 2 cards/row, 163.5×95.6px. `/bitcoin-puzzle`: `.table-responsive` 343px with `overflow-x:auto`, `scrollWidth=736` — the 7-column table scrolls inside the wrapper; filters wrap; document `scrollWidth=384` (≈9px page overflow).

## What our pages must change

1. **Add `?key=` deep link.** Done (2026-11-21): `apps/site/browse.js`
   (`pageForHexKey` computes `(BigInt(key)-1n)/60n+1n` and clamps;
   `jumpToKeyPage` navigates only when the computed page differs), pinned by
   `apps/site/search-test.mjs` (`0xdeadbeef` -> page 62,265,476, clamping,
   non-hex/zero rejection). The puzzle detail link already uses the short
   canonical `/bitcoin-puzzle/<n>` URL.
2. **Both WIFs in the key cell.** Done (2026-11-21): `fillAddressCell` in
   `apps/site/browse.js` renders `.key-wif` rows labelled `(c)`/`(u)` linking
   to `/key/<WIF>` for every chain that exposes a WIF (BTC/LTC/DOGE); styles in
   `apps/site/site.css` (`.key-wif`, `.key-wif-prefix`). BCH/ZEC have no WIF
   link, as in the donor.
3. **Per-chain stats.** Done (2026-11-21): UTXO chains render Balance/Received/TX,
   account-model chains (EVM/Tron/Solana/Sui/XRP/Ton) render Balance/Active.
   Evidence: `src/coordinator/mod.rs:1272` (`AddressKind::is_utxo`), `:3336-3349`
   and `:3382-3384` (`summary_cards` in the `/private-keys/<chain>` body),
   `apps/site/site.css:1517-1519`
   (`.balance-summary--account`, two columns, collapsed by the mobile rule at
   `:1819`) and `:1898-1901` (the ≤560px phone-density block keeps three
   columns for three-card summaries and two for the account variant),
   `apps/site/browse.js:156,411-416,578-602,906-945`
   (`totalActive`, `setSummary` 4th arg, active counting in `renderSummary`,
   best-effort `eth_getTransactionCount` batch in `evmProvider`),
   `tests/coordinator_api.rs:1218`
   (`private_key_pages_shape_summary_cards_by_chain_model`). The
   `summary-grid-orphan` detector in `scripts/ui-audit.mjs` (ledger entry
   `docs/process/defects.json`) fails any summary whose card count does not
   fill its computed column count; it caught the empty third cell at 375px
   before the ≤560px fix.
4. **Search controls.** Done (2026-11-21): `apps/site/site.js`
   (`SEARCH_CHIPS`, the `#global-search-chips` group built from it) replaces the
   mode select; the BIP39 passphrase and 1/3/5/10 count live in the hidden
   `#global-search-mnemonic` block and are unhidden only when the selected mode
   is `mnemonic` (`site.js` `mnemonicEl.hidden = selectedMode !== 'mnemonic'`).
   Auto-detection stays the default (`apps/site/search.js`, `detect`).
5. **Search results as cards.** Done (2026-11-21): `buildCard` in
   `apps/site/site.js` renders `article.ws-chain-card` per chain with per-address
   rows, name/symbol/balance and an `Active` status; the summary line renders
   `N active chains • M active addresses`. The cards are the only rendering —
   there is no separate table view.
6. **Split Copy All from CSV.** Done (2026-11-21): `apps/site/site.js` — Copy All
   calls `RotorSearch.cardsToTsv` (`apps/site/search.js`), Copy CSV calls
   `cardsToCsv` (`apps/site/search.js`) and exports public fields only.
7. **Mnemonic URL contract.** Done (2026-11-21): `directoryQuery` in
   `apps/site/mnemonic-seeds.js` emits `bits` and `preset`, omits the default
   `bits=128`/address type, and falls back to `path` only for a custom path.
8. **Mnemonic presets as chips.** Done (2026-11-21):
   `apps/site/mnemonic-seeds.html` (`#mnemonic-path-presets`) and `renderPresets`
   in `apps/site/mnemonic-seeds.js` render `.preset-btn.chip` buttons with
   `aria-pressed`; no preset select remains.
9. **Show the full mnemonic.** Done (2026-11-21): `apps/site/mnemonic-seeds.js`
   (`col-mnemonic`/`mnemonic-text`: the full phrase in `textContent` and in
   `title`) plus a `Copy mnemonic` icon button.
10. **Puzzle defaults/URL.** Done: default filter is Unsolved, `/bitcoin-puzzle/<n>` is the canonical detail URL (links, JSON-LD and sitemap updated), and `/bitcoin-puzzle/<n>/detail` permanently redirects (301) to it.
11. **Add `/richest/<chain>`.** **Blocked:** the repo has no licensed ranked
    top-100 dataset (only gzip download mirrors, `src/coordinator/wallets.rs`),
    so the donor's ranks, 100 `Unknown` labels and balances cannot be
    reproduced. Nothing is faked; the row stays open until a dataset/API is
    chosen by the owner.
