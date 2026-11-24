# Tasks

Applies `docs/design-system/DESIGN-SYSTEM.md` §3.19 (Progressive disclosure)
to `apps/site/wallet.html` per the inventory in `proposal.md`. Every task ends
with an acceptance line; the page is vault-gated, so acceptance is the
independent visual check (375/768/1280 screenshots in the PR) plus a rendered
DOM check, not `ui-audit`.

## 1. Top of page

- [ ] Rewrite the top `p.notice` to the single safety sentence
      ("Losing the passphrase loses the keys: there is no recovery and the
      server cannot help.", 86 chars) plus an encrypted-backup pointer; move
      the chains/tokens/allowance/fee-cap body into a `<details>` directly
      below it.
      Acceptance: at 375px the "Create a vault"/"Unlock the vault" heading is
      visible without scrolling past more than one line of prose; the
      `<details>` opens with the full current text and the arm/fee-cap facts
      are unchanged inside it.

## 2. Vault cards

- [ ] Shorten `#wallet-onboard-help` to a ≤140-char one-liner; move the
      derivation/server claims into a `<details>` below the chip pair.
      Acceptance: chips reachable within one prose line at 375px; `<summary>`
      has a 44px target and focus ring.
- [ ] Shorten `#wallet-pass-help` to ≤140 characters (drop the PBKDF2
      iteration count into a `title`-free `aria-describedby` short form or
      `details`).
      Acceptance: inline text ≤140 chars, key derivation facts preserved.
- [ ] Leave the unlock card note inline (already ≤140 and safety-relevant);
      verify it stays under budget.
      Acceptance: no change unless a rewrite is needed; measured ≤140.

## 3. Vault panel (assets, import, seed, addresses, summary, history)

- [ ] `#wallet-assets-help`: one-liner ("The ten largest supported assets with
      a balance path…") + `<details>` for price source, caching and the
      not-loaded rules.
      Acceptance: table header visible within one prose line at 375px.
- [ ] `#wallet-import-help`: one-liner ("WIFs map by version byte; hex keys
      need an explicit chain…") + `<details>` for the per-chain mapping.
      Acceptance: the "Add to vault" button reachable within one prose line.
- [ ] Move `#wallet-seed-estimate` into a `.popover` anchored to the existing
      `#wallet-seed-info` icon-button (`aria-label` present, add
      `aria-expanded` handling, no native `title`); delete the always-visible
      paragraph.
      Acceptance: no `#wallet-seed-estimate` paragraph in the default DOM;
      popover opens from keyboard and closes on Esc/outside click.
- [ ] `#wallet-seed-help`: one-liner ("Generated and shown in this tab only;
      the vault stores one derived key per chain…") + `<details>` for the
      BIP44/no-preset chains.
      Acceptance: "Add derived key to vault" reachable within one prose line.
- [ ] `#wallet-lookup-note`: one-liner beside the checkbox ("Lookups are off by
      default and send only the public address…") + `<details>` for the
      per-provider detail.
      Acceptance: checkbox and first entry row reachable within one prose
      line at 375px.
- [ ] `#wallet-summary-help` and `#wallet-history-help`: one-liners +
      `<details>` (price/stale rules; provider coverage and the Bitcoin
      observer-view warning).
      Acceptance: stat strip visible within one prose line; the observer-view
      warning stays reachable in the `details` copy verbatim.

## 4. Sign-in and security cards

- [ ] `#wallet-signin-help`: one-liner ("Sign in proves control of the EVM
      address; the key never leaves this tab…") + `<details>` for the
      non-EVM caveats.
      Acceptance: "Sign in with this wallet" button reachable within one
      prose line.
- [ ] `#wallet-security-help`: one-liner + `<details>` (scan scope,
      uncompressed-WIF and seed-range caveats).
      Acceptance: stat strip visible within one prose line at 375px.

## 5. Send, approvals and BTC cards

- [ ] Send intro: one-liner ("Built here, reviewed field by field, signed in
      WASM and broadcast from your browser; the server never sees a key") +
      `<details>`.
      Acceptance: the "From" select is the first prose-free control after the
      heading at 375px.
- [ ] Network/arm paragraph: keep the arm checkbox label verbatim inline
      (safety); replace the 873-char paragraph with a ≤140-char one-liner
      ("Sepolia is the default; mainnet needs the arm checkbox, which resets
      on lock/unlock and reload") and move the chain-id/token/fee-cap body
      into a `<details>` above the "To" field's form section.
      Acceptance: the arm checkbox label text contains "cannot be reversed"
      unchanged; token and cap facts intact in the `details`.
- [ ] Gas/fee paragraph ("Empty gas limit uses…"): move wholesale into the
      same `<details>`.
      Acceptance: no guidance paragraph between the fee fields and "Fetch
      fees and review".
- [ ] Approvals intro: one-liner carrying the danger sentence ("Granting lets
      another address move your tokens — smallest allowance, revoke when
      done") + `<details>` for logs/window/indexer mechanics.
      Acceptance: the token field reachable within one prose line; danger
      sentence inline.
- [ ] Approvals validation and grant-constraint paragraphs: move into
      `<details>` blocks; grant intro one-liner stays inline (safety).
      Acceptance: "Find approvals" and "Review the grant" reachable within
      one prose line each.
- [ ] BTC intro and parsing paragraphs: one-liner ("Testnet only; UTXOs and
      fees come from mempool.space testnet, signed in your browser") +
      `<details>`.
      Acceptance: "Fetch UTXOs and review" reachable within one prose line.

## 6. Backup card

- [ ] Keep "Importing replaces this browser's vault…" inline verbatim
      (safety).
      Acceptance: unchanged text, still before the file input.
- [ ] Move "What is stored" and "What this page signs" into one
      `<details>` ("What is stored and what is sent") at the bottom of the
      backup card.
      Acceptance: card renders as heading, inline note, two forms, one
      `details`; IndexedDB/AES-GCM facts unchanged inside.

## 7. Verification

- [ ] `node --check` on touched scripts; `node scripts/check-projects.mjs`;
      `node scripts/ui-audit.mjs --serve` (expect no new failures on audited
      pages — the wallet page itself is out of its reach).
- [ ] Independent visual review (different agent): 375/768/1280 screenshots
      of every card, before/after scroll position of the first control,
      keyboard pass over every new `<summary>` and the seed popover.
      Acceptance: reviewer confirms §3.19 at 375px — first interactive
      control of each card reachable without scrolling past more than one
      prose line; no native `title` added; `<summary>` focus ring visible.
- [ ] Update `docs/design-system/inventory.md` if the wallet family gains a
      shared `details`/`popover` component entry.
