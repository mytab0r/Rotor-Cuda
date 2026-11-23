---
chain: bitcoin-cash
title: "Bitcoin Cash seed phrases: BIP44 and CashAddr | Crypto"
description: "60 deterministic 12-word Bitcoin Cash phrases derived at the BIP44 coin-145 path and shown as legacy P2PKH and CashAddr."
---

## What a Bitcoin Cash seed phrase controls

Bitcoin Cash kept Bitcoin's UTXO model and secp256k1 keys but dropped SegWit.
A mnemonic becomes the usual BIP39 seed, the coin-145 branch yields a private
key, and that key signs spends of outputs locked to its P2PKH script. The same
public-key hash can be displayed in two ways: the legacy `1…` Base58Check
address and the CashAddr form with the `bitcoincash:` prefix and its own
checksum. Both strings point at one locking script, so they are not separate
wallets.

## Path used on this page

Every example uses `m/44'/145'/0'/0/0`, Bitcoin Cash's registered coin type with
account, change and address zero. The table shows both encodings for that one
key. There is no BIP84 or BIP86 branch here because BCH does not use witness
programs; claiming a `bc1`-style address would describe Bitcoin, not this chain.

## Address formats and limits

The legacy row begins with `1` and opens Blockchair directly. The CashAddr row
uses base32 with the `bitcoincash` prefix and is the form that avoids confusion
with Bitcoin's identical legacy prefix. BCH has eight decimals. The balance
column reserves its height and stays empty; the page fetches nothing. The words
are the first sixty 128-bit entropy values, publicly reproducible, and the
private keys they produce must never be used for funds.
