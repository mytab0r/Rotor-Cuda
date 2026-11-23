---
chain: sui
title: "Sui seed phrases: SLIP-0010 ed25519 accounts | Crypto"
description: "60 deterministic 12-word Sui phrases derived with SLIP-0010 at m/44'/784'/0'/0'/0' into 0x accounts with BLAKE2b hashing."
---

## What a Sui seed phrase controls

Sui uses ed25519 and an object-centric model. The BIP39 words produce the
standard 64-byte seed, but the wallet follows SLIP-0010 at the hardened path
`m/44'/784'/0'/0'/0'` rather than secp256k1 BIP32. The resulting 32-byte seed
expands to an ed25519 public key, and the address is `0x` plus BLAKE2b-256 of a
one-byte scheme flag (`0x00`) concatenated with that public key. The key signs
transactions for one account, which owns coins, NFTs and Move package
capabilities. Shared objects need the object's own rules, not this key alone.

## Paths used on this page

Every row uses the hardened branch above. All segments are hardened, as
SLIP-0010 requires for ed25519. The page does not claim BIP32 secp256k1
derivation for Sui, and it does not reuse the Solana path even though both
chains start from ed25519: coin type 784 and the final account segment differ,
and the address hash is different as well.

## Address formats and limits

Rows show the 32-byte `0x` account linked to Suiscan. A Sui keypair is often
exported as 64 bytes, but the first 32 are the seed used here. A Bitcoin WIF is
a secp256k1 wrapper and cannot represent this key. SUI has nine decimals. The
scheme flag matters: a different flag over the same public key would produce a
different account string, which is why the table labels the Sui format
explicitly. Balances remain static placeholders, and every example phrase is
public by construction.
