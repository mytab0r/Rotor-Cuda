# Security advisories pipeline

## Summary

Publish known wallet/key vulnerabilities and threat classes as reviewed data,
render a public `/security` page from that data, and surface the subset that
affects a user's own vault entries inside the cabinet wallet. The wallet runs
local checks only, never sends an address anywhere new, and records when a
check last ran. Opt-in Telegram notifications for people who linked an account
and proved control of a watchlist address are designed here but not implemented
in this change.

## Problem

A holder who created a wallet with a weak key generator usually learns about
it years later, if at all. The information exists in CVE records, research
posts and vendor advisories, but it is scattered, written for researchers, and
rarely says what a non-technical owner should do. Rotor already has a Milk Sad
checker and a local encrypted vault; what is missing is one reviewed source of
truth, a public page, and a wallet panel that connects a published advisory to
the entries the user actually holds.

## Goals

- One machine-readable SSOT, `data/security-advisories.json`, for advisories,
  threat classes and the registry of local checkers.
- A validator that rejects an advisory with no primary https source, no
  actions, a non-closed severity/status, unreviewed facts presented as reviewed,
  or a checker whose route or implementation does not exist.
- A generated, indexable `/security` page with plain-language impact, actions,
  local checker links and primary sources.
- A "Security status" card in the cabinet wallet that lists only reviewed
  advisories affecting the user's own vault chains, runs a local check when one
  exists, and states honestly when no local check can decide the question.
- A written notification design with consent, template, rate limit and a list
  of what must never be included.

## Non-goals

- No mass notification job in this change. The data model, checker registry and
  wallet card ship; the server-side Telegram job is scheduled follow-up work.
- No vulnerable-key directory, searchable or otherwise. The page explains why:
  it is a target list, not a safety tool.
- No scanning of addresses the user did not add to their own vault. The wallet
  selects entries from the local vault only.
- No claim that the site protects a wallet, prevents a theft, or proves a key
  is safe. A bounded scan covers only the range it ran on.

## Honesty boundary

Observable and publishable: a published CVE or research finding, the affected
tool and version, the action an owner can take, and whether a local check can
reproduce a weak key from user-supplied input.

Not observable and not claimable: that a specific key was copied, that a wallet
is compromised while idle, or that a no-match result makes a key safe. Every
entry is reviewed by a human or agent reviewer who records `reviewed_by` and
`reviewed_at`; AI may draft, but a draft never appears on the page or in the
wallet.

## Affected areas

- `site`: `data/security-advisories.json`, `apps/site/security.html`,
  `apps/site/milk-sad-scan.js`, `apps/site/wallet-security.js`,
  `apps/site/wallet.html`, `apps/site/wallet.js`.
- `coordinator`: embedded `/security` and `/security-advisories.json` routes,
  sitemap entry, route tests.
- `ops/docs`: `scripts/check-advisories.mjs`,
  `scripts/gen-security-page.mjs`, tests, CI wiring, this change.
