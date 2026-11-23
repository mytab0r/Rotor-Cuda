---
chain: bitcoin
title: "Bitcoin seed phrases: BIP44, BIP84 and BIP86 | Crypto"
description: "60 deterministic 12-word Bitcoin seed phrases, each derived at the BIP44, BIP49, BIP84 and BIP86 paths into four reproducible example addresses."
---

## What a Bitcoin seed phrase controls

A BIP39 phrase is a readable encoding of entropy. Wallet software stretches the
words with PBKDF2-HMAC-SHA512 into a 64-byte seed, then walks a BIP32 hierarchy
of private keys. On Bitcoin those keys sign UTXO spends: value is not stored as
an account balance, only as outputs whose locking script a key can satisfy. This
page derives four branches, so one phrase appears four times with four different
keys. They are not four backups of one wallet — each branch is a separate path
below the same seed, and each key controls only the coins sent to its own
script.

## Paths used on this page

The build walks `m/44'/0'/0'/0/0` for legacy P2PKH, `m/49'/0'/0'/0/0` for
nested SegWit, `m/84'/0'/0'/0/0` for native SegWit and `m/86'/0'/0'/0/0` for
taproot. The first three are the BIP44, BIP49 and BIP84 account branches; the
last is BIP86. Every row shows address index 0 of its branch. Advancing that
final number is how a wallet exports further receiving addresses from the same
phrase.

## Address formats and limits

Legacy rows begin with `1`, nested SegWit with `3`, native SegWit with `bc1q`,
and taproot with `bc1p`. All four use the compressed public key; an
uncompressed legacy address is an older, different string and is not rendered.
Testnet and signet have their own prefixes, and this table is mainnet only.
These examples are the lowest values of the 128-bit BIP39 space: anyone can
reproduce them, so they must never hold funds.
