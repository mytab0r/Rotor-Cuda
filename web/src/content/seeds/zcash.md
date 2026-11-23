---
chain: zcash
title: "Zcash seed phrases: BIP44 transparent addresses | Crypto"
description: "60 deterministic 12-word Zcash phrases derived at the BIP44 coin-133 path into transparent t1-addresses, not shielded notes."
---

## What a Zcash seed phrase controls

Zcash separates transparent value from shielded pools. This page derives the
transparent side: a BIP39 seed, the coin-133 BIP32 branch, and a secp256k1 key
whose compressed public key is hashed and prefixed with the two-byte Zcash
version `0x1cb8`. Base58Check turns that into a `t1…` address. The key signs
transparent UTXO spends. It does not control Sapling, Orchard or unified
addresses, which need separate spending keys and, for spends, zero-knowledge
proofs.

## Path used on this page

Every row uses `m/44'/133'/0'/0/0`, Zcash's BIP44 coin type with account,
change and address index zero. The path is not shared with Bitcoin or with the
EVM coin-60 branch, so identical words produce a different key here. The page
does not derive a shielded branch, because a transparent scalar cannot be
reused as a Sapling or Orchard spending key.

## Address formats and limits

The rendered `t1…` strings open Blockchair. Zcash's transparent version prefix
is two bytes, unlike Bitcoin's one, so the Base58Check payload and checksum
differ even when the hash160 step is the same. A `t1…` destination and a `z…`
destination belong to different pools and are not interchangeable. ZEC has eight
decimals. Balance cells are fixed-height placeholders; the page makes no
provider call. These phrases are the lowest BIP39 entropy values, so they are
public examples and must never receive funds.
