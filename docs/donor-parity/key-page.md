# Donor parity: `privatekeyfinder.io/key/<value>`

2026-11-20. Method: `curl -sL -A "Mozilla/5.0"` for HTTP/HTML; headless Chrome via CDP for post-JS DOM, `location.href`, computed styles at 375px; obfuscated bundle string tables decoded. Read-only; no forms submitted.

## 1. Route model

All inputs return HTTP 200; errors are client-side. Page title is constant: "Private Key Details - All Addresses & Formats". `<link rel="canonical">` and `og:url` echo the raw path verbatim.

| Input | Badge | Renders | Final URL |
|---|---|---|---|
| 64-hex `000…001` | `HEX` | full | unchanged |
| Uppercase 64-hex | `HEX` | full (regex `i`; internal value lowercased) | unchanged |
| Decimal `1`, `0x1` | `HEX` | full (1–64 hex chars padded to 64) | unchanged |
| WIF `KwDi…`, `5Hue…` | `WIF` | full | unchanged |
| Solana keypair base58 | `Solana Keypair` | full | unchanged |
| XRP secret `pBsh…` | `XRP Secret` | full | unchanged |
| Brainwallet text | none | error `Invalid Key` / `Invalid key format`; content `d-none` | unchanged |
| 12-word mnemonic | none | same error | unchanged |
| Out-of-range hex | `HEX` | error `Key out of valid range` | unchanged |

CDP `location.href` equals the requested URL for hex, WIF, XRP secret and text; no `history`/`replaceState`/`pushState` in any bundle. `generate()` order: WIF `/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/` → XRP secret → Solana keypair → hex `/^(0x)?[0-9a-fA-F]{1,64}$/` → error. Only the search modal canonicalizes (lowercases hex when building its link).

## 2. Key page anatomy (in order)

Breadcrumb `Home › Key Details`; `<h1 class="kd-header"><code>{input}</code><span class="kd-badge">…</span></h1>` — input shown verbatim.

**Stats** — `.kd-stats`, four cards: `Total Value`, `Has Balance`, `Active`, `Checked` (DOM capitalisation; CSS uppercases).
- `Total Value` = Σ(balance × USD), e.g. `$3,339.72`; card gets `has-value`.
- `Has Balance` = unique chain groups with balance (key `1`: 6).
- `Active` = unique chain groups with balance or activity (key `1`: 17).
- `Checked` = `chainsChecked + '/' + totalChains`, decoded `totalChains: 0x12` (=18). Server HTML ships stale `0/14`; JS renders `18/18`. Numerator increments once per chain check, including failures.

**Keys** — `<table class="kd-tbl">`, eight rows, exact labels: `HEX`, `Decimal`, `WIF`, `WIF (u)`, `Keypair (SOL)`, `Secret (XRP)`, `PubKey`, `Page`. Values are `<code>` + hover-revealed copy button. `Page` links to `/private-keys/bitcoin/<ceil(decimal/60)>`, text locale-formatted (`1 303 124 892` for `0x1234567890`).

**Addresses** — real `<table class="kd-addr-tbl">` with `<thead>` and `<tbody id="addressList">`, 30 rows, columns `Chain | Type | Address | Status |` (last header empty). Chain cells use `rowspan`: BTC 5, LTC 4, BCH 2, DOGE 2, TON 2, ZEC 2. EVM is one `0x` row plus eight chain rows (`ETH, BNB, POL, ARB, OP, BASE, AVAX, zkSync`) with italic `↑ same` address. Address is `<code>`, not a link; actions = explorer `<a target="_blank">` (29) + copy `<button>` (22; EVM sub-rows none).

**No per-address WIF.** Address-table HTML contains zero "wif" occurrences; CDP WIF query inside `.kd-addr-tbl` returns 0. WIF text exists only in Keys (compressed and `(u)`, copy-only, no anchor). Bottom warning: "Never use keys from this site for real wallets. Educational purposes only."

## 3. Derivation controls

None on the key page: zero `<input>`/`<select>`, no path editor, no tabs. Legacy/SegWit/P2SH/Taproot and CashAddr/Legacy are fixed rows. Address-type choice belongs to directory pages: `/private-keys/bitcoin` has a page-level "Bitcoin Address Type" card selector (`Legacy / SegWit / Nested SegWit / Taproot`) above its keys table plus a search-type `<select>`; `/mnemonic-seeds/bitcoin` has `<input id="pathInput">` (BIP-32) with presets and its own type cards. Nothing sits beside the key page's address table.

## 4. Balance/status model

Per address: balance plus activity signal (tx count / `wasUsed` / EVM nonce as statuses). EVM batches one `eth_call` to helper `0xDe3d4d3BdF0a0d948AA3CD030E77120d49f9955d` (`balances(address[],address[])`); RPCs from `/assets/data/rpcs.json` (DefiLlama chainlist). Other chains: `blockchain.info/balance?cors=true&active=` (BTC), TronGrid/Tronscan, `tonapi.io/v2`, `fullnode.mainnet.sui.io`, Chainz + Tatum (LTC), Haskoin + `/api/bch`, BlockCypher/Tatum/DogeBlocks (DOGE), and same-origin `/api/solana`, `/api/solana-activity`, `/api/xrp`, `/api/zec`. Balances are mostly third-party; only Solana/XRP/ZEC/BCH go through their own `/api/*`.

USD prices come from `https://api.binance.com/api/v3/ticker/price?symbols=[…]`, cached in `localStorage.pkf_prices` for 6 h, with hardcoded fallbacks.

Status states: green amount (full precision in `title`, e.g. `10343.145665`, displayed `10343.15`); amber check for active/no balance; `-` for checked-empty; red `!` on error; spinner pending. Row tints: `has-balance`, `is-active`. All 18 chain groups have a provider; a failure shows `!`, there is no separate "no provider" state.

## 5. Search mechanics

A modal, not a page: `.global-search-trigger` ("Search key, WIF, mnemonic across 18 chains", `Ctrl+K`) opens `#walletSearchModal` (`modal-lg modal-dialog-scrollable`) with a 4-row textarea. Auto-detect, then "Interpret as" chips: `Private Key (HEX) | WIF Format | Keypair | XRP Secret | Mnemonic | Brainwallet`. Mnemonics add BIP39 passphrase and address-count select (1/3/5/10).

Detect → View link: 64-hex → `/key/<lowercased hex>` ("Key Details"); WIF → `/key/<wif>`; keypair → `/key/<keypair>`; XRP secret → `/key/<secret>`; mnemonic → `/mnemonic-converter`; any other text (including `1`) → "Brainwallet (SHA256)" → `/brainwallet` (plus "Did you mean Private Key HEX?" for `1`).

Results render inline: 18 `.ws-chain-card`s with chain name/symbol, balance, status "Active", and address rows (`#0`, type, explorer link, copy). Every key/WIF/keypair value is wrapped by `keyLink(v) = baseUrl + '/key/' + v`, so hex cards link to `/key/<64-hex>`. Header actions "Copy All" and "CSV"; summary "17 active chains • 27 active addresses".

## 6. Directory pages (differences only)

`/private-keys`: chain-card grid linking to per-chain directories.

`/private-keys/bitcoin`: stats (Balance/Received/TX), global address-type selector, search bar (HEX/WIF/Brainwallet + type select), pagination, 60-row `Private Key | Address | Balance` table; key cells link to `/key/<hex>`.

`/mnemonic-seeds/bitcoin`: word-count select, BIP-32 path input + presets, address-type cards, 60-row `Mnemonic | Key | Address | Balance` table.

## 7. Mobile at 375px

CDP: `innerWidth=375`, `scrollWidth=375` (no overflow). `.kd-stats` becomes two columns (`172.5px 172.5px`); `.kd-tbl` computes `display:block` and stacks (label + copy on line one, value full-width below); `.kd-addr-tbl` remains `display:table` at 349px in a 351px container with all five columns and smaller fonts; h1 wraps. Navbar collapses below 1200px; search trigger stays full-width above content. No derivation control exists to reach; the address list is still below the Keys table.

## Differences we must copy (by impact)

1. No per-address WIF link/column; WIF only in Keys (compressed + `(u)`, copy-only).
2. One flat address table: Chain | Type | Address | Status | actions, rowspan grouping, EVM "↑ same".
3. Key page has no derivation/address-type controls; all types always rendered as rows.
4. `Checked` = `chainsChecked/18` (constant denominator); Has Balance/Active count unique chains, not rows.
5. Status vocabulary: green amount w/ full-precision `title`, amber check, `-`, `!`, spinner, row tints.
6. Stats order and exact labels.
7. Eight-row Keys table incl. `WIF (u)` and Page → `/private-keys/bitcoin/<ceil(decimal/60)>`.
8. No URL canonicalization; every input form renders in place, input echoed verbatim, HTTP 200 even when invalid.
9. Client-side detection (WIF regex, XRP secret, Solana keypair, optional-0x 1–64 hex, pad/lowercase) with badge.
10. Progressive client-side generation: skeleton spinners, then rows fill.
11. Global Ctrl+K modal: detect → View link `/key/<value>` (hex lowercased), mnemonic/brainwallet routing.
12. Inline search results as per-chain cards with balances, Copy All/CSV, activity summary.
13. Prices from Binance ticker, 6 h cache, hardcoded fallbacks.
14. Per-chain sources incl. same-origin `/api/{solana,solana-activity,xrp,zec,bch}` and batched EVM `eth_call`.
15. 375px: 2×2 stats, stacked Keys, intact 5-column address table, zero overflow.
