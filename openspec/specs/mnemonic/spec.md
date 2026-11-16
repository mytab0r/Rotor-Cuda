# Mnemonic domain

## Existing behavior
The tool derives BTC keys and compressed P2PKH addresses from BIP39 phrases
using BIP32 CKDpriv and the existing secp256k1 arithmetic, and audits a bounded
entropy counter space against known targets.

## Requirements

### Requirement: phrase and seed derivation
The executable MUST accept an English BIP39 phrase with an optional passphrase
and BIP32 path, and MUST print the master fingerprint, derived private key,
compressed public key and P2PKH address. It MUST also encode raw entropy
(16/20/24/28/32 bytes) into a phrase with the BIP39 checksum.

### Requirement: bounded entropy audit
`--mnemonic-audit` MUST derive one candidate per counter in an END-exclusive
range, with the counter stored big-endian in the low bits of N-bit entropy.
N MUST be one of 128, 160, 192, 224, 256; one run MUST reject more than 2^32
candidates; a target list MUST be required. Targets are compressed P2PKH
hash160 records by default and x-only public keys with `-m xpoints`.

### Requirement: honest reporting and scope
The audit MUST print its measured rate and ETA, MUST warn that each candidate
costs a full PBKDF2 derivation and cannot reach the puzzle range, and MUST
state that only authorized data may be audited. The mnemonic flags MUST be
rejected together with GPU, BSGS, coordinator, benchmark, ETH and
uncompressed/both key modes.

### Scenario: canonical vectors
- GIVEN zero or all-0xff entropy
- WHEN the phrase is generated
- THEN it matches the published BIP39 vectors, and seed derivation with and
  without a passphrase matches the published BIP39 seed vectors

### Scenario: BIP32 vectors
- GIVEN a known seed
- WHEN `m`, `m/0'`, `m/0'/1`, `m/0` and `m/0/2147483647'` are derived
- THEN keys and chain codes match the published BIP32 test vectors

### Scenario: audit finds a known counter
- GIVEN a target address from a phrase built for counter C
- WHEN the audit sweeps a range that includes C
- THEN it prints one MATCH with the counter, phrase, key and address, and
  exits 0

### Scenario: END-exclusive sweep
- GIVEN a target for counter 3 and the range `0:3`
- WHEN the audit runs
- THEN it reports no match; the same target matches in `3:4`

### Scenario: rejection paths
- GIVEN an unsupported entropy size, an oversized range, a missing target
  list, or a conflicting backend/key mode
- WHEN the CLI parses the request
- THEN it fails with a message naming the constraint and runs no derivation
