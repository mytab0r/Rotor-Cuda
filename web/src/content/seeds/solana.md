---
chain: solana
title: "Solana seed phrases: SLIP-0010 ed25519 paths | Crypto"
description: "60 deterministic 12-word Solana phrases derived with SLIP-0010 at m/44'/501'/0'/0' into reproducible base58 ed25519 accounts."
---

## What a Solana seed phrase controls

Solana does not use secp256k1. The BIP39 words are converted to the standard
64-byte seed, but the wallet then applies SLIP-0010 ed25519 derivation rather
than BIP32. The resulting 32-byte seed is expanded by ed25519 into a 32-byte
public key, and the account address is simply that public key in base58 — no
keccak, hash160 or `0x` step. The key signs transactions for one account, which
can hold SOL, SPL tokens and NFTs, and which may own program accounts. Rent and
fees are paid in lamports from that account.

## Paths used on this page

Every row uses the hardened path `m/44'/501'/0'/0'`, the branch most Solana
wallets call the first Phantom-style account. All four levels are hardened,
which SLIP-0010 requires for ed25519. This is not the same operation as a
Bitcoin BIP32 path: ed25519 has no public-key child derivation here, and adding
an unhardened index would be rejected by the derivation code rather than
silently producing another account.

## Address formats and limits

Each address is a base58 ed25519 public key linked to Solscan. A Solana keypair
is often exported as 64 bytes, but only the first 32 are the seed used here.
SOL has nine decimals. A Bitcoin WIF cannot represent this key. The balance
column is a static placeholder with reserved height, and these example phrases
are the lowest entropy values of the BIP39 range, so they are public and must
never be funded.
