---
chain: bitcoin-cash
title: "Bitcoin Cash private keys: legacy and CashAddr | Crypto"
description: "Browse 60 deterministic Bitcoin Cash private keys in legacy and CashAddr form, with the 8-decimal BCH unit and UTXO model explained."
---

## What a Bitcoin Cash private key controls

Bitcoin Cash forked from Bitcoin and keeps the UTXO model and secp256k1 keys. A
private key signs inputs that spend coins locked to its public key; there is no
account balance, only transaction outputs. BCH removed SegWit, so the address
family is P2PKH rather than a witness program. The same key and public key hash
can be displayed as a legacy `1…` address or as a CashAddr such as
`bitcoincash:q…`. Both strings encode the same locking script; they are two
representations of one destination, not two different wallets.

## Address formats on this page

The table derives both representations for every example key:

- **Legacy P2PKH (`1…`)** — version byte `0x00` plus hash160 of the compressed
  public key, Base58Check encoded.
- **CashAddr (`bitcoincash:q…`)** — the same hash160 with the CashAddr version
  byte and checksum, base32 encoded under the `bitcoincash` prefix.

The explorer link uses the legacy form because Blockchair accepts it directly.
CashAddr exists to avoid confusion with Bitcoin addresses, but the two chains
share the legacy prefix; always confirm which network a wallet is using before
sending.

## Key encodings and limits

A BCH key can be 64 hex characters or a WIF with version byte `0x80`, giving the
`5…`, `K…` or `L…` prefixes. The WIF compression flag changes the legacy address
in the same way it does on Bitcoin, but not the CashAddr payload if the same
public key encoding is used. BCH has 8 decimals. The balance column here is a
static placeholder with reserved height. The key spends UTXOs but cannot reverse
a confirmed transaction, cannot move coins locked to a script it does not
satisfy, and cannot protect funds if the scalar is copied.
