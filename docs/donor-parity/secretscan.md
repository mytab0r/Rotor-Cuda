# Donor audit: ref-site-b — lists, pricing, check/search

2026-11-20. Method: `curl -sL -A "Mozilla/5.0"` for server HTML/CSS/JS; headless Chrome 157.0.8103.79 (`C:\Program Files\Google\Chrome\Application\chrome.exe`) driven over CDP for post-JS DOM and computed layout at 1280px, 980px (the site's phone layout width — see §6), and a forced 375px CSS viewport; declared viewport size vs. layout viewport recorded via `visualViewport`. Scope: public pages only.

**Mechanics only, no data copied, no access-control bypass.** No key, seed, address, balance, market or paid-list rows are reproduced. No forms were submitted; every POST-only endpoint (`box/box.php`, `script/offer_order.php`, `script/scaner_job_new.php`, `script/download_explorer.php`) was read from its caller, not called. The site was reachable and did not block automated access; there was no block to work around.

Citation convention: selectors in backticks come from server HTML or the CDP DOM; `searchable.js`, `sort_new.js`, `rent.css`, `results.css`, `scaner.css`, `wallets.css` are the public assets fetched from the same pages; inline-script citations are the page's own `<script>` blocks. Measurements marked `CDP` are `getComputedStyle` / `getBoundingClientRect`.

Surfaces and routes:

| Surface | Route | Role |
|---|---|---|
| Dataset index | `/wallets` (nav label `Addresses`) | coin/asset list with per-row dataset purchase action |
| Records list | `/results` | per-account found-key table (empty when logged out) |
| Pricing | `/rent` (alias `/rent.php`) | single-plan capacity calculator |
| Check/search | `/scaner` | private-key range scanner |
| Secondary check | `/PrivateKeyHex`, `/PrivateKeyWif`, `PubkeyAdd`, `Reconstruction`, … | step-by-step calculators |
| Gated shells | `/dashboard`, `/programs` | zeroed dashboard / download page |

No `<link rel="canonical">`, no `<meta name="robots">` and **no `<meta name="viewport">`** on any audited page (`grep -ic 'name="viewport"'` = 0 on `/`, `/wallets`, `/results`, `/rent`, `/scaner`, `/PrivateKeyHex`, `/dashboard`).

---

## 1. `/wallets` — dataset index ("Addresses")

**Route / title.** HTTP 200. `<title>` = `Cryptocurrency Address Database - Download Active Wallets with Balances | SecretScan.org`. `h1` = `Cryptocurrency Address Databases for sale`. Subtitle `h2` is a keyword list (`Cryptoaddress databases, active wallet lists, …`). Nav item `Addresses` carries `.grid-item.active`.

**Grouping.** One table, `table#t2.coin-table.qwe.js-searchable`, with **42 `<tbody class="coin-group" data-symbol="…">` groups and 45 asset rows** (`tr[data-symbol]`). A group is one ranked entity; variants share the entity's rank via `rowspan`:

| Shared cell (leader row) | Variant rows |
|---|---|
| `.col-rank` (rowspan 2–4) | `.col-name` (asset name) |
| `.col-pic` (`img.coin-image`, 24×24) | `.col-addr` (`label.generate` → `Buy rich list`) |
| `.col-ticker` | |
| `.col-price` | |
| `.col-vol` | |
| `.col-cap` | |

Examples (`HTML: tbody.coin-group`): Bitcoin = 2 rows (`Bitcoin`, `Bitcoin PublicKeys`); Tether = 3 rows (`Tether ERC20`, `Tether BEP20`, `Tether TRC20`) under one rank; Ethereum/BNB/XRP = 1 row each.

**Exact columns** (`thead th`, left to right):

1. `Rank` — `th.sortable.col-rank` `data-type="number"`
2. `Pic` — `th.col-pic`
3. `Ticker` — `th.col-ticker`
4. `Coin` — `th.sortable.col-name` `data-type="string"`
5. `Price $` — `th.sortable.col-price` `data-type="zero"`
6. `24h volume k$` — `th.sortable.col-vol` `data-type="zero"`
7. `Address dump` — `th.col-addr`
8. `Market Cap k$` — `th.sortable.col-cap` `data-type="zero"`

Five sortable columns; `Pic`, `Ticker` and `Address dump` are not sortable. Sort indicators are two CSS triangles (`.sortable::before/::after`, `opacity .3`; `.sort-asc`/`.sort-desc` raise one triangle to `opacity 1`).

**Sort mechanic** (`js/sort_new.js?v=6`). Click on any `TH`; sorts the array of `<tbody>` elements, **not rows**, so variants stay attached to their leader. `order *= -1` per click; a click in a different column resets to `-1`; classes `sort-asc`/`sort-desc`; comparators per `data-type`: `number` (`parseFloat`), `string` (tag-stripped text), `zero` (strip whitespace, `parseFloat`, treat 0/empty as 0), `date` (`dd.mm.yyyy`). CDP-verified: first click on `Coin` produced descending order, second click ascending.

**Search mechanic.** `input.js-searchable-input` (`placeholder="Search..."`, width 230px, height 32px) + `js/searchable.js`: on `keyup` it hides every `tr` in `.js-searchable`, then shows rows whose text contains any whitespace-separated token (case-insensitive `:contains`). Consequences, CDP-verified:

- Searching a term that matches one group leaves only that group's rows visible (e.g. three Tether rows); the leader's `rowspan` cells are hidden with it, so the surviving variant rows show name + action only.
- Input is cleared on first focus (`this.value = ""; $(this).unbind('focus')`).
- **No result count and no empty state.** A no-match query hides all 45 rows; the table collapses to its header height (32px) with no message.
- Filtering is client-side over the rendered page only; it does not query the server.

**Pagination / density control.** Only a page-size select: `select#group` with options `25` (value `25`), `50` (value `50`), `100` (**value `105`**), default `105`. `onchange="auto_grow()"` navigates to `/wallets.php?page=<value>` (a full navigation, not fetch). `page()` then re-selects the option by matching the value against `location.href`; CDP-verified on `?page=25` the select shows 25 and 25 groups render. There are no page numbers, no next/prev, no total count. `?page=50`, `?page=100`, `?page=105` all return the same full 45-row page; `?page=999`, `?page=abc`, `?page=0` return HTTP 200 with the full list (no error state).

**Row action / what is gated.** Header says `Address dump`; the cell contains `<label class="generate"><input type="radio" name="buysell" value="<symbol>" hidden><span>Buy rich list</span></label>`. Inline handler: click → `$.ajax({type:'POST', url:'box/box.php', data:{buysell: value}})` → response HTML injected into `div#mistake` (`css({color:'#CCC', display:'contents'})`). There are **36 actions across 45 rows**; 9 groups have no purchase action (`Solana`, `Monero`, `Cardano`, `Toncoin`, `Wrapped BNB`, `PancakeSwap`, `TrueUSD`, `Basic Attention Token`, `Decentraland`). What the injected widget contains (price, plan names, download formats) is **unverified** — it is POST-only and was not requested.

**Density (CDP).** `wallets.css`: `td{height:34px; padding:4px 0}`; `th{padding:20px}`; `font-size:14px`; `.coin-image{24×24}`; `.generate{font-size:12px; padding:6px 12px; border-radius:4px}`; row hover `#25262a`. Measured table: 1280px → 1000×1593px (≈35px/row); 980px → 940×1602px.

**Empty/error states.** None. No search-empty message, no error page, no "0 results" row.

---

## 2. `/results` — found-key records list

**Route / title.** HTTP 200 while logged out. `<title>` = `Results | Rent Results & Earn SSC Tokens | Multi-Crypto Support (ETH, BCH, KCS, MANA & More) | SecretScan`. `h1` = `Results`; `h2` = `Supports ETH, USDT, BNB, TRX, DOGE, BCH, LTC, ZEC and more`.

**Top bar.** Left: `0 records found` (server text). Right: two selects —
- `select#group` — coin filter; in the empty state a single option `no data available` with `value=''`; `onChange=''`. The page's own JS expects option **values to be URLs** (`auto_grow2(){ if (sel.value) window.location.href = sel.value }`) and expects coin chips `#all` / `#<coin>` with `buttons_found` / `buttons_found_activ` classes.
- `select#group2` — page size `5`, `25` (selected), `50`, `100`; `onChange="auto_grow3()"` sets `?on_page=<n>` on the current URL.

`auto_grow()` in the same bundle reads `#coin`, `#sorting` and `#column`, which do not exist in the empty DOM; that path is dead/unverified for the populated state.

**Table.** `table.table.table-bordered` (14px). Exact header cells, left to right:

| # | Header | Width | Sort |
|---:|---|---|---|
| 1 | *(empty)* | 50px | no |
| 2 | `Latest Time` | — | `▼` → `results?sorting=desc&column=ddate`, `▲` → `?sorting=asc&column=ddate` |
| 3 | `Coin` | 50px | no |
| 4 | `%` | 50px | `▼`/`▲` with `column=percent` |
| 5 | `Key` | 50px | no |
| 6 | `Found Address / Search Address` | — | no |
| 7 | *(empty)* | 50px | no |

Only two columns are server-sortable; each arrow is a plain `<a class="sort" href="results?…">` GET link. `%` is the match percentage; the page explains `40-100% coincidences` and the "share" concept below the table.

**Empty state (the only state observable without an account).** One row: `<td colspan='10' style='…text-align:center…'>no data</td>`, plus `0 records found` and the `no data available` option. HTTP 200; `?page=2` is identical. Populated row anatomy (where Key/address text, per-row copy, coin icon, and pagination links appear) is **unverified** — the table is account/session data.

**Pagination.** No pager is emitted in the empty state. `results.css` defines `.pagination`, `.pagination a`, `.pagination b` (7px 14px padded current page with border), so numeric pagination is expected when rows exist; **unverified**.

**Actions.**
- `button#download_csv_button` `Download` (SVG icon + label) → `downloadCSV()` builds a hidden form and POSTs `hash=''`, `action=download_csv` to `script/download_explorer.php`. Filename/CSV columns not observed.
- `button#delete_button` `Delete all` → `confirm('Are you sure you want to delete all entries? This action cannot be undone.')` then POST `action=delete_all`; JSON `result` written into `div#result` (red).
- Retention note: `Data is stored for 1 year. To ensure its safety, please save it to prevent deletion.`

**Density (CDP).** `results.css`: `.qwe td{padding:8px; border-bottom:.5px solid}`; `.qwe th{padding:5px}`; table font 14px. Empty table: 1000×108px at 1280, 940×108 at 980. Buttons 31px tall (below the 44px touch minimum).

---

## 3. `/rent` — pricing / plans

**Route / title.** HTTP 200; `/rent.php` returns the same page. `<title>` = `Private Key Search - Rent Massive Computing Power | SecretScan.org`. `h1` = `Rent SecretScan to search your private keys`; `h2` describes renting a server and storing results privately in the account.

**Shape: one calculator, no plan matrix.** There are no plan cards, tier names, feature-comparison columns or "most popular" badges. The whole offer is a single card: `div.swap_1` (`rent.css: max-width:600px; border-radius:10px`), a 510px-wide decorative `img[src="img/12_2.svg"]`, then one `form#form1`:

| Control | Selector / exact label | Behaviour |
|---|---|---|
| Quantity stepper | `.number-input-container`, buttons `.minus-btn` `-` and `.plus-btn` `+`, `input#packs` | clamp `1…999` (`Math.max(1,…)`, `Math.min(…,999)`); default `1` |
| Coin amount | `input#pay` | editable price in the selected coin; `onblur` triggers recalc |
| Payment coin | `select#coin` | exactly `Bitcoin BTC` (1), `Ethereum ETH` (2), `Litecoin LTC` (3), `USDT TRC20` (4), `USDT BEP20` (5, default), `USDT ERC20` (6), `USDC ERC20` (7) |
| USD equivalent | `.usd` `≈<span id='usd'>0</span> USD` | 12px muted text; initial markup `0`, filled on load |
| Capacity | `Total private keys will be checked in 7 days:` + `#total_checked` | default markup is `100.000.000.000.000` (one pack = 10^14 keys / 7 days, dots as thousands separators) |
| Order | `button#submit_order` `Order Now` | sets `action=order`; form submit is `preventDefault`ed |

Defaults are written by the page's inline `$(document).ready`: packs `1`, coin `5`, a server-set coin price in `#pay`, the same figure in `#usd`, and the 10^14 capacity. The **price values themselves are not reproduced here** (task constraint on pricing tables).

**Recalculation / gating.** Quantity input, coin change and price `blur` each POST the serialised form to `script/offer_order.php` with `action=packs|pay|coin`. The response is JSON with one of four shapes, and the handler picks a UI state:
- `mistake` → `#mistake` gets `.status-active` (red translucent alert);
- `order` → `.status-order` (grey) and hides `Order Now`;
- `payment` → `.simple-magic-btn` (purple gradient) and hides `Order Now`;
- otherwise → overwrite `#packs`, `#pay`, `#usd`, `#total_checked` (the normal price refresh).

So the only gated step is the actual order/payment; browsing and pricing are public. The response bodies were **not observed** (no form submitted).

**What else is gated on the site.**
- `/wallets`: 36 `Buy rich list` actions fetch a per-asset purchase widget (`box/box.php`, POST) — **unverified**.
- `/results`: public shell, account/session rows.
- `/dashboard`: public zeroed shell (Speed/Blocks today/Shares today/Blocks-shares/Rigs/Graphic cards/Reward today/Uptime/Mode, then `Rigs name | Uptime | Last share | Day share | Graphic card(s) | # | Speed | Temp | Fan`); data requires the desktop client's `-user YourLogin.RigName`.
- `/programs`: public download page (version, SHA-256, install steps); no price.

**Density / responsive.** Inputs 32px tall (packs 110px, pay 190px, coin 200px); buttons 32px; `.usd` 12px. `.swap_1` max-width 600px; `.status-active` `.status-order` `.status-payment` share `padding:10px 20px; margin-left:15px` and `display:none` until filled.

---

## 4. `/scaner` — check/search surface

**Route / title.** HTTP 200. `<title>` = `Online Private Key Scanner | SecretScan.org`. `h1` = `Online Private Key Scanner`; `h2` includes a `span.badgev` `100+`.

**Stat cards** (`div.cards > div.card_info`, 4 cards; CDP 218.5×80px each at 980/1280, one row):

| # | Exact label | Element |
|---:|---|---|
| 1 | `Number of checks` | `p#inquiries` |
| 2 | `Addresses database (bn)` | `p#difficulty` |
| 3 | `Coins` | `p#generated` (server value `106`) |
| 4 | `Range` | `p#range` (initial `-`) |

**Progress strip.** `div#progress` is a 20-tick ruler (`div.vl1` per 16 ticks) labelled `1` … `2^256`, with the hint `The strength of each generated private key is shown in the table below`.

**Input form** (`form#form1`, inside a borderless `table.qwe`):

| Control | Selector | Notes |
|---|---|---|
| Private key | `input#private_key.priv_key` (text, 36px tall) | prefilled with a 64-hex placeholder value; label `Private key (hex or wif) 🔑 → WIF Converter`; `onkeyup="keyDownFunc(this.id)"` strips every non-alphanumeric character; live character counter `#private_key_char` |
| Hidden token | `input#channels` | per-page base64 token used as the Centrifuge channel |
| Calculate | button `Calculate` (`action=6`) | submits via AJAX, `event.preventDefault()` |
| Step key | `-1` (`action=1`), `+1` (`action=5`) | with `Calculate` in the first row |
| Range actions | `Random Start` (3), `Start -1` (2), `Start +1` (4), `Stop` (`#stop`, 7) | second row |
| Puzzle range | `select#puzzle` | **162 options**: `Full range` (value 0), `Puzzle range` (161), then `1 puzzle range` … `160 puzzle range` (values 1–160) |

Submit handler POSTs `form#form1` to `/script/scaner_job_new.php`, shows `#spinnerContainer`, parses JSON and writes `data.info` into `#info`. The body of that `info` HTML is **unverified** (no form submitted).

**Live result anatomy** (from the page's Centrifuge subscription, no submission needed). `new Centrifuge('wss://scaner.ref-site-b:443/connection/websocket')`, `setToken(...)`, `subscribe(<#channels value>, …)`. Each message updates:
- `#server` (`message.data.start`),
- `#inquiries` (`message.offset * 16`, thousands set with commas),
- `#progress` (`innerHTML = message.data.progress` — the ruler is replaced live),
- `#private_key` (`value = message.data.private_key`),
- `#range` (`message.data.range`),
- on a hit: `#found` gets `<strong>You found key (Hex): </strong> ` + the key, and its class switches from `hidden` to `hidden_found` (`display:block; background:#2c3a88; padding:10px 20px; color:#fff; font-family:Consolas`); all `.stylebutton` inline styles are cleared and `#stop` is highlighted.

`#info` is hidden again as soon as a live message arrives. Containers `#found`, `#info`, `#server` are empty in server HTML.

**Copy/export.** None on `/scaner`: no copy button, no CSV/export. The only copy affordance on the site's chrome is the footer e-mail `copyemail()` (`document.execCommand('copy')`, flips the label to `ok!` for 2s).

**Density / responsive.** `.priv_key` height 36px; buttons 36.39px tall (`input_ss` has `padding:8px 22px 38px`, `.input_ss2` `height:1.7em`); `.calcul_4` labels 12px. At 980 the four cards stay one row; at a forced 375 CSS viewport they reflow to 2 × 103.7px + one full-width 335px card, and the table becomes 335px wide with no overflow.

---

## 5. Secondary check surfaces — step calculators

`/PrivateKeyHex` and `/PrivateKeyWif` are representative of a 23-item calculator family.

**Shared sub-nav.** `div.container.menu_calculators` holds 23 `a` pills: `Legacy address`, `SegWit Base58`, `SegWit Bech32`, `Taproot P2TR`, `Ethereum`, `USDT TRC20`, `Tron`, `Ripple XRP`, `BNB`, `Solana`, `Monero`, `Ton`, `Hex <-> Wif`, `Wif <-> Hex`, `Brainwallet`, `Mnemonic`, `Hex<->Dec<->Bin`, `Reconstruction`, `PublicKey`, `Add public keys`, `Converter Bitcoin Cash`, `Bitcoin transaction`, `Ethereum transaction`. The active item is a non-link `<a style='background:#3d4085;cursor:default;box-shadow:0 0 5px #000;'>`. At 980 the strip wraps to 3 rows (123px); at forced 375 it wraps to 410px.

**`/PrivateKeyHex`.** `h1` = `Wallet Address Generator: <span.container_name> P2PKH Calculator`. Input `textarea#private` with label `Private key Hex (64 characters [0-9A-F]) 🔑` + `#private_char` counter; actions `Calculate`, `Generate` (random), `Clear`; a `select[name=taskOption]` (`+`, `-`, `×`, `÷`, `mod/2`) with `input[name=calc]` for arithmetic on the key; a coin `select#group` and a prefix row.

Results are two side-by-side `div.calculator` pipelines — `Uncompressed address legacy (P2PKH)` and `Compressed address legacy (P2PKH)` — each numbered 1–7 with its own `Calculate` button:

| Step | Fields (exact labels) |
|---:|---|
| 1 | `Public Key` (130 chars, `04 + x + y`) / compressed `02|03 + x` (66 chars) |
| 2 | `SHA-256` |
| 3 | `Prefix` + `RIPEMD-160` |
| 4 | `SHA-256` |
| 5 | `SHA-256` |
| 6 | `Prefix` + `RIPEMD-160` + `Checksum` |
| 7 | `Uncompressed address - Base58 encoding` / `Compressed address - Base58 encoding` |

Every field shows a character counter (`#<id>_char`). Each `Calculate` POSTs the form to `calculators/hex_new.php`; the JSON fields are mapped back by `info(data)` with field aliases. WIF inputs/outputs (`#private_wif_uncompressed`, `#private_wif_compressed`) have their own `Calculate` buttons. Final addresses are `<input>`/`div.field` coloured (`#5099ab` / `#618e56`), **not** copy buttons; there is no export.

**`/PrivateKeyWif`.** `h1` = `Private Key Format Converter: HEX to WIF & More`. `input#private` + `Calculate`, `-1`, `+1`, `Generate`, `Clear`; `input#prefix`; the output pipeline `prefix+key → SHA-256 → SHA-256 → Checksum → WIF`, with `input#wif_uncompressed` and `input#wif_compressed` (500px wide) each followed by a `Decode` button (`action=keyWIF` / `keyWIFcompressed`). Char counters throughout; no copy/export.

---

## 6. Responsive behaviour (global)

The site is **not mobile-adapted**: no viewport meta is present, so at a 375px device width Chrome lays the page out at `innerWidth = 981`, `visualViewport.width = 980`, `scale = 0.3827` — the desktop page is simply zoomed out. CDP confirmed the same 980px layout for `/wallets`, `/rent`, `/scaner`, `/results` and `/PrivateKeyHex`, with `document.documentElement.scrollWidth = 980` (no overflow at the layout viewport, but everything renders at ~38% physical size).

Consequences at a real 375px phone:
- 14px table text renders at ~5.4 physical CSS px; 32–36px buttons at ~12–14px.
- Nav becomes two rows at ≤1100px: `.top-bar{flex-direction:column; padding-top:50px}` → 101px tall at 980; `.menu-grid` is one wrapped row. Dropdowns are **hover-only** (`.grid-item:hover .dropdown{display:block}`), with no click/touch state.

Forced 375px CSS viewport (what the page would do if a viewport meta were added) — measured, not the current phone behaviour:

| Page | `scrollWidth` at 375 | Overflow source |
|---|---:|---|
| `/wallets` | 867 | `table#t2` is 846.7px wide; `wallets.css` has zero media queries |
| `/rent` | 510 | `img[src="img/12_2.svg"]` fixed `width:510px` |
| `/scaner` | 375 | fits; cards 2-up + full-width, table 335px |
| `/results` | 375 | fits; table 335px, buttons 120/94px |
| `/PrivateKeyHex` | 571 | `div.calculator` min-width ~541px; 23 pills wrap to 410px |

**This is an anti-pattern to avoid, not a mechanic to copy**: Rotor should keep its viewport meta and its 375/768/1280 layouts.

---

## 7. Blockers / not observable

- **No forms submitted** (task constraint). Therefore: the `box/box.php` rich-list widget (prices, plan names, download format), the `offer_order.php` order/payment states, the `scaner_job_new.php` `#info` body, and the `download_explorer.php` CSV schema were all read from their callers only.
- **`/results` populated state** is account/session data. Column header set, sort links, empty row, filters, actions and retention note are verified; row cells, coin chips, pagination markup and the leading/trailing empty columns' meaning are inferred or unverified.
- **Hover dropdown behaviour** was read from CSS, not exercised on a touch device; no real phone was used (emulation only).
- **Market/price values, coin rows, addresses, balances and any found keys are deliberately not reproduced.**
- Site content can change; captures are from 2026-11-20. No `sitemap.xml`; `robots.txt` is only `User-Agent: *`.

---

## 8. Ideas worth adopting (ranked)

1. **Group-of-rows table with one shared metrics block.** `/wallets` groups variants (USDT ERC20/BEP20/TRC20; Bitcoin + PublicKeys) under one `tbody`, with rank/icon/ticker/price/volume/cap on `rowspan` and the per-variant name + action on the following rows. *Why:* one identity, many variants, no repeated numbers. **Rotor surface:** `/private-keys/<chain>` and the key page's address table — EVM chain rows under one `0x` parent, BCH CashAddr/Legacy, LTC types.
2. **Sort groups, not rows.** `sort_new.js` moves whole `<tbody>` elements, so a variant never separates from its leader; two-triangle indicator + `sort-asc`/`sort-desc` classes give the state without arrows in markup. *Why:* correct semantics for grouped data. **Rotor surface:** any directory table (currently server-ordered).
3. **Page-size-only density control.** A single `select` (25/50/100) that navigates to `?page=<n>`; no page numbers, no next/prev, and it re-selects itself from the URL. *Why:* one control for density without pager chrome. **Rotor surface:** `/private-keys/<chain>` (currently fixed 60 rows). *Fix the donor's `value=105`-labelled-100 bug.*
4. **Instant client-side filter with focus-to-clear.** `keyup` filters rendered rows by any token, no request. *Why:* a 45-row list feels searchable instantly. **Rotor surface:** directory tables and the results list. **Must add what the donor lacks:** a visible result count and an explicit "no matches" state (the donor collapses to a 32px header with no message).
5. **Per-row gated action that opens an inline quote widget.** `Buy rich list` is a radio-styled label in the row; its POST response is injected into a container under the table (`#mistake`) instead of navigating to a store page. *Why:* the purchase stays in the context of the asset. **Rotor surface:** a future per-chain "download dataset" action; price/plan contents **unverified** (POST-only).
6. **Single-plan capacity calculator.** Quantity stepper (1–999), payment-coin select, dual price (coin + USD), capacity output ("keys checked in 7 days"), one `Order Now`, and four server-driven states (error / order / payment / price refresh). *Why:* one decision (how much), no plan-comparison matrix. **Rotor surface:** a `/rent`-style pricing page if one is added.
7. **Numbered step-by-step derivation panel.** Seven numbered steps with one `Calculate` per step, intermediate hex fields (public key → SHA-256 → RIPEMD-160 → checksums), char counters, and the final address colour-coded per address type. *Why:* makes the derivation auditable instead of a black box. **Rotor surface:** the Derivation section above the address list on `/key/<value>`.
8. **Calculator sub-nav pill strip with a non-link active state.** 23 sibling tools, the current one highlighted, the rest one click away; wraps naturally on narrow widths. *Why:* cheap cross-navigation for a tool family. **Rotor surface:** the check/calculator pages if Rotor grows more than one.
9. **Live public stats over a websocket.** Centrifuge pushes `server`, `inquiries`, `progress`, `private_key`, `range` and a `found` banner; the page never polls. *Why:* long-running work stays legible. **Rotor surface:** a scanner/status page; the key-page check progress could use the same idea.
10. **Results table with coin chips + two server-sort columns + CSV + confirm-delete + retention note.** `Latest Time` and `%` are the only sortable columns; `Download` POSTs a CSV; `Delete all` is behind `confirm()`; the footer states the 1-year retention. *Why:* narrow, explicit affordances for sensitive data. **Rotor surface:** a results/history page. Populated row anatomy, pager and coin chips are **unverified** (account data).

Caution: the donor's missing viewport meta, 32–36px touch targets, hover-only dropdowns, and missing search-empty state are defects — do not copy them.

