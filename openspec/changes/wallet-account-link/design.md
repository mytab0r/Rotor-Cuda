# Wallet account link design

## Boundaries

- `crates/rotor-wasm` owns EIP-191 hashing and secp256k1 signing. It never sees
  the network, a token or a vault passphrase.
- `apps/site/wallet-sign.js` owns the wasm call, the challenge/login exchange
  and the read-only session validation. It never stores a token.
- `apps/site/wallet.js` owns the vault, the sign-in card and the monitor token's
  lifecycle in `localStorage`.
- The coordinator owns the SIWE challenge (`/api/v1/monitor/challenge`), EIP-191
  recovery and session issuance (`/api/v1/monitor/login`). It never receives a
  private key or a vault passphrase.

## Signing

The message is the coordinator's SIWE string, signed exactly as returned. The
wasm core builds `keccak256("\x19Ethereum Signed Message:\n" + byte-length +
message)`, signs it deterministically (RFC 6979, low-S) and returns 65 bytes
`r || s || v` with `v = 27 + parity`. The JS glue writes the raw 32-byte key
into wasm memory, never copies it to hex, validates the response shape and wipes
the wasm copy and the result buffer in `finally`. The Rust ABI also wipes the
caller's key copy and its stack copy before returning.

## Flow

1. Pick a vault entry and derive its EVM address from the existing
   `derive_report` output (`evm` row). The address is public and may be cached.
2. `POST /api/v1/monitor/challenge` with `{chain:"evm", address}`. The
   coordinator stores the nonce and returns the exact SIWE message.
3. Sign that message locally with `evm_sign_message`.
4. `POST /api/v1/monitor/login` with `{chain:"evm", message, signature}`. The
   coordinator recovers the signer, compares it with the claimed address,
   consumes the nonce and returns `{token, user}`.
5. Store `token` under `rotor-monitor-token` (the monitor page's key) and the
   public account address separately. Neither is rendered or logged; only the
   address appears in the chip and the account line.

The action is explicit. Automatic sign-in runs only when the user ticks "Sign me
in after creating this wallet", and only after a key import that lands in the
vault. A failed challenge, signature or login never stores a token.

## Session lifecycle

- On unlock, a stored token is shown optimistically and validated once with
  `GET /api/v1/monitor/me`.
- HTTP 401 (expired TTL, logout on `/cabinet`) clears the token and returns the
  card to the signed-out state without an error banner.
- A network failure or a non-401 server error keeps the optimistic state; the
  next user action surfaces the real error.
- Lock clears the in-memory session and hides the card. The stored token is the
  monitor page's own session and stays for it.
- Sign out calls `POST /api/v1/monitor/logout`, then removes the token even when
  the server is unreachable.

## Identity

The account identity is the EVM address derived from the vault key. The sign-in
proves control of that EVM address only. Bitcoin, TRON and Solana entries keep
their wallet-derived addresses and are not verified by this flow. Ed25519-only
entries (Solana, Sui, TON) have no EVM derivation; they are not listed and the
help text says EVM sign-in is unavailable for them.

## Threat model

- The key never leaves the tab: only the EVM address, the challenge and the
  signature cross the network.
- The SIWE domain is coordinator configuration, never the request `Host`.
  The message is signed byte-for-byte as returned, so a domain swap fails
  verification.
- XSS: the account address is rendered with `textContent`; the token is never
  placed in the DOM, logs, URLs or error messages.
- Stale session: validation on unlock prevents a revoked token from showing a
  signed-in card.
- Wrong chain/curve: only secp256k1 entries with an `evm` derivation row are
  offered.

## Non-goals

Per-chain identity proofs (Bitcoin message signing, TRON `signMessageV2`,
Solana ed25519) and WalletConnect/browser-extension sign-in. Those are separate
slices and do not change this flow.
