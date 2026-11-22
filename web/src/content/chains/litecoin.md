---
chain: litecoin
title: "Litecoin private keys: P2PKH, SegWit and Taproot | Crypto"
description: "Browse 60 deterministic Litecoin private keys in four formats — P2PKH, nested SegWit, native SegWit and taproot — derived locally."
---

## What a Litecoin private key controls

Litecoin is a UTXO chain built on secp256k1. A private key signs the inputs that
spend coins locked to its public key, and the key controls every UTXO that its
locking scripts can satisfy. Litecoin's account model is therefore the same
shape as Bitcoin's: no stored balance, only coins scattered across transaction
outputs. The same scalar yields several address encodings, and each encoding is
a different locking script. Litecoin also has extension blocks (MWEB) for
confidential transfers; this page does not derive MWEB addresses, because their
key material and encoding are outside the four single-key scripts shown here.

## Address formats on this page

The table derives four formats for each example key:

- **P2PKH legacy (`L…`)** — hash160 of the compressed public key with version
  byte `0x30`, Base58Check encoded.
- **P2SH-P2WPKH nested (`M…`)** — a witness-v0 redeem script behind version
  byte `0x32`.
- **P2WPKH native (`ltc1q…`)** — the witness-v0 program with human-readable part
  `ltc`, bech32 encoded.
- **P2TR taproot (`ltc1p…`)** — the tweaked x-only key as a witness-v1 program,
  bech32m encoded.

The compressed key is used for all four, matching the modern default. A legacy
address derived from an uncompressed key would be a fifth, older form and is
not part of this table.

## Key encodings and limits

A Litecoin key can be 64 hex characters or a WIF with version byte `0xb0`,
which produces the `6…` or `T…` prefixes. The WIF records compression, so it can
change the legacy address even though the scalar is the same. LTC has 8
decimals. The balance column is a reserved placeholder in this static build;
no provider is queried until the page's client-side balance step runs. The key
spends UTXOs but cannot reverse a confirmed transaction or move coins held by a
different script, including an MWEB output.
