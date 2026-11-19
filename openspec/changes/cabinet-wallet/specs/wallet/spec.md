# wallet delta

## ADDED Requirements

### Requirement: local encrypted vault
The cabinet wallet MUST store imported WIF/hex keys only in an encrypted local
vault. The encryption key MUST be derived from a user passphrase with
PBKDF2-SHA256 (at least 600,000 iterations) and the payload MUST be encrypted
with AES-GCM-256 using a fresh IV on every save. The coordinator MUST NOT receive
or persist a key, WIF or passphrase.

#### Scenario: lock and unlock
- GIVEN an unlocked vault with one imported WIF
- WHEN the visitor locks and reloads the page
- THEN no secret is visible or stored in plaintext
- AND unlocking with the correct passphrase restores the address
- AND a wrong passphrase shows an error without decrypting anything

### Requirement: watch-only address management
The wallet MUST list imported addresses grouped by chain with balance, explorer
link, label and copy action. Balance calls MUST be opt-in, send only public
addresses and show per-row provider errors without hiding other rows.

#### Scenario: multi-chain list
- GIVEN imported BTC and ETH keys
- WHEN the wallet opens
- THEN both addresses appear under their chains
- AND each has an explorer link
- AND no private key is sent to a provider

### Requirement: transaction review before signing
The wallet MUST decode every transaction into a review screen showing network,
destination, value, fee, change, nonce/chain id and the exact raw bytes before
any signature is produced. Broadcasting MUST require an explicit confirmation.

#### Scenario: EVM testnet send
- GIVEN an unlocked Sepolia key and a valid destination
- WHEN the visitor builds and reviews a transaction
- THEN the review shows chain id, nonce, fee and raw hex
- AND no signature exists until Confirm is pressed

### Requirement: direct broadcast with honest origin
Signed transactions MUST be sent directly from the browser to the selected
public provider with the browser's real `Origin`. The wallet MUST NOT spoof
`Origin`/`Referer` or bypass CORS. A same-origin proxy MAY be used only as an
explicit fallback when the provider blocks CORS, and it MUST forward only a
signed raw transaction with size and rate limits.

#### Scenario: CORS fallback
- GIVEN a provider that rejects the browser request
- WHEN the visitor chooses the documented fallback
- THEN the UI states that the signed raw transaction goes through Rotor
- AND the proxy stores nothing and returns the provider response

### Requirement: testnet-first rollout
The wallet MUST default to testnet for signing and broadcast. Mainnet MUST
remain disabled until testnet evidence is recorded in the change.

#### Scenario: mainnet locked
- GIVEN a fresh wallet
- WHEN the network selector opens
- THEN mainnet signing is disabled with an explanation
