---
chain: ethereum
title: "Ethereum private keys: 0x accounts and EIP-55 | Crypto"
description: "Browse 60 deterministic Ethereum private keys and their EIP-55 0x addresses, derived locally from the same secp256k1 key used by every EVM chain."
---

## What an Ethereum private key controls

An Ethereum private key is a secp256k1 scalar. It signs transactions and
messages for one externally owned account (EOA). The account is identified by
the last 20 bytes of keccak256 over the uncompressed public key, written as a
`0x` hexadecimal string. Unlike Bitcoin, Ethereum keeps an account state: a
balance in wei, a nonce that orders transactions, and optional code if the
address has been deployed as a contract. The key does not control that contract
code; it controls the EOA that can call it and pay for the call. A key can also
sign typed data and EIP-191 messages, which is how many wallets authenticate
without a transaction.

## Address formats on this page

This page shows one format per key: the `0x` account address with the EIP-55
mixed-case checksum. Ethereum has no native SegWit or taproot variant, because
the account is derived from the same keccak hash on every EVM network. The
checksum is a display convention, not a second address: the underlying twenty
bytes are identical with all-lowercase input. The table's address is the same
account you would see on Etherscan, and the explorer link opens that account.

## Key encodings and limits

The canonical input is 64 hexadecimal characters, with or without the `0x`
prefix. A WIF is a Bitcoin-family encoding of a secp256k1 scalar; the key
calculator accepts one and derives the Ethereum account from the same scalar,
but WIF is not an Ethereum-native format and does not record an Ethereum
network. The 18-decimal ETH unit is shown for context only: this build renders
balance placeholders, and no balance is fetched while the page is static. The
address controls mainnet ETH and any token or contract position held by the
account; it does not recover funds sent to a different address, and it cannot
reverse a transaction that the key has already signed.
