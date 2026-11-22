---
chain: zcash
title: "Zcash private keys: transparent t-addresses | Crypto"
description: "Browse 60 deterministic Zcash private keys and their transparent t1-addresses, with the 8-decimal ZEC unit and shielded-pool limits explained."
---

## What a Zcash private key controls

Zcash has transparent and shielded value pools. This page derives the
transparent P2PKH account from a secp256k1 key: the key signs transparent
inputs, and the address is a two-byte version prefix (`0x1cb8`) plus hash160 of
the compressed public key, Base58Check encoded. That produces the `t1…` form.
Transparent addresses work like Bitcoin's UTXO model, so the key controls the
unspent outputs locked to its script. A shielded address (`z…` or a unified
address) uses different key material and a different proving system; it is not
derived from this transparent scalar and is not shown here.

## Address formats on this page

Every row is the transparent `t1…` account, linked to Blockchair. The table does
not claim to show a Sapling, Orchard or unified address, because those require
separate key derivation and, for spends, zero-knowledge proofs. Zcash's
transparent address prefix is two bytes rather than Bitcoin's one, so the
Base58Check payload and checksum are different even though the public-key hash
is computed the same way. A `t1…` address and a `z…` address are not
interchangeable destinations, and a wallet must support the pool it is sending
to.

## Key encodings and limits

A Zcash transparent key can be 64 hex characters or a WIF with version byte
`0x80`, giving the `5…`, `K…` or `L…` prefixes. Compression changes the
transparent address; this table uses the compressed key. ZEC has 8 decimals.
The balance column is a reserved placeholder in this static build. The key
controls transparent UTXOs, not shielded notes, and it cannot decrypt shielded
history or move funds from a pool whose spending key it does not have. Treat a
transparent key as public whenever it has ever touched the chain.
