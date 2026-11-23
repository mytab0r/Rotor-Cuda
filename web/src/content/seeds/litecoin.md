---
chain: litecoin
title: "Litecoin seed phrases: BIP44, BIP49 and BIP84 | Crypto"
description: "60 deterministic 12-word Litecoin phrases derived at the BIP44, BIP49 and BIP84 paths into legacy, nested and native SegWit addresses."
---

## What a Litecoin seed phrase controls

Litecoin is a UTXO chain on secp256k1. The BIP39 seed is walked along three
BIP32 branches below, and each branch produces its own private key and locking
script. There is no stored account balance; the key spends outputs sent to its
script, and different scripts mean different addresses even under one phrase.
Litecoin also supports MWEB confidential transfers, but those use separate key
material and are outside the single-key branches rendered here.

## Paths used on this page

Rows derive `m/44'/2'/0'/0/0` for legacy P2PKH, `m/49'/2'/0'/0/0` for nested
SegWit and `m/84'/2'/0'/0/0` for native SegWit. Coin type 2 is Litecoin's BIP44
value. The page deliberately stops at those three: the seed presets this
project ships do not include a BIP86 Litecoin branch, so no taproot row is
claimed. Each row shows address index zero of its branch.

## Address formats and limits

Legacy addresses start with `L`, nested SegWit with `M`, and native SegWit with
`ltc1q`. All use the compressed public key; an uncompressed legacy form would be
a fifth, older string and is not shown. LTC has eight decimals. A WIF with
version byte `0xb0` can export the scalar, but it does not change the BIP39
path. The balance column is a fixed-height placeholder in this build, and these
phrases are deliberately public: they begin at the lowest values of BIP39
entropy, so every derived address can be reproduced and none should be funded.
