# key-explorer delta

## MODIFIED Requirements

### Requirement: optional balance lookups
Balance checks MUST run automatically after derivation for the public addresses
currently shown, with a visible switch and provider/privacy note; the visitor
MUST be able to turn them off. Only the derived addresses are queried, per
provider, against mempool.space (BTC), public Ethereum JSON-RPC endpoints,
Toncenter (TON), and the other public adapters already used by the chain
browser. Failures stay visible per row and MUST NOT block derivation or other
rows. The page MUST state which providers are used.

#### Scenario: automatic lookup
- GIVEN a derived key and the switch left on
- WHEN the report renders
- THEN each address row fills its balance or an error without hiding other rows

#### Scenario: switch off
- GIVEN the switch off
- WHEN the report renders
- THEN no balance request is made and the page says lookups are off

## ADDED Requirements

### Requirement: explorer and WIF links
Every derived address MUST link to its chain explorer using the single explorer
map. Every Bitcoin row MUST show its compressed WIF under the address, linked
to `/key/<WIF>`; the expanded calculation MUST show both WIFs.

#### Scenario: BTC row links
- GIVEN key 1 and the legacy address type
- WHEN the row renders
- THEN `1BgGZ9…` links to mempool.space and `KwDiBf89…` links to `/key/KwDiBf89…`

### Requirement: compact key facts and counters
After derivation the page MUST show four counters (total value, addresses with
a balance, active chains, checked N/N) and a compact key-facts block with HEX,
DECIMAL, WIF, WIF(U), KEYPAIR(SOL), SECRET(XRP), PUBKEY and PAGE. Each value
MUST be copyable; WIF/HEX MUST link to their entity calculators.

#### Scenario: no key yet
- GIVEN `/key` without a key
- WHEN the page loads
- THEN counters and key facts are absent, not rendered empty

### Requirement: merged address toolbar
The key, chain and seed pages MUST use one address toolbar with chain filter,
address type, path preset, wallet preset, address count and balance controls.
Address-type buttons MUST be the same component and visual states on all three
pages. Presets only filter or highlight rows and MUST NOT change derivation.

#### Scenario: same component
- GIVEN the Bitcoin key page and the Bitcoin chain page
- WHEN the address-type selector is compared
- THEN both have the same DOM class, sizes, focus ring and active state

### Requirement: interactive curve editor
The curve area MUST render a labelled SVG curve, a draggable point with
keyboard support, two-way editable X/Y fields, `Random`, `Reset` and `Copy`
actions, and a caption that distinguishes the real-valued illustration from the
finite-field arithmetic. Motion MUST respect `prefers-reduced-motion`.

#### Scenario: edit coordinates
- GIVEN the curve editor
- WHEN the visitor types a valid X and Y
- THEN the point moves to it and the copy action returns the same values

### Requirement: seed studio options
The seed page MUST let the visitor choose entropy length 12/15/18/21/24,
mnemonic type BIP39 / Electrum old / Electrum BIP39, an optional passphrase,
all-path presets, chain filter, and an address count of 1/3/5/10, then derive
and check balances for the resulting addresses. It MUST NOT store or upload the
phrase; it clears on pagehide.

The schemes MUST be real: BIP39 uses the BIP39 wordlist, checksum and
`mnemonic` PBKDF2 salt; Electrum BIP39 uses the BIP39 wordlist with Electrum's
seed-version check (`01` standard, `100` segwit) and `electrum` PBKDF2 salt;
Electrum old uses the 1626-word legacy list, its hex seed and the old
stretch/sequence derivation. Electrum old accepts 12 or 24 words and has no
passphrase. Electrum 2FA seed versions are an explicit unsupported state, not
a fallback to another scheme.

BIP39 validation keeps the 12/15/18/21/24 word list and checksum. Electrum
BIP39 validation MUST NOT be limited to those counts: all words must be in the
BIP39 wordlist, the phrase must have at least two words, and the Electrum
seed-version check must report standard (`01`) or segwit (`100`). A native
Electrum standard seed may be 13 words.

#### Scenario: BIP39 24 words
- GIVEN 256-bit entropy and a passphrase
- WHEN the visitor derives
- THEN the page shows the 24-word phrase, selected paths and N addresses

#### Scenario: Electrum old phrase
- GIVEN a 12-word legacy Electrum phrase
- WHEN the visitor derives
- THEN the Bitcoin address comes from the old Electrum stretch and sequence
  scheme and the page reports the legacy seed type

### Requirement: brainwallet directory
`/brainwallet` MUST be an index of 18 chain directories with the total corpus
count and links to `/brainwallet-generator`; it MUST NOT contain the
single-passphrase calculator form. `/brainwallet/<chain>` and
`/brainwallet/<chain>/<page>` MUST list a deterministic corpus of 18,890
unique two-word passphrases built locally from a 138-word list (ordered pairs,
sliced to 18,890), 60 rows per page and 315 pages, with BigInt page math,
First/Previous/Random/Next/Last and Jump. Each row MUST show the passphrase,
its SHA-256 hex private key, the chain-specific address from the shared wasm
`derive_report`, compact labelled copy/explorer icon buttons and a balance
cell; Bitcoin and Litecoin MUST expose their address-type switch and re-derive
the visible rows without re-hashing. The summary MUST show balance, active
rows, received and transaction counts where the provider supplies them.
Balance loading MUST be controlled by a visible toggle and send only public
addresses. Passphrases, keys and derived private keys MUST NOT be stored,
logged, put in the URL or sent to the coordinator; rows MUST clear on
`pagehide`. Out-of-range keys MUST show the core's explicit error.

#### Scenario: directory page tail
- GIVEN the visitor opens `/brainwallet/bitcoin/315`
- WHEN the page derives the visible rows
- THEN it shows 50 rows (indices 18840..18889) of the 18,890-phrase corpus
  and the header reports page 315 of 315

#### Scenario: balance toggle off
- GIVEN the visitor turns the balance toggle off
- WHEN the page has rendered its rows
- THEN no balance request is made and every row keeps a local derived state

### Requirement: brainwallet generator
`/brainwallet-generator` MUST be the canonical single-passphrase calculator
with an 18-network dropdown, a passphrase field, "Generate & Check Balance",
a 1/3/5/10 address count, WIF/hex/address results, Copy All/CSV and an
explicit opt-in balance toggle. The key MUST be SHA-256 of the trimmed UTF-8
passphrase; rows after the first MUST be labelled as key + n. The passphrase
and keys MUST NOT be stored, logged, put in the URL or sent to the
coordinator; results MUST clear on `pagehide`.

#### Scenario: known vector
- GIVEN the phrase `correct horse battery staple` on Bitcoin
- WHEN the visitor generates
- THEN the first row shows SHA-256 key `c4bbcb1f…`, its WIF and the Bitcoin
  address `1C7zdTfnkzmr13HfA2vNm5SJYRK6nEKyq8`, with a mempool.space link

#### Scenario: opt-in balance
- GIVEN the balance toggle is off
- WHEN the visitor generates an address
- THEN the address is derived locally and no balance request is made

### Requirement: transaction entry
The key page MUST expose the signing entry defined by
`openspec/changes/tx-sign-broadcast/` behind its explicit gate. Signing and
broadcast MUST remain local and testnet-first; no key material may be sent to
the coordinator.

#### Scenario: sign on testnet
- GIVEN a testnet UTXO set and an explicit review
- WHEN the visitor signs and confirms
- THEN the decoded transaction is shown before any broadcast request
