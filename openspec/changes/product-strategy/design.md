# Design: product strategy, surface map and architecture

Status: strategy for review, 2026-11-16. Facts cite `file:line`; external facts
are dated and marked **not verified** where they could not be re-checked.

## D1 Context: what exists, what it costs to extend

| Asset | Evidence | State |
|---|---|---|
| Public site and coordinator | `src/coordinator/mod.rs:31-41`, `:490-505` | `/`, `/app`, `/me`, `/docs`, `/run`, `/key` embedded in one binary |
| Coordinator runtime | `src/coordinator/mod.rs:1-7`, `:42-50` | `tiny_http`, one `Mutex<State>`, one thread per request, 1 MiB body, 32 concurrent, 20 req/s per token |
| State | `src/coordinator/state.rs:461-470` | Whole-file JSON rewrite per mutation; targets dozens of clients, not thousands (`README.md:376-378`) |
| Accounts | `src/coordinator/state.rs:126-145` | Contributor token only: name, token hash, stats; no e-mail, password, plan |
| Monetisation | `apps/site/landing.html:95-104` | Donation addresses and a `pay.pxbt.app` link |
| Key explorer | `apps/site/key.html:22-27`, `apps/site/key.js:742,787,823` | Client-side WASM derivation; opt-in balance calls direct from browser |
| Browser worker | `README.md:226-249` | ~300-400k keys/s per tab, leases chunks from the coordinator |
| Puzzle engine | `README.md:8-34` | CPU/GPU/BSGS search for authorised public puzzles |
| Licence | `Cargo.toml:5`, `README.md:801-802` | GPL-3.0-only |

Constraints from the owner: calculations client-side, minimal server load, one
product with accounts/settings/paid service, Cloudflare Workers/Pages possible
later but not required now, existing receive-only pay page, existing Rust puzzle
tool.

Consequence: the product can add free client-side surfaces cheaply, but a paid
watchlist introduces the first sustained server obligation (polling, state,
delivery, billing). The strategy must make that obligation explicit and bounded.

## D2 Positioning, honesty boundary and trust posture

### D2.1 Claim matrix

| Allowed | Forbidden |
|---|---|
| "Derive addresses from your key locally, in this browser" | "Find any private key", "search all wallets", "index funded addresses" |
| "We never ask for your key or seed phrase" | "We detect leaked keys", "prevent theft", "guaranteed" |
| "Watch addresses you verify and alert on activity, approvals, dust and known-compromised lists" | "Recover your funds", "protect your wallet", "your key is safe" |
| "This is a puzzle-only tool for authorised public events" | "Scan live wallets", "find lost Bitcoin" |

The boundary is not marketing tone: it is the product's legal and ethical
defence. An idle copied key is unobservable; an alert limits damage but does not
prevent it (`key-leak-monitor/proposal.md:33-55`). UI, docs, alerts and metadata
must repeat that. A grep gate should fail the build on forbidden claims
(`key-leak-monitor/proposal.md` acceptance 11).

### D2.2 Trust posture

"Client-side" means **the coordinator does not receive the key**. It does not
mean a compromised host, malicious extension, DNS/TLS interception or altered
WASM is safe (`tx-sign-broadcast/proposal.md:219-232`). Controls, in order:

1. **Separate origin for key tools** (e.g. a dedicated subdomain or product
   domain). A compromise of the puzzle/dashboard origin must not share cookies,
   local storage or CSP with the page that handles keys. This is a strategy
   decision, not a code detail. A separate origin is a security boundary, not a second
   product: accounts, billing and settings stay unified.
2. **CSP and no third-party scripts** on `/key` and future calculators:
   `default-src 'self'`, `connect-src` only the documented public providers, no
   ads, no third-party analytics, no tag managers.
3. **Pinned, reproducible WASM**: publish the build hash and a reproducible-build
   recipe; verify it in CI; show it on the page.
4. **No server-side key intake**: endpoints reject 64-hex/WIF/BIP39-shaped
   bodies with 422 and never log the payload (`key-leak-monitor/design.md` D3).
5. **No mnemonic input on the web page.** Seed-level operations stay in the
   offline Rust CLI; a seed phrase is a higher-value secret than a single key and
   turns the page into a bigger target.
6. **Signing is testnet-first**: testnet default, typed mainnet confirmation, no
   sweep, no auto-sign, no auto-broadcast, local review before broadcast
   (`tx-sign-broadcast/proposal.md` scope).
7. **Incident plan**: security.txt, disclosure address, kill switch for key
   pages, rotation, user notice template, post-mortem.

## D3 Product surface map and build/defer/reject decisions

| # | Surface | Now | Compute | Decision |
|---|---|---|---|---|
| 1 | Key explorer `/key` | Shipped | Client (WASM) | **Keep and harden**; trust anchor |
| 2 | Address/key converters (hex, decimal, WIF, Base58Check, bech32/bech32m, hash160, keccak, script) | Partial inside `/key` details | Client | **Build as standalone SEO pages**; cheap traffic |
| 3 | xpub/address derivation (public key only, gap limit) | Not built | Client | **Build** in Phase 1; safe because the input is public |
| 4 | Mnemonic/BIP32 from a seed phrase on the web | Explicitly out of `/key` v1 | Client | **Reject on web**; keep in the signed offline CLI |
| 5 | Transaction builder, local sign, broadcast | Spec'd, not built | Client + public APIs | **Build P2WPKH MVP, testnet-first** in Phase 2; mainnet behind a gate |
| 6 | Customer accounts (e-mail + wallet) | Contributor tokens only | Server | **Build unified identity** in Phase 3; link, do not break, contributor tokens |
| 7 | Cabinet and settings | Token-only `/me` | Server | **Extend** with watchlist, plan, notification settings, export/delete |
| 8 | Watchlists and alerts | Spec'd | Server | **Build after demand gate**; the only paid core |
| 9 | Subscriptions and billing | Absent | Server + Stripe | **Build Phase 4**; Stripe first, crypto annual invoice second |
| 10 | Puzzle participation | Shipped | Server + client | **Keep free**; no pay-to-win, no gated puzzle features |
| 11 | Partner API | Public summary only | Server | **Reject bulk key/derivation API**; later webhook API for paid watchlists |
| 12 | SEO/docs/security pages | Minimal docs | Static/edge | **Build Phase 0-1**; honest limits, security page |
| 13 | Offline CLI key tools | Mnemonic derive exists (`README.md:748-799`) | Local | **Package and sign** in Phase 1; the safe path for seeds |
| 14 | Mobile apps | None | Client | **Defer**; responsive web first |

Notes:

- Surfaces 1-5 are free. They create traffic and trust but no direct revenue.
- Surface 8 is the only recurring-revenue product. It is also the only surface
  that creates a standing server obligation; everything else is either static or
  client-side.
- Surfaces 10-11 are community/developer surfaces. They must not subsidise a
  hosted key-computation API: that is an abuse magnet and a server cost with no
  defensible moat.

### D3.1 Rejected outright

- **Bulk key checking / "does this random key have funds"**: indistinguishable
  from theft tooling; server load is unbounded.
- **Hosted bulk derivation API**: same abuse profile; publish the library instead.
- **Seed-phrase intake on a web page**: highest-value secret, highest liability.
- **Selling access to leaked-key datasets or "recovery" services**: conflicts
  with the honesty boundary and invites fraud.
- **Ads or third-party analytics on key pages**: supply-chain risk on the one
  surface that handles secrets.
- **Pay-to-win puzzle mechanics**: undermines the verified-work leaderboard.

## D4 Roadmap: phases, dependencies and exit gates

| Phase | Scope | Depends on | Exit gate | Revenue |
|---|---|---|---|---|
| 0. Trust + measurement | CSP, separate key origin, security page, pinned WASM, key-leak test, funnel events, SEO metadata/sitemap, waitlist CTA | — | Baseline dashboard; security checklist green; waitlist live | None |
| 1. Calculators + offline CLI | Converter pages, xpub derivation, signed CLI package, cross-links | Phase 0 | Organic traffic baseline; derive→waitlist measured | None |
| 2. Signing MVP | P2WPKH, testnet default, mainnet gate, local review, broadcast fallback | Phase 0; `tx-sign-broadcast` T0-T3 | Regtest + testnet acceptance; key-leak test; no mainnet incident | None |
| 3. Accounts + watchlist beta | E-mail magic link + wallet signature, link contributor, BTC+EVM watch, e-mail+Telegram, dedupe, degraded banner, 10-user beta | Phase 1-2 demand gate; `key-leak-monitor` tasks 1-5 | 10 users; measured latency, false positives; written go/no-go | Beta, free |
| 4. Billing + public launch | Stripe Checkout/Portal, crypto annual invoice ledger, entitlement, pricing page, support | Phase 3 end-to-end alert | First paying customers; trial→paid; cost per watch | Subscription |
| 5. Expansion | Solana/TRON, xpub watch, webhooks, P2SH-P2WPKH/P2TR signing, partner webhook API, CF migration | Triggered rows in D6 | Per-feature gate | Add-ons |

**Demand gate (between Phases 2 and 3).** Do not authorise the watchlist build
until all three hold:

1. At least 50 waitlist sign-ups from distinct, plausible users (not the
   operator's own addresses).
2. A 10-user concierge beta: the operator watches their addresses manually with
   existing scripts + Telegram for two weeks, and at least 3 users say they would
   pay the proposed price.
3. Measured alert latency and false-positive rate are acceptable (target: median
   < 5 min for BTC mempool, < 15 min for EVM; false positives < 5% of critical
   alerts).

If the gate fails, stop at free calculators + puzzle and keep the brand clean
without a subscription. If it passes early, start Phase 3 backend in parallel
with Phase 2; never start Phase 4 before a testnet alert proves the path.

## D5 Monetisation

### D5.1 Free vs paid boundaries

| Capability | Free | Solo (EUR 5/mo) | Pro (EUR 12/mo) |
|---|---|---|---|
| Client-side calculators and key explorer | Unlimited | Unlimited | Unlimited |
| Transaction signing (when shipped) | Free, testnet-first | Free | Free |
| Watched addresses | 3 | 10 | 50 |
| Default polling | 15 min | 15 min | 5 min |
| Priority polling (60 s) | — | Add-on | Included for 10 addresses |
| Alert channels | E-mail daily digest | E-mail + Telegram | E-mail + Telegram + HMAC webhook |
| Event history | 7 days | 90 days | 1 year |
| xpub watch | — | — | Included |
| Add-on address | — | EUR 0.25/address/month | EUR 0.25/address/month |
| Annual | — | 10 months for 12 | 10 months for 12 |
| Puzzle participation | Free forever | Free | Free |

Rationale: charge for **standing work and history** (addresses, poll frequency,
delivery channels, retention), never for the calculators or for safety-critical
warnings. Charging for signing would create a perverse incentive to handle funded
keys; keep it free and gated by safety UX.

### D5.2 Cost floor

From `key-leak-monitor/design.md` D5.2 (recorded 2026-11-16): one EVM address at
300 s (2 calls/poll) is ~576k calls/day, about **USD 0.52/month** at Etherscan
overage; at 900 s it is ~**USD 0.17/month**. BTC public APIs publish no numeric
paid quota, so BTC is either self-hosted (`electrs`/Esplora) or sponsored.

Consequences:

- A EUR 5 tier with 10 EVM addresses at 5-min polling costs ~EUR 5.2/month —
  underwater. The 5-min tier must be Pro or an add-on, or default to 15 min.
- Free tier must not promise 1-min BTC polling. It cannot be funded by the
  subscription at low conversion.
- Re-check the floor before launch; provider prices are not verified and may
  change.

### D5.3 Pricing experiments

Run sequentially while traffic is low; never A/B security or disclaimer copy.

| # | Experiment | Measure | Decision rule |
|---|---|---|---|
| E1 | Anchor Solo at EUR 5 vs EUR 9 on the pricing page | Trial starts, trial→paid | Keep the higher price if conversion drops < 20% |
| E2 | Address buckets vs pure per-address pricing | Comprehension, support tickets, revenue/account | Buckets if support drops and revenue/account holds |
| E3 | Monthly vs annual prepay (10/12) | Cash flow, churn | Push annual if churn falls without conversion loss |
| E4 | Crypto annual -10% vs card | Payment mix, reconciliation cost | Keep crypto only if reconciliation < 15 min/invoice |
| E5 | 7-day vs 14-day trial | Trial→paid, support | 7 days unless 14 materially improves paid conversion |

### D5.4 Stripe vs crypto, and why the pay page is receive-only

Verified fact (recorded 2026-11-16 in `key-leak-monitor/design.md` D9):
`pay.pxbt.app` is a payment-link tool that connects a wallet and shows an address
or QR. It has no registration, server, subscriptions or webhooks. It can display
a receiving address, but it cannot tell our server that a specific customer paid,
cannot renew, refund, charge back or reconcile by invoice.

- **Card path (recommended first)**: Stripe Checkout subscription + Customer
  Portal; signed webhooks with event-id idempotency; Stripe Tax for EU VAT;
  refunds and chargebacks exist; Stripe sees e-mail, never user wallet addresses.
- **Crypto path (fits the audience)**: annual prepay only at first. A server-side
  invoice ledger creates a unique amount/reference and a platform receiving
  address; the existing watcher confirms N confirmations and grants the period
  idempotently by txid. `pay.pxbt.app` may display the address/QR, but it is not
  the source of truth. Risks: wrong amount, volatility, no chargebacks, manual
  refunds; show exact amount and expiry, credit overpayment.
- **What is needed either way**: an entitlement service (`plan`, `period_end`,
  `address_limit`, `grace_until`), a customer portal, dunning, and an admin
  reconciliation view. Billing must not live inside the puzzle state file.

### D5.5 Abuse and cost controls

- Address addition requires a signature; no unverified watches.
- Per-account and per-IP limits on challenge issuance and adds; uniform responses
  so a caller cannot learn whether an address is already watched.
- Shared polling: one provider poll per `(chain, address)`, N users = N
  deliveries, not N polls (`key-leak-monitor/design.md` D4).
- Adaptive intervals, per-chain daily budget, circuit breaker, degraded-state
  banner; slow all watches proportionally rather than dropping them silently.
- One trial per verified wallet + e-mail; low trial limits instead of
  fingerprinting.
- No free hosted API; no unmetered webhook fan-out; cap alerts per address/day.
- Reject ads: they are both a trust problem and a supply-chain risk.

## D6 Architecture: client, server and edge

### D6.1 Principle

**Key material and key math never leave the client. Public-data state may live on
the server.** "Everything client-side" is true for derivation, conversion,
signing and puzzle scanning. It cannot be true for a watchlist: someone must poll
providers, remember cursors, deduplicate events, deliver alerts and honour a
subscription. Those are stateful obligations, not calculations.

### D6.2 Must be server-side

| Capability | Why |
|---|---|
| Customer accounts, sessions, e-mail verification, password reset | Identity and recovery cannot be client-only |
| Address ownership proofs (nonce issue/verify) | Server must verify the signature and bind it to an account; nonce must be single-use |
| Watchlist, labels, mute, entitlement | Shared, durable state |
| Provider polling, cursors, dedupe, reorg correction | The server is the only party that sees all users' watches |
| Notification delivery, retries, delivery log | Must survive the browser closing |
| Billing webhooks, invoices, entitlement transitions | Money and access must be authoritative |
| Abuse controls, audit, rate limits | Cross-user visibility |
| Puzzle jobs, leases, proof verification, leaderboard, BSGS state | Existing coordinator contract; cannot move without breaking clients |

### D6.3 Can be Cloudflare Workers/Pages later

| Capability | Cloudflare option | Caveat |
|---|---|---|
| Marketing/docs/SEO calculator pages | Pages + edge cache | Keep canonical URLs and one source of content; do not fork copy |
| Billing/email webhooks | Worker | Must be independent of coordinator uptime; verify signatures; idempotency in KV/D1 |
| Scheduled provider polls | Cron Triggers + Queues | Per-address state needs Durable Objects or D1; fan-out needs Queues |
| Leak dataset lookup | R2 + Worker | Hash-only dataset; no plaintext addresses |
| Public stats cache | Worker/KV | Read-only; never cache authenticated data |
| Partner webhook delivery | Queues + Worker | Signing, retries, dead-letter |

Caveats: Workers CPU limits for secp256k1 signature verification are **not
verified**; Durable Objects/Queues add cost and a second state model; a split
deploy doubles config, secrets and observability. Do not move key math to the
edge either: the browser is the only place it belongs.

### D6.4 Must stay in the Rust coordinator

- Puzzle lease/chunk/heartbeat/result/proof/leaderboard and BSGS state. These are
  CPU-bound, latency-sensitive and already have a strict client contract
  (`README.md:142-378`).
- Embedded pages while a single-binary deploy remains a feature.
- The whole-file JSON state is acceptable for dozens of clients; it is not the
  store for thousands of watches (`README.md:376-378`).

### D6.5 Decision table: migration triggers

Thresholds are internal planning values to review, not measured facts.

| Component | Today | Option | Move when |
|---|---|---|---|
| Static pages | Embedded in Rust | CF Pages | Content deploys are blocked by coordinator releases, p95 TTFB > 300 ms, or organic traffic > 50k sessions/month |
| Billing webhook | Rust | CF Worker | Stripe/email retries fail > 0.1%, or coordinator downtime would miss an entitlement window |
| Watch polling | Rust thread | Cron Triggers + Queues/DO | Watches > 2,000, provider calls > 100k/day, or multi-region latency needed |
| Watch store | JSON file | SQLite, then managed DB | > 5,000 watches or > 20 MB (from `key-leak-monitor/design.md` D2.3); managed DB at > 50k |
| Accounts | JSON + token auth | SQLite / managed auth | > 1,000 customers, or e-mail deliverability/compliance becomes a burden |
| Notifications | Rust thread | Queues + Worker | Alerts > 1,000/day or p95 delivery > 60 s |
| Partner API | None | Worker | A paying partner exists and traffic is separable from internal |
| Puzzle coordinator | Rust | Scale Rust, not CF | > 100 concurrent clients, p95 lease latency > 500 ms, or multi-region clients |
| Key math | Browser WASM | Never server | No trigger; this is a product invariant |

## D7 KPIs and validation experiments

### D7.1 Funnel events

No third-party analytics on key pages. Use first-party, aggregate counters (no
key, no address, no precise fingerprint) and server-side event names:

| Stage | Event | Leading or lagging |
|---|---|---|
| Acquisition | `calc_view` (page, no key) | Leading |
| Activation | `derive_success` | Leading |
| Intent | `balance_check_opt_in` | Leading |
| Bridge | `watch_cta_click` | Leading |
| Demand | `waitlist_signup` | Leading |
| Account | `account_created` | Lagging |
| Activation | `watch_verified` | Lagging |
| Value | `alert_delivered` | Lagging |
| Revenue | `trial_start`, `paid_start`, `churn` | Lagging |

### D7.2 Leading indicators and hypotheses

Targets are hypotheses to validate, not promises:

- Organic sessions to calculator pages; derives per session (target > 0.6).
- D7/D30 return rate for calculator visitors (target D30 > 10% once accounts and
  watch CTA exist).
- `watch_cta_click` / `balance_check_opt_in` > 5%.
- Waitlist → beta > 20%; beta → paid > 10%; trial → paid 3-5%.
- Alert delivery success > 99.9%; false positives < 5% of critical alerts.
- Support tickets per 100 users < 10; provider cost per paying user < 30% of
  revenue.
- Zero security incidents; zero third-party requests on key pages.

### D7.3 Experiments

| # | Experiment | Duration | Success signal |
|---|---|---|---|
| V1 | Publish 5 converter SEO pages, link to `/key` | 4 weeks | Organic sessions and derive→waitlist measurable; at least one page ranks for a long-tail query |
| V2 | "Watch this address" CTA after a balance check | 2 weeks | CTA CTR > 5%; at least 20 waitlist sign-ups |
| V3 | Concierge beta: 10 users, manual watch via scripts + Telegram | 2 weeks | 3 users would pay; latency and false positives measured |
| V4 | Pricing anchor EUR 5 vs 9 | 4 weeks or 200 visits | Trial→paid within 20% of the lower-anchor baseline |
| V5 | Signing testnet beta | 4 weeks | Completion rate and drop-off; zero key-leak test failures |

## D8 Risks, legal exposure and the ethical line

| Risk | Severity | Why | Mitigation | Trigger |
|---|---|---|---|---|
| Security reputation / key theft | Existential | A key site is a target; one XSS, dependency or deploy compromise can steal funded keys and end the brand | Separate key origin; CSP; no third-party JS; pinned reproducible WASM; no server key intake; audit; bug bounty; incident plan | Any third-party request or CSP violation on `/key` blocks release |
| Brand conflict | High | Rotor is known as a key-cracking project; "send us your addresses" can read as alarming | Separate product name/domain; no cross-claims; clear puzzle-only framing; independent security page | Before public watchlist launch |
| Ethical / theft facilitation | High | Bulk key checking, sweeps or "find funds" features would turn the product into a theft tool | One user-supplied key; no index; no bulk API; authorised puzzles only; written refusal policy | Any feature whose primary use is finding others' keys is rejected |
| Legal / YMYL / GDPR / crypto payments | Medium-high | Financial/security claims, subscriptions, personal address data, crypto payment and tax rules; not verified | Counsel review; terms/privacy; subprocessor list; disclaimers; retention/export/delete; no investment advice | Before charging money |
| Provider dependency | Medium | mempool.space/Etherscan rate limits, CORS, schema changes, terms; BTC has no published paid quota | Adapters, budgets, circuit breaker, paid tiers, self-host `electrs` threshold, status page | 429 rate > 1% or p95 latency > 60 s |
| Support burden | Medium | Wallet signing quirks (BIP322 support varies), false alerts, billing | E-mail-only MVP; diagnostics; docs; status page; concierge beta; 7-day dead-man test | Tickets > 10/100 users |
| SEO YMYL volatility | Medium | "Private key" queries are high-risk; Google may distrust the category; the brand can be associated with scams | Honest content, E-E-A-T signals, no "find lost Bitcoin", diversify to community/Telegram | Organic share > 70% of signups |
| GPLv3 source obligation / moat | Medium | Served WASM is distribution; source must remain available; competitors can reuse it | Accept open source and compete on trust/service, or isolate new server code; legal review | Before any proprietary packaging |
| Single-operator bus factor | Medium | One maintainer runs infra, support and security | Runbooks, backups, monitoring, on-call expectations, documented recovery | Any key-person absence > 1 week |
| Cloudflare lock-in | Low-medium | A later migration can strand logic in Workers/DO/Queues | Abstract provider interfaces; keep exit path; no key math at the edge | When a D6.5 trigger fires |

### D8.1 The ethical line

**Do:** compute one key the user supplies; explain the math; derive public xpubs;
sign the user's own transaction locally; monitor addresses the user proved they
control; participate in authorised public puzzles.

**Do not:** index wallets or keys; enumerate funded addresses; offer bulk
"check any key" as a service; sweep or move funds from keys the user cannot
prove they own; sell leaked-key data; build "recovery" flows that ask for a seed;
market anything as "find lost Bitcoin".

**Refusal policy:** if a feature's primary use is finding or taking another
person's keys, it is rejected even if it would convert. Document the refusal in
the change, so the decision is not relitigated by traffic pressure.

### D8.2 Legal and platform items (not legal advice)

- Consumer subscription law, trial/auto-renew disclosure, cancellation and
  refund policy.
- GDPR roles: controller for accounts/watchlists; processors for Stripe, e-mail,
  providers; address data is personal data and linkable to a person.
- Crypto payment/tax/AML treatment depends on jurisdiction; do not add KYC until
  a provider requires it, but do not assume none is needed.
- Provider terms: mempool.space/Etherscan commercial use, attribution, caching
  and rate limits must be re-checked before launch.
- YMYL content: no investment, tax or legal advice; no guarantee of recovery or
  protection.

## D9 Open questions

1. **Brand and domain**: does the paid product launch under a separate name and
   domain from Rotor? (Recommended: yes, to decouple the key-cracking brand.)
2. **Mnemonic policy**: confirm that seed phrases stay in the offline CLI and are
   never accepted by a web page.
3. **Mainnet signing gate**: is a separate hardened origin plus an independent
   crypto review required before mainnet is enabled? (Recommended: yes.)
4. **Demand threshold**: are the D4 gate numbers (50 waitlist, 10 beta, 3 willing
   to pay) the right ones for this audience?
5. **Provider contracts**: which BTC data path is affordable at launch — public
   APIs, a paid Esplora, or self-hosted `electrs`?
6. **Billing mix**: is crypto annual prepay worth the reconciliation cost, or
   should the first launch be card-only?
7. **Cloudflare timing**: is a second platform justified before the watchlist
   exceeds the D6.5 triggers?
8. **Free tier**: keep 3 free watches forever, or make the product trial-only to
   control provider cost?
