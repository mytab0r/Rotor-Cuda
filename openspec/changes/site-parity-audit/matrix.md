# High-level parity matrix

Detailed route/feature matrix lives in `/site-map` and in the audits below.
Status: `parity`, `partial`, `missing`, `ours-only`.

| Area | privatekeyfinder.io / secretscan.org | rotor.pxbt.app | Status | P |
|---|---|---|---|---|
| Key directory | 18 chains, 60 rows, pager/random/jump, auto-derive, multiple address types, copy | same core; some chains have one address type | partial | P1 |
| Key entity `/key` | auto-derive, 7 key formats, aggregate counters, 8 EVM rows, CSV/Copy All | buttons required, EVM collapsed, no aggregates/CSV | partial | P0 |
| Global search | modal interpret-as, 1/3/5/10 addresses, result table, export | auto-detect + redirect to `/key` | partial | P0 |
| Mnemonic directory | 60 rows, pager, path/word/type, balances, key+phrase copy | same, but no private key/WIF copy in rows | partial | P0 |
| Mnemonic converter | live word count, 20 addresses, Load next 5, Copy All, Received/Active | 1/3/5/10, no live counter/next batch/aggregates | partial | P1 |
| Puzzle home | stats, CTA, All/Solved/Unsolved, search, 160-row table | cards/grid, no table/filters/search/balance columns | partial | P0 |
| Puzzle random | range controls, segmented solo/team, metrics, Community Hunt, result table | worker exists; no hunt panel/result table | partial | P0/P1 |
| Brainwallet | 18,890-phrase directory, 60×315, auto address/balance, BTC type tabs, pager | single calculator with Derive button | missing | P0 |
| Brainwallet generator | single phrase, network, 1/3/5/10, Copy All/CSV | alias of calculator | partial | P1 |
| Richest lists | `/richest` + 7 chains, top-100 table, filters, search | absent; only gz dumps | missing | P0 |
| Dormant/Satoshi/Whale | three content hubs with stats/tables/paging | absent | missing | P1 |
| Wallet viewer | wallet.dat import, password, address table | absent (ETH keystore only) | missing | P2 |
| Wallets storefront | privatekeyfinder 404; secretscan market table | real mirrored downloads, no prices | ours-only/partial | P2 |
| Send transactions | 9 secretscan `Easy_*` pages, fee/bytes/total/signed hex | Sepolia + BTC testnet inside cabinet only | partial | P0 |
| Tx decoders | BTC raw + EVM RLP decoders | absent | missing | P0 |
| Vanity | threads/ETA/difficulty/save/recent/QR | 6 chains, no threads/ETA/save | partial | P1 |
| Keystore | drag-drop file, examples, metadata | paste/password, no file/examples | partial | P1 |
| Pubkey add | P+Q, P−Q, scalar multiply | P+Q only | partial | P1 |
| Reconstruction | ±a±λb formulas, 6 addresses | byte-fragment assembler (different tool) | ours-only | P1 |
| Shell | icon actions, dense tables, Ctrl+K, consistent states | mixed words/icons, header overflow, 3 filter panels | partial | P1 |
| i18n / admin | donor has no full admin; secretscan dashboard/rent | no i18n; cabinet wallet | gap | P2 |

## Donor-only pages

`/richest`, `/richest/<chain>`, `/bitcoin-dormant`, `/satoshi-wallets`,
`/whale-tracker`, `/wallet-viewer`, `Easy_*_transaction_online`,
`Transaction_decoded_Bitcoin`, `decode_ethereum_transaction`,
`transaction_to_bitcoin_address_p2pkh`, `usdt-trc20-calculator`,
`benchmark`, `programs`, `rent`, `scaner`.

## Our advantages

- Real mirrored wallet datasets through our domain (no direct GitHub links).
- Local WASM derivation/signing; no server sees keys.
- Cabinet wallet with encrypted local vault.
- Seed studio with BIP39/Electrum old/Electrum BIP39 and 13-word validation.
- Puzzle Team mode and local worker already exist.
