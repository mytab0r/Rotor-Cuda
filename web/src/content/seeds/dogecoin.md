---
chain: dogecoin
title: "Dogecoin seed phrases: BIP44 P2PKH D-addresses | Crypto"
description: "60 deterministic 12-word Dogecoin phrases derived at the BIP44 coin-3 path into the compressed-key D-addresses the UTXO chain uses."
---

## What a Dogecoin seed phrase controls

Dogecoin is a UTXO coin with secp256k1 keys and hash160 addresses. The mnemonic
is stretched into the BIP39 seed, and the coin-3 branch produces a private key
that signs transaction inputs. Funds are not held in an account balance; they
sit in unspent outputs, and the key can spend an output only when its script
matches. Dogecoin inherited Bitcoin's address machinery with its own version
byte, so the resulting `D…` string is a P2PKH destination rather than an account
handle.

## Path used on this page

The table derives `m/44'/3'/0'/0/0` for every phrase — Dogecoin's BIP44 coin
type, account zero, external change and first address. It does not derive a
SegWit branch, because the project's Dogecoin key path is the legacy P2PKH
script. The same words imported into a Bitcoin wallet take a different coin
type and therefore a different key; sharing a phrase across chains is not the
same as sharing an address.

## Address formats and limits

Rows show the compressed-key `D…` form and link to Blockchair. An uncompressed
public key would create another legacy address, but it is not the modern default
and is not rendered. DOGE has eight decimals. A WIF with version byte `0x9e`
exports the scalar without changing the derivation path. Balance cells are
reserved placeholders in this static build. The examples are public entropy
values, so their phrases and keys are reproducible and unsuitable for storing
value.
