# Tasks: address activity monitor

Roles: [back] backend/Rust, [front] web page, [ops] infrastructure, [qa]
acceptance. Each phase ends in a testable artifact. Do not start billing
before the watcher proves an end-to-end alert on testnet.

## 1. Store and module skeleton (blocked by: -) [back]
- [ ] `src/monitor/` module with its own `Mutex<Store>`, `monitor.json` and
      `monitor-events.jsonl` (daily rotation, 90-day retention); batched
      cursor flush (<=1/min). No monitor state inside `state::Data`
      (`state.rs:461-470` rewrites the whole file per mutation).
- [ ] Records per design D4: user, wallet link, watch (shared by
      chain+address), address state, event, delivery, leak set, invoice.
- [ ] Dedupe insert-if-absent on `sha256(chain|address|txid|kind)`; restart
      test proves no duplicate alerts.
- [ ] Canonicalization + validation for EVM/BTC addresses; fixture tests.
- [ ] Load test 1,000 watches with a mocked provider; store stays <20 MB
      (threshold for SQLite, design D2.3).

## 2. Providers and watcher (blocked by: 1) [back]
- [ ] Provider trait: `heartbeat(address) -> counters`, `details(address,
      cursor) -> events`. Adapters: mempool.space/Esplora, Etherscan v2.
- [ ] Scheduler: due-queue, adaptive intervals (300/900/60 s), per-chain
      daily budget that slows intervals instead of dropping watches.
- [ ] Circuit breaker on 429/5xx, exponential backoff, `last_ok_at` and
      failure counters; watcher heartbeat exposed to the ops surface.
- [ ] Reorg handling: correction event if a mempool tx disappears; never
      rewrite history.
- [ ] Mock-provider tests: 429 storm, timeout, schema drift, duplicate txs.

## 3. Wallet auth and watchlist API (blocked by: 1) [back]
- [ ] Nonce issue/verify endpoint; message schema per design D3; 10-min TTL,
      single-use, bound to domain + account.
- [ ] EVM: SIWE/EIP-4361 verification incl. EIP-1271; BTC: BIP322 P2WPKH/P2TR
      + legacy P2PKH fallback; signature never persisted.
- [ ] `POST /api/v1/monitor/watches` requires a fresh proof for the address;
      `DELETE` and `PATCH` (label, mode, mute).
- [ ] Entitlement gate on add (trial/plan/invoice), uniform error responses,
      per-IP/per-account rate limits.
- [ ] Custody guard: reject 64-hex/WIF/BIP39-shaped bodies with 422, log no
      payload.
- [ ] Tests: mutated signature, wrong domain, expired/replayed nonce, two
      users watching one address, address enumeration attempts.

## 4. Classification and leak set (blocked by: 2) [back]
- [ ] Rules S1-S9 (design D6) with severity, direction, amount, counterparty;
      approval detection for ERC-20 and ERC-721 topics.
- [ ] User acknowledgement ("this was me") recorded; never suppresses
      S1/S3/S4/S5.
- [ ] Import Milk Sad-style and operator lists into a SHA-256 `LeakSet`;
      match on add and version bump; one alert per (address, version).
- [ ] Fixture tests for each rule, including dust/poisoning and nonce jump.

## 5. Notifications (blocked by: 4) [back] [ops]
- [ ] Telegram bot link flow (code hashed, expiry), email provider adapter,
      HMAC-signed webhook with replay protection.
- [ ] Severity routing, digest, quiet hours, per-address cap, retries,
      second-channel fallback, 7-day dead-man test message.
- [ ] Alert template with txid/amount/confirmations, "what to do" and the
      no-keys disclaimer; wording gate test (acceptance 11).
- [ ] Ops alerts for provider failure, delivery failure >1%, watcher death.
- [ ] Delivery log readable by the user; email SPF/DKIM/DMARC verified.

## 6. Cabinet UI (blocked by: 3, 5) [front]
- [ ] `/monitor` page embedded like `/me` (`mod.rs:31-41`, `:487-506`):
      email sign-in, wallet connect + sign, watchlist with verification state,
      per-address event feed, mute/delete, plan and usage.
- [ ] "Monitoring degraded" banner; empty/error/loading states; no analytics;
      responsive 375/768/1280.
- [ ] Copy: honest wording, "we never ask for keys", link to legal pages.
- [ ] Node page test with mocked API; live browser check; `impeccable detect`
      clean; UI checklist gate.

## 7. Billing and entitlement (blocked by: 3) [back] [ops]
- [ ] Stripe Checkout subscription + Customer Portal; webhook with signature
      verification and event-id idempotency; entitlement transitions
      trial/active/past_due/paused/canceled; 7-day grace.
- [ ] Crypto invoice: unique amount/reference, platform receiving address,
      watcher confirms N confirmations, idempotent grant by txid, admin
      reconciliation view.
- [ ] Trial abuse limits: one trial per verified wallet + email; no
      fingerprinting.
- [ ] Tests: trial 4th address rejected; paid limit raised; expiry pauses
      alerts but keeps data 30 days; webhook replay ignored.

## 8. Legal, docs and privacy (blocked by: 6, 7) [ops] [front]
- [ ] Terms, privacy policy, subprocessor list, deletion/export flow,
      retention jobs; confirm GDPR roles and crypto-payment treatment with
      counsel (**not verified**).
- [ ] `/docs` section: what is watched, what is impossible, latency, pricing,
      disclaimers; link from landing and cabinet.

## 9. Acceptance and rollout (blocked by: 1-8) [qa] [ops]
- [ ] Testnet E2E: BTC testnet payment -> one alert <=5 min; Sepolia
      ERC-20 transfer -> alert <=15 min; approval -> separate alert.
- [ ] Delete stops alerts within one poll; restart produces no duplicates.
- [ ] Failure-honesty drill with a mock provider: degraded banner + ops alert.
- [ ] Wording grep gate, custody-rejection test, log-redaction test.
- [ ] Dogfood 2 weeks on the operator's addresses; private beta 10 users;
      measure latency, false positives, calls/day before public launch.
- [ ] PR, deploy via the existing pipeline, verify the live page and a live
      testnet alert.

## Out of scope
- Custody, key/seed intake, sweeping, recovery, guaranteed SLAs.
- Self-hosted indexer, full-chain indexing, Solana/TRON, xpub watch,
  web push, mobile apps (phase 2 or later).

## MVP status (2026-11-16)
- Done: monitor store with own file, EVM+SIWE login, session TTL/logout,
  EVM watch import (login address verified, others unverified), BTC address
  validation for manual watches, EVM watcher with baseline/balance/nonce
  events, in-app feed, `/monitor` page, `/key` opt-in exposure check,
  challenge/login/add IP+account rate limits, trust-proxy client IP,
  custody-shape guard, wording test.
- Deferred: email/Telegram/webhook delivery, BTC activity provider, xpub,
  leak lists, approvals/ERC-20 classification, billing/trial, account
  deletion/export, BIP322/BTC login, EIP-1271, xpub watch, SQLite.
