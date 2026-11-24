# Proposal: copy the donor mechanics, then rebrand to Crypto

## Why

The public site still invents its own layouts where the donor already has a
proven, dense, structured mechanic. The owner asked for a carbon copy of
ref-site-a mechanics (recoloured), then ideas from ref-site-b, and
a rename of the product from Rotor to Crypto.

## What changes

1. Key page (`/key/<value>`) copies the donor anatomy:
   - one canonical page per key: HEX, DECIMAL, WIF, WIF (U), KEYPAIR (SOL),
     SECRET (XRP), PUBKEY, PAGE live in a "Keys" table;
   - **no per-address WIF links** — the donor has none; WIF is key-level;
   - derivation controls sit above the address list, not after it (owner's
     explicit deviation — the donor has none);
   - the URL is NOT rewritten: every accepted input renders in place, like the
     donor. An earlier replaceState idea was dropped after the audit.
2. Donor audit drives every further page: address list columns, chain grouping,
   stats row (TOTAL VALUE / HAS BALANCE / ACTIVE / CHECKED), search modal,
   directory and seed pages.
3. Secondary reference: ref-site-b — lists/pricing, filters, density.
4. Product rename Rotor → Crypto in UI (wordmark, titles, meta, docs); domain
   and repository name stay owner decisions.
5. Paid lists (owner, 2026-11-20): sell access to address datasets and deliver
   an expiring download link. The buyer is identified by an order (unique
   amount or deposit address/memo) plus an optional contact; payment is verified
   on-chain; no custody, no cards, no accounts. Design: `docs/donor-parity/payments.md`.
   Constraint found in the design pass: the six rich lists we already serve are
   MIT and the donor's comparable dumps are CC0/free, so the paid artifact must
   be distinct (packaged history, normalised/derived data, custom extraction,
   commercial licence, support) — not the raw snapshot.
6. Domain strategy (owner, 2026-11-20): keep the current domain for now; later
   split by global category (`crypto.<tld>`, `ai.<tld>`, …) with resources under
   each. SEO decides the final scheme; nothing is renamed until the owner picks it.

## Out of scope

- Copying proprietary datasets or paid lists into the repository.
- Bypassing any access control on either donor.
- Mainnet signing; custody; server-side private keys. Provider API keys (e.g.
  TronScan) live only in environment variables, never in the repository or logs.

## Evidence

- `docs/donor-parity/key-page.md` — donor route/anatomy audit.
- `docs/donor-parity/sources.md` — source/bundle/dataset findings.
