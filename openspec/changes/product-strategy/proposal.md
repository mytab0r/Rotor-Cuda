# Product strategy: a trusted self-custody toolkit on top of Rotor

## Summary

Rotor already owns three assets: a verified puzzle coordinator with accounts and
a leaderboard, a browser WASM core, and `/key`, a client-side private-key
explorer. It has no measurement, no retention loop, no recurring revenue, and no
product-level decision about what to build next.

This proposal turns those assets into **one product with one trust posture**:

- **Free, client-side calculators** — key/address derivation, converters, later
  a testnet-first transaction signer. The key never leaves the browser.
- **A paid, server-side watchlist** — alerts when an address the user has proven
  they control moves, approves, or appears in a known-compromised list.
- **A free, honest puzzle community** — the existing coordinator, browser worker,
  native client and leaderboard. Not monetised, not pay-to-win.

Positioning: **"The private-key calculator that never asks for your key, and the
monitor for the addresses you verify."** Not a key finder, not a wallet, not an
index of wallets.

Recommended order: (1) trust + measurement + SEO/demand capture; (2) client-side
P2WPKH signing MVP, testnet-first; (3) watchlist + billing, gated on demand. The
full surface map, monetisation model, architecture decision table and risks are
in `design.md`; execution is split in `tasks.md`.

## Problem / motivation

- `/key` is read-only and deliberately custody-free (`README.md:254-274`,
  `web/docs.html:84-95`). It is a good trust anchor but a weak business: a
  one-visit calculator with no account, no return reason and no revenue.
- Accounts are contributor tokens only — no e-mail, password, OAuth, payments or
  per-account quotas (`src/coordinator/state.rs:126-145`,
  `README.md:366-368`). There is no customer identity to attach a paid service to.
- The only money path is a donation card (`web/landing.html:95-104`) plus a
  receive-only `pay.pxbt.app` link that cannot manage subscriptions or confirm
  payments to the server (recorded in `key-leak-monitor/design.md` D9).
- Two implementation-ready changes exist — `key-leak-monitor` (watchlists,
  alerts, subscription) and `tx-sign-broadcast` (local P2WPKH signing) — but
  nothing decides their order, their gates, or what must not be built.
- A key site is a security target. Growth without a trust baseline increases the
  chance that the first scaling event is also the first incident.

## Positioning and audience

| Audience | Job to be done | Product | Willingness to pay |
|---|---|---|---|
| Self-custody holders / learners (primary buyer) | "What does this key control, and did anything move?" | `/key`, converters, signer, watchlist | Subscription for alerts and history |
| Puzzle hunters (community) | "Contribute compute to an authorised puzzle and see verified progress" | Coordinator, browser worker, native client | Low; keep free |
| Developers / tinkerers (tertiary) | "Use the same derivation code offline" | Open-source library/CLI, docs | Low; no hosted bulk API |

**Honest framing of a "key explorer":** it computes the user's own key. It does
not index wallets, search "all private keys", enumerate funded addresses, or
observe a key that is copied elsewhere while idle. Observable watchlist signals
are on-chain activity, approvals, dust/poisoning and published compromised lists
— not "leak detection" (`key-leak-monitor/proposal.md:33-55`).

**Differentiation** (competitor details from the prior investigations recorded in
`key-explorer/proposal.md` and `tx-sign-broadcast/proposal.md`, dated 2026-11-16;
not re-verified today because outbound fetch was blocked):

| Dimension | privatekeyfinder.io | secretscan.org | Rotor |
|---|---|---|---|
| Key handling | Derives in browser, queries public balance APIs (prior investigation) | Server-side calculators; its tx page claims "offline" but posts the key to a PHP endpoint (prior investigation) | Local WASM; no key to the server; no third-party scripts |
| Breadth | Addresses + balances | Many calculators + tx builder | Key explorer + local signer + watchlist + puzzle |
| Account / recurring service | Not observed | Not observed | Unified account, watchlist, paid tiers |
| Trust claim | Little custody explanation | "Offline" claim contradicted by the form handler | Explicit trust boundary and honest limits |

Do not compete on page count. Compete on **provable local computation, honest
limits, and an integrated service** the reference calculators do not offer.

## Scope

### In

- Product positioning, audience, trust and safety posture.
- Surface map with **build / defer / reject** decisions.
- Phased roadmap with dependencies and exit gates.
- Free-vs-paid boundaries, pricing hypotheses and cost floor.
- Client / server / edge architecture with numeric migration triggers.
- KPIs, validation experiments, risk register and ethical line.

### Out

- Product code, pricing implementation, legal advice, provider contracts.
- Committing to Cloudflare now; it is a documented later option.
- Any new runtime behaviour. This change adds no delta specs; behaviour changes
  remain in `key-leak-monitor`, `tx-sign-broadcast` and future changes.

## Recommended next three increments

1. **Trust + measurement + SEO/demand capture** (2-3 weeks). CSP, separate key
   origin, no third-party scripts, pinned/reproducible WASM, `/security` page,
   key-leak regression test, privacy-preserving funnel events, converter SEO
   pages, and a "watch this address" waitlist CTA. *Why first:* trust is the
   gating asset of a key site, and the funnel data decides whether signing or
   monitoring is the next real build.
2. **Client-side signing MVP, P2WPKH, testnet-first** (4-6 weeks). Execute
   `tx-sign-broadcast` with testnet default, typed mainnet confirmation, local
   review, no sweep and no server key. *Why second:* it is the strongest
   differentiator against server-side competitors, adds zero server load, and
   deepens `/key` engagement; the trust baseline contains the added risk.
3. **Watchlist + billing MVP** (6-10 weeks for the beta, plus 3-4 for billing). BTC+EVM watchlists, e-mail +
   Telegram, dedupe, degraded-state honesty, Stripe subscriptions, crypto annual
   invoice ledger. *Why third:* it is the only recurring revenue and the largest
   operational burden, so it starts only after the demand gate
   (`design.md` D4) and an end-to-end testnet alert.

Decision rule: if waitlist/concierge demand clears the gate before increment 2
finishes, start increment 3 in parallel on the backend. Do not start billing
before a testnet alert proves the full path.

## Impacted domains

- `product` (new): positioning, pricing, decisions, metrics.
- `browser-client` / `key-explorer`: trust hardening, converters, signing.
- `coordinator`: customer identity, static assets, security headers.
- `monitor` (new): watchlists, providers, notifications, entitlement.
- `billing` (new): Stripe, crypto invoice ledger, plans.
- `docs/site`: security page, pricing, honest limits.
- `search` / puzzle: unchanged and free.

## Acceptance criteria

1. **Traceable facts**: every claim about the current product cites `file:line`;
   every external claim is dated and marked verified or not verified.
2. **Funnel baseline**: named events exist for calculator view, derive, balance
   opt-in, watch CTA, waitlist, account, verified watch, alert, trial, paid; a
   baseline is recorded before any new surface ships (design D7).
3. **Security baseline**: `/key` has a CSP with no third-party origins, zero
   third-party requests at runtime, a pinned WASM hash, and a passing key-leak
   regression test (no hex/WIF/decimal key in network, storage, URL or logs).
4. **Demand gate**: a 10-user concierge beta measures alert latency and false
   positives, and a written go/no-go decision exists before the watchlist build
   is authorised (design D4).
5. **Pricing floor**: every tier is documented with its provider-cost floor; no
   tier is priced below the measured cost at its default polling interval.
6. **Architecture triggers**: the migration table names a numeric trigger for
   each component; no component moves to Cloudflare without a triggered row.
7. **Build/defer/reject**: the surface map has an explicit decision for every
   surface, including the rejected bulk-key/API and web-mnemonic features.
8. **No behaviour change**: this change adds no product code and no delta specs;
   implementation changes remain separately reviewable.

## Risks / unknowns

- **Strongest risk: security reputation.** A site that invites funded keys is a
  target; one XSS, dependency or deploy compromise is existential and can cause
  user loss. See design D8 for the controls.
- **Brand conflict**: Rotor is a key-cracking project; "send us your addresses"
  from that brand can read as alarming (`key-leak-monitor/proposal.md:149-150`).
- **Legal / YMYL**: financial/security content, subscriptions, crypto payments,
  address data and GDPR roles need counsel; none of this is verified.
- **Provider terms**: mempool.space publishes no numeric commercial quota;
  Etherscan free is 3 req/s and 100k/day (recorded 2026-11-16). Commercial
  polling may require paid tiers or self-hosting.
- **Ethical line**: a feature whose primary use is finding other people's keys is
  rejected even if it would convert well.
- **GPLv3**: served WASM is distribution, so source availability is a business
  constraint as well as a licence obligation (`Cargo.toml:5`,
  `README.md:801-802`).
- **Unknowns**: competitor features were not re-verified today; Cloudflare
  Workers CPU limits for secp256k1 verification are not verified; real demand
  for paid monitoring is unknown until the demand gate runs.

## References

- `README.md:254-274` — `/key` scope and custody warning; `:360-378` — token-only
  accounts and whole-file JSON state limits; `:801-802` — GPLv3.
- `Cargo.toml:5` — `GPL-3.0-only`.
- `src/coordinator/mod.rs:31-41` — embedded pages; `:42-50` — 1 MiB body,
  32 concurrent requests, 20 req/s per token.
- `src/coordinator/state.rs:126-145` — `ClientRecord` (no e-mail/password/plan);
  `:461-470` — whole-file state rewrite.
- `web/landing.html:95-104` — donation-only monetisation.
- `web/key.html:22-27` — funded-key warning; `web/key.js:742,787,823` — direct
  opt-in balance calls to mempool.space / public EVM RPC / Tronscan.
- `web/docs.html:84-95` — read-only, no-signing, no-storage claims.
- `openspec/changes/key-explorer/proposal.md` — `/key` v1 scope.
- `openspec/changes/key-leak-monitor/{proposal.md,design.md}` — watchlist,
  cost model D5.2, billing D9, pricing D11.
- `openspec/changes/tx-sign-broadcast/proposal.md` — P2WPKH scope and risks.
- https://privatekeyfinder.io/ and https://secretscan.org/ — prior investigation
  2026-11-16; not re-verified today.
- https://pay.pxbt.app — receive-only payment-link tool, recorded 2026-11-16.
