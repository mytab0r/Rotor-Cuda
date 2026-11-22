# Design

## D1. SSOT and generated page

`data/security-advisories.json` holds three arrays: `checkers`, `advisories`
and `threats`. `scripts/gen-security-page.mjs` renders `apps/site/security.html`
from it deterministically; the page is committed because the coordinator embeds
static assets with `include_str`. `scripts/check-advisories.mjs` fails when the
committed page differs from the renderer output, so the SSOT cannot drift from
what is served.

The JSON is served verbatim at `/security-advisories.json`. The wallet fetches
it from the same origin; the request carries no user data. The page and the
wallet both filter to `review.status === "reviewed"`, so drafts never leak to
users.

## D2. Schema

Closed sets: `severity` in `critical|high|medium|low|info`; `review.status` in
`draft|reviewed|superseded`; `kind` in `vulnerability|threat`; checker `kind`
in `local-seed-range` (the only implemented type today).

An advisory requires `cve`, `disclosed`, `affected.tools`,
`affected.versions`, `affected.chains` and an optional `checker`. A threat
requires `threat_class` and `first_documented`, and must not carry `cve` or
`checker`. Every entry requires non-empty `actions`, `sources` with at least
one `primary: true` and an https URL, and a `review` object. A reviewed entry
requires `reviewed_by` and `reviewed_at`; a draft must not carry them.

The validator also rejects protection claims from a small banned-phrase list
(for example "we protect you", "guaranteed"). Wording is load-bearing in
security communication, so the gate checks it rather than trusting review.

## D3. Checker registry

Each checker has one record:

```
{
  "id": "milk-sad-seed-range",
  "kind": "local-seed-range",
  "title": "Milk Sad seed-range scan",
  "description": "...",
  "chains": ["bitcoin"],
  "route": "/milk-sad#address-audit",
  "implementation": "apps/site/milk-sad-scan.js",
  "network": false,
  "limits": { "max_seeds_per_run": 2000 },
  "honesty": "A no-match result covers only the seed range entered..."
}
```

`route` must exist in the coordinator's `static_asset` map, and
`implementation` must exist in the repo. An advisory references a checker by
id; the gate fails on an unknown id, a missing route or a missing file. This is
the "ledger/registry entry" for the pipeline: the registry is data, and the
validator is the gate. The gate itself is registered as the
`security-advisory-integrity` detector and has a defect-ledger entry so a
removed checker route cannot ship silently.

`network: false` is a contract, not a comment: a local checker reads only what
the user supplies in the browser. The seeded Milk Sad checker reproduces
`bx seed` output from a 32-bit seed range with `RotorMilkSad.scanRange`; it
sends nothing.

## D4. Public page

`/security` is a content route: canonical link, indexable (no `noindex`),
`CollectionPage` JSON-LD, one `main`, one `h1`, and the shared coordinator
footer injected at serve time (the generated page ships no footer of its own). Advisory cards
show severity/CVE/review badges, the summary, "what it means for you",
"affected", "what to do", a local-checker block or an explicit "no local check"
block, and primary sources. Threats are a separate section with a note that
they are scam techniques, not software bugs, so a version update is never
presented as the fix.

The page states that it is documentation, not a protection service, and that a
bounded scan cannot prove a key is safe. It does not publish vulnerable keys.

## D5. Wallet "Security status" card

Data flow:

1. On unlock, the wallet fetches `/security-advisories.json` (public data).
2. `RotorWalletSecurity.selectForEntries` keeps reviewed advisories whose
   affected chain is present in the local vault. It returns `applicable`
   (a runnable local checker exists) and `uncheckable` (real advisory, but an
   address alone cannot decide it).
3. The card shows the applicable entries, the uncheckable ones with an honest
   explanation, a count, the number of local checks run, and the last check
   time.
4. "Check locally" opens a bounded seed-range form. The scan runs in the tab
   through `RotorMilkSad.scanRange` and the local WASM derivation. Only the
   user's own derived address is compared; nothing is sent.
5. On completion the card stores a timestamp keyed by advisory id and the
   vault's random entry id. It never stores an address. A match tells the user
   to move funds to a new wallet and links to `/security#<id>`; the card does
   not print a mnemonic, WIF or private key.

States covered by tests: no applicable advisory, applicable with a checker,
applicable with no checker ("checker unavailable"), advisory feed unreachable,
draft entries ignored, testnet not treated as mainnet, and hostile storage
failing closed.

## D6. Privacy boundary

The advisory fetch sends no address. The only network calls that include an
address remain the existing opt-in balance/history providers. The local Milk
Sad scan uses no network at all. Stored check history contains only
`advisoryId|entryId -> ISO timestamp`. Logs must not include an address; the
server never receives one from this feature.

## D7. Opt-in Telegram notifications (design; not implemented here)

The mass notification job is deliberately out of scope. It is specified so the
data model and consent rules are not invented later under delivery pressure.

### Consent

- The user must (a) link a Telegram account and (b) explicitly enable
  "security alerts" in the cabinet. Linking Telegram alone is not consent.
- Every address in the alert watchlist must be proven by a wallet signature
  over a server nonce, as in `openspec/changes/key-leak-monitor`. An address
  pasted without proof is never watched.
- Consent is versioned: `consent_version`, `consented_at`, the exact text the
  user saw, and the Telegram chat id. A double opt-in message ("Reply START to
  confirm") is required before the first alert.
- Withdrawal is one tap in the cabinet and a `STOP` reply in Telegram. Both
  take effect before the next job run and are recorded.

### Data model

```
security_alert_subscriptions(
  account_id, telegram_chat_id, consent_version, consented_at,
  status, quiet_hours_start, quiet_hours_end, updated_at
)
security_alert_watchlist(
  account_id, chain, address_hash, address_ciphertext, verified_at, revoked_at
)
security_alert_deliveries(
  advisory_id, account_id, address_hash, sent_at, result, dedupe_key
)
```

`address_hash` is a keyed hash used for dedupe; `address_ciphertext` is
encrypted at rest and used only when a server-runnable checker needs the
address. The existing watchlist service owns the key material.

### Job

A daily job reads published advisories. For each, it sends only to
subscriptions whose watchlist has a chain the advisory affects and whose
consent is active. It checks a watchlist address only when the advisory's
checker declares `server_check: true` (none do today; the local Milk Sad scan
cannot be run per address on the server without a vulnerable-key dataset,
which we refuse to build). When no server check exists, the message tells the
user that an advisory matches their wallet's chain and tool history and asks
them to run the local check; it does not pretend the wallet was tested.

### Message template

```
Security advisory: {title}
Severity: {severity}
Affects: {affected.tools} {affected.versions}
If you created a wallet with that tool, {first_action}.
This is not a detection of your wallet. We cannot move or recover funds.
Details and sources: {site}/security#{id}
Reply STOP to opt out.
```

If a server-runnable checker positively matches a watchlist address, the
message may say: "A published check matched an address on your watchlist.
We cannot move or recover funds. Actions: {first_action}." It must not print
the address, a balance or a claim about other addresses.

### Rate limit and dedupe

- At most one message per `(advisory_id, account_id, address_hash)` ever.
- At most one digest per user per day, and no more than three security messages
  per user per week. A critical advisory with a positive match may bypass the
  digest, not the weekly cap.
- Quiet hours are respected; a queued message is sent after them.
- The delivery log is the dedupe source; a retry reuses `dedupe_key`.

### Never include

- No seed phrase, private key, WIF, keystore or passphrase request.
- No full address in the message; at most the last four characters if a
  reference is unavoidable.
- No balance, portfolio value or transaction list.
- No "we detected a leak" or "your wallet is compromised" unless a
  server-runnable checker positively matched, and even then the wording is
  limited to the matched watchlist address.
- No third-party links that are not the primary sources in the SSOT.
- No attachments, no executable files, no shortened links.

## D8. Failure modes

- Advisory feed unavailable in the wallet: the card states it and links to
  `/security`; it does not hide the failure.
- The checker implementation or route disappears: CI fails before deploy.
- A checker is removed while an advisory still names it: CI fails. The fix is
  to point the advisory at a live checker or set it to `null` and explain why.
- A generated page is stale: CI fails; run `gen-security-page.mjs`.
