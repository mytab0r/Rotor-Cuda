---
chain: ton
title: "TON private keys: v3R2, v4R2 and W5 addresses | Crypto"
description: "Browse 60 deterministic TON private keys and their v3R2, v4R2 and W5 wallet addresses, with the 9-decimal TON unit and StateInit contract model explained."
---

## What a TON private key controls

TON accounts are smart contracts. A TON private key is a 32-byte ed25519 seed,
and the user-facing address is derived from the wallet contract's StateInit — the
code cell plus a data cell that stores the public key and wallet parameters — not
from the public key alone. This page shows the v3R2, v4R2 and W5 wallet contract
addresses, the three versions this site derives. The key signs messages that the
wallet contract sends, and the contract enforces its own seqno and signature
rules. Two wallet versions with the same public key produce different addresses
because their code cells differ.

## Address formats on this page

Each row is a user-friendly address for one wallet version: one workchain byte,
the 32-byte StateInit hash and a CRC16 suffix, base64url encoded. It looks like
a 48-character string and is linked to Tonviewer. The raw form (`0:…` hex)
encodes the same workchain and hash, so it is a different display of the same
account, not a second wallet. A TON address is not a base58 public key and is
not interchangeable with an EVM `0x` address. The three versions share one
public key but not one address, so import the version your wallet uses.

## Key encodings and limits

The key is 32 bytes, usually written as 64 hex characters; a 64-byte keypair or a
JSON byte array is also accepted, with the first 32 bytes used as the seed. A
Bitcoin WIF is not valid here. TON has 9 decimals, so one TON is 10^9 nanoTON.
The balance column is a reserved placeholder in this static build. The key
controls the wallet contract's outgoing messages, but it cannot change the
contract code, cannot bypass the wallet's seqno replay protection, and cannot
move funds held by a different wallet version or a multisig contract.
