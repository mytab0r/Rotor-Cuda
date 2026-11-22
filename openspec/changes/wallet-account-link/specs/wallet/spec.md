# wallet delta

## ADDED Requirements

### Requirement: vault-key monitor sign-in
The cabinet wallet MUST offer a monitor sign-in that uses a key already in the
local vault. The page MUST request a coordinator SIWE challenge, sign the exact
returned message locally with EIP-191 `personal_sign` and exchange the signature
for a monitor session. The private key MUST never leave the tab.

#### Scenario: explicit sign-in from an unlocked vault
- GIVEN an unlocked vault with a secp256k1 key
- WHEN the visitor presses "Sign in with this wallet"
- THEN the page derives the EVM address from the existing wasm report
- AND calls `POST /api/v1/monitor/challenge` with `{chain:"evm", address}`
- AND signs the returned message locally
- AND calls `POST /api/v1/monitor/login` with `{chain:"evm", message, signature}`
- AND shows the account chip and settings link on success
- AND never sends the key, WIF or passphrase to the coordinator

#### Scenario: no silent sign-in
- GIVEN an unlocked vault
- WHEN a key is imported without the opt-in box ticked
- THEN no challenge or login request is made
- AND the explicit action is offered instead

#### Scenario: opt-in sign-in after import
- GIVEN the visitor has ticked "Sign me in after creating this wallet"
- WHEN a secp256k1 key is added to the vault
- THEN the page performs the challenge/login exchange automatically
- AND a failed request leaves the card signed out

### Requirement: EVM-only identity and honest exclusions
The session identity MUST be the EVM address derived from the vault key. The UI
MUST NOT claim server-verified ownership of Bitcoin, TRON or Solana addresses,
and MUST NOT offer EVM sign-in for an entry without an EVM derivation.

#### Scenario: mixed vault
- GIVEN a vault with an EVM-capable key and an ed25519-only key
- WHEN the sign-in panel opens
- THEN only the EVM-capable key is listed
- AND the help text states that ed25519-only keys cannot sign in with EVM
- AND the Bitcoin/TRON/Solana addresses are described as wallet-derived, not
  verified by this sign-in

### Requirement: session storage and lifecycle
The session token MUST be stored under the monitor page's key, never rendered,
logged, put in a URL or stored in the vault record. Locking the vault MUST clear
the in-memory session and hide the sign-in panel. Sign out MUST revoke the
session and remove the token. A stored token MUST be validated once on unlock
with `GET /api/v1/monitor/me`; HTTP 401 MUST clear it and return the card to the
signed-out state without an error banner.

#### Scenario: revoked or expired token on unlock
- GIVEN a stored monitor token that the coordinator no longer accepts
- WHEN the vault is unlocked
- THEN the page calls `GET /api/v1/monitor/me` once
- AND clears the token on HTTP 401
- AND shows the signed-out card with no error banner

#### Scenario: offline unlock keeps the local session
- GIVEN a stored monitor token and an unreachable coordinator
- WHEN the vault is unlocked
- THEN the validation request fails without HTTP 401
- AND the card keeps the optimistic signed-in state and shows no banner

#### Scenario: lock and sign out
- GIVEN a signed-in wallet
- WHEN the visitor locks the vault
- THEN the sign-in card and account chip are hidden
- WHEN the visitor unlocks and presses Sign out
- THEN `POST /api/v1/monitor/logout` is attempted
- AND the stored token is removed even if the coordinator is unreachable
