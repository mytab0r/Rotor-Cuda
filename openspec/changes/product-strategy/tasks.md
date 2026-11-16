# Tasks: product strategy execution

Roles: [product] decisions, [front] web/JS, [back] Rust/API, [ops] infra and
release, [qa] acceptance, [legal] review. Each phase ends in a testable artifact.
Front and back may run in parallel after a phase's contract is frozen; do not
merge a page against a half-finished API.

This change itself writes no product code. The tasks below are the execution
plan handed to implementation changes.

## 0. Decisions and preconditions (blocked by: —) [product][legal]

- [ ] Decide brand/domain separation for the paid product (design D9.1); record
      the decision and the redirect plan in this change.
- [ ] Confirm the mnemonic policy: web pages never accept a seed phrase; the
      offline CLI is the only seed path (design D2.2 item 5).
- [ ] Set the mainnet signing gate: separate hardened origin + independent crypto
      review before mainnet is enabled (design D9.3).
- [ ] Approve the demand-gate numbers and the pricing anchor (design D4, D5.3).
- [ ] Choose the launch BTC data path (public API vs paid Esplora vs self-hosted
      `electrs`) and record the cost basis (design D5.2, D9.5).
- [ ] Legal review scope agreed: terms, privacy, subprocessors, crypto payments,
      consumer subscription rules (design D8.2).

Exit: a decision record exists for every item; no phase starts with an open
decision that changes its architecture.

## 1. Phase 0 — trust, measurement and demand capture (blocked by: 0)

### 1a. Security and trust [front][back][ops][qa]

- [ ] Serve key tools from a separate origin/subdomain; no shared cookies,
      storage or CSP with the coordinator/puzzle pages.
- [ ] Add a strict CSP for `/key` and future calculator pages: `default-src 'self'`; `connect-src` only the documented balance providers; no ads, no
      third-party analytics, no tag manager.
- [ ] Pin the WASM hash in the page and CI; publish a reproducible-build recipe
      and show the hash on `/security`.
- [ ] Add `/security`, `security.txt`, disclosure address, incident and kill-switch
      runbook.
- [ ] Add a key-leak regression test: intercept fetch/XHR/beacon/WebSocket, form
      submits, storage, IndexedDB, cookies, URL/history and console; assert the
      key's hex/WIF/decimal never appears (adapt `tx-sign-broadcast` acceptance 5).
- [ ] Add a build-time grep gate for forbidden claims (design D2.1).
- [ ] QA: zero third-party requests on `/key`; CSP violation is a release blocker.

### 1b. Measurement [front][back]

- [ ] Define the D7.1 event schema; implement first-party aggregate counters (no
      key, no address, no precise fingerprint).
- [ ] Record a baseline before any new surface ships: `calc_view`,
      `derive_success`, `balance_check_opt_in`, `watch_cta_click`,
      `waitlist_signup`.
- [ ] Build a small internal dashboard (or a CSV export) for the funnel.
- [ ] Do not add third-party analytics to key pages; if site-wide analytics is
      needed, exclude `/key` explicitly.

### 1c. SEO and demand capture [front][product]

- [ ] Add title/meta/canonical/structured data to `/key`; add sitemap and
      internal links from `/docs` and `/`.
- [ ] Add a "Watch this address — get alerts" CTA after balance results; it opens
      a waitlist form, not a fake product.
- [ ] Publish 5 converter SEO pages (hex/decimal/WIF, Base58Check, bech32,
      hash160/keccak, public-key compression) that reuse the WASM core.
- [ ] Ensure every calculator page works without an account and without network
      requests when the input is local.

Exit: security checklist green; baseline dashboard exists; waitlist live; at
least one organic entry point per converter page.

## 2. Phase 1 — calculators and offline CLI (blocked by: 1)

- [ ] [front] Standalone converter pages: hex/decimal/WIF, Base58Check,
      bech32/bech32m, hash160/keccak, public-key compression, script/address.
- [ ] [front][back] xpub/address derivation (public key only; BIP32 path
      presets; gap limit 20; BTC first, EVM later). The input is public, so this
      is safe to put on the web.
- [ ] [back] Keep mnemonic/BIP32-from-seed in the Rust CLI; do not add a web
      endpoint or a web input for it.
- [ ] [ops] Package a signed offline CLI build (`rotor key-tools` or equivalent)
      with checksums and a one-page guide; link it from `/key` as the safe path
      for seeds.
- [ ] [qa] Vectors: BIP32/BIP39 xpub fixtures, converter round-trips, no network
      request when offline; SEO pages render without JS errors.
- [ ] [product] Measure derive→waitlist and decide whether the demand gate can
      start early (design D4).

Exit: converter/xpub pages live; offline CLI published and signed; funnel data
exists for the demand decision.

## 3. Phase 2 — signing MVP (blocked by: 1; follows tx-sign-broadcast)

- [ ] Freeze the `sign_p2wpkh`/`decode_tx` ABI and the P2WPKH-only scope.
- [ ] Decide hand-rolled vs audited `k256` for ECDSA/RFC6979; record wasm size
      and review evidence.
- [ ] Implement BIP143, RFC6979, low-S/DER, local signature verification.
- [ ] Implement local decode/review (inputs, outputs, scripts, fee, vsize, txid).
- [ ] Add UTXO discovery, change, fee guardrails and the broadcast fallback chain.
- [ ] Enforce: testnet default, typed mainnet confirmation, no sweep, no
      auto-sign, no auto-broadcast, no server key, no third-party decoder before
      broadcast.
- [ ] [qa] BIP143 vector, regtest end-to-end, testnet acceptance, tamper
      invalidation, key-leak test, broadcast failure paths.
- [ ] [front] Add the signing mode to `/key` behind an explicit gate; keep the
      read-only explorer as the default.

Exit: regtest + testnet acceptance; zero key-leak failures; mainnet still gated
by the Phase 0 decision.

## 4. Phase 3 — accounts and watchlist beta (blocked by: demand gate)

- [ ] [back] Customer identity: e-mail magic link + wallet signature; link an
      existing contributor token without changing its permissions.
- [ ] [back] Watchlist store and API (separate from `state::Data`), address
      proofs, single-use nonce, uniform responses, custody-rejection test.
- [ ] [back] Provider adapters, scheduler, adaptive intervals, budgets, dedupe,
      reorg correction, degraded-state flag (follow `key-leak-monitor` tasks 1-5).
- [ ] [back][ops] E-mail + Telegram delivery, retries, delivery log, dead-man
      test message, ops alerts.
- [ ] [front] Cabinet sections: watchlist, per-address events, mute/delete,
      notification settings, plan and usage; degraded banner; responsive UI.
- [ ] [qa][product] 10-user concierge beta: measure latency, false positives,
      willingness to pay; write the go/no-go.
- [ ] [legal] Terms/privacy/subprocessor list ready before the beta collects
      addresses.

Exit: 10 users; median alert latency and false-positive rate measured; written
go/no-go for billing.

## 5. Phase 4 — billing and public launch (blocked by: 3)

- [ ] [back][ops] Stripe Checkout subscription + Customer Portal; signed webhooks
      with event-id idempotency; trial/active/past_due/paused/canceled states;
      7-day grace.
- [ ] [back] Crypto annual invoice ledger: unique amount/reference, platform
      receiving address, N-confirmation grant by txid, overpay credit, admin
      reconciliation. `pay.pxbt.app` is display-only.
- [ ] [front] Pricing page with the D5.1 tiers and the D5.2 cost floor; trial
      disclosure, cancellation, refunds.
- [ ] [qa] Trial 4th address rejected; paid limit raised; expiry pauses alerts but
      keeps data 30 days; webhook replay ignored; crypto wrong-amount path safe.
- [ ] [ops] Status page, support inbox, runbooks, backup/restore drill.
- [ ] [product] Launch only after a testnet alert proves the full path.

Exit: first paying customers; trial→paid and cost per watch recorded.

## 6. Phase 5 — deferred and rejected (no work now)

Deferred until a D6.5 trigger or a later change:

- [ ] Solana/TRON watch adapters, xpub watch in paid tier, web push, mobile apps.
- [ ] P2SH-P2WPKH and P2TR signing, PSBT, hardware wallets, RBF bumping.
- [ ] Partner webhook API; public stats API expansion.
- [ ] Cloudflare migration (Pages/Workers/Cron/Queues) only when a trigger fires.

Rejected (do not schedule):

- [ ] Bulk key checking / hosted bulk derivation API.
- [ ] Seed-phrase input on any web page.
- [ ] Sweeping, "send max", automatic signing or automatic broadcast.
- [ ] Ads or third-party analytics on key pages.
- [ ] Pay-to-win puzzle mechanics.
- [ ] Any feature whose primary use is finding or taking others' keys.

## 7. Strategy acceptance (blocked by: 1-5)

- [ ] Funnel baseline recorded before launch of each new surface.
- [ ] Security checklist green: CSP, zero third-party requests, pinned WASM,
      key-leak test, `/security`.
- [ ] Demand gate documented with numbers and a decision.
- [ ] Pricing floor documented per tier; no tier below cost.
- [ ] Architecture triggers reviewed; no migration without a triggered row.
- [ ] Build/defer/reject list reviewed; rejections still hold.
