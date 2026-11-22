---
chain: tron
title: "TRON private keys: Base58Check T addresses | Crypto"
description: "Browse 60 deterministic TRON private keys and their T-addresses. TRX uses 6 decimals, and the same keccak account appears as an EVM 0x address."
---

## What a TRON private key controls

TRON uses secp256k1 and derives its account from keccak256, like Ethereum, but
it displays the address differently. The account bytes are the last twenty bytes
of the keccak hash; TRON prefixes them with `0x41`, appends a double-SHA256
checksum and encodes the result in Base58Check, producing a `T…` address. The
key signs TRON transactions for one account, which holds TRX, TRC-20 tokens and
TRC-721 assets. TRON's resource model is not a simple gas balance: transactions
consume bandwidth and energy, which can be staked or burned. The account also
has a sequence number that orders transactions.

## Address formats on this page

Each row shows the Base58Check `T…` account and links it to Tronscan. The same
key also yields an EVM `0x` account because the underlying twenty bytes are the
keccak hash; the key calculator shows both, but this page follows TRON's native
display. The `T…` string is not a checksum variant of the `0x` string — it is a
different encoding with a version byte and a Base58 checksum. Sending TRC-20
tokens to the `0x` form without a compatible wallet path is a common mistake;
use the `T…` address on TRON.

## Key encodings and limits

A TRON key is normally 64 hexadecimal characters, optionally with `0x`. TRON
does not use Bitcoin WIF: a WIF encodes the same curve but not TRON's address
prefix or resource model. TRX has 6 decimals, so one TRX is 10^6 sun. The balance
column here is a reserved placeholder in the static build. The key controls the
account's TRX and token balances and its staking positions, but it cannot
recover energy already consumed, cannot undo a confirmed transaction, and cannot
sign for a contract's own address.
