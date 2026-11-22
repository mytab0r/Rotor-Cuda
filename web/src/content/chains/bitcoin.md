---
chain: bitcoin
title: "Bitcoin private keys: P2PKH, SegWit and Taproot | Crypto"
description: "Browse 60 deterministic Bitcoin private keys in four formats — P2PKH, nested SegWit, native SegWit and taproot — derived locally in your browser."
---

## What a Bitcoin private key controls

A Bitcoin private key is a 256-bit number on the secp256k1 curve. It signs the
inputs of a transaction, and the signature proves that the spender owns the
coins locked to the matching public key. Bitcoin has no account balance stored
under an address: value sits in unspent transaction outputs (UTXOs), and a key
controls every UTXO whose locking script it can satisfy. Losing the key loses
those outputs; copying the key copies control. The same scalar always produces
the same public key, so the four address encodings below are four views of one
key, not four separate wallets.

## Address formats on this page

The table derives all four single-key formats for every example key:

- **P2PKH legacy (`1…`)** — hash160 of the compressed public key behind version
  byte `0x00`, Base58Check encoded. It is the oldest widely supported form.
- **P2SH-P2WPKH nested (`3…`)** — a witness-v0 redeem script wrapped in P2SH,
  useful for wallets that understand SegWit but not bech32.
- **P2WPKH native (`bc1q…`)** — the witness-v0 program with human-readable part
  `bc`, bech32 encoded.
- **P2TR taproot (`bc1p…`)** — the x-only internal key tweaked for an empty
  script path, witness v1, bech32m encoded.

The compressed and uncompressed public keys give different legacy addresses;
this table uses the compressed key, which is the modern default. Taproot always
uses the compressed key.

## Key encodings and limits

A Bitcoin key can arrive as 64 hexadecimal characters or as Wallet Import
Format (WIF): Base58Check with version byte `0x80`, which produces the familiar
`5…`, `K…` or `L…` prefixes. A WIF also records whether the public key was
compressed, so the same scalar can yield a different legacy address from a
compressed and an uncompressed WIF. The example rows use the bare scalar, so
they show the compressed-key result. Mainnet addresses are shown here; testnet
uses different version bytes and the `tb` prefix and is not part of this table.
