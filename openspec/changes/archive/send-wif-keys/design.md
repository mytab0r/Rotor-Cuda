# Design: WIF on the testnet send routes

## D1. WIF semantics on EVM and TRON

A Bitcoin WIF is `Base58Check(version || key[32] || optional 0x01)`.
The 32 key bytes are the secret; the version byte identifies the Bitcoin
network and the trailing byte records the corresponding public-key compression
preference. EVM and TRON consume the scalar directly, so neither byte changes
the derived address.

Decision: on `isEvmChain` and `isTronChain` routes accept version `0x80`
(mainnet) and `0xef` (testnet), compressed or uncompressed, and use only the 32
bytes. Reject every other version with an explicit message. This does not
weaken the testnet gate: `assertTestnetChain`, the chain-id guard and the HTTP
allowlists are untouched. A mainnet WIF cannot select a mainnet chain.

Alternative rejected: requiring a testnet WIF only. It would refuse the key a
user actually has and buys no safety, because the route cannot reach a mainnet
endpoint from the WIF version byte.

## D2. Parsing order and shape

`parseSecret(text, chain)` keeps its contract: `{chain, keyBytes, keyHex}`.
Hex is tried first (so a 64-hex string that also happens to be valid base58 is
never reinterpreted), then `decodeWif`. The Bitcoin route keeps its own branch
and its testnet-compressed rule. `keyLooksComplete` accepts either a 64-hex key
or a 50–53 character base58 string on every route; that is a paste-state hint
only, never an acceptance decision.

## D3. Derivation parity

The page derives through the existing WASM core. `deriveAddress(wasm, bytes,
chain)` is factored out of `init` so the Node test can run the same code: EVM
and TRON use the mainnet report (`derive_report`), Bitcoin uses
`derive_report_network(..., 1)`. For key `0…001` the test pins
`TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC` for TRON and the EIP-55 EVM address, and
asserts hex, mainnet WIF and testnet WIF all derive them.

## D4. UI

Label `Testnet WIF or 64-hex key` on all five routes; helper text lists WIF
first. A hidden `#send-wif-notice` paragraph is filled only when an EVM/TRON
route parses a WIF, with the exact sentence from the request. The notice is
cleared by `wipeKey`, the clear button and `pagehide`, together with the key.

## D5. Security

The WIF is decoded in memory, the key bytes are zeroed by the existing
`wipeKey`, and nothing about the WIF is stored or logged. The tests keep the
existing `containsSecret` assertion over the prepare/sign/broadcast payloads.
