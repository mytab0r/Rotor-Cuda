# Send domain

## Requirements

### Requirement: WIF keys on the EVM and TRON testnet send routes
The `parseSecret` function MUST accept a 64-hex key first and then a Bitcoin
WIF on `ethereum-sepolia`, `bnb-testnet`, `usdt-sepolia` and `tron-nile`.
It MUST accept WIF version `0x80` (mainnet) and `0xef` (testnet), compressed or
uncompressed, verify the Base58Check checksum, and return the same
`{chain, keyBytes, keyHex}` shape as the hex path. It MUST reject other WIF
versions. The WIF version byte MUST NOT select a chain and MUST NOT weaken the
testnet gate. Source: `apps/site/send.js` (`parseWifForSecpChain`,
`parseSecret`).

#### Scenario: mainnet WIF on an EVM testnet route
- GIVEN the published compressed mainnet WIF for key `0…001`
- WHEN it is parsed for `ethereum-sepolia`
- THEN `keyHex` is the 64-hex key and the derived address is the same as from
  that hex key

#### Scenario: bad checksum
- GIVEN a WIF whose checksum bytes were altered
- WHEN it is parsed for any route
- THEN it is rejected with a checksum error and no key bytes are returned

#### Scenario: foreign-coin WIF
- GIVEN a Litecoin WIF (version `0xb0`)
- WHEN it is parsed for `tron-nile`
- THEN it is rejected because only Bitcoin `0x80`/`0xef` versions are accepted

#### Scenario: mainnet cannot be selected
- GIVEN a Bitcoin mainnet WIF on `tron-nile`
- WHEN the review is prepared
- THEN the transaction still targets TRON Nile and the mainnet slug/endpoints
  remain rejected

### Requirement: TRON address parity and signing from a WIF
The TRON route MUST derive the same address from a WIF and the equivalent hex
key through the local WASM core, and MUST build and sign the same Nile
transaction. Source: `apps/site/send.js` (`deriveAddress`, `signTronTransfer`).

#### Scenario: key 1 vector
- GIVEN key `0…001` as hex or as any accepted Bitcoin WIF
- WHEN the TRON address is derived
- THEN the result is `TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC`
- AND the existing review/sign path produces a signed Nile transaction

### Requirement: Bitcoin route behaviour is unchanged
The Bitcoin route MUST keep accepting only a compressed Bitcoin testnet WIF
(`0xef`) or a 64-hex key; a Bitcoin mainnet WIF and an uncompressed testnet WIF
MUST stay rejected. Source: `apps/site/send.js` (Bitcoin branch of
`parseSecret`).

#### Scenario: mainnet WIF on the Bitcoin route
- GIVEN a Bitcoin mainnet WIF
- WHEN it is parsed for `bitcoin-testnet`
- THEN it is rejected with the mainnet message

### Requirement: key-entry UI
Every send route MUST label the key field `Testnet WIF or 64-hex key` and list
WIF first in its helper text. When an EVM/TRON route accepts a WIF, the page
MUST show exactly: "Bitcoin WIF accepted as a 32-byte key; the WIF network byte
does not select the chain." The notice MUST be cleared together with the key.
Source: `apps/site/send.html`, `apps/site/send.js` (`setWifNotice`).

#### Scenario: WIF pasted on TRON
- GIVEN a testnet WIF pasted into `/send/tron`
- WHEN the address is derived
- THEN the notice is visible and the derived T... address matches the hex key

#### Scenario: hex pasted on TRON
- GIVEN a 64-hex key pasted into `/send/tron`
- WHEN the address is derived
- THEN the WIF notice stays hidden
