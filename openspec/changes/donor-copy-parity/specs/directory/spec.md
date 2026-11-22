# Directory listing domain (delta)

## ADDED Requirements

### Requirement: every address form is visible immediately
A `/private-keys/<chain>` listing row MUST render every address form of a key
on first paint. For a legacy Bitcoin key that is the compressed and the
uncompressed P2PKH address; each form carries a `(c)`/`(u)` label, an explorer
link whose `title` is the full address, and a 44×44 labelled copy action. A
row MUST NOT hide an address behind a disclosure, `aria-expanded` toggle,
`display:none`, or a second row-only block.

#### Scenario: legacy Bitcoin row
- GIVEN `/private-keys/bitcoin` has rendered its addresses
- WHEN the first row is inspected
- THEN it contains two visible `.addr-line`s labelled `(c)` and `(u)`
- AND both address links exist and both copy actions are 44×44
- AND the row contains no `.addr-extra`, `.addr-extra-toggle` or
  `aria-expanded` control

#### Scenario: single-address chain
- GIVEN `/private-keys/ethereum` has rendered its addresses
- WHEN a row is inspected
- THEN it contains exactly one visible `.addr-line`

### Requirement: addresses per page stay constant
The directory MUST keep 60 keys per page (the donor's `KEYS_PER_PAGE`). For a
legacy Bitcoin page, with two addresses per key, the page MUST declare and
render 120 addresses; a single-address chain MUST declare and render 60. The
visible counter (`#page-address-count`) MUST equal
`rows × addresses-per-key`, and `data-addresses-per-page` MUST equal the
number of visible address lines.

#### Scenario: legacy Bitcoin total
- GIVEN `/private-keys/bitcoin` page 1
- WHEN the last row has rendered
- THEN `data-addresses-per-page` is 120
- AND the rendered visible address lines total 120
- AND the counter reads `120 addresses`

### Requirement: donor balance information model
Each visible address MUST have one `.balance-info` line: the balance is
prominent, the transaction count is a separate `.badge` with an accessible
name, and the received amount is a `.badge` that is rendered only when it is
non-zero. The row MUST NOT render a zero received figure or a relative-age
label. A provider miss MUST render the honest `-` or `unavailable` state
instead of a fabricated zero.

#### Scenario: zero received amount
- GIVEN an address with zero received value
- WHEN its balance line renders
- THEN it shows the balance and the TX badge
- AND it shows no received badge

#### Scenario: provider failure
- GIVEN the balance provider fails for an address
- WHEN the balance cell renders
- THEN the line shows `unavailable` with the retry action
- AND no zero balance or zero received amount is invented
