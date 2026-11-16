# Monitor domain

## Requirements

### Requirement: MVP scope
The MVP MUST support EVM and BTC watchlists only. An add request naming TRON
or Solana MUST return 400 naming the supported chains and MUST NOT create a
watch. Billing, plans, trial entitlement and out-of-app alert delivery
(Telegram/email/webhook) are deferred: the MVP ships wallet login, the
watchlist, baseline EVM polling (`eth_getBalance`/`eth_getTransactionCount`),
the in-app event feed, session expiry/revocation and the transparent `/key`
exposure check. Source: design D12.

#### Scenario: unsupported chain
- GIVEN a signed-in user submits a TRON or Solana address
- WHEN the add request is handled
- THEN the response is 400 stating that only `evm` and `btc` are supported
- AND no watch is created

#### Scenario: no plan gate in MVP
- GIVEN a signed-in account below the 50-address hard cap
- WHEN it adds an address
- THEN no trial or paid-plan check is applied (billing is deferred)

### Requirement: verified watchlist
An address MUST be watched only after a valid signature over a server-issued,
single-use nonce bound to the account, domain, chain, address and an expiry.
Unverified addresses MUST NOT be watched. Adding an address MUST NEVER require
or accept a private key, WIF or mnemonic. Source: design D3.

#### Scenario: valid EVM proof
- GIVEN a monitor account and a fresh nonce
- WHEN the user submits a SIWE message and signature matching the account,
  domain, chain and address
- THEN the address is stored as verified and appears in the cabinet

#### Scenario: rejected proof
- GIVEN a mutated signature, a wrong domain, an expired nonce or a replayed
  nonce
- WHEN the add request is handled
- THEN the response is 400 and no watch is created

#### Scenario: secret material rejected
- GIVEN a request body containing a 64-hex key, a WIF or a mnemonic
- WHEN any monitor endpoint handles it
- THEN the response is 422, the payload is not logged and no watch is created

### Requirement: on-chain activity alerts
For every verified watched address the system MUST poll the configured
provider and emit exactly one alert per detected event, identified by
`chain|address|txid|kind`. A BTC testnet transaction paying a watched address
MUST produce an alert within 5 minutes of broadcast; an EVM ERC-20/721
transfer or approval MUST produce an alert within 15 minutes. Alerts MUST
include chain, address, direction, amount, txid and confirmations. Source:
design D5, D6, D8.

#### Scenario: BTC receive
- GIVEN a verified watch on a BTC testnet address
- WHEN a transaction paying that address is broadcast
- THEN one alert is delivered within the configured interval bound and is
  recorded in the delivery log

#### Scenario: no duplicates
- GIVEN an event was already alerted
- WHEN the watcher restarts or re-polls the same transaction
- THEN no second alert is delivered

#### Scenario: approval
- GIVEN a watched EVM address with no prior approval to spender X
- WHEN an ERC-20 or ERC-721 `Approval` for X is mined
- THEN a separate "approval" alert is delivered

### Requirement: deletion stops monitoring
Deleting an address MUST stop polling and alerting within one poll interval,
and MUST remove its watch and pending deliveries.

#### Scenario: delete then receive
- GIVEN the user deleted a watched address
- WHEN a new transaction pays that address after the next polling cycle
- THEN no notification is sent and no event is created

### Requirement: known-compromised match
An address present in the imported leak set MUST raise one "known compromised"
alert per address and dataset version. Wording MUST say the address appears in
a published list, never that the key is currently leaked. Source: design D7.

#### Scenario: match on add
- GIVEN the fixture leak set contains address A
- WHEN the user verifies and adds A
- THEN exactly one critical alert names A and the dataset version
- AND later polling of A does not repeat that alert

### Requirement: provider failure is visible
If a provider fails for more than two consecutive intervals, the cabinet MUST
show "monitoring degraded", the user MUST receive an operational notice, and
the operator MUST be alerted. The system MUST NOT silently skip watch cycles
or report healthy status with a stale `last_ok_at`. Source: design D5.4.

#### Scenario: 429 storm
- GIVEN a mock provider returns 429 for three consecutive intervals
- WHEN the watcher tick completes
- THEN degraded status is stored, an ops alert fires, and no event is lost
  silently

### Requirement: entitlement gating (deferred from MVP)
This requirement is deferred together with billing. The MVP applies only the
50-address hard cap and stores no plan or trial state. When billing lands,
watchlist size MUST be limited by the account plan. Trial accounts MUST be
limited to 3 addresses and MUST NOT exceed that on add. Expired subscriptions
MUST pause alerts, keep data for 30 days and allow reactivation. Source:
design D9.

#### Scenario: trial limit
- GIVEN a trial account with 3 verified addresses
- WHEN it tries to add a fourth
- THEN the response is 403 with an upgrade hint and no watch is created

#### Scenario: pause
- GIVEN a paid subscription expired more than the grace period ago
- WHEN the watcher detects an event
- THEN no user alert is sent, the event is stored, and the cabinet shows the
  paused state

### Requirement: privacy and retention
Events and deliveries MUST be retained no longer than 90 days; account
deletion MUST purge watches, events and deliveries within 30 days. Logs MUST
NOT contain full addresses. The privacy policy MUST list every third-party
provider that receives addresses. Addresses MUST be encrypted at rest.
Source: design D10.

#### Scenario: delete account
- GIVEN a user requests deletion
- WHEN the retention job runs
- THEN addresses, watches, events and deliveries are gone and invoices needed
  for tax remain only as legally required

#### Scenario: log redaction
- GIVEN a provider error is logged
- WHEN the log line is written
- THEN the address appears only as a prefix/suffix, never in full

### Requirement: honest product wording
UI, docs and marketing MUST NOT claim detection of leaked keys, theft
prevention, guaranteed protection or fund recovery. They MUST state that
derivation and idle compromise are not observable and that alerts may be late
or missed. A build test MUST fail on forbidden phrases in user-facing
surfaces (`apps/site/*.html`, shipped docs and marketing copy; OpenSpec files and the
test fixtures themselves are excluded). Source: design D10.

#### Scenario: wording gate
- GIVEN a user-facing page or shipped doc containing "detect leaked keys" or
  "prevent theft"
- WHEN the test suite runs
- THEN the wording test fails

### Requirement: no address enumeration oracle
The API MUST NOT reveal whether an address is watched by another account.
Responses for add/verify MUST be uniform regardless of existing watches, and
rate limits MUST apply per IP and per account.

#### Scenario: probing
- GIVEN account A watches address X
- WHEN account B submits a verification for X without a valid signature
- THEN the response is indistinguishable from any other invalid proof
