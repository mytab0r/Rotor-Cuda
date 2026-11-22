---
chain: solana
title: "Solana private keys: ed25519 and base58 addresses | Crypto"
description: "Browse 60 deterministic Solana private keys and their base58 ed25519 addresses, with the 9-decimal SOL unit and account model explained."
---

## What a Solana private key controls

Solana uses ed25519, not secp256k1. A Solana private key is a 32-byte seed, and
the corresponding public key is a 32-byte ed25519 point. The account address is
the base58 encoding of that public key — there is no hash step and no `0x`
prefix. The key signs transactions for one account, which can hold SOL, SPL
tokens and NFT metadata, and which can own or delegate program accounts. Solana
uses a fee and rent model: an account needs enough lamports to stay rent-exempt,
and the key pays transaction fees. A program-derived address is not this key's
account and is not derived in this table.

## Address formats on this page

Every row shows the base58 ed25519 account, linked to Solscan. The table does not
show an EVM address, because a Solana key is not a secp256k1 scalar and cannot
produce one. A 64-byte Solana keypair contains the seed and the public key; the
key calculator accepts the 64-byte form, a 32-byte seed, a JSON byte array or a
base58 keypair, and uses the first 32 bytes as the seed. The example rows use
keys 1–60 as seeds, so the addresses are reproducible but have no special
privilege.

## Key encodings and limits

The canonical raw form is 32 bytes, often written as 64 hexadecimal characters;
wallets also export a 64-byte secret key or a base58 keypair string. A Bitcoin
WIF is meaningless here: it encodes secp256k1, not ed25519. SOL has 9 decimals,
so one SOL is 10^9 lamports. The balance cells in this static build are
placeholders with reserved height. The key controls the account and anything it
owns, but it cannot recover rent from an account that is not rent-exempt, cannot
change a program's code, and cannot sign for a program-derived address without
the program's own rules.
