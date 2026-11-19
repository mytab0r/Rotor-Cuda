# Cabinet wallet: non-custodial multi-chain wallet

## Summary

Add a wallet to the personal cabinet for managing addresses across networks from
WIF/hex keys. Keys are imported and encrypted in the browser; the coordinator
never receives a private key, WIF, seed or password. The wallet is watch-only by
default, then gains an explicit local-signing and direct-broadcast flow.

## Why

The calculators already derive addresses for 18 networks, but a user who wants
to manage an address has to copy its key into another site to check balances or
send a transaction. The cabinet is the natural place to keep a local, encrypted
set of keys and to build, review, sign and broadcast transactions without
leaving Rotor.

## Goals

1. Local encrypted vault (WebCrypto AES-GCM + PBKDF2, IndexedDB) with import,
   labels, lock/unlock, auto-lock and encrypted backup/restore.
2. Watch-only address management for all supported networks: group by chain,
   balance and history through public APIs, explorer links.
3. Transaction builder/decoder with an explicit review screen: inputs, outputs,
   fee, change, network, nonce; no signing before review.
4. Signing happens locally, in the existing WASM core; broadcast goes directly
   from the browser to a public RPC/API with the honest `Origin`.
5. Testnet-first. Mainnet is an explicit switch after the testnet flow is
   verified.

## Non-goals

- Custody: the coordinator never stores or decrypts user keys.
- Origin/Referer spoofing, bypassing CORS, or disguising Rotor as another site.
- Seed-phrase wallet in the first phase (WIF/hex only; seed studio stays
  separate).
- Automatic sweeping, silent broadcast or server-side signing.

## Security requirements

- Vault: random salt, PBKDF2-SHA256 >= 600k iterations, AES-GCM-256, unique IV
  per save; no plaintext key in localStorage, URLs, logs or network.
- Lock clears decrypted keys from memory and UI; auto-lock after idle.
- Every broadcast shows the exact raw transaction and destination first.
- Direct providers are documented; a same-origin proxy is a fallback only when
  the provider does not allow CORS, and the UI says so.
- No provider receives a private key, only a signed raw transaction or public
  addresses.

## Success criteria

- A user imports a WIF, sees the derived address and balance, locks the vault,
  unlocks it and still sees the address.
- A testnet EVM transaction is built, reviewed, signed locally and broadcast
  directly; the explorer link confirms it.
- A testnet Bitcoin transaction is built, reviewed, signed locally and
  broadcast directly; the explorer link confirms it.
- The server access log contains no private key, WIF or password.
