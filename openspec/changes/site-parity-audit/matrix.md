# High-level parity matrix

Detailed route/feature matrix lives in the internal docs page
`docs/site-map/index.html` and in the audits below.
Status: `parity`, `partial`, `missing`, `ours-only`.

| Area | privatekeyfinder.io / secretscan.org | rotor.pxbt.app | Status | P |
|---|---|---|---|---|
| Key directory | 18 chains, 60 rows, pager/random/jump, auto-derive, multiple address types, copy | same core: 60 rows/page, pager/random/jump, `?key=` jump, search + type select, per-row hex key with copy, address and balance (WIF stays key-level on `/key/<hex>`, as the donor does), BTC/LTC four type cards incl. LTC Taproot; account-model chains summarise Balance/Active, UTXO chains Balance/Received/TX. The donor has no CSV export or balance sorting. | parity | P1 |
| Key entity `/key` | auto-derive, 7 formats + Page, aggregate counters, 8 EVM rows, per-value copy (no CSV/Copy All on the key page) | same donor rows: auto-derive, 7 formats + Page, counters, 8 EVM rows (`↑ same`); ours adds Copy All/CSV; signing entry links to the testnet `/send` page; LTC/DOGE/ZEC (SoChain, BlockCypher fallback for LTC/DOGE), BCH (Haskoin) and the other single-address providers back every chain group, so no balance row shows —, and each of the eight shared-EVM rows links to its own chain explorer | parity | P0 |
| Global search | modal interpret-as, 1/3/5/10 addresses, result table, export | Ctrl+K modal, interpret-as detection, inline result cards (`ws-chain-card`) with Copy All (TSV)/CSV; a live `N chars`/`N words` counter under the input; mnemonics get an Electrum SegWit/Legacy detection label and hand off to `/mnemonic-converter` (phrase in sessionStorage); every interpret-as chip stays visible (deliberate superset) | parity | P0 |
| Mnemonic directory | 60 rows, pager, path/word/type, per-row balances, key+phrase copy | same plus hex private-key copy and full-phrase cell; balances load for Bitcoin, the 8 EVM chains, Solana, BCH (60/60, one batched request), SUI (60/60), TRON (Tronscan), XRP (XRPScan; accounts XRPScan redirects to its bulk dataset show the retry state, not a filled balance) and TON (standard SLIP-0010 ed25519 at the donor path `m/44'/607'/0'`, v4R2/W5, one batched TonAPI `/accounts/_bulk` POST per page, measured 60/60 `ok` on `/mnemonic-seeds/ton` and `/private-keys/ton` at 375/768/1280 in both themes; the donor instead feeds secp256k1 master bytes to v4R2 — row 0: donor `1837c1be…`→`EQD5BSqb…`, ours `560f9f3c…`→`EQBql5Ey…` — and renders one static v4R2 row, so our types and balances are a documented superset); LTC/DOGE/ZEC now map to the shared per-address SoChain provider (2500 lookups a day per IP, keyless, so a 60-row page is 2.4% of the daily budget; the first 429 stops the rest of the page, so an exhausted quota costs ~10 requests, not 240) on both the mnemonic and private-key directories; on SoChain's first 429 a Litecoin page is served whole through the keyless `litecoinspace` Esplora provider the SSOT declares (one request per address, BigInt funded−spent), measured live 2026-11-22 while SoChain answered 429 to everything: `/mnemonic-seeds/litecoin` and `/private-keys/litecoin` each rendered 60/60 `data-balance-state="ok"` at 375/768/1280 in both themes (12 page runs), each page sending ~10 SoChain 429s then exactly 60 `litecoinspace.org` 200s with 0 failed requests; DOGE falls back to one batched BlockCypher request (SSOT `blockcypher`; its small hourly quota counts each address, so it can also be exhausted), and on 2026-11-22 both DOGE pages rendered 60/60 `err` because that fallback also answered 429; ZEC has no fallback and keeps the retry state. The row stays `partial` only for DOGE/ZEC's still-unmeasured live 60/60; WIF stays on `/key`, as in the donor | partial | P0 |
| Mnemonic converter | live word count, 20 addresses, Load next 5, Copy All, Received/Active | live word count, 20 addresses, Load next 5, Copy All, aggregates (current balance and the lifetime Received total for BTC, taken from the same blockchain.info balance response) | parity | P1 |
| Puzzle home | stats, CTA, All/Solved/Unsolved, search, 160-row table | 160-row table with All/Solved/Unsolved, search and Balance/TX/Actions | parity | P0 |
| Puzzle random | range controls, segmented solo/team, metrics, Community Hunt, result table | worker plus Community Hunt counters and a live result table | parity | P0/P1 |
| Brainwallet | 18,890-phrase directory, 60×315, auto address/balance, BTC type tabs, pager | `/brainwallet` 18-chain directory (60×315, auto addresses/balances, BTC type tabs, pager/jump) plus the single calculator | parity | P0 |
| Brainwallet generator | single phrase, network, 1/3/5/10, Copy All/CSV | same calculator surfaces: network dropdown, passphrase, 1/3/5/10, Copy All and CSV | parity | P1 |
| Richest lists | `/richest` + 7 chains, top-100 table, filters, search | absent; only gz dumps | missing | P0 |
| Dormant/Satoshi/Whale | three content hubs with stats/tables/paging | absent | missing | P1 |
| Wallet viewer | wallet.dat import, password, address table | absent (ETH keystore only) | missing | P2 |
| Wallets storefront | privatekeyfinder 404; secretscan market table | real mirrored downloads, no prices | ours-only/partial | P2 |
| Send transactions | secretscan `Easy_*` send family (5 routes captured), fee/bytes/total/signed hex | top-level `/send/{bitcoin,ethereum,bnb,tron,usdt}` on testnets only; mainnet stays gated | partial | P0 |
| Tx decoders | BTC raw + EVM RLP decoders | `/tx/bitcoin` + `/tx/ethereum`, client-side, JSON view | parity | - |
| Vanity | threads/ETA/difficulty/save/recent/QR | 6 chains, parallel workers (1-4), difficulty/ETA, recent addresses and an address-only QR (keys never saved); saving keys is intentionally absent | partial | P1 |
| Keystore | drag-drop file, examples, metadata | paste/password plus drag-drop/file input, a verified web3 test-vector example and id/version/cipher/address metadata | partial | P1 |
| Pubkey add | P+Q, P−Q, scalar multiply | P+Q, P−Q and k·P | parity | - |
| Reconstruction | ±a±λb formulas, 6 addresses | byte-fragment assembler (different tool) | ours-only | P1 |
| Shell | icon actions, dense tables, Ctrl+K, consistent states | mixed words/icons, 4-link + More drawer at ≤860px, 3 filter panels | partial | P1 |
| i18n / admin | donor has no full admin; secretscan dashboard/rent | no i18n; cabinet wallet | gap | P2 |

## Donor-only pages

`/richest`, `/richest/<chain>`, `/bitcoin-dormant`, `/satoshi-wallets`,
`/whale-tracker`, `/wallet-viewer`, `Easy_*_transaction_online`,
`transaction_to_bitcoin_address_p2pkh`, `usdt-trc20-calculator`,
`benchmark`, `programs`, `rent`, `scaner`.

## Our advantages

- Real mirrored wallet datasets through our domain (no direct GitHub links).
- Local WASM derivation/signing; no server sees keys.
- Cabinet wallet with encrypted local vault.
- Seed studio with BIP39/Electrum old/Electrum BIP39 and 13-word validation.
- Puzzle Team mode and local worker already exist.
