# Address activity monitor ("watch my addresses")

## Summary

A paid, watch-only service: a registered user proves control of an address
(EVM, Bitcoin, later Solana/TRON) by signing a server nonce, adds it to a
watchlist, and receives alerts when the address moves funds, receives new
approvals or transfers, is touched by dusting/address-poisoning, or appears in
a published list of known-compromised keys. The product is an early-warning
and damage-limitation tool. It is **not** a "leaked key detector": derivation
of a key elsewhere is not observable on-chain, and a stolen key that stays
idle cannot be detected by anyone.

## Goal

Give a non-technical holder a single place that answers "did anything happen
to my addresses that I did not do?" within minutes, for a monthly fee, without
ever taking custody of keys or seeds.

## Problem / motivation

- Users with several wallets and cold addresses cannot watch them: explorers
  are per-address, per-chain, reactive, and email-free by default.
- The realistic threat is a leaked seed or a compromised key being used
  against an address that is otherwise dormant. The victim usually learns
  days later.
- The owner wants a subscription product adjacent to Rotor, and already runs
  Telegram ops and a receive-only crypto pay page.
- The coordinator already has accounts with bearer tokens, a cabinet, a
  public site, and an outbound HTTP client (ureq) - the missing pieces are
  wallet-signed identity, a watcher loop, notifications and billing.

## Honesty boundary (the central constraint)

Observable, therefore product-worthy:

1. Confirmed and (for BTC) mempool transactions touching an address.
2. Balance/UTXO changes, EVM nonce changes.
3. ERC-20/ERC-721 transfers and token approvals to spenders never seen before.
4. Inbound dust and address-poisoning lookalikes.
5. Membership of an address in a published compromised/weak-key dataset
   (e.g. Milk Sad-style brainwallet dumps) - but only after publication.
6. Activity on child addresses derived from a user-supplied **xpub** (public
   key only; gap limit), including addresses the user never listed.

Not observable, and must not be claimed:

- that someone copied, brute-forced or derived your key while it stays unused;
- that a mnemonic sits in someone's notes or in key-stealing malware;
- compromise before the first on-chain use;
- whether a given outgoing transaction was you or an attacker, without user
  input (we never hold the key, so we cannot sign or prove intent).

Consequence: alerts limit damage; they do not prevent it. "We detect leaked
keys" is false and is rejected in UI, docs and marketing.

## Ethics and disclosure boundary

Two tempting shortcuts are explicitly rejected, even though they would make the
product feel more powerful:

- **Covert reporting of derived addresses.** The key explorer must not quietly
  transmit addresses to the backend, disguised as image/skeleton requests or
  otherwise, to compare them with registered users. That contradicts the page's
  privacy promise, hides data collection, and links a person to their
  addresses. Any server-side exposure check must be visible, opt-in, and
  explained before it happens. A privacy-preserving alternative is a
  client-side membership check against a rotating, HMAC-keyed filter of
  registered address hashes, triggered by an explicit user action; it tells the
  visitor "this address belongs to a registered user" without reporting them.
- **Sweeping funds "for safekeeping".** Moving a balance from an address the
  service does not control is unauthorized access and theft in most
  jurisdictions, regardless of the intent to return it later. The service never
  takes custody, never signs, and never moves user funds. On a positive balance
  it may only alert the verified owner and show recovery guidance; the owner
  moves the funds themselves.

The only automated notification path is a consent-based watchlist: the user
proves control of an address and asks to be alerted about its activity and about
membership in published leak datasets.

## Scope

In (MVP):

- Account: email + wallet-signature login (EIP-4361 for EVM; BIP322 with
  legacy `signmessage` fallback for BTC). Existing bearer-token contributor
  accounts stay untouched; the monitor account is a separate record.
- Address linking: signature over `domain | account_id | chain | address |
  nonce | issued_at | expiry`; single-use nonce (10 min TTL); unverified
  addresses are never watched. Optional xpub watch (paid tier).
- Watcher: provider adapters (mempool.space/Esplora, Etherscan v2), a cheap
  per-address heartbeat call, full event fetch only on change, cursors,
  idempotent dedupe, per-address/chain budgets, shared watch keyed by
  `(chain, address)`.
- Signals: spend/receive, balance change, EVM nonce jump, ERC-20/721 transfer,
  approval to unseen spender, dust/poisoning, leak-list match.
- Alerts: Telegram, email, HMAC-signed webhook, in-cabinet event feed;
  delivery log; digest for low severity, immediate for spend/approval/leak.
- Billing: trial (7 days, 3 addresses), paid limits, entitlement with grace;
  Stripe Checkout **or** crypto invoice verified by the same watcher
  (`pay.pxbt.app` is receive-only, see References).
- Operator surface: provider health, "monitoring degraded" user banner,
  ops alert when a watcher loop or provider fails.

Out:

- Custody of any kind; accepting private keys, seeds or mnemonics; sweeping;
  recovery services; signing transactions on the user's behalf.
- Claims of leak detection or theft prevention; SLA guarantees.
- Self-hosted indexer in v1; full-chain indexing; "search any address".
- Solana/TRON adapters (phase 2), web push, mobile apps.
- KYC/AML, automated refunds, tax handling beyond Stripe Tax.

## Impacted domains

- `monitor` (new): accounts, wallet links, watchlist, cursors, events,
  providers, notifier, billing entitlement.
- `coordinator`: routes and static pages (`/monitor`, legal/docs), config
  flags, embedded assets; existing `/api/v1/*` permission matrix unchanged.
- `browser-client` / `key-explorer`: reuse address normalization and the
  privacy stance of `/key` ("we never ask for the key"); shared provider
  knowledge but no shared key material.

## Acceptance criteria

1. **Verified add**: a watched EVM address added with a valid SIWE signature
   appears in the cabinet; the same request with a mutated signature, wrong
   domain, expired or replayed nonce returns 400 and adds nothing.
2. **BTC testnet alert**: after a signed watch is created for a testnet
   address, a broadcast transaction paying it produces exactly one alert
   (Telegram/email/webhook recorded in the delivery log) within 5 minutes,
   naming txid, direction, amount and confirmations.
3. **EVM testnet alert**: an ERC-20 transfer to a watched Sepolia address
   produces an alert within 15 minutes; a token approval to a new spender
   produces a separate "approval" alert.
4. **Dedupe**: the same transaction is never alerted twice, including after a
   watcher restart.
5. **Delete stops alerts**: after deleting an address, a new transaction to it
   produces no notification; deletion takes effect within one poll interval.
6. **Plan limits**: a trial account cannot add a fourth address (403 with
   upgrade hint); a confirmed payment raises the limit; an expired
   subscription pauses alerts but keeps data for 30 days.
7. **Leak list**: an address present in the fixture dataset raises one
   "known compromised" alert on add, not on every poll.
8. **Failure honesty**: when the provider returns 429/5xx for more than two
   intervals, the cabinet shows "monitoring degraded" and an ops alert fires;
   no silent gaps (verified with a mock provider).
9. **No custody**: endpoints reject bodies containing a 64-hex private key,
   WIF or mnemonic with 422 and log no payload; docs state keys are never
   requested.
10. **Privacy/deletion**: account deletion removes addresses, events and
    delivery records within 30 days; logs contain no full addresses; the
    privacy page lists every third-party provider that receives addresses.
11. **Wording gate**: a grep test fails the build if UI/docs contain
    "detect leaked keys", "prevent theft" or similar claims.
12. **Budget**: a 1,000-address mocked load test stays within the request
    budget in design D5 and produces no per-address polling above the
    configured interval.

## Risks / unknowns

- **Provider terms and cost**: mempool.space documents 429s and possible bans
  but no numeric quota or commercial-use terms (fetched 2026-11-16);
  Etherscan free is 3 calls/s and 100k/day. Commercial polling may require a
  paid tier or self-hosting.
- **False sense of security / liability**: an alert is not protection; missed
  or late alerts are the main product failure. Needs explicit disclaimers.
- **Privacy**: the server learns every user's addresses; a breach correlates
  identities to wallets. Hashing does not help while polling public APIs
  (they require plaintext addresses).
- **Abuse**: verified-signature gates address addition, but an attacker could
  still probe whether an address is watched unless responses are uniform.
- **Brand trust**: Rotor is a key-cracking project; "send us your addresses"
  from that brand can read as alarming. Consider a separate product name.
- **Billing**: the owner's pay page has no subscriptions, webhooks or server
  (verified); card subscriptions need Stripe, crypto needs invoice matching
  and has no refunds/chargebacks.
- **Legal**: unverified - subscription consumer law, crypto payment handling,
  GDPR roles and third-party address disclosure.
- **Leak data quality**: public dumps prove "this address was weak/known
  compromised", not "your specific key leaked now"; false comfort is possible.

## References

- `src/coordinator/state.rs:125-145` - `ClientRecord` (id, name, token hash,
  stats; no email).
- `src/coordinator/state.rs:531-561` - `create_client`, token returned once.
- `src/coordinator/state.rs:586-596` - constant-time token identity.
- `src/coordinator/state.rs:1083-1130` - `/api/v1/me` cabinet snapshot.
- `src/coordinator/mod.rs:216-251` - endpoint permission matrix (`/me` and
  post/lease/heartbeat/result are client-only).
- `src/coordinator/mod.rs:439-441`, `:563-598` - open registration, per-IP
  60 s throttle, token returned once.
- `src/coordinator/mod.rs:31-41`, `:487-506` - embedded pages/assets.
- `src/coordinator/mod.rs:42-50` - 1 MiB body cap, 20 req/s per token.
- `apps/site/me.html:24-31`, `:73-184` - cabinet token login, 2 s polling.
- `apps/site/site.js:5-20`, `:49-61` - token in localStorage, bearer fetch.
- `Cargo.toml:33` - `ureq` with native-tls; `src/coordinator/client.rs:1-11`
  - existing outbound HTTP client.
- `openspec/changes/key-explorer/proposal.md` - sibling `/key` page: local
  derivation, public balance lookups, "key never leaves the browser".
- https://mempool.space/docs/api/rest - address endpoints; no documented
  rate numbers, no webhooks; 429 and possible ban (fetched 2026-11-16).
- https://docs.etherscan.io/rate-limits.md - free 3 req/s, 100k/day; paid up
  to 30 req/s, 1.5M/day; overage $3/100k calls (fetched 2026-11-16).
- https://pay.pxbt.app - crypto payment-link tool: connect wallet, show
  addresses/QR; no registration, no server, no subscriptions or webhooks
  (fetched 2026-11-16).
