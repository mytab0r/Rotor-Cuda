---
chain: sui
title: "Sui private keys: ed25519 accounts and BLAKE2b | Crypto"
description: "Browse 60 deterministic Sui private keys and their 0x ed25519 accounts, with the 9-decimal SUI unit and BLAKE2b address derivation."
---

## What a Sui private key controls

Sui uses ed25519 keys and an object-centric account model. A Sui address is not
the raw public key: it is `0x` plus the BLAKE2b-256 hash of a one-byte signature
scheme flag (`0x00` for ed25519) followed by the 32-byte public key. The private
key signs transactions for one account, which owns objects such as coins, NFTs
and Move package capabilities. SUI pays gas, and the account's objects are
versioned and can be transferred or shared through Move calls. The same 32-byte
ed25519 seed produces a Solana address too, but the two chains hash or encode
the public key differently, so the addresses do not match.

## Address formats on this page

Every row shows the `0x` Sui account derived with the ed25519 scheme flag, linked
to Suiscan. The table does not show a base58 form, because Sui's native display
is the 32-byte hex address. A 64-byte Sui keypair contains the seed and public
key; the key calculator accepts a 32-byte seed, a JSON byte array or a base58
keypair and uses the first 32 bytes. The example rows use keys 1–60 as seeds, so
the accounts are reproducible but have no special status.

## Key encodings and limits

The raw key is 32 bytes, often exported as 64 hex characters. A Bitcoin WIF is a
secp256k1 encoding and is not valid for Sui's ed25519 account. SUI has 9
decimals. The balance column here is a fixed-height placeholder in the static
build. The key controls the account and the objects it owns, but it cannot
change a Move package's code, cannot unilaterally spend a shared object, and
cannot recover objects transferred to an address whose key it does not hold.
The scheme flag matters: a different flag over the same public key would produce
a different address.
