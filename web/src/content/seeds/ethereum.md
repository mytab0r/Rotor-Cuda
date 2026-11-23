---
chain: ethereum
title: "Ethereum seed phrases: BIP44 and 0x accounts | Crypto"
description: "60 deterministic 12-word Ethereum phrases derived at the BIP44 coin-60 path into EIP-55 0x accounts, with no key or phrase sent anywhere."
---

## What an Ethereum seed phrase controls

From the mnemonic, Ethereum wallets build the standard 64-byte BIP39 seed and
derive a secp256k1 key. The matching externally owned account is the last
twenty bytes of keccak256 over the uncompressed public key. That account stores
a balance in wei, a nonce that orders its transactions, and any contract state
deployed at its address. Holding the seed therefore means holding the ability
to sign transfers, contract calls and EIP-191 messages for the account. It does
not grant control of token contracts or of contracts the account merely calls.

## Derivation path used here

Every row uses one path: `m/44'/60'/0'/0/0` — coin type 60, account zero, change
zero, first address. This is the path MetaMask, Hardware wallets and most EVM
software default to. Index zero is shown so the example is reproducible; a real
wallet increments the final component for each new receive address. BIP39 also
accepts an optional passphrase, which changes the seed and therefore every key
below it. This page uses an empty passphrase.

## Address format and limits

The account is written as `0x` plus forty hex characters with the EIP-55
mixed-case checksum. The checksum is a display convention: the underlying
twenty bytes are the same with lowercase input. Ethereum has no SegWit, base58
or taproot form, and a Bitcoin WIF is only a secp256k1 wrapper, not an Ethereum
export. ETH uses eighteen decimals. The balance cells are static placeholders;
the page makes no network request.
