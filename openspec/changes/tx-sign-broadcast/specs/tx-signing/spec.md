# tx-signing domain

## Requirements

### Requirement: client-side key custody
The signing flow MUST keep the private key in the browser and MUST NOT include
the key, its WIF, its decimal form, or any other secret derived from it in a
network request, URL, history entry, storage API, cookie, console message,
telemetry event or error report. Public addresses, public keys, UTXO identifiers
and the final raw transaction are explicitly allowed. The coordinator MUST NOT
expose an endpoint that accepts a private key or a signed transaction. The key
MUST be handed to a dedicated signer worker or an equally bounded lifetime, zeroed after use, and the worker
or wasm instance MUST be discarded on "Clear" or `pagehide`. Source:
`web/key.js:2,90-100,992-996`, `src/coordinator/mod.rs:31-41,490-505`.

#### Scenario: derive and sign without leakage
- GIVEN a known test key is entered and a transaction is signed
- WHEN all network, storage, URL and console activity is recorded
- THEN the key's hex, WIF and decimal forms are absent from every record
- AND the only transaction POST body is the raw signed transaction

#### Scenario: no server signing route
- GIVEN the coordinator's route table
- WHEN a request tries to submit a private key or ask the server to sign
- THEN no such route exists and the request is not handled by the coordinator

### Requirement: P2WPKH construction and BIP143 sighash
The builder MUST create a version-2 transaction with P2WPKH inputs, SIGHASH_ALL,
an optional RBF sequence, the user's outputs, and change to the same P2WPKH
address. It MUST compute the BIP143 sighash with scriptCode
`0x1976a914{hash160(pubkey)}88ac`, serialize the segwit transaction, sign with
RFC6979 deterministic ECDSA (low-S, DER), and append the sighash byte. It MUST
verify the signature locally before returning. Source:
`src/secp.rs:45,72`, `src/hashes.rs:7,13,23`,
`src/scalar.rs:83-142`, `crates/rotor-wasm/src/derive.rs:29-95`.

#### Scenario: BIP143 vector
- GIVEN the published BIP143 P2WPKH example key, outpoint, amount and output
- WHEN the builder signs with SIGHASH_ALL
- THEN the raw transaction, txid, sighash and signature match the vector

#### Scenario: change and dust
- GIVEN selected inputs exceed outputs plus fee by an amount below dust
- WHEN the plan is built
- THEN no change output is created and the remainder is added to the fee
- AND the review shows the increased fee

### Requirement: signature binding and review
Signing MUST require an explicit review of the exact network, inputs, outputs,
change, fee, fee rate, vsize, RBF flag and txid. Any subsequent change to the
key, network, input set, output set, values, fee or RBF flag MUST invalidate the
signature and clear the signed raw transaction. The flow MUST NOT sign or
broadcast automatically. Source: design D9, D13.

#### Scenario: edited output after signing
- GIVEN a signed transaction
- WHEN the user changes any output value or address
- THEN the UI returns to the unsigned state, the old raw transaction is cleared,
  and the new plan requires a new signature

#### Scenario: tampered signature
- GIVEN a signed transaction whose output was modified after signing
- WHEN it is verified locally or submitted to `testmempoolaccept`
- THEN verification fails and the node rejects it

### Requirement: network-aware derivation and binding
The page MUST derive and display addresses/WIF for the selected network
(mainnet, testnet4, testnet3; regtest in tests) and MUST reject an output
address or WIF from a different network. The transaction MUST be broadcast only
to endpoints of the selected network. Source: `src/base58.rs:7-9,68-82`,
`crates/rotor-wasm/src/derive.rs:29-95`, design D3.

#### Scenario: testnet key, mainnet address
- GIVEN the network selector is testnet4
- WHEN a mainnet `bc1...` output address is entered
- THEN the builder rejects it before signing
- AND no mainnet endpoint is contacted

#### Scenario: mainnet derivation unchanged
- GIVEN a key with no signing action
- WHEN the page derives mainnet addresses
- THEN the existing address and WIF outputs are byte-for-byte unchanged

### Requirement: UTXO sourcing and fee guardrails
The page MUST query the selected key's own UTXO set, cross-check the primary
and secondary providers when both are available, and refuse to sign when their
values disagree unless the user explicitly resolves the conflict. The prevout
script MUST be reconstructed locally from the key, never accepted from a
provider. The page MUST show fee, fee rate and change before signing, MUST warn above the
configured fee/output guardrails, and MUST refuse a zero fee or an output above
the input total. Source: design D7, D8.

#### Scenario: provider value mismatch
- GIVEN mempool.space reports a different value for an outpoint than
  blockstream.info
- WHEN the plan is built
- THEN the review is blocked with an explicit conflict message
- AND no signature is produced

#### Scenario: fee guardrail
- GIVEN the computed fee exceeds the configured rate or share of inputs
- WHEN the user tries to sign
- THEN a separate explicit confirmation is required

### Requirement: broadcast fallback and idempotency
Broadcast MUST happen only after a separate explicit action on a signed
transaction. It MUST use the documented provider order for the selected
network, compare the returned txid with the locally computed txid, and confirm
the transaction with a follow-up GET before displaying success. A deterministic
rejection MUST NOT be retried on another provider. "Already known" MUST be
treated as success only after txid confirmation. If every provider fails, the
raw transaction MUST remain visible and copyable. Source: design D11.

#### Scenario: primary unavailable
- GIVEN mempool.space returns 503 or a network error
- WHEN the user presses Broadcast
- THEN the client backs off and tries blockstream.info
- AND displays the provider that accepted the txid

#### Scenario: already known
- GIVEN the transaction is already in the mempool
- WHEN a provider answers with an "already known" error
- THEN the client confirms the local txid via GET and reports success
- AND does not report a new broadcast

#### Scenario: all providers fail
- GIVEN every configured provider fails
- WHEN the attempt ends
- THEN the signed raw transaction is still shown and copyable
- AND the errors are listed without clearing the transaction

### Requirement: local preview and decode
The preview MUST be built from the raw transaction bytes by the local decoder
and MUST show inputs, outputs, scripts, values, fee, fee rate, weight, vsize,
txid and wtxid. A pre-broadcast transaction MUST NOT be sent to a third-party
decoder. External explorer/decode links are allowed only after broadcast or
after an explicit warning. Source: design D12.

#### Scenario: known fixture
- GIVEN a known raw transaction fixture
- WHEN the local decoder renders it
- THEN txid, wtxid, weight, vsize and every output value/script match the
  independent reference

#### Scenario: pre-broadcast privacy
- GIVEN a signed but not yet broadcast transaction
- WHEN the user has not requested an external link
- THEN no request contains the raw transaction

### Requirement: prohibited actions
The signing flow MUST NOT offer sweeping, "send max", automatic consolidation,
automatic signing, automatic broadcast, background retry, or any server-side
key handling. Source: proposal "Out of scope", design D13.

#### Scenario: no sweep control
- GIVEN the signing UI
- WHEN the user looks for a "send all" or sweep action
- THEN no such control exists
- AND every output must be entered explicitly

#### Scenario: no automatic broadcast
- GIVEN a successful signing
- WHEN the signature is produced
- THEN the transaction is not broadcast until a separate, explicit action

### Requirement: verifiable acceptance path
The change MUST ship with (a) BIP143 P2WPKH vectors, (b) a regtest end-to-end
test that funds, signs, `testmempoolaccept`s and `sendrawtransaction`s without
internet, (c) a manual testnet4 acceptance that records a public txid, and (d)
an automated key-leak test. CI MUST NOT broadcast to mainnet and MUST NOT use a
committed funded key. Source: proposal acceptance criteria 1-9, design D15.

#### Scenario: regtest acceptance
- GIVEN a regtest node and a funded P2WPKH address
- WHEN the client signs and submits the transaction
- THEN `testmempoolaccept` returns allowed
- AND the destination and change balances match the plan after mining

#### Scenario: CI has no mainnet broadcast
- GIVEN the CI workflows
- WHEN the signing tests run
- THEN no request targets a mainnet broadcast endpoint
- AND no funded key is present in the repository or CI configuration
