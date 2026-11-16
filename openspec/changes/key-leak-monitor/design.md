# Design: address activity monitor

Status: draft for review. Evidence is file:line in the repository or a URL
fetched on 2026-11-16; anything not checked is marked **not verified**.

## D1 Context and constraints

- The coordinator is a single Rust binary with `tiny_http`, one accept thread,
  one thread per request, a single `Mutex<State>` and whole-file JSON
  persistence (`src/coordinator/mod.rs:1-27`, `state.rs:461-470`). There is no
  async runtime and no TLS (terminate it in a reverse proxy).
- Accounts exist but are contributor accounts: `ClientRecord` stores a name, a
  SHA-256 token hash and scan stats; there is no email, password or wallet
  (`state.rs:125-145`). Registration returns the token once
  (`state.rs:531-561`, `mod.rs:563-598`).
- The cabinet is a static page that stores the bearer token in localStorage
  and polls `/api/v1/me` every 2 s (`apps/site/me.html:24-31`, `:73-184`,
  `apps/site/site.js:5-20`, `:49-61`).
- Outbound HTTP already exists via `ureq` + native-tls (`Cargo.toml:33`,
  `src/coordinator/client.rs:1-11`), so provider calls and Telegram/email
  webhooks need no new runtime.
- Consequence: the monitor is incremental, not a rewrite. Keep it a new
  module and a new store; do not put its high-frequency cursor updates into
  `state::Data` (each `save()` rewrites the whole file).

## D2 Architecture

```
                 +--------------------------- rotor-coord ---------------------------+
 browser  --->   | tiny_http routes: /monitor, /api/v1/monitor/*                    |
                 |   |                                                             |
                 |   +-- monitor store (own Mutex, own file) <----+                  |
                 |                                                |                  |
                 |   watcher threads (one per chain) -------------+                  |
                 |     |- scheduler: due watches, adaptive interval                 |
                 |     |- provider adapter (ureq): heartbeat/detail                  |
                 |     |- classifier: diff -> signals -> dedupe                      |
                 |     +- notifier: Telegram / email / webhook                       |
                 |                                                             |
                 |   billing: entitlement check + Stripe webhook / crypto verifier  |
                 +-------------------------------------------------------------------+
```

Decisions:

- **D2.1 Same binary, new module** `src/monitor/` (`store`, `providers`,
  `classify`, `notify`, `auth`, `billing`, `http`). Rationale: reuse embedded
  pages, token identity and `ureq`; one deploy. Reject a separate service in
  v1: it duplicates config, TLS and account plumbing for no MVP benefit.
- **D2.2 Threads, not async.** One thread per chain (BTC, EVM) plus one for
  delivery retries. The scheduler is a loop over due watches with a bounded
  per-tick batch; no unbounded thread-per-address.
- **D2.3 Separate store.** `monitor.json` (accounts, wallets, watches,
  cursors, plans) and append-only `monitor-events.jsonl` (alerts, deliveries),
  rotated daily, 90-day retention. Cursor writes are batched (flush at most
  once per minute) to avoid the whole-file rewrite cost per poll. Threshold to
  move to SQLite: >5,000 watches or a store file >20 MB; **not verified** that
  JSON stays under these bounds in production.
- **D2.4 Public site stays static.** `/monitor` is embedded like `/me`
  (`mod.rs:31-41`, `:487-506`); all state comes from `/api/v1/monitor/*`.

## D3 Identity and wallet linking (no custody)

- **Account**: `monitor_user` { id, email, email_verified_at, plan,
  trial_until, stripe_customer_id, telegram_chat_id, created_at, deleted_at }.
  Kept separate from `ClientRecord` so the contributor permission matrix
  (`mod.rs:216-251`) is untouched. An optional link field ties a monitor user
  to a contributor id; it grants nothing.
- **Login**: email magic link (single-use token, 15 min) and/or wallet
  signature. Wallet signature alone cannot recover an account without email;
  email alone cannot add addresses (addresses always need a signature).
- **Linking an address** (per address, one signature):
  - message: `rotor-monitor | domain | account_id | chain | address | nonce |
    issued_at | expiry`, 10-min expiry, nonce single-use (server store).
  - EVM: EIP-4361 (SIWE) fields; verify ECDSA recovery; support EIP-1271
    `isValidSignature` for Safe/smart accounts. Reject `chainId` mismatch.
  - BTC: BIP322 `signmessage` for P2WPKH/P2TR; legacy Bitcoin `signmessage`
    for P2PKH (wallet support varies; **not verified** per wallet). Verify
    the signature against the address's script; never accept a pubkey that
    does not hash to the claimed address.
  - Solana / TRON (phase 2): ed25519 `signMessage`; TRON
    `signMessageV2`; same message schema.
- **What is stored**: chain, canonical address, `proof_kind`, `verified_at`.
  The challenge string and signature are deleted after verification; keep only
  a verification audit line without the signature.
- **Canonicalization**: EVM lowercase hex (display EIP-55); BTC base58 is
  case-sensitive, bech32 lowercase; validate checksum. Reject mixed/invalid.
- **No custody, enforced**: no endpoint accepts a private key, WIF or
  mnemonic. A rejection test scans request bodies for 64-hex/WIF/BIP39 shapes
  and returns 422 without logging the payload. UI/docs repeat "we never ask
  for your key or seed".
- **Abuse controls**: per-IP and per-account limits on challenge issuance and
  address adds (e.g. 10/hour, 50/day); uniform responses so a caller cannot
  learn whether an address is already watched by someone else; same-address
  multi-user watch is allowed and deduplicated internally.

## D4 Data model

| record | fields (essential) |
|---|---|
| MonitorUser | id, email, email_verified_at, plan (trial/active/past_due/paused/canceled), trial_until, period_end, stripe_customer_id, telegram_chat_id, notify (telegram/email/webhook, quiet hours), created_at |
| WalletLink | id, user_id, chain, address, proof_kind, verified_at |
| Watch | id, chain, address (shared key: chain+address), user_id, label, mode (cold/hot), added_at, muted_until |
| AddressState | chain, address, last_seen_txid, last_block, last_balance, last_nonce, last_poll_at, interval_s, failures, last_ok_at |
| Event | id, chain, address, kind, severity, txid, block, direction, amount, asset, counterparty, first_seen_at, confirmed_at, dedupe_key |
| Delivery | event_id, user_id, channel, status, attempts, last_error, sent_at |
| LeakSet | version, source, built_at, hash_count |
| Invoice | id, user_id, plan, amount, currency, chain, address, status, txid, confirmations, created_at |

- Dedupe key: `sha256(chain | address | txid | kind)`; insert-if-absent under
  the store lock before any delivery, so restarts cannot double-alert.
- An address watched by N users yields one poll and N deliveries.
- Event severity: `critical` (outbound spend, nonce jump, approval to new
  spender, leak match), `high` (transfer out, balance drop), `info` (inbound
  payment, dust unless the address is cold).
- Retention: events + deliveries 90 days; watches until deleted; payment and
  invoice records per tax law (**legal review required**), addresses in
  invoices are platform receiving addresses, not user wallets.

## D5 Watcher, providers and cost

### D5.1 Cheap heartbeat, detail only on change

- BTC: one `GET /api/address/:address` per poll returns `chain_stats` and
  `mempool_stats` (`funded_txo_sum`, `spent_txo_sum`, tx counts). A change in
  spent sums or mempool count triggers `GET /api/address/:address/txs` (50
  mempool + 25 confirmed, `after_txid` paging) and `/utxo`. Endpoints and
  paging confirmed in mempool.space docs (fetched 2026-11-16).
- EVM: two cheap calls per poll - `eth_getTransactionCount` and
  `eth_getBalance`; any change triggers Etherscan v2 detail calls:
  `account/txlist`, `account/tokentx`, `account/txlistinternal`, and
  `logs` filtered to the ERC-20/721 `Approval` topic. Free tier 3 req/s,
  100k/day; overage $3/100k on paid plans (Etherscan docs, fetched
  2026-11-16).
- Adaptive interval: default 300 s; confirmed-idle cold address 900 s; an
  address with mempool activity 60 s until it settles; per-chain global budget
  caps requests/day and slows all intervals proportionally rather than
  dropping watches silently.

### D5.2 Request volume per 1,000 addresses/day

| chain | interval | calls/poll | calls/day | fits |
|---|---|---|---|---|
| BTC | 60 s | 1 | 1,440,000 | needs self-host/sponsorship |
| BTC | 300 s | 1 | 288,000 | self-host or sponsor |
| BTC | 900 s | 1 | 96,000 | self-host preferred |
| EVM | 300 s | 2 | 576,000 | Etherscan Advanced (500k) slightly short; Pro (1M) |
| EVM | 900 s | 2 | 192,000 | Etherscan Standard (200k) |

Marginal provider cost at overage rates: one EVM address at 300 s = 576
calls/day ~ $0.017/day ~ **$0.52/month**; at 900 s ~ $0.17/month; at 60 s ~
$2.59/month. BTC public APIs publish no numeric paid tier (mempool.space
offers "enterprise sponsorship" only), so BTC cost is either self-host or
negotiated. These numbers drive the price floor in D11.

### D5.3 Self-hosted indexer threshold

Move BTC to self-hosted `electrs` + Esplora when any two hold: >2,000 watched
BTC addresses; sustained 429 rate >1%; p95 provider latency >60 s; monthly
provider spend > VPS cost. Order-of-magnitude footprint: 100+ GB SSD, 16 GB
RAM, ~$30-60/month (**not verified** this session; measure before committing).
EVM self-hosting is not worth it below tens of thousands of addresses; at
scale use a managed push provider (Alchemy Address Activity webhooks,
QuickNode Streams, Tenderly Alerts - options, pricing **not verified**).
Push webhooks also cut latency below polling.

### D5.4 Failure modes to design for

- 429/5xx, banned key, DNS/TLS failure -> exponential backoff, per-provider
  circuit breaker, user-visible "monitoring degraded", ops alert.
- Explorer schema/deprecation (Etherscan v1 -> v2 multichain; Solana/TRON
  providers change) -> provider adapters behind one trait, contract tests.
- Reorgs -> alert on first sighting for mempool, and send a correction event
  if the tx disappears; never silently rewrite history.
- Address formats: EVM checksum case, bech32 vs base58, testnet prefixes;
  canonicalize before keying.
- EVM internal transactions and token transfers are separate endpoints;
  missing one is a false negative. Approval logs must include both ERC-20 and
  ERC-721 topic signatures.
- A watcher that dies must not look healthy: heartbeat timestamp + ops alert.

## D6 Detection signals and classification

| # | signal | chain | severity | rule / caveat |
|---|---|---|---|---|
| S1 | outbound spend | BTC/EVM | critical | tx spends a watched UTXO or `from == address`; BTC mempool first |
| S2 | balance drop | both | high | spent sum increases without a user-acknowledged tx |
| S3 | nonce jump | EVM | critical | nonce > last seen; catches zero-value and contract calls |
| S4 | ERC-20/721 transfer out | EVM | critical | token endpoint; include contract, amount, recipient |
| S5 | approval to new spender | EVM | critical | `Approval` log; unlimited allowance raises severity |
| S6 | inbound tx | both | info | high if the address is cold (no outbound for 180 d) or in a leak set |
| S7 | dust / address poisoning | both | info/medium | inbound < ~$1 from an unknown address; lookalike prefix/suffix of a known counterparty |
| S8 | leak-set membership | both | critical (once) | address appears in a published compromised dataset |
| S9 | xpub child activity | BTC | high | child within gap 20 was used; user never listed it |

- "Unexpected" vs "expected": we cannot prove intent. The user can mark an
  event "this was me"; the acknowledgement is stored and reported, and can
  tune S2/S6 severity for that address, but never suppresses S1/S3/S4/S5.
- False positives: exchange withdrawals to your own address, consolidation,
  scheduled DCA -> user acknowledgement. False negatives: keys used only for
  off-chain signing, Lightning, or chains not watched. Document both.
- BTC value: mempool watching can beat confirmation; a user may be able to
  outbid a pending spend only in narrow RBF cases - do not promise rescue.
- EVM value: approvals and nonce jumps are the strongest early warnings;
  address poisoning is common and cheap.

## D7 Known-compromised lists

- Sources: public brainwallet/weak-key address datasets (Milk Sad
  `milk_sad_*.csv`), published compromised-address lists, and operator
  imports. Store only `SHA-256(normalized address)` in `LeakSet`; matching is a
  hash lookup, so the server holds no plaintext copy of the list.
- Match on add and on each dataset version bump; one alert per
  `(address, set_version)`.
- Wording: "this address appears in a published list of known weak or
  compromised keys" - not "your key leaked". An address in a list can be
  re-secured only by moving funds with a **new** key.
- Complementary, not server-side: `/key` already derives locally
  (`openspec/changes/key-explorer/proposal.md`); a weak-key warning there
  never sends the key anywhere.

## D8 Notifications

- Channels: Telegram bot (first, owner already runs Telegram ops), email
  (transactional HTTP provider: Resend/Postmark/SES), HMAC-signed webhook
  (power users), in-cabinet feed (always). Web push is out of MVP: service
  worker + VAPID + encrypted payload for little gain over Telegram.
- Routing: critical -> immediate on every enabled channel; high -> immediate
  on primary; info -> daily digest. Quiet hours apply to info only.
  Rate cap per address (e.g. 20 alerts/day) with a "suppressed" summary.
- Every alert contains: chain, address (abbreviated in subject, full in
  body), direction, amount, txid, confirmations, what to do (move funds with
  a new key, revoke approvals), and "we never ask for your key or seed".
- Delivery reliability: retries with backoff, delivery log, fallback to a
  second channel if the primary fails twice, and a dead-man check: if no
  alert channel has been exercised for 7 days, send a test message.
- Email hardening: SPF/DKIM/DMARC; transactional subdomain; no links that
  ask to "verify a wallet"; no full seed/phrase wording that trains users to
  trust phishing.
- Ops alerting: watcher loop failure, provider 429 storm, delivery failure
  rate >1% -> Telegram to the operator.

## D9 Billing and entitlement

Verified fact: `pay.pxbt.app` is a receive-only crypto payment-link tool (connect
a wallet, show addresses/QR). It has no registration, server, subscriptions or
webhooks (fetched 2026-11-16), so it **cannot** gate access by itself.

- **Entitlement** is server-side: `plan`, `period_end`, `address_limit`,
  `grace_until`. Trial 7 days / 3 addresses; paid tiers per D11. Expired ->
  `paused`: no new alerts, data kept 30 days, read-only cabinet.
- **Card path (recommended first)**: Stripe Checkout subscription + Customer
  Portal; webhook with signature verification and event-id idempotency
  (`checkout.session.completed`, `customer.subscription.updated/deleted`,
  `invoice.paid`, `invoice.payment_failed`). Stripe Tax for EU VAT. Cards give
  refunds and chargebacks; Stripe sees email, never wallet addresses.
- **Crypto path (fits the audience)**: an invoice with a unique amount or a
  reference, paid to a platform receiving address; the watcher confirms N
  confirmations (BTC 2, EVM 12) and grants the period idempotently by txid.
  Reuses D5 infrastructure. Risks: wrong amount, price volatility, no
  chargebacks, manual refunds; show exact amount and expiry, allow overpay
  credit. `pay.pxbt.app` can display the platform address/QR, but it is not
  the source of truth.
- **Trial abuse**: one trial per verified wallet + email; no card; low limits
  instead of fingerprinting. Never delete an address silently when a plan
  lapses - pause, notify, keep 30 days.

## D10 Privacy, legal and honesty

- Addresses are personal data and linkable to a person. The server must hold
  plaintext addresses to query public APIs; **hashing does not solve this**
  (the provider needs the plaintext). Hashing is used only for the leak set.
- Mitigations: field-level encryption at rest, least-privilege access, no
  third-party analytics on `/monitor`, address abbreviation in logs, no
  addresses in error messages, per-user data export, deletion within 24 h of
  a request (30-day purge for backups), and a subprocessor list.
- Third parties that receive addresses: mempool.space/Esplora, Etherscan (and
  phase-2 providers), plus Telegram/email provider (alert content includes the
  address). Disclose all of them; allow email-only users to keep Telegram off.
- GDPR roles: the operator is controller for accounts and watchlists,
  processor for nothing user-facing; Stripe/email provider are processors.
  Retention: events 90 days, account data until deletion, invoices per tax
  law. DPA, EU hosting preference, and a lawful basis (contract) are
  **legal-review items, not verified**.
- Honest wording gate: allowed - "we watch the addresses you verify and alert
  you to activity, new approvals, dusting, and known-compromised lists";
  forbidden - "detect leaked keys", "prevent theft", "guaranteed", "recover
  your funds". A grep test (acceptance 11) enforces it.
- Disclaimers at signup and in every alert: not a guarantee, alerts may be
  delayed or missed, no custody, never share keys/seeds, you remain
  responsible.
- Crypto payments may trigger AML/tax obligations depending on jurisdiction
  (**not verified**); do not add KYC until a payment provider requires it.

## D11 Pricing experiments

Cost floor from D5: ~$0.17-0.52/month per EVM address at 5-15 min polling,
plus BTC infrastructure. Proposed start:

- Trial: 7 days, 3 addresses, all signals.
- Solo: EUR 5/month, 10 addresses. Pro: EUR 12/month, 50 addresses.
  Add-on: EUR 0.25/address/month. Annual: 10 months for 12 (2 free).
- Experiments (sequential if traffic is low; do not A/B disclaimers):
  E1 price anchor EUR 5 vs 9 for Solo on the landing page; measure
  trial-start and trial->paid conversion (target >= 3%).
  E2 buckets vs pure per-address pricing; measure comprehension (support
  tickets) and revenue per account.
  E3 annual prepay vs monthly; measure cash flow and churn.
  E4 crypto annual -10%; measure share of crypto vs card.
- Guardrails: refund rate, support load per 100 users, alert false-positive
  rate (<5% of critical alerts acknowledged as "not mine" by mistake).
- Do not price below the D5 floor; a per-address tier is the honest way to
  cover polling cost.

## D12 Rollout and metrics

1. Dogfood: operator's own testnet + mainnet addresses, Telegram only, 2 weeks.
2. Private beta: 10 users free, manual onboarding, measure latency and false
   positives; keep the watcher budget under 50k calls/day.
3. Public MVP: BTC + EVM, email + Telegram, Stripe, 1,000-address load test.
4. Phase 2: Solana/TRON, xpub watch, webhooks, web push.

Metrics: activation (>=1 verified address), median detection latency, alert
delivery success (target >99.9%), false-positive rate, trial->paid, churn,
provider spend per paying user, support tickets per 100 users.

## D13 Open questions

- Separate product name/domain from Rotor (brand trust)?
- Email provider and EU data residency.
- Is xpub watch MVP or phase 2 (cost: gap-20 x N addresses)?
- Paid explorer tier vs self-host for BTC at launch volume.
- Legal entity, VAT and crypto-payment treatment.
- Whether to expose a public status page for watcher health.
