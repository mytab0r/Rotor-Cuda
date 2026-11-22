# Wallet account link (vault-key sign-in)

## Summary

Creating or restoring a cabinet wallet now offers one explicit **Sign in with
this wallet** action. The action signs the coordinator's SIWE challenge with a
key that is already in the local vault and exchanges the signature for the
monitor session used by `/cabinet`. The vault and the server account stop being
unrelated without sending a private key anywhere.

## Identity model

- The account identity is the **EVM address derived from the vault key**
  (`secp256k1`, the `evm` row of the existing wasm `derive_report`).
- `POST /api/v1/monitor/challenge` is called with `{"chain":"evm","address":…}`.
  The coordinator builds the SIWE message and binds it to the nonce it stores.
- The message is signed locally in WASM with `evm_sign_message`, which
  implements EIP-191 `personal_sign`
  (`keccak256("\x19Ethereum Signed Message:\n" + byte-length + message)`) and
  returns `0x` + 65-byte `r || s || v` with `v = 27 + parity`.
- `POST /api/v1/monitor/login` receives
  `{"chain":"evm","message":…,"signature":…}` exactly as the monitor page sends
  it. Success returns `{token, user}`; the token is stored under the monitor
  page's localStorage key and is never rendered or logged.
- The vault key never leaves the tab. Only the EVM address, the challenge and
  its signature cross the network.

## What is verified and what is not

| Claim | Verified by this sign-in |
| --- | --- |
| Control of the EVM address derived from the vault key | **yes**, by the coordinator's EIP-191 recovery |
| Control of a Bitcoin address in the same vault | **no**, it remains a wallet-derived address |
| Control of a TRON address in the same vault | **no**, wallet-derived only |
| Control of a Solana address in the same vault | **no**, wallet-derived only |
| That the vault passphrase is correct | **no**, only that the tab could decrypt the vault |

An entry whose key has no EVM derivation (an ed25519-only key: Solana, Sui,
TON) cannot sign in; the panel says so instead of offering a broken action.
The address rows and help text keep calling non-EVM addresses wallet-derived.

## Why

The wallet could create, import and sign transactions, but the server account
that watches addresses had to be opened separately and proved with a browser
wallet extension. Reusing the key already in the vault removes that second
login without weakening the rule that keys never leave the tab.

## UX

- After a vault create or restore the lock is lifted into the same panel, which
  explains that signing in proves the EVM address only and that the key stays
  in the tab.
- A key selector lists EVM-capable entries. The action is a single
  **Sign in with this wallet** button; a signed-in state shows an account chip,
  the EVM address and a link to the account settings on `/cabinet`.
- Auto sign-in happens only when the user ticks
  "Sign me in after creating this wallet"; otherwise the button is explicit.
- Locking the vault clears the in-memory session and hides the panel. **Sign
  out** revokes the session server-side and removes the stored token.

## Non-goals

- Per-chain identity proofs (Bitcoin/TRON/Solana signatures). Those remain
  wallet-derived addresses and need their own verification slices.
- WalletConnect or browser-extension sign-in changes. The existing monitor
  flow is untouched.
- Storing keys, passphrases or derived secrets in the monitor account, or
  storing the token in the vault record.

## Next slice

1. TRON `signMessageV2` proof from a vault TRON key, reusing the coordinator's
   existing TRON verifier.
2. Bitcoin message signing (BIP-322 or a documented equivalent) before any
   Bitcoin address can become a verified identity.
3. Solana ed25519 proof from a seed-derived key.
4. A coordinator endpoint that lists the identities of a session so the wallet
   can show which vault entries are already linked.

## Areas

`wasm-core`, `site`, `coordinator` (embed only), `ops` (site map and this
change).

## Verification

- `cargo test -p rotor-wasm`: EIP-191 vectors from ethers 6.13.4, wrong-key and
  empty-message cases.
- `cargo test --release` for the workspace.
- `node apps/site/wallet-sign-test.mjs` and the full site suite.
- `node scripts/ui-audit.mjs --serve`, `check-projects`, `check-ssot`,
  `check-defect-ledger`, `gen-detector-docs --check`.
