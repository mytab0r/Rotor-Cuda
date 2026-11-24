# Donor sources: ref-site-a and ref-site-b

2026-11-20. Public `curl` and static analysis only; no JS execution, no protection bypassed.

## 1. Source-code hunt

Neither has a public source, clone or template.

| Candidate | Stars | Last push | Licence | Verdict / evidence |
|---|---:|---|---|---|
| repository hit 1 | 24 | 2024-02-21 | none | No. Node CLI checking ETH/BNB; `index.js`, `privatekeys`, no web assets. |
| repository hit 2 | 2 | 2022-04-01 | none | No. Node script + `addresses.txt`. |
| repository hit 3 | 11 | 2023-02-22 | MIT | No. Python GUI (`src`, `libs`). |
| repository hit 4 | 0 | 2024-08-28 | none | No. Delphi desktop app. |
| repository hit 5 | 0 | 2026-10-18 | none | No. Docker/K8s Node scanner. |
| repository hit 6 | 0 | 2025-10-27 | none | No. Python/Streamlit app. |
| repository hit 7 | 0 | 2024-05-07 | none | Only cites the ref-site-a brainwallet generator in its README. |

Repository names are omitted on purpose: each one contains the donor brand. A
repository search for the ref-site-b brand returns 200+ unrelated
secret-scanner tools; none maps to the domain. Exact repository searches for
the two reference names and for a sibling explorer site return zero.

Evidence of closed source: all five ref-site-a bundles are obfuscated with a
plaintext string-array (`javascript-obfuscator` style). `*.js.map` URLs answer
`200` but return the SPA HTML, not JSON — there are no source maps. Assets
carry `?v=6a18dc52`; the donor's `CONFIG` object exposes only module/chain
config.

Two useful archived/sibling artifacts:
- Wayback has a readable 2022 `app.js?v=2.2` (49,887 B uncompressed) — the old site used server APIs `/api/cache_handle`, `/api/brainwallet-convert` and third-party balance endpoints. This proves the current client-side design is a later rewrite.
- A sibling explorer site (named in the ref-site-a footer) has a readable `assets/js/app.min.js`, but it is simpler, not the ref-site-a source.

## 2. ref-site-a mechanics

Architecture: Cloudflare front; server-rendered pages plus obfuscated modules (`ui`, `theme`, `crypto-loader`, `balance-checker`, `app`, page modules). The donor's `CONFIG` sets `apiBaseUrl`/`apiSocketUrl` (empty = same origin), `module`, `action`, `chain`, `page`, `type`.

**Endpoints**
- `/api/vf`, `/api/wf` — POST JSON "found wallet"/verify results; `/api/wf` is called by `sendViaApi`.
- `/api/evm-activity` — EVM tx/activity counts.
- `/api/bch`, `/api/solana`, `/api/xrp`, `/api/zec` — server-side batch balance proxies (XRP explicitly "1 at a time, 2s delay").
- `/assets/data/rpcs.json` — 10,148 B EVM RPC catalogue, `{"updated","source":"https://github.com/DefiLlama/chainlist","chains":{…}}`.
- Socket.IO 4.7.4 (`cdn.socket.io`) for `FoundWallets` live search; fallback to API.

Direct browser calls: `blockchain.info/balance`, BlockCypher (DOGE), Haskoin (BCH), Tatum (DOGE/LTC), TronGrid/Tronscan, XRPScan, Chainz (LTC), plus 1RPC/publicnode/drpc/llamarpc for EVM.

**Address derivation — client-side, no server call.** Loader pulls `@noble/curves@1.8.1` (secp256k1, ed25519), `@noble/hashes@1.7.1` (SHA-2/3, RIPEMD-160, HMAC, PBKDF2, BLAKE2b) and `ethers@6.9.0`. String evidence: `toBitcoinTaproot`, `cashaddr`, bech32 charset, `base58`, `getWalletFromWif`, `m/44'/133'/0'/0`. `/key/<64-hex>` renders "Generating addresses…" then fills 14 rows (`kd-chain`, `kd-addr`, `kd-type`, `kd-status`, `kd-loading`): BTC Legacy/compressed/SegWit/P2SH/Taproot; EVM (ETH/BNB/POL/ARB/OP/BASE/AVAX/zkSync share one `0x`); TRX; SOL; TON V4R2/W5; SUI; XRP; LTC; BCH CashAddr; DOGE; ZEC. It is canonical and SEO surface.

**Catalogue pages**
- `/private-keys/<chain>/<page>`: 60 sequential keys/page (`KEYS_PER_PAGE=60`), links `/key/<hex>`; 18 chains; random-page link and jump box.
- `/bitcoin-puzzle`: 160 server-rendered puzzles (#, Status, Address, Range, Balance, TX, Actions); detail `/bitcoin-puzzle/N` with range, target, solution key, transactions.
- `/richest/<chain>`: 100 server-rendered rows (Rank, Address, Label, Type, Balance, Actions), balances lazy-loaded via `data-address`.
- `/brainwallet/<chain>`: 18,890 passphrases, 60/page (315 pages), HEX + passphrase + client-derived address + balance.
- `/mnemonic-seeds/<chain>`: informational/directory pages, same 18-chain tabs.

**Downloadable datasets** (`/downloads`, 10 files, 15.30 GB; no licence, "educational/research only"):
`all.bin.gz` 1.73 GB; `all.blf.gz` 488 MB (Bloom); `all.hex.gz` 1.99 GB; `bitcoin-v1.txt.gz` 482 MB; `bitcoin.hex.gz` 470 MB; `bitcoin.tsv.gz` and the Blockchair dump 1.66 GB each; `brainwallet.txt.gz` 80,322 B (19,701 passphrases, one per line); `ethereum.hex.gz` 1.36 GB; `ethereum.tsv.gz` 5.49 GB. Formats: gzip text/TSV, raw 20-byte hash160/keccak, Bloom.

## 3. ref-site-b

Architecture: nginx, server-rendered PHP + jQuery; no bundler, maps or repo. Page set (~58 links): 22 calculators (Legacy, SegWit, Bech32, Taproot, ETH, TRON, XRP, BNB, SOL, XMR, TON, hex/WIF/brainwallet/mnemonic/bit ops/PublicKey/BCH); 9 transaction pages (send BTC/ETH/TRON/BNB + tokens, decode BTC/ETH); BP/ETH vanity; puzzle; scanner; results; wallets; rent; benchmark; dashboard; programs; about; login.

**Key mechanics.** Inputs are hex (64 chars), WIF compressed/uncompressed, raw public key, SHA-256, RIPEMD-160, brainwallet, mnemonic, decimal/binary. Forms POST to the page, whose inline JS AJAX-posts to `calculators/hex_new.php`; the JSON returns `private, publicKey, ripemd160, sha256…sha256_4, checksum, uncompressedAddress, compressedPubKey, compressedRipemd160, compressedAddress, private_wif_uncompressed, private_wif_compressed, prefix, robot`. Derivation is server-side PHP. There is no canonical URL per key (no `<link rel=canonical>`); only `?symbol=&prefix=` selects a coin. `calculators/legacy_coins.json` is 34,997 B / 360 entries `{coin,name_coin,pubkey_hex}` (version-byte map).

**Scanner** (`/scaner`): server-side worker; UI shows "Addresses database (bn) 2.78", 106 coins, full/start/±1/random/puzzle-range 1–160 controls, live counters via `centrifuge.min.js` websocket, optional e-mail + captcha. **Puzzle**: one 160-row table — #, Range, Address, Private key (Hex), Public key, Solve date, Balance — solved keys published in bulk. **Wallets store**: Rank/Pic/Ticker/Coin/Price/24h volume/Address dump/Market Cap, 25/50/100 selector; "Buy rich list" posts to `box/box.php` (price by request). **Results**: sortable by date/percent via `?sorting=&column=`, 40–100% partial-match metric. **Rent**: quantity × crypto payment, queued scans.

**What it does better than ref-site-a:** denser, sortable tables (`th.sortable` + `data-type`, server-side sort), 25/50/100 page size, one consolidated solved-puzzle table with dates/keys, integrated send/decode transaction tools, 360-coin prefix catalogue, GPU dashboard/benchmark/programs, and rental pricing page. Weaker: no canonical key URL, key material posted to the server, older UI and heavy ads.

## 4. What to reuse

| Item | Licence | Use |
|---|---|---|
| `@noble/curves`, `@noble/hashes` | MIT | Derivation core: secp256k1/ed25519, SHA-2/3, RIPEMD, PBKDF2, BLAKE2b. |
| `ethers` v6 | MIT | EVM/keystore; optional alongside noble. |
| `bitcoinjs-lib` / `bip39` | MIT | Base58/bech32/cashaddr/taproot, mnemonics (verify wordlist terms). |
| `qrcode` library | MIT | Paper-wallet QR. |
| DefiLlama chainlist RPC catalogue | GPL-3.0 | Fetch with attribution; do not vendor. |
| ref-site-a datasets | none ("educational") | Do not copy; rebuild from public APIs. |
| Blockchair dump | terms unverified | Do not copy; check before use. |
| ref-site-b rich lists/PHP | proprietary | Do not copy or scrape; rebuild. |
| BTC puzzle facts | public | Rebuild from the public thread/chain. |
| Brainwallet list | none | Rebuild from compatible public sources. |

Rebuild: page shell/SEO routes (`/key/<hex>`, per-chain browse, puzzle detail), balance proxy (rate limits, caching, provider fallback), puzzle/rich-list ingestion, paid catalogues. The derivation core is the only large reusable piece.
