---
chain: xrp
title: "XRP private keys: classic r-addresses and reserves | Crypto"
description: "Browse 60 deterministic XRP private keys and their classic r-addresses, with the 6-decimal XRP unit, reserves and sequence rules explained."
---

## What an XRP private key controls

The XRP Ledger is an account-based chain with its own address alphabet. A
secp256k1 private key signs transactions for one account, and the classic
address is `0x00` followed by hash160 of the compressed public key, checked with
a double-SHA256 and encoded in Ripple's Base58 alphabet. That produces the
familiar `r…` address. The account holds XRP and issued tokens, has a sequence
number and must satisfy the ledger's base reserve and owner reserve. The XRP
Ledger also supports ed25519 keys, but this page derives the secp256k1 classic
account, which is the form the key calculator shows for a hexadecimal key.

## Address formats on this page

Every row is a classic `r…` address, linked to XRPScan. Ripple's Base58 alphabet
differs from Bitcoin's, so an `r…` string is not interchangeable with a Bitcoin
Base58Check address even when the payload bytes are similar. The ledger has no
EVM `0x` account and no SegWit or taproot form. A destination tag is a routing
field attached to a payment, not part of the address; sending to an exchange
without the tag can lose the deposit even when the address is correct.

## Key encodings and limits

Input can be 64 hexadecimal characters or an XRP family secret seed, which the
key calculator recognizes separately from a WIF. The XRP unit has 6 decimals
(one XRP is 10^6 drops). The balance column is a fixed-height placeholder in
this static build. The key controls the account's XRP and issued balances and
its sequence, but it cannot bypass the reserve requirement, cannot reclaim a
payment already validated by the ledger, and cannot sign for an account whose
regular key or multi-signing list has been changed to exclude it.
