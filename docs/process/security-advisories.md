# Security advisories

`data/security-advisories.json` is the single source of truth for the public
`/security` page and for the cabinet wallet's "Security status" panel. The
generated page `apps/site/security.html` is committed so the coordinator can
embed it with `include_str` and crawlers see the content without JavaScript.

## Two sections, one honesty rule

`advisories` are software vulnerabilities: they carry a CVE, an affected tool
or version, and usually a local checker. `threats` are scam techniques with no
affected version and no patch (for example address poisoning). The split is
deliberate: an upgrade is never presented as the fix for a threat class.

No entry may promise protection. The gate rejects the strings listed in
`BANNED_CLAIMS` (for example "we protect you", "guaranteed"). A local check
covers only the input it ran on, and the page must say so.

## Entry shape

Every advisory and threat carries:

- `id`, `kind`, `title`, `severity` (closed set), `summary`, `user_impact`,
  `actions` (non-empty), `sources` (https, at least one `primary: true`),
  `review`.
- `review.status` is `draft`, `reviewed` or `superseded`. A reviewed entry
  records `reviewed_by` and `reviewed_at`; a draft must carry neither. The
  page and the wallet only show reviewed entries.
- An advisory adds `cve`, `disclosed`, `affected.tools`, `affected.versions`,
  `affected.chains` and an optional `checker` id.
- A threat adds `threat_class` and `first_documented` and must not carry a
  `cve` or a `checker`.

AI may draft an entry. A human or agent reviewer checks the summary, the
affected tools and versions, and the actions against the primary sources
before switching the status to `reviewed`.

## Checker registry

`checkers` names each local check once:

- `id`, `kind` (`local-seed-range` today), `title`, `description`, `chains`,
  `route`, `implementation`, `network`, `limits`, `honesty`.
- `route` must be a path served by the coordinator's `static_asset` map. The
  gate fails when an advisory points at a checker whose route or
  implementation no longer exists.
- `network` is `false`: a checker reads only data the user supplies in the
  browser. The seeded Milk Sad checker reproduces `bx seed` wallets from a
  32-bit seed range in this tab and never sends an address anywhere.

## Gate

```sh
node scripts/check-advisories.mjs
node scripts/gen-security-page.mjs --check
node --test scripts/check-advisories.test.mjs
```

`check-advisories.mjs` validates the schema, the closed sets, the https primary
sources, the review provenance, the checker routes and files, the generated
page freshness, the page SEO shape (canonical, one main, one h1, no page-local
footer because the coordinator injects the shared one, parseable JSON-LD, no
`noindex`) and that `/security` and
`/security-advisories.json` are served. It is registered as the
`security-advisory-integrity` detector and runs in CI next to
`check-defect-ledger.mjs`.

To add an entry: edit the JSON, run `node scripts/gen-security-page.mjs`, then
the gate and its tests. Never publish a vulnerable-key directory: the page
explains why, and the checker only reports a match for the address the user
entered.

## Wallet behaviour

The cabinet wallet fetches ` /security-advisories.json` (public data), selects
reviewed advisories whose affected chain is present in the local vault, and
shows a "Security status" card. A local check runs only for the user's own
vault entries, derives addresses in the tab and stores only a timestamp keyed
by advisory id and the random vault entry id. No address is written to
storage or sent to the site.

## Notifications

The design for opt-in Telegram notifications (watchlist consent, message
template, rate limit, what must not be included) is in
`openspec/changes/security-advisories/design.md`. The mass notification job is
not implemented in this change.
