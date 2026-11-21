# Private-key explorer domain

## Requirements

### Requirement: local derivation
The page MUST derive every displayed value in the browser: it MUST NOT send the
private key, a seed, a WIF or any derived secret to the coordinator or any
third party. It MUST accept 64-hex (optional `0x`), decimal below the secp256k1
order, or WIF input, and MUST keep the key in memory only (no URL, history,
localStorage, sessionStorage or console).

#### Scenario: offline derivation
- GIVEN a valid key and the balance switch off
- WHEN the page derives
- THEN all rows render and the page issues no network request carrying the key

#### Scenario: invalid input
- GIVEN key 0, a value >= n for secp256k1, or malformed text
- WHEN the visitor submits
- THEN the page shows an inline error and renders no addresses

### Requirement: address coverage
For secp256k1 the page MUST show BTC P2PKH compressed and uncompressed,
P2SH-P2WPKH, P2WPKH, P2TR, EVM (EIP-55) and TRON addresses, plus WIF
compressed/uncompressed; for ed25519 it MUST show the Solana address. Each row
MUST expose the intermediate values behind an expandable calculation.

#### Scenario: canonical fixtures
- GIVEN key 1
- WHEN the page derives
- THEN it shows the canonical P2PKH, WIF, P2SH-P2WPKH, P2WPKH, P2TR, EVM and
  TRON values, and key 6 shows the taproot address of the even-y lifted key

### Requirement: optional balance lookups
Balance checks MUST be off by default. When enabled, only the derived addresses
currently visible are queried, per provider, against mempool.space (BTC), a
public Ethereum JSON-RPC fallback list, and Tronscan; failures are shown per row
and MUST NOT block derivation or other rows. The page MUST state which
providers are used.

#### Scenario: provider failure
- GIVEN every EVM endpoint fails
- WHEN balances are checked
- THEN the EVM row shows an error and the BTC/TRON rows still render

### Requirement: USD total value
The stats row MUST show a USD total for the balances already loaded on the page,
without fetching balances again. Prices MUST come from a public ticker request
that carries only ticker symbols (never a key, address or balance), cached for
six hours. Atomic amounts MUST be converted with each chain's decimals and
summed exactly (BigInt); the card shows two decimals and its title carries the
exact amount and the price timestamp. While any balance is loading the card MUST
show a pending marker rather than a partial total. A row without a price or a
balance MUST be excluded and its count exposed in the title/`aria-label`; it
MUST NOT be counted as zero. On a 429/network failure the previous cache is kept
and marked stale; when no price source is reachable and no cache exists, the card
shows `—` with an explicit title and MUST NOT invent a number.

#### Scenario: missing price
- GIVEN a loaded balance whose ticker is absent from the price response
- WHEN the total renders
- THEN that row is excluded and the title names how many rows were excluded

#### Scenario: offline
- GIVEN no price request succeeds and no cache exists
- WHEN the key page renders
- THEN the total shows `—` with a "No price source reachable" title

### Requirement: curve selector and presets
The page MUST let the visitor choose secp256k1 or ed25519, show an honest
illustrative curve plot with a movable point, and offer wallet presets that
filter rows and list the standard derivation paths they describe. Presets MUST
not change the math.

#### Scenario: preset filter
- GIVEN the Phantom preset
- WHEN selected on an ed25519 key
- THEN only the Solana row remains and the address is unchanged
