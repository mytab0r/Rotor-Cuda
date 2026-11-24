# Private-key explorer (client-side)

## Summary

Add a page that takes any 256-bit private key and shows, entirely in the
browser, what it controls: addresses across several chains and address types,
the WIF/hex/decimal forms, step-by-step derivations behind expandable details,
and optional balance/activity lookups from public APIs. Unlike the reference
sites, the private key never leaves the browser; only derived public addresses
are queried, and only when the visitor asks.

## Why

Reference resources split into two useful ideas: a minimal, fast key page
(ref-site-a derives addresses in the browser and queries public
balance APIs) and a step-by-step calculator (ref-site-b explains every
conversion but computes on its server). This change combines them: local
derivation for speed and privacy, expandable calculations for education, and
an honest interface that also lets the visitor pick the curve instead of
assuming secp256k1. The same client-side WASM core already powers the browser
puzzle worker, so the page reuses it.

## Scope (v1)

- New `/key` page (`web/key.html`, `web/key.js`) reachable from the nav.
- Input: 64-hex (optional `0x`), decimal, or BTC WIF; random key button. The
  key is kept in memory only (never in the URL, history or storage).
- Curves: secp256k1 and ed25519 (seed).
- secp256k1 outputs: BTC P2PKH compressed/uncompressed, P2SH-P2WPKH, P2WPKH,
  P2TR; EVM (Ethereum/BSC/Polygon/Arbitrum/Base address); TRON; WIF
  compressed/uncompressed.
- ed25519 outputs: Solana address (base58 of the public key).
- Expandable "calculation" per address: public key, hash160/keccak, payload,
  checksum, encoding, and for taproot the tweak and output key.
- Curve visualization: an SVG/canvas plot of the selected curve shape with a
  small-field interactive point (slider) clearly labelled as an illustration,
  plus the real key point in hex.
- Balance/activity: offline by default; a "Check balances" action queries
  public CORS-enabled endpoints (mempool.space for BTC, a public JSON-RPC for
  EVM, Tronscan for TRON) and shows per-row results/errors. No proxy, no key
  transmission.
- Wallet presets that select which address rows are relevant (Ledger/Trezor,
  MetaMask, SafePal, TronLink, Phantom).

## Out of scope (v1)

- Mnemonic/BIP32 derivation from a seed phrase and derivation paths.
- secp256r1, Cardano/Stellar and other curves; LTC/DOGE/BCH/XRP addresses.
- Indexing or browsing "all keys"; only the key in the URL/input is computed.
- Any sweeping, signing or wallet-import functionality.
- Server-side balance proxies; endpoints stay public and optional.

## Acceptance

- Known vectors: key 1 gives the canonical compressed/uncompressed P2PKH
  addresses, WIF, bech32, P2SH-P2WPKH and taproot addresses; a secp256k1
  fixture matches published BIP173/BIP350/BIP341 vectors; an ed25519 fixture
  matches a known Solana address.
- The page derives all rows offline with zero network requests when the
  balance check is off; the key never appears in a network request, URL sent to
  a server, DOM text after leaving the page, or logs.
- Balance lookups are opt-in and failures render per row without breaking the
  page.
- The curve selector changes the derivation set (ed25519 shows Solana only)
  and the plot; presets filter rows without changing the math.
- Responsive at 375/768/1280 with no overflow; keyboard operable; details are
  expandable; `impeccable detect` reports no findings on the page.
