# Donor parity: directory and search surfaces

2026-11-20. Method: `curl -sL -A "Mozilla/5.0"` for HTTP/HTML; headless Chrome 157.0.8103.79 via CDP for post-JS DOM, `location.href`, and computed layout at 1280px and 375px; obfuscated bundle string tables decoded locally. Read-only: no forms submitted, no accounts created, no access control touched.

Scope: `/private-keys`, `/private-keys/bitcoin`, `/mnemonic-seeds/bitcoin`, and the global search modal. Mechanics only — **no key, seed, address or balance values are reproduced**; placeholders such as `<hex>` and `<address>` stand in for data.

Citation convention: selectors/classes in backticks are from the server HTML or the CDP DOM; `app.obf.js` and `mnemonic-seeds.obf.js` citations are decoded bundle strings/functions; `style.min.css` citations are computed or minified CSS rules. Measurements marked `CDP` are `getComputedStyle` / `getBoundingClientRect` at the stated viewport.

---

## 1. `/private-keys` — directory index

**Route / title.** HTTP 200, canonical and `og:url` are `https://ref-site-a/private-keys` (`<link rel="canonical">`, `<meta property="og:url">`). `<title>` is `Bitcoin Private Keys Database - Browse 2²⁵⁶ Wallet Keys` — Bitcoin-branded even though the page lists 18 chains. Breadcrumb is `Home › Private Keys` (`ol.breadcrumb`).

**Heading.** `h1.h2.fw-bold` = `Private Keys Directory`, followed by `p.text-muted` = `Select a blockchain to browse all possible private keys` (`header.text-center`).

**What it lists.** One ungrouped grid: `div.row.g-3.justify-content-center` containing 18 `a.chain-card` links. Each column is `div.col-6 col-md-4 col-lg-3 col-xl-2`; each card is an icon (`32×32`) plus `span.chain-name`, with an inline `--chain-color` custom property. There are no section headings, counts, balances or filters — the chain order itself is the only grouping.

Exact card order and labels (`HTML: .chain-card .chain-name`):

| # | Label | Link |
|---:|---|---|
| 1 | Bitcoin | `/private-keys/bitcoin` |
| 2 | Ethereum | `/private-keys/ethereum` |
| 3 | BNB Chain | `/private-keys/bnb` |
| 4 | Arbitrum | `/private-keys/arbitrum` |
| 5 | Optimism | `/private-keys/optimism` |
| 6 | Base | `/private-keys/base` |
| 7 | Polygon | `/private-keys/polygon` |
| 8 | Avalanche | `/private-keys/avalanche` |
| 9 | zkSync Era | `/private-keys/zksync` |
| 10 | Solana | `/private-keys/solana` |
| 11 | Tron | `/private-keys/tron` |
| 12 | TON | `/private-keys/ton` |
| 13 | Sui | `/private-keys/sui` |
| 14 | XRP | `/private-keys/xrp` |
| 15 | Litecoin | `/private-keys/litecoin` |
| 16 | Bitcoin Cash | `/private-keys/bitcoin-cash` |
| 17 | Dogecoin | `/private-keys/dogecoin` |
| 18 | Zcash | `/private-keys/zcash` |

TON and Bitcoin Cash index cards link to the bare slugs above; the per-chain tabs on the Bitcoin page add `?type=legacy` for those two (see §2).

**No table, no paging.** The index has no column headers, rows, row actions, stats, search box or pagination — it is purely a link grid plus the global search trigger and footer/SEO copy.

**Trailing content.** `div.alert.alert-warning` = “Educational Purpose: The probability of finding a used key is ~1 in 2^160.” Then `div.seo-content` with `h2` “What is a Private Key?” and `h3` “How Many Private Keys Exist?”, “Is It Possible to Find a Used Wallet?”.

**Responsive.** Bootstrap classes give 2 / 3 / 4 / 6 columns at the `col-6 / col-md-4 / col-lg-3 / col-xl-2` breakpoints. Measured CDP: 375px → 2 columns, card width 163.5px, `scrollWidth=367`; 1280px → 6 columns, card width 172.66px, `scrollWidth=1272`. No horizontal overflow at either width.

**Differences we must copy**
1. Single, ungrouped grid of exactly 18 chain cards — no EVM/non-EVM sections, no counts.
2. Exact order and labels, including `BNB Chain`, `zkSync Era`, `Bitcoin Cash`.
3. Whole card is the link; icon + name only; accent colour carried by a CSS custom property.
4. Subtitle “Select a blockchain…” and the 2^160 educational warning.
5. Responsive column count 2/3/4/6, with no horizontal overflow at 375px.
6. The index `<title>` is Bitcoin-branded; only the H1 names the directory.

---

## 2. `/private-keys/bitcoin` — per-chain private-key directory

**Route / title.** HTTP 200, canonical and `og:url` = `https://ref-site-a/private-keys/bitcoin` (page 1) or `.../bitcoin/2` (page 2). `<title>` = `Bitcoin Private Keys - Browse BTC Wallet Addresses | PKF`. **There is no `<h1>` on this page** (`grep -c '<h1'` = 0); the page identity is the breadcrumb plus `.page-info-text`. Breadcrumb = `Home › Private Keys › Bitcoin`.

### 2.1 Controls, top to bottom

**Chain tabs.** `div.chain-tabs` with 18 `a.chain-tab` links, same order as §1. Active tab has `.active` and preserves its chain colour. TON and Bitcoin Cash tab hrefs are `/private-keys/ton?type=legacy` and `/private-keys/bitcoin-cash?type=legacy`; the other 16 are bare slugs. The strip wraps rather than scrolling: measured tab rows are 1280px → 3 rows (8/9/1 tabs, 173px high), 768px → 2 rows (10/8, 122px), 375px → 5 rows (4/4/4/4/2, 266px), with `scrollWidth=clientWidth` at every width (no horizontal scroll).

**Page info / progress.** `div.page-info-container` contains a chain icon and `.page-info-text`: `Bitcoin keys page #1 out of #1.93E+75`. `div.progress-bar` is server-rendered at `width:0%` with `.progress-text` `0.0000%`; it is effectively always near zero because the denominator is astronomical.

**Navigation bar.** `div.nav-bar` has two groups:
- `.nav-buttons`: `First` → `/private-keys/bitcoin`; `Previous` → `/private-keys/bitcoin` on page 1 (no `/1`); `Random` → `a#randomPageBtn` with a server-rendered random page path; `Next` → `/private-keys/bitcoin/2`; `Last` → `<button onclick="PKF.lastPage()">` (not a link).
- `.page-jump`: `label` “Page:”, `input#pageInput` (text, current page), `button` “Jump” → `PKF.jumpToPage()`.

`PKF.lastPage()` navigates to `TOTAL_PAGE` from `app.obf.js` = `1929868153955269923726183083478131797547292737984581739710086052358636024906` (≈1.93E+75). `jumpToPage()` strips non-digits, clamps to 1…`TOTAL_PAGE`, and toasts `Page exceeds maximum (…)`.

**Search bar.** `div.search-bar.has-type-select` (icon, input, select, button, hint):
- `input#searchInput` placeholder: `HEX, WIF (5/K/L), or Brainwallet`.
- `select#searchType`: `Legacy (1...)` (value `legacy`, default), `SegWit (bc1q...)` (`segwit`), `Nested (3...)` (`script`), `Taproot (bc1p...)` (`taproot`).
- `button` “Search” → `PKF.searchKey()`.
- `.search-bar-hint`: `Supports 64-char HEX, WIF (5.../K.../L...), or any text as brainwallet`.

Directory search detection (`app.obf.js: PKF.searchKey`) accepts: optional-`0x` 1–64 hex (padded to 64); WIF matching `^[5KLT6Q][1-9A-HJ-NP-Za-km-z]{50,51}$`; XRP secret; Solana keypair; a JSON array of 64 or 32 byte values (first 32 bytes become hex); otherwise SHA-256 of the text (brainwallet). It then navigates to `/private-keys/<chain>?key=<encodeURIComponent(value)>`, appending `&type=<type>` when the selected type is not the chain default.

**Stats.** `div.balance-summary.cols-3` with three `.stat-card`s, DOM labels `Balance`, `Received`, `TX` (CSS `text-transform:uppercase`). Values are filled after row hydration; the first two carry a native unit, the third is an integer. At 1280px the grid is three equal columns (369.33px each); at 375px it collapses to one column (343px).

**Address-type selector.** `div.address-type-selector` with label `Bitcoin Address Type` and four `button.address-type-card`s:

| Button | `.type-name` | `.type-desc` | `onclick` |
|---|---|---|---|
| 1 | Legacy | `P2PKH · 1...` | `PKF.changeAddressType('legacy')` |
| 2 | SegWit | `P2WPKH · bc1q...` | `PKF.changeAddressType('segwit')` |
| 3 | Nested SegWit | `P2SH · 3...` | `PKF.changeAddressType('script')` |
| 4 | Taproot | `P2TR · bc1p...` | `PKF.changeAddressType('taproot')` |

Active card gets `.active`. Clicking navigates to `/private-keys/bitcoin[ /page]?type=<type>`; `legacy` omits the query. This is a full page navigation, not a client-side re-render.

### 2.2 Table anatomy

The “table” is a CSS grid, not a `<table>`. `div.keys-table` contains `div.keys-header` and `div#keysContainer` with exactly **60** `div.key-row[data-index="0..59"]`.

Exact header cells, in order (`HTML: .keys-header > div`):

1. `.col-key` — key icon + `Private Key`
2. `.col-address` — wallet icon + `Address`
3. `.col-balance` — coin icon + `BTC Balance`

Desktop grid (`getComputedStyle`): `1.6fr 0.9fr minmax(180px, auto)` → measured `556.8px 313.2px 180.0px` for both header and row. The header is uppercase at 12.8px.

**Row cell contents**

| Cell | Contents |
|---|---|
| `.col-key` | `.key-hex`: `<hex>` as `a.private-key.key-link` → `/key/<hex>`, plus `.copy-btn` title `Copy HEX`. Then `.key-wif` `(c)`: `a.wif-value.key-link` → `/key/<wif-compressed>`, plus copy title `Copy WIF`. Then `.key-wif` `(u)`: same for the uncompressed WIF. |
| `.col-address` | For Legacy: two `span.address-item`s separated by `<br>` — `(c) ` + `a.address-link` (`target="_blank" rel="noopener noreferrer"`) to the chain explorer + copy title `Copy Address`; then `(u) ` + the same for the uncompressed address. For SegWit / Nested / Taproot: one address item, no `(c)/(u)` prefix. |
| `.col-balance` | One `.balance-info` per address line. Each line has `.bal` (coin icon + balance amount), `.tx` (arrows icon + transaction count, class `has-tx` when >0), `.recv` (down-arrow icon + received amount, class `has-recv` when >0). Legacy rows have two `.balance-info` lines (compressed and uncompressed); other types have one. |

All key/WIF links point to `/key/<value>`; address links go to the external explorer. Copy buttons are `opacity:0` until row hover (`style.min.css: .key-row .copy-btn`). The server HTML ships address cells as `Calculating...` and balance cells as `-`; `PKF.generateKeys()` derives the 60 addresses row by row, then `fetchBalancesForPage()` fills the metrics.

**Paging / URL scheme**
- Fixed page size: `KEYS_PER_PAGE=0x3c` (60) in `app.obf.js`; no page-size selector.
- Page 1 keys are decimal 1–60; page 2 is 61–120 (`0x3d…0x78`), confirming `(page-1)*60 + 1`.
- Canonical page 1: `/private-keys/<chain>`; page N: `/private-keys/<chain>/<N>`.
- `?type=<type>` is appended for non-default address types and preserved by `goToPage`; `?key=<value>` is used by the inline search and combined as `?key=…&type=…`.
- On load, `fillSearchFromUrl()` puts `?key=` into `#searchInput` and normalizes hex/WIF/XRP/keypair to hex; `highlightSearchedKey()` adds `.highlighted` and scrolls the matching row into view. It does **not** auto-run the search.

**Responsive at 375px.** `scrollWidth=367` (no overflow). `.keys-header` is `display:none`; `.key-row` becomes a single 309px column with three stacked blocks (grid rows `110.3px 39.2px 48.6px`). Key and address text drop to 10.4px. Chain tabs wrap in 341px; `.nav-bar` becomes a column; `.search-bar` becomes a column with full-width input; stats become one column; the four type cards stack at 309px each; `.page-jump` stays visible.

**Differences we must copy**
1. 18-chain tab strip above the directory, with TON/BCH defaulting to `?type=legacy`.
2. No H1 on the chain page; identity is breadcrumb + `.page-info-text`.
3. Page-info line, progress bar, First/Previous/Random/Next/Last, and a numeric page-jump box.
4. Inline search accepts hex/WIF/XRP/keypair/byte-array/brainwallet, pre-fills via `?key=`, and only highlights an existing row — it does not auto-submit.
5. Three stat cards `Balance / Received / TX` (uppercase via CSS), hydrated after the 60 rows.
6. Address-type cards `Legacy / SegWit / Nested SegWit / Taproot`, persisted as `?type=`.
7. 60-row CSS-grid table with exact columns `Private Key | Address | BTC Balance`.
8. Row key cell includes hex **and both WIF forms** as `/key/<value>` links plus copy buttons; this is different from the key page, where WIF is copy-only.
9. Address cell uses `(c)/(u)` explorer links with per-address copy; Legacy has two address lines, other types one.
10. Balance cell packs three metrics per address line: balance, tx count, received amount.
11. Page size 60; page N URL `/private-keys/<chain>/<N>`; page 1 canonical omits `/1`.
12. 375px: header hidden, row stacked into one column, all controls stacked, no overflow.

---

## 3. `/mnemonic-seeds/bitcoin` — per-chain mnemonic directory

**Route / title.** HTTP 200, canonical and `og:url` = `https://ref-site-a/mnemonic-seeds/bitcoin` (page 1) or `.../bitcoin/2` (page 2). `<title>` = `Mnemonic Seeds Directory - Browse All BIP-39 Seed Phrases`. **No `<h1>`** on this page either. Breadcrumb = `Home › Mnemonic Seeds › Bitcoin`.

### 3.1 Controls, top to bottom

**Chain tabs.** `div.chain-tabs` with the same 18 chains and order as §1/§2. Here TON and Bitcoin Cash links are plain `/mnemonic-seeds/ton` and `/mnemonic-seeds/bitcoin-cash` — no `?type=` suffix. Active tab = Bitcoin.

**Page info / progress.** `.page-info-text` = `Bitcoin mnemonic seeds page #1 out of #5.67E+36 (0.0000%)` (the percentage is inline here, unlike §2). `.progress-bar` is `width:0%`, text `0.0000%`.

**Navigation bar.** `.nav-buttons`:
- `First` → `/mnemonic-seeds/bitcoin`
- `Previous` → `/mnemonic-seeds/bitcoin/1` **even on page 1** (the donor emits `/1`, unlike §2)
- `Random` → `<button onclick="MnemonicSeeds.randomPage()">` (JS: 32 random bytes mod `totalPages` + 1)
- `Next` → `/mnemonic-seeds/bitcoin/2`
- `Last` → server-rendered link to `/mnemonic-seeds/bitcoin/5671372782015641057722910123862803525` (≈5.67E+36)

`.page-jump`: `input#pageInput` + `button` “Jump” → `MnemonicSeeds.jumpToPage()`. It strips non-digits, clamps to 1…`PKF_CONFIG.totalPages`, and toasts `Please enter a valid page number` when empty.

**Options panel.** `div.milk-sad-options` (reused class name):
- `label` “Word Count” + `select#bitsSelect`: `12 words (128 bits)` value `128` (default), `18 words (192 bits)` value `192`, `24 words (256 bits)` value `256`.
- `label` “BIP-32 Derivation Path” + `input#pathInput` placeholder `m (master key)`, default empty.
- `button` “Apply” → `MnemonicSeeds.applyOptions()`.
- `div.path-presets#pathPresets`, populated by JS with a wrapper `div.d-flex.flex-wrap.gap-1` and `button.preset-btn[data-id][data-path]` pills. Desktop shows all five BTC presets in one row (106–213px each); at 375px the wrapper is 309px and the pills wrap one per row (each 31px high, intrinsic width 106–213px).

BTC presets exactly (`window.MNEMONIC_SEEDS_PRESETS.bitcoin`):

| id | Label | Path | `desc` / title |
|---|---|---|---|
| `master` | Master Key | `m` | `BIP-32 root` |
| `bip44` | BIP44 Legacy | `m/44'/0'/0'/0/0` | `1...` |
| `bip84` | BIP84 SegWit | `m/84'/0'/0'/0/0` | `bc1q...` |
| `bip49` | BIP49 Nested | `m/49'/0'/0'/0/0` | `3...` |
| `bip86` | BIP86 Taproot | `m/86'/0'/0'/0/0` | `bc1p...` |

Other chains use the same structure with a smaller set: Ethereum (`Master`, `BIP44`, `MEW/Trezor`), Litecoin (`Master`, `BIP84`, `BIP44`), Tron/Dogecoin/Zcash/XRP/Sui/TON/Solana (`Master` + one chain-specific preset), Bitcoin Cash (`Master`, `BIP44 BCH`, `BIP44 BTC`), and `_default` (`Master`, `BIP44` EVM). The full map is in the page’s inline `window.MNEMONIC_SEEDS_PRESETS` script.

**Address-type selector.** Same component as §2, but shorter descriptions: `Legacy` / `P2PKH`, `SegWit` / `P2WPKH`, `Nested SegWit` / `P2SH`, `Taproot` / `P2TR`. `onclick=MnemonicSeeds.changeAddressType('<type>')`; it preserves the current page and adds `?type=` when non-default.

**Stats.** `div.balance-summary.cols-3`, three cards `Balance`, `Received`, `TX`. Desktop three columns (369.33px each); 375px one column (343px). The `Received` stat can render in `sat` (and `zat` for Zcash) rather than BTC when the amount is small; balance stays in the native unit.

**No search bar.** `document.querySelectorAll('.search-bar').length` = 0 on this page. The only global entry point is the site-wide “Search key, WIF, mnemonic across 18 chains” trigger.

### 3.2 Table anatomy

`div.keys-table.milk-sad-table` → `div.keys-header` + `div#keysContainer` with **60** `div.key-row[data-entropy="0..59"]` on page 1 (60–119 on page 2).

Exact header cells, in order (`HTML: .keys-header > div`):

1. `.col-key-header` — key icon + `Private Key / Mnemonic`
2. `.col-address-header` — wallet icon + `Address`
3. `.col-balance-header` — coin icon + `BTC Balance`

This is **three** header columns, not four. Each row has a fourth child, `.col-mnemonic`, which is `grid-column:1/-1` and therefore occupies a second grid line spanning all three columns. Desktop row grid: `1.4fr 1fr minmax(180px,auto)` → `507.5px 362.5px 180px`, grid rows `68.2px 32.2px`. The header is hidden at 375px.

> Correction to `key-page.md` §6: that section describes the mnemonic table as `Mnemonic | Key | Address | Balance` (four columns). The donor actually has three header columns (`Private Key / Mnemonic | Address | BTC Balance`) plus a full-width mnemonic sub-row.

**Row cell contents**

| Cell | Contents |
|---|---|
| `.col-key` | `.key-hex`: `span.key-label` `Seed #<N>` (N = `data-entropy`, 0-based), `a.private-key` → `/key/<hex>` with `data-key`, and `.copy-btn.copy-key` title `Copy Private Key`. No WIF links. |
| `.col-address` | `span.address-item` `(c) ` + `a.address-link.address` to the explorer (`target="_blank" rel="noopener"`, `data-address`), `<br>`, `span.address-item` `(u) ` + `a.address-link.address-u`. No copy buttons in this cell. |
| `.col-balance` | Two `.balance-info` lines (compressed and uncompressed). Each has `.bal` (coin icon + amount), `.tx` (arrows icon + count), `.recv` (down-arrow icon + received amount). Small received values render as `sat` (Zcash `zat`). |
| `.col-mnemonic` | `span.key-label` `Mnemonic`, `span.mnemonic-text` with the phrase in `title`, truncated with ellipsis on desktop and wrapping on mobile, plus `.copy-btn.copy-mnemonic` title `Copy Mnemonic`. |

Rows also carry `data-mnemonic`, `data-privatekey` and `data-address` attributes alongside `data-entropy`. The server HTML ships `Loading...` / spinner placeholders; `MnemonicSeeds.generateAllKeys()` derives each row's mnemonic, key and address client-side, then balances are fetched per page.

**Paging / URL scheme**
- Fixed 60 rows/page; no page-size selector.
- Page 1 `/mnemonic-seeds/<chain>`; page N `/mnemonic-seeds/<chain>/<N>`.
- Query parameters: `type` (non-default address type), `bits` (`192` or `256`; omitted for the default `128`), and either `preset=<id>` or `path=<custom path>`.
- `applyOptions()` resets to page 1 when the word count changes; otherwise it keeps the current page. `changeAddressType()` keeps the page and adds `?type=`.
- `randomPage()` uses `crypto.getRandomValues(new Uint8Array(32))` modulo `totalPages` + 1. `jumpToPage()` clamps to `1…totalPages`.

**Responsive at 375px.** `scrollWidth=367` (no overflow). `.keys-header` is `display:none`; `.key-row` switches to `display:flex; flex-direction:column; gap:12px` with the four blocks stacked (key 309px, address 249px, balance 164px, mnemonic 309px). The mnemonic text switches from ellipsis to wrapping. Options columns stack at 317px each; the preset wrapper is 309px and its pills wrap one per row; type cards stack at 309px; stats become one column.

**Differences we must copy**
1. 18-chain tab strip, plain links for TON/BCH (no `?type=` default here).
2. No H1; identity is breadcrumb + page-info line with inline percentage.
3. Navigation asymmetry: `Previous` points to `/1` even on page 1; `Random` is a JS button; `Last` is a server link to the maximum page.
4. Word-count select exactly `12/18/24 words (128/192/256 bits)`, default 128.
5. BIP-32 path input + Apply + preset pills; BTC presets exactly Master/BIP44/BIP84/BIP49/BIP86 with the paths above.
6. Four address-type cards with short descriptions and `?type=` persistence.
7. Three stat cards, with `sat`/`zat` formatting for small received amounts.
8. Three-column header `Private Key / Mnemonic | Address | BTC Balance`, plus a full-width mnemonic sub-row per record — not a four-column table.
9. Row key cell is `Seed #N` + hex link + copy; no WIF links.
10. Address cell is `(c)/(u)` explorer links only, with no copy buttons.
11. Mnemonic sub-row has its own copy action and a `title` with the full phrase.
12. Page size 60; page N URL and `bits`/`type`/`preset`/`path` query scheme.
13. 375px: header hidden, row becomes a vertical flex column, options/presets/type cards stack, no overflow.

---

## 4. Global search: Ctrl+K modal + inline results

`key-page.md` §5 already correctly documents: the `.global-search-trigger` (“Search key, WIF, mnemonic across 18 chains”, `Ctrl+K`), `#walletSearchModal` (`modal-lg modal-dialog-scrollable`), the 4-row textarea, the six “Interpret as” chip labels, the mnemonic passphrase/address-count controls, the main detect→View routes (`/key/<value>` for hex/WIF/keypair/XRP, `/mnemonic-converter`, `/brainwallet`), the per-chain result cards, the “Copy All”/“CSV” buttons, and the activity summary line. Those points are **not repeated** below; this section only adds what was not recorded there.

The same modal markup (`#walletSearchModal`) is present on every audited page — the index and both chain directories — so the search is global, not page-specific.

### 4.1 Modal chrome and input states

- Title `#walletSearchModalLabel` = `Wallet Search`.
- `textarea#walletSearchInput` rows=4, placeholder `Enter private key, mnemonic, or any text (brainwallet)...`, `autocomplete=off`, `spellcheck=false`.
- Default detection line `#walletSearchInputType` = `Auto-detect: HEX, WIF, Keypair, XRP Secret, Mnemonic, Brainwallet`; after input it becomes `Detected: <type>`.
- `#walletSearchWordCount` shows `<n> chars` or `<n> words`.
- `#wsInputInfo` starts as `-`; after a search it becomes one of `HEX Private Key`, `WIF Private Key`, `Solana Keypair`, `XRP Secret`, `Mnemonic Phrase`, `Brainwallet`.
- `#wsViewLink` is hidden until detection; its text is `Key Details`, `Mnemonic Converter` or `Brainwallet Generator`.
- `#walletSearchMnemonicOptions` is `display:none` except for a mnemonic detection; it contains `#walletSearchPassphrase` (“BIP39 passphrase (optional)”) and `#walletSearchAddressCount` with `1 address` (default), `3 addresses`, `5 addresses`, `10 addresses`.
- The submit button is `#walletSearchBtn2` = `Search All Chains` → `WalletSearch.search()`. Typing only runs detection; **the search does not auto-run**.
- Closing the modal (`hidden.bs.modal`) calls `WalletSearch.reset()`, clearing input, type, results and summary.

### 4.2 “Interpret as” chips

The chips are `input.ws-type-radio[name="wsInputType"]` + `label.ws-type-chip`, in fixed DOM order:

1. `Private Key (HEX)` → `hex`
2. `WIF Format` → `wif`
3. `Keypair` → `keypair`
4. `XRP Secret` → `xrp-secret`
5. `Mnemonic` → `mnemonic`
6. `Brainwallet` → `brainwallet`

Only two chips are shown for any detection: the detected type and its allowed alternate. Exact pairs seen in the DOM (`getComputedStyle(display) !== 'none'`):

| Detected | Visible chips (DOM order) | Checked |
|---|---|---|
| HEX | `Private Key (HEX)`, `Brainwallet` | `hex` |
| WIF | `WIF Format`, `Brainwallet` | `wif` |
| Solana keypair | `Keypair`, `Brainwallet` | `keypair` |
| XRP secret | `XRP Secret`, `Brainwallet` | `xrp-secret` |
| Mnemonic (any) | `Mnemonic`, `Brainwallet` | `mnemonic` |
| Brainwallet | `Mnemonic`, `Brainwallet` | `brainwallet` |

Selecting a chip sets `userTypeOverride`; it is discarded if it is not in the allowed pair for the current detection. Selecting `Mnemonic` toggles the passphrase/address-count panel via `onTypeChange()`.

### 4.3 Detection matrix (extended)

`WalletSearch.detectInputType()` (`app.obf.js`), in evaluation order:

| Input | Detection | `#wsInputInfo` | View link | Notes |
|---|---|---|---|---|
| `^(0x)?[0-9a-fA-F]{64}$` | `hex` | `HEX Private Key` | `/key/<lowercased hex>` | optional `0x` stripped; internal value lowercased |
| `^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$` | `wif` | `WIF Private Key` | `/key/<wif>` | |
| `CryptoUtils.isSolanaKeypair` | `keypair` | `Solana Keypair` | `/key/<keypair>` | |
| `CryptoUtils.isXrpSecret` | `xrp-secret` | `XRP Secret` | `/key/<secret>` | |
| 12 words, all in BIP39 English, HMAC-SHA512 with key `Seed version` starts `100` | `mnemonic`, type `segwit` | `Mnemonic Phrase` | `/mnemonic-converter` | label `Detected: Electrum SegWit` |
| same, prefix `01` | `mnemonic`, type `standard` | `Mnemonic Phrase` | `/mnemonic-converter` | label `Detected: Electrum Legacy` |
| 12/15/18/21/24 words, all in BIP39 English | `mnemonic` | `Mnemonic Phrase` | `/mnemonic-converter` | label `Detected: Mnemonic (BIP39)` |
| standard word count, not all in BIP39 | `mnemonic` | `Mnemonic Phrase` | `/mnemonic-converter` | label `Detected: Mnemonic (non-standard)` |
| 3+ words, each 3–8 Latin letters, not a mnemonic | `brainwallet` | `Brainwallet` | `/brainwallet` | label `Detected: Brainwallet (SHA256)` |
| 1–63 hex chars | `brainwallet` | `Brainwallet` | `/brainwallet` | `#wsHexSuggestion` adds “Did you mean Private Key HEX?”; the link calls `WalletSearch.fillHex(<padded 64-hex>)`, no navigation |
| anything else | `brainwallet` | `Brainwallet` | `/brainwallet` | |

The 12-word Electrum test uses `hmac(sha512, key="Seed version", msg=NFKD(mnemonic))` and checks the leading hex of the digest (`100` → SegWit, `01` → Legacy). This is a donor-specific branch that `key-page.md` §5 does not mention.

### 4.4 Result cards — exact anatomy

`#walletSearchResults` is `d-none` until a search; it contains `.ws-results-header` (“Derived Addresses” + `#wsInputInfo` badge + `#wsActivityStatus`), actions `Copy All` / `CSV`, `#wsActivitySummary`, and `#walletSearchChainsGrid.ws-chains-list` (flex column).

Each chain produces one card:

```html
<div class="ws-chain-card" id="ws-chain-<chain>" data-chain="<chain>">
  <div class="ws-chain-header">
    <div class="ws-chain-info">
      <img class="crypto-icon"> <span class="ws-chain-name">NAME</span>
      <span class="ws-chain-symbol">SYMBOL</span>
    </div>
    <div class="ws-chain-balance">
      <div class="ws-chain-balance-value" id="ws-balance-<chain>">-</div>
      <div class="ws-chain-status" id="ws-status-<chain>">0/N</div>
    </div>
  </div>
  <div class="ws-chain-body">
    <div class="ws-address-item" data-chain="<chain>" data-address="<address>">
      <div class="ws-address-row">
        <span class="ws-address-index">#<i></span>
        <span class="ws-address-type">TYPE</span>
        <span class="ws-address-value"><a href="<explorer><address>" target="_blank" rel="noopener">ADDRESS</a></span>
        <button class="copy-btn" onclick="PKF.copy('<address>')" title="Copy Address">…</button>
        <span class="ws-address-balance" id="ws-addr-bal-<chain>-<sanitized>">-</span>
      </div>
      <div class="ws-key-row">
        <span class="ws-key-label">Key</span>
        <a href="/key/<privateKey>" class="ws-key-value">PRIVATE KEY</a>
        <button class="copy-btn" onclick="PKF.copy('<privateKey>')" title="Copy Private Key">…</button>
      </div>
    </div>
  </div>
</div>
```

Field notes:
- `.ws-chain-status` starts `0/N` (N = number of derived addresses for that chain). It gets `.active` (blue) or `.error` (red); the error text can be `All RPCs failed`.
- `.ws-chain-balance-value` starts `-` and is filled with the chain balance after checks.
- Card state classes: `.has-balance` (green border), `.has-activity` (blue border), `.has-error` (red border).
- `.ws-address-item` state classes: `.has-balance`, `.has-activity` (blue left border and a `●` after the index), `.has-error`.
- `.ws-address-balance` gets `.has-balance` (green, bold) or `.has-error`.
- Every key in `.ws-key-row` is wrapped by `PKF.keyLink(v) = baseUrl + '/key/' + v`, including WIF/keypair/XRP/mnemonic-derived values. Mnemonic results also include a `path` in the data object, but the card itself does not render a path row; the path appears only in CSV.

### 4.5 Copy All / CSV / activity summary

**Copy All** (`WalletSearch.copyAll()`) builds tab-separated text:

```text
=== <Chain name> ===
<address>\t<privateKey>
<address>\t<privateKey>

=== <Next chain> ===
...
```

It copies the whole string to the clipboard, then toasts `Copied <n> addresses to clipboard`. Empty results toast `No addresses to copy` as an error.

**CSV** (`WalletSearch.exportCsv()`) downloads `wallet-addresses.csv` (`text/csv;charset=utf-8`) with header:

```csv
Chain,Index,Address,Private Key,Path
```

Each row is `"<chain name>",<index>,"<address>","<privateKey>","<path>"`; `Path` is empty for non-mnemonic inputs. Success toast: `CSV exported successfully`.

**Activity summary** (`#wsActivitySummary`, separator `span.ws-sep`):
- Initial: `#wsActiveChains` = `0 chains`, `#wsActiveAddresses` = `0 addresses`.
- While checking: `#wsActivityStatus` and `#wsActiveChains` show `<checked>/<total> chains`; `#wsActiveAddresses` shows `<n> active`.
- Done with activity: `#wsActivityStatus` = green badge `Active`; `#wsActiveChains` = `<n> active chain(s)`; `#wsActiveAddresses` = `<m> active address(es)`; the line reads like `17 active chains • 27 active addresses`.
- Done with none: `#wsActivityStatus` = grey badge `No Activity`; the counts render as `0 active chains • 0 active addresses`.

### 4.6 Supported-chains strip

`.ws-supported-chains` shows `Supported:` plus ten `.ws-chain-icon` entries — Bitcoin, Ethereum, BNB, Polygon, Arbitrum, Solana, Tron, Litecoin, Dogecoin, Zcash — followed by `.ws-chains-more` `+more`. The actual search covers 18 chains; the strip is illustrative, not exhaustive.

### 4.7 Responsive at 375px

Opening the modal in CDP at 375px: `.modal-dialog` is 351px wide with 8px margins, `.modal-body` 349px, textarea 317px × 4 rows at 14.4px. Chips wrap (`flex-wrap:wrap`, 27px high each); the supported-icons strip wraps; result actions stay `nowrap`. `scrollWidth` stays 367 (no horizontal overflow).

**Differences we must copy**
1. Two-chip “Interpret as” model: detected type + one alternate, in fixed chip order, not a free six-way selector.
2. Detection branches missing from the earlier audit: Electrum prefix test, standard 12/15/18/21/24 mnemonic counts, non-standard mnemonic, short-hex pad suggestion, and byte-array handling in the directory search.
3. `#walletSearchInputType` live “Detected: …” line and `#walletSearchWordCount` `chars`/`words` counter.
4. Per-chain card with logo/name/symbol, balance, `0/N` status, address rows (`#i`, type, explorer link, copy, balance) and a separate `Key` row linking to `/key/<privateKey>`.
5. Card/address state vocabulary: `has-balance`, `has-activity`, `has-error`, status `active`/`error`.
6. Copy All TSV format with `=== Chain ===` headers; CSV columns `Chain,Index,Address,Private Key,Path` and filename `wallet-addresses.csv`.
7. Activity summary has three states (initial, checking, done) and uses `Active` / `No Activity` badges.
8. No auto-search; explicit `Search All Chains` button; reset on modal close.
9. Supported strip shows ten icons + `+more` while the search runs 18 chains.
10. 375px modal is 351px wide, 4-row textarea, wrapping chips, no overflow.

---

## 5. Blockers / not observable

- **Search submission not performed** (task constraint: no forms submitted). Live per-chain result values, status transitions and balance formatting were not observed in a real run; card structure was verified from the obfuscated bundle plus a synthetic `WalletSearch.renderResults()` render in the headless page (no network, no data used in this file).
- **Electrum detection not exercised with a real Electrum seed.** The branch is visible in `app.obf.js` (`hmac`, `Seed version`, `100`/`01`), but no valid Electrum seed was generated to confirm the UI label end-to-end.
- **Last-page navigation not exercised** on `/private-keys/bitcoin` (JS BigInt to ≈1.93E+75); the `Last` button and `TOTAL_PAGE` constant were read, not navigated.
- **`?key=` prefill on non-BTC chains** was not exercised; the code path is generic (`fillSearchFromUrl` + `highlightSearchedKey`), but only the BTC page was loaded with a query.
- **No screenshots / visual diff.** Responsive claims are computed-layout measurements (widths, grid templates, overflow), not pixel screenshots; ad slots were present but ignored.
- **Donor content can change.** Titles, chain lists and totals were captured 2026-11-20 against bundle version `6a18dc52`; later deployments may differ.
