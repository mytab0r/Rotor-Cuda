# Security advisories domain

## Requirements

### Requirement: reviewed SSOT
`data/security-advisories.json` MUST be the only source of advisory content.
Every advisory and threat MUST carry a plain-language summary, a user impact,
at least one action, at least one https primary source and a review record.
A `reviewed` entry MUST name `reviewed_by` and `reviewed_at`; a `draft` MUST
NOT carry them. The page and the wallet MUST NOT show a draft entry. Source:
design D1, D2.

#### Scenario: a reviewed entry ships
- GIVEN an advisory with `review.status: reviewed`, a reviewer and a date
- WHEN the page is generated
- THEN the entry appears on `/security` and in the wallet selection

#### Scenario: a draft is invisible
- GIVEN an advisory with `review.status: draft`
- WHEN the page is generated and the wallet selects advisories
- THEN the entry appears in neither surface

#### Scenario: unreviewed facts are rejected
- GIVEN a reviewed entry with no `reviewed_by`
- WHEN `check-advisories.mjs` runs
- THEN it exits non-zero and names the missing field

### Requirement: checker registry integrity
Every advisory checker reference MUST resolve to a top-level checker whose
`route` exists in the coordinator's `static_asset` map and whose
`implementation` file exists. A checker with `network: false` MUST read only
user-supplied data in the browser. Source: design D3, D6.

#### Scenario: removed checker route
- GIVEN an advisory that references `/milk-sad#address-audit`
- WHEN the `/milk-sad` route is removed from the coordinator
- THEN `check-advisories.mjs` fails with the missing route
- AND the generated page is not deployable

#### Scenario: unknown checker id
- GIVEN an advisory whose `checker` id is not in `checkers`
- WHEN the gate runs
- THEN it fails and names the unknown id

### Requirement: public security page
The coordinator MUST serve `/security` as an indexable content route with a
canonical link, one `main`, one `h1`, the shared coordinator footer (injected
at serve time), parseable JSON-LD and no `noindex`. The page MUST list
advisories and threats separately and MUST state
that it is documentation, not a protection service. It MUST NOT publish or
link to a vulnerable-key directory. Source: design D4.

#### Scenario: crawler sees the content
- GIVEN a request for `/security`
- WHEN the coordinator answers
- THEN the HTML carries the advisory text, the canonical URL and JSON-LD

#### Scenario: draft content is not served
- GIVEN the SSOT contains a draft entry
- WHEN the page is generated
- THEN the entry's title does not appear on `/security`

### Requirement: wallet security status
The cabinet wallet MUST show a "Security status" panel only while the vault is
unlocked. It MUST select reviewed advisories whose affected chain matches at
least one vault entry. A runnable local checker MUST be offered only for the
user's own derived address; an advisory without a local checker MUST be shown
as uncheckable with an explanation. The panel MUST show the number of
advisories, the number of local checks run and the last check time. Source:
design D5.

#### Scenario: applicable advisory
- GIVEN an unlocked vault with a Bitcoin entry and a reviewed Milk Sad advisory
- WHEN the panel renders
- THEN the advisory is listed with a "Check locally" action

#### Scenario: no applicable advisory
- GIVEN a vault with only an Ethereum entry
- WHEN the panel renders
- THEN it states that no reviewed advisory applies

#### Scenario: checker unavailable
- GIVEN a reviewed advisory with `checker: null` for a chain in the vault
- WHEN the panel renders
- THEN the advisory is listed as having no local check, without a run action

#### Scenario: testnet is not mainnet
- GIVEN a vault entry on `bitcoin-testnet`
- WHEN the panel selects advisories
- THEN a Bitcoin-mainnet advisory is not applied to it

### Requirement: local-check privacy
A wallet check MUST send no address anywhere. The Milk Sad scan MUST run in the
browser through the shared scan module. The wallet MUST persist only a
timestamp keyed by advisory id and the random vault entry id. It MUST NOT
display or store a recovered mnemonic, WIF or private key in the security
panel. Source: design D5, D6.

#### Scenario: no new network call
- GIVEN a user starts a local Milk Sad scan
- WHEN the scan runs
- THEN no request containing the address is made

#### Scenario: no address in storage
- GIVEN a completed check
- WHEN the stored check history is read
- THEN it contains only ids and an ISO timestamp

### Requirement: honest wording
Every advisory and threat MUST cite a primary source. No entry may claim that
the site protects a wallet, prevents a theft or proves a key safe. A bounded
scan MUST state that it covers only the entered range. Source: proposal
"Honesty boundary", design D2.

#### Scenario: protection claim rejected
- GIVEN an entry whose summary says "we protect you"
- WHEN the gate runs
- THEN it exits non-zero with a banned-claim error

#### Scenario: bounded result
- GIVEN a local scan with no match in the entered range
- WHEN the panel reports the result
- THEN it says the result covers only that range and is not a safety guarantee

### Requirement: opt-in notifications are specified, not shipped
The change MUST document the consent, template, rate limit and excluded data
for future Telegram notifications. It MUST NOT implement the mass notification
job in this change. Source: design D7.

#### Scenario: no job in this release
- GIVEN this change is applied
- WHEN the server starts
- THEN no security-alert job or sender exists

#### Scenario: consent is explicit
- GIVEN the future job design
- WHEN a user has linked Telegram but has not enabled security alerts
- THEN no security message is sent
