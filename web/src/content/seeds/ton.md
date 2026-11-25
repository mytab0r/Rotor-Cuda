---
chain: ton
title: "TON seed phrases: v3R2, v4R2 and W5 wallets | Crypto"
description: "60 deterministic 12-word TON phrases derived with SLIP-0010 at m/44'/607'/0' into v3R2, v4R2 and W5 wallet contract addresses."
---

## What a TON seed phrase controls

TON accounts are smart contracts, so the user-facing address is not just a
public-key encoding. The BIP39 phrase produces a 64-byte seed, and the wallet
applies SLIP-0010 ed25519 at the hardened path `m/44'/607'/0'`. The resulting
32-byte key signs messages that a wallet contract sends. The address is derived
from that contract's StateInit — its code cell plus a data cell holding the
public key and wallet parameters. Two wallet versions over one public key
therefore have different addresses.

## Paths used on this page

The table derives the same SLIP-0010 key once and renders three contracts from
it: the older v3R2 and v4R2 wallets and the current W5 wallet. `m/44'/607'/0'`
is the branch the seed directory uses and its tests pin; this page does not
claim a BIP32 secp256k1 derivation for TON. All three addresses come from the
WASM report. They are shown together because a holder may meet any of these
versions in a wallet import flow.

## Address formats and limits

Addresses are 48-character base64url strings with a workchain byte, a 32-byte
StateInit hash and a CRC16 suffix, linked to Tonviewer. The raw `0:…` hex form
is the same account in another display. TON has nine decimals. The key controls
messages sent by its wallet contract; it cannot change that contract's code or
bypass its sequence protection. Balance cells are reserved placeholders in this
static build, and the example phrases are the first sixty 128-bit entropy
values — public, reproducible and never a wallet.
