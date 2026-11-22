# Tasks: security advisories pipeline

Roles: [site] data, page and wallet UI; [back] coordinator routes; [ops] gate,
CI and docs; [qa] tests.

## 1. SSOT and checker registry (done) [site]
- [x] `data/security-advisories.json` with `version`, closed `severity_levels`
      and `review_statuses`, `rules`, `checkers`, `advisories`, `threats`.
- [x] Seed Milk Sad (CVE-2023-39910) with the local seed-range checker and
      primary sources (Milk Sad research, NVD).
- [x] Seed the Android `SecureRandom` advisory (CVE-2013-7372) with no local
      checker, so the wallet has an honest "checker unavailable" state.
- [x] Seed address poisoning as a `threat`, not an advisory: no CVE, no
      affected version, no patch, primary source Chainalysis.
- [x] Record `reviewed_by` / `reviewed_at` and the review notes on every entry.
- [x] `apps/site/milk-sad-scan.js`: one shared `bxSeed`, `addressProfile` and
      bounded `scanRange`; `/milk-sad` uses it instead of its local copies.

## 2. Validator and gate (done) [ops]
- [x] `scripts/check-advisories.mjs`: schema, closed sets, https primary
      sources, actions, review provenance, canonical chains.
- [x] Fail when an advisory names an unknown checker, or a checker route or
      implementation does not exist in the coordinator/file tree.
- [x] Fail when the committed `apps/site/security.html` is stale.
- [x] Check the page SEO shape and that `/security` and
      `/security-advisories.json` are served.
- [x] `scripts/gen-security-page.mjs` (+ `--check`).
- [x] `scripts/check-advisories.test.mjs` covers the rejection paths.
- [x] Register the detector `security-advisory-integrity` in
      `data/detectors.json` and add the defect-ledger entry.
- [x] Wire into `rust.yml` and `ui.yml` next to the other checks;
      `projects.json` build/test lists.

## 3. Public page and route (done) [site] [back] [qa]
- [x] Generated `/security` page: advisory and threat cards, "what to do",
      local checker or "no local check", primary sources, methodology, the
      no-vulnerable-key-directory note.
- [x] Canonical, indexable, `CollectionPage` JSON-LD, one `main`, one `h1`,
      no page-local footer (the coordinator injects the shared one).
- [x] Coordinator embeds `/security`, `/security-advisories.json` and
      `/milk-sad-scan.js`; sitemap lists `/security`; breadcrumb test updated.
- [x] Rust test covers the routes, the JSON shape and the sitemap.
- [x] `ui-audit.mjs` default routes include `/security`.

## 4. Wallet security status (done) [site] [qa]
- [x] `apps/site/wallet-security.js`: reviewed-only selection, chain scope,
      applicable vs uncheckable, timestamp storage, bounded run dispatch.
- [x] "Security status" card in `wallet.html`: counts, last check, per-entry
      rows, local scan form, honest result text.
- [x] `wallet.js` wiring: fetch catalog on unlock, render on entry changes,
      hide on lock, record only timestamps.
- [x] Tests: no advisories / applicable / checker unavailable / draft ignored /
      testnet excluded / hostile storage / no address stored.
- [x] `/milk-sad` page and the wallet use the same scan module.

## 5. Notification design (specified, not implemented) [back] [ops]
- [ ] Consent model and versioned consent text; double opt-in; `STOP` and
      cabinet unsubscribe, both effective before the next job run.
- [ ] Verified watchlist only: an address is alertable only after a wallet
      signature over a server nonce (reuse `key-leak-monitor` proofs).
- [ ] `security_alert_subscriptions`, `security_alert_watchlist` (keyed hash +
      ciphertext) and `security_alert_deliveries` tables with migrations.
- [ ] Daily job: reviewed advisories only; match the watchlist chain and the
      user's declared tool history; run a checker only when it declares
      `server_check: true`.
- [ ] Message template per design D7; no address, balance, seed request or
      "we detected a leak" claim.
- [ ] Dedupe `(advisory_id, account_id, address_hash)`; one digest/day; three
      messages/week; quiet hours; retry reuses the dedupe key.
- [ ] Tests: no consent no message; Telegram linked without alert consent no
      message; one delivery per advisory; quiet hours; STOP; address absent
      from logs and message body.

## 6. Acceptance
- [x] `node scripts/check-advisories.mjs`
- [x] `node scripts/gen-security-page.mjs --check`
- [x] `node --test scripts/check-advisories.test.mjs`
- [x] `node apps/site/milk-sad-scan-test.mjs`
- [x] `node apps/site/wallet-security-test.mjs`
- [x] `node scripts/check-projects.mjs`
- [x] `node scripts/check-ssot.mjs`
- [x] `node scripts/check-defect-ledger.mjs`
- [x] `node scripts/gen-detector-docs.mjs --check`
- [x] `cargo test --test coordinator_api` (security route test)
- [x] `node scripts/ui-audit.mjs --serve` (routes include `/security`, wallet
      security panel states)
