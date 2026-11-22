---
chain: polygon
title: "Polygon private keys: 0x accounts and POL gas | Crypto"
description: "Browse 60 deterministic Polygon private keys and their 0x addresses, covering POL gas, ERC-20 tokens and the shared EVM account model."
---

## What a Polygon private key controls

Polygon PoS is an EVM-compatible proof-of-stake network. A private key is a
secp256k1 scalar whose keccak account signs Polygon transactions. The account
pays gas in POL, the network's gas token, and can hold ERC-20 tokens, NFTs and
contract positions on the Polygon chain. Polygon has its own chain id, state and
validator set; the same scalar also controls the matching Ethereum account, but
the balances do not merge. The key authorizes the account's outgoing
transactions and contract calls, not the Polygon consensus layer or the bridge
contracts that connect the chain to Ethereum.

## Address formats on this page

Every row shows the standard EIP-55 `0x` account, linked to PolygonScan. Polygon
does not add a second address encoding: the twenty bytes come from the same
keccak hash as any EVM chain. The network migrated its gas token from MATIC to
POL, but that change is a token and contract change, not an address-format
change. A key imported into a Polygon wallet shows this same string, and a
bridge deposit to Polygon is credited to it after the bridge confirms.

## Key encodings and limits

The canonical input is 64 hex characters, with or without `0x`; WIF is accepted
only as a secp256k1 encoding, not as a Polygon-native export. POL has 18
decimals, and the balance cells in this build are placeholders with a reserved
height — no provider is called while the page is static. The key controls the
EOA, not the validator stake delegated through a contract, and it cannot reverse
a finalized Polygon transaction. An account with a compromised key can be
drained on every EVM network at once, so treat the scalar as the real secret.
