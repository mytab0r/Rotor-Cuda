# Proposal: accept WIF keys on the EVM and TRON testnet send routes

## Why

The owner asked when the transaction tools will work from a WIF (for example
on TRON). Today the top-level testnet send page accepts only a 64-hex key on
`/send/ethereum`, `/send/bnb`, `/send/usdt` and `/send/tron`; a Bitcoin WIF is
explicitly rejected there. Users usually hold a WIF, not bare hex.

## What changes

1. `parseSecret` on the secp256k1 EVM and TRON routes tries 64-hex first, then
   decodes a Bitcoin WIF: Base58Check, 32-byte key, optional `0x01`
   compression marker, valid double-SHA-256 checksum. Both the Bitcoin mainnet
   (`0x80`) and testnet (`0xef`) version bytes are accepted because on these
   routes the WIF is only a 32-byte key container and its network byte does not
   select the chain. Other WIF versions (Litecoin `0xb0`, etc.) are rejected.
2. `keyLooksComplete` recognises a WIF on every send route, so the paste state
   derives instead of silently staying empty.
3. The key label is `Testnet WIF or 64-hex key` on every send route; the helper
   text lists WIF first. When a WIF is accepted on an EVM/TRON route the page
   shows: "Bitcoin WIF accepted as a 32-byte key; the WIF network byte does not
   select the chain."
4. The Bitcoin route is unchanged: only a compressed Bitcoin testnet WIF
   (`0xef`) or a 64-hex key; mainnet and uncompressed WIFs stay rejected.
5. Tests cover published mainnet/testnet compressed/uncompressed WIF vectors,
   checksum rejection, hex/WIF parity for EVM and TRON through the real WASM
   derive, `keyLooksComplete`, the unchanged Bitcoin rule, and a Nile signing
   review built from a WIF-parsed key.

## Out of scope

- Mainnet sending. The page still signs only Sepolia / BNB testnet / USDT
  testnet / TRON Nile transactions, and mainnet slugs, chain ids and endpoints
  stay rejected.
- WIFs for non-Bitcoin version bytes, BIP38 encrypted WIFs, extended keys.
- Logging, storing or transmitting a secret; the key still lives in memory only.
- Changing address derivation or the WASM ABI.
