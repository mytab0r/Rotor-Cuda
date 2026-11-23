---
chain: xrp
title: "XRP seed phrases: BIP44 classic r-addresses | Crypto"
description: "60 deterministic 12-word XRP phrases derived at the BIP44 coin-144 path into classic r-addresses on the XRP Ledger, with reserves and sequence rules."
---

## What an XRP seed phrase controls

The XRP Ledger is account-based and uses its own display alphabet. A mnemonic
becomes a BIP39 seed; the coin-144 branch provides a secp256k1 key; the classic
address is a zero version byte followed by hash160 of the compressed public key,
checked twice with SHA-256 and written in Ripple's Base58 alphabet. That gives
the familiar `r…` form. The account holds XRP and issued tokens, carries a
sequence number, and must keep enough XRP to satisfy the ledger's base and owner
reserves. The ledger also accepts ed25519 keys, but this page derives the
secp256k1 classic account.

## Derivation path used here

Every row uses `m/44'/144'/0'/0/0`: XRP's coin type, account zero, external
change and first address. The path is separate from the EVM coin-60 branch, so
the same phrase does not land on the same key as an Ethereum account. A
destination tag is a payment routing field, not part of this path or address;
an exchange deposit that needs a tag can be lost even when the `r…` string is
correct.

## Address format and limits

The table links each classic address to XRPScan. Ripple's alphabet is not
Bitcoin's, and the ledger has no `0x`, SegWit or taproot form. XRP carries six
decimals, so one XRP is one million drops. Balance cells stay as placeholders
in this static build. The example phrases are the earliest BIP39 entropy values,
which makes them reproducible by anyone; they are demonstrations, not wallet
material.
