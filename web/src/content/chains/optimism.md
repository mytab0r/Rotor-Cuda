---
chain: optimism
title: "Optimism private keys: 0x accounts on the OP Stack | Crypto"
description: "Browse 60 deterministic Optimism private keys and their 0x addresses. One key uses ETH for gas on the OP Stack and holds OP tokens."
---

## What an Optimism private key controls

OP Mainnet is an optimistic rollup built on the OP Stack. A private key is a
secp256k1 scalar whose keccak-derived account signs L2 transactions. The account
holds ETH for gas and can hold OP, ERC-20 tokens and other contract positions on
the rollup. OP Mainnet posts transaction data to Ethereum and derives its
security from that settlement layer, but the account state, nonce and gas price
are local to the L2. The same scalar controls the same address on Ethereum and
on every OP Stack chain, so a key should be treated as shared EVM material, not
as an Optimism-only secret.

## Address formats on this page

Each row is the EIP-55 `0x` account, and the explorer link opens the Optimistic
Etherscan view. Optimism has no chain-specific address prefix: the twenty bytes
behind the checksum are identical to the Ethereum account for that key. The OP
token is a contract on the network, so holding it does not change the address
format. A bridge transfer to Optimism credits this same `0x` string after the
bridge message is processed; the key only signs the eventual L2 transaction.

## Key encodings and limits

The input is 64 hexadecimal characters, with or without `0x`. A WIF is accepted
by the key calculator because it encodes the same curve, but it is not an OP
Stack format and carries no chain id. ETH uses 18 decimals for gas and OP uses
its own contract and decimals; the balance cells here are reserved placeholders
until the client-side balance step runs. The key cannot change the rollup's
challenge window, cannot withdraw instantly without the bridge's delay, and
cannot spend assets that the account does not hold. Keep the scalar offline for
any account with real value.
