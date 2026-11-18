# Donor route map and gap status

Crawled `ref-site-a/sitemap.xml` and representative pages on
2026-11-19. Status is against the live Rotor site.

| Donor route | Rotor status | Priority |
|---|---|---|
| `/private-keys`, `/private-keys/<18 chains>` | done, 18 chains | — |
| `/key/<hex>` and `/key/<WIF>` | done | — |
| direct key search modal (`Ctrl+K`, auto-detect HEX/WIF/keypair/XRP secret/mnemonic/brainwallet, 18 chain icons, “Search All Chains”) | partial: HEX/WIF/brainwallet only, no mnemonic/keypair/XRP secret, no chain icon strip | P0 |
| `/mnemonic-seeds`, `/mnemonic-seeds/<chain>` | done: directory, 60-per-page seed space, 12/18/24 words, BIP-32 path, address type, pager and BTC/EVM balances; TON is an explicit unsupported state | — |
| `/mnemonic-converter` | missing (converter lives only in `/seed`) | P1 |
| `/brainwallet`, `/brainwallet/bitcoin`, `/brainwallet/ethereum`, `/brainwallet-generator` | only one generic `/brainwallet` page | P1 |
| `/keystore-parser` | missing | P2 |
| `/richest`, `/richest/{bitcoin,bnb,ethereum,solana,tron}` | only external Rich-Address-Wallet links added to landing; no browsable/filterable in-site lists | P1 |
| `/wallet-viewer` | missing | P2 |
| `/whale-tracker` | missing | P3 |
| `/satoshi-wallets` | missing | P3 |
| `/bitcoin-dormant` | missing | P3 |
| `/bitcoin-puzzle` | done (pooled search, not donor's key list) | P1 parity |
| `/vanity-generator` | done (`/vanity`) | — |
| `/faq`, `/disclaimer`, `/donate`, `/docs` | done | — |

## Observed donor seed page (`/mnemonic-seeds/bitcoin`)

- Chain tabs for all 18 networks.
- Page info: `Bitcoin mnemonic seeds page #1 out of #5.67E+36`, progress bar.
- First / Previous / Random / Next / Last + page input + Jump.
- Word Count: 12 (128 bits), 18 (192 bits), 24 (256 bits).
- BIP-32 derivation path input + Apply.
- Bitcoin Address Type cards: Legacy/P2PKH, SegWit/P2WPKH, Nested/P2SH, Taproot/P2TR.
- Summary: Balance / Received / TX.
- 60 rows: `Seed #N`, mnemonic, address, balance; data derived client-side.

Rotor's `/seed` starts from a phrase and returns fixed paths; the separate
`/mnemonic-seeds` directory now browses the seed space with word count, path,
address type and balances. `/seed` remains the single-phrase converter.

## Observed donor search component

- Header: icon-only search button next to a theme toggle.
- Opens a "Wallet Search" modal with a textarea, auto-detect label
  (HEX, WIF, Keypair, XRP Secret, Mnemonic, Brainwallet), a supported-chain
  icon strip (`+more`) and a single `Search All Chains` primary button.
- Rotor has a text input modal with HEX/WIF/brainwallet only; no textarea, no
  auto-detect label, no chain strip, no theme toggle.

## Rule

Every future donor page must appear in this table with a status and a task in
`tasks.md` before it is marked done. A page that is only linked externally
counts as P0/P1 backlog, not as parity.

## Observed donor puzzle page (`/bitcoin-puzzle/71/random`)

Breadcrumbs: `Home / Bitcoin Puzzle / Puzzle #71 / Random Keys`. Compared with
Rotor's pooled `/bitcoin-puzzle`, the donor page is a different product:

- Puzzle selector `#1…#160`, previous/next puzzle, `Select Puzzle`.
- Tabs/variants: `Detail`, `Random Keys`, `Unsolved`.
- Puzzle metadata: current balance, range start/end, range progress, split
  presets `1st Half`, `2nd Half`, `Q1…Q4`, `Full`, target address and
  `Blockchain` / `Mempool` links.
- Browser worker: `Start`, `Reset`, `Check`, mode `Team` / `Solo Random` /
  `Solo Seq`, `Space`, `Start/Stop`.
- Live counters: `Generated`, `Speed /s`, `Workers`, `WASM`, `Match`, `ETA`,
  `Network /s`.
- On a match: `MATCH FOUND`, target address, private key and Copy.
- The scan is client-side (WASM worker); the page is a puzzle browser, not the
  coordinator's pooled lease board.

Rotor currently has only `/bitcoin-puzzle` with a pooled chunk-leasing
explanation and live public jobs; it lacks puzzle selection, puzzle detail,
range presets, the random/sequential browser worker and the match UI.

## Secretscan.org `/wallets` and calculator catalogue

Crawled 2026-11-19. The page combines a paid rich-list marketplace with a large
calculator menu. Features worth taking (not necessarily the paid marketplace):

- Chain/token price table with rank, ticker, price, 24h volume, market cap and
  a `Buy rich list` action for BTC, ETH, USDT (ERC20/BEP20/TRC20), BNB, USDC,
  XRP, SOL, TRX, stETH, ZEC, XMR, DOGE and others; `25/50/100` rows per page.
- Address calculators: legacy P2PKH, SegWit Base58, SegWit Bech32, Taproot,
  Ethereum, Tron, USDT TRC20, XRP, BNB, Solana, Monero, TON, Bitcoin Cash.
- Key utilities: HEX, WIF, HEX↔WIF, hex/dec/bin, private-key reconstruction,
  public key, add public keys, brainwallet, BIP39 mnemonic.
- Transaction tools: Bitcoin, Ethereum, Tron, BNB, USDT BEP20/TRC20/ERC20,
  USDC ERC20 builders; Bitcoin/Ethereum decoders.
- Vanity: Bitcoin and Ethereum; scanner/results pages; puzzle page.

Rotor already has: key/WIF/hex/decimal/brainwallet/seed/vanity, BTC/EVM/TRON/
SOL/XRP/LTC/DOGE/BCH/ZEC/SUI/TON address derivation, local balances, and a
pooled puzzle board. Missing or thin: Monero, per-chain address-generator pages,
hex/dec/bin converter, private-key reconstruction, public-key calculator,
add-public-keys, keystore parser, transaction builders/decoders, in-site
rich-list marketplace, scanner/results UX.
