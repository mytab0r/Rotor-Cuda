# wallet delta — TRON mainnet slice

## ADDED Requirements

### Requirement: TRON transaction kinds
The WASM core MUST encode two TRON contract kinds from one strict request
schema: a plain TRX `TransferContract` and a TRC-20 `transfer(address,uint256)`
carried as `TriggerSmartContract` (contract type 31). The request MUST name the
kind explicitly, MUST carry `token_contract_address` only for the TRC-20 kind,
and MUST reject unknown, duplicate or missing fields, including a TRX request
that carries a token contract.
Source: `crates/rotor-wasm/src/tron.rs`.

#### Scenario: TRC-20 payload
- GIVEN a valid owner address, a valid TRC-20 contract and an amount in base units
- WHEN the TRC-20 request is encoded
- THEN `data` is `a9059cbb`, the 20-byte recipient body left-padded to 32 bytes,
  and the amount as a 32-byte big-endian integer
- AND the contract type is 31 with type URL
  `type.googleapis.com/protocol.TriggerSmartContract`

#### Scenario: kind mismatch
- GIVEN a request whose kind is `trx` and whose `token_contract_address` is not empty
- WHEN it is encoded
- THEN the call fails and names the offending field

### Requirement: one signing path for both networks
The signature MUST be SHA-256 over `raw_data`, an RFC 6979 nonce and a 65-byte
`r || s || v` with `v = 27 + recovery_id`, verified against the derived public
key before returning. TRON mainnet and the Nile testnet MUST share this path;
the network changes the node and the endpoints, never the encoder.
Source: `crates/rotor-wasm/src/tron.rs`, `apps/site/wallet-tron.js`.

#### Scenario: mainnet is a parameter
- GIVEN the same key, recipient and amount on Nile and on mainnet
- WHEN both transactions are built
- THEN the encoding logic is identical and only the fetched ref block and the
  broadcast endpoint differ

### Requirement: mainnet arm applies to TRON
A TRON mainnet transaction MUST be refused unless the session is armed, and the
check MUST run in the codec as well as in the page. The arm MUST reset on lock,
unlock and reload. The Nile route MUST remain selectable without arming.
Source: `apps/site/wallet-tron.js`, `apps/site/wallet.js`.

#### Scenario: unarmed mainnet
- GIVEN an unlocked wallet with mainnet not armed
- WHEN a TRON mainnet transfer is prepared or confirmed
- THEN both calls fail before any node request is made

### Requirement: pinned TRON endpoints
Node calls MUST go to the providers declared for the selected TRON network in
`data/providers.json`; a user-supplied URL MUST be refused. The wallet MUST
fail over between declared providers and MUST NOT retry a broadcast.
Source: `data/providers.json`, `apps/site/wallet-tron.js`.

#### Scenario: broadcast once
- GIVEN a reviewed, signed transaction
- WHEN the user confirms
- THEN exactly one broadcast request is sent to a declared provider
- AND a provider error is shown verbatim with no retry

### Requirement: review before signing
The review MUST show the network, the sender, the recipient, the kind, the
token contract with its symbol when resolved, the amount in base and display
units, the `fee_limit` in TRX and an irreversible-action warning. A review
older than the node's expiration window MUST be refused at confirm.
Source: `apps/site/wallet.js`, `apps/site/wallet-tron.js`.

#### Scenario: expired review
- GIVEN a review built more than 60 seconds ago
- WHEN the user confirms
- THEN the transaction is rebuilt from fresh node data and the stale review is
  not signed
