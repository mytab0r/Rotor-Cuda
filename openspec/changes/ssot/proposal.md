# Single source of truth for shared facts

## Summary

The repository already single-sources design tokens (`design/tokens/tokens.json`
plus `scripts/build-tokens.mjs --check`) and component manifests. This change
applies the same pattern to the facts that are still copied across the site
scripts and the two Rust chain tables: public RPC/API endpoints, chain identity,
amount formatting, vendor hashes, detector manifests and SEO route data.

Slice 1 is implemented in this PR: providers/RPC and the minimal chain identity
they need. Formatting, symbols/colors/ordering, vendor hashes, detector
manifests and SEO stay in slices 2-4.

## Problem / motivation

Ranked by drift risk (highest first), with the audit evidence:

1. **P0 - eight independent provider/RPC tables in the site JS.**
   `apps/site/site.js:378`, `apps/site/key.js:10,30-36`,
   `apps/site/browse.js:27`, `apps/site/mnemonic-seeds.js:25`,
   `apps/site/brainwallet-engine.js:60`, `apps/site/seed-page.js:62`,
   `apps/site/wallet.js:49-56`, `apps/site/wallet-evm.js:31-180`.
   The verified Polygon/Optimism RPC fix (`d39a9f9`) touched only two of them,
   and the `wallet.js` comment claiming the URLs mirror `key.js` became false.
   The same endpoints are also repeated in `send.js`, `wallet-btc.js`,
   `tron-tx.js` and the vendor bundles.

2. **P1 - amount formatting is reimplemented per feature.**
   `site.js formatUnits`, `key.js formatEth`, `wallet-evm.js formatUnits`,
   `wallet.js` amount text, `send.js`, `browse.js` and `mnemonic-seeds.js` each
   parse/format atomic units and decimals with their own rounding rules. A unit
   or decimals change has to be found in every copy.

3. **P1 - chain identity is duplicated in Rust and JS.**
   `src/chain.rs:94-275` and `src/coordinator/mod.rs:1376-1575` both define the
   same 18 chains (slug, name, symbol, family/kind, explorer, ordering). The
   coordinator does not consume `crate::chain`. The site repeats the same
   identity in `search.js`, `wallet.js`, `brainwallet-engine.js`,
   `mnemonic-seeds.js` and `seed-page.js`, including labels and symbols that
   already disagree (`zkSync` vs `zkSync Era`).

4. **P2 - vendor hashes, detector manifests and SEO route data.**
   The SRI/vendor hash list, the defect-detector registry and the SEO route
   table are maintained by hand in more than one place. A hash or route edit can
   leave the browser, the coordinator and the docs disagreeing.

The rule this change enforces: a fact used in two places has exactly one
machine source; consumers reference it or consume a generated artifact; drift
fails CI.

## Scope

In scope (this PR, slice 1):

- `data/providers.json` - per-chain ordered `{id, url, label}` public
  RPC/API endpoints and named groups.
- `data/chains.json` - minimal chain identity used by the provider tables:
  slug, name, symbol, family and explorer URL template.
- `scripts/gen-ssot.mjs` - validates both files and writes
  `apps/site/chains.generated.js` (ES5 globals, no build step) and
  `src/generated/chains.rs`.
- `scripts/check-ssot.mjs` - data validation, generated freshness and a
  provider/explorer host-literal gate with a shrink-only
  `data/ssot-allow.json`.
- Migration of the eight audited tables plus the direct consumers of the same
  endpoints (`search.js`, `public-key.js`, `reconstruction.js`,
  `keystore-parser.js`, `brainwallet*.js`, `puzzle-browser.js`, `send.js`,
  `wallet-btc.js`, `tron-tx.js`).
- Coordinator embedding/fingerprinting and the shared script tag in every
  served document.
- CI wiring, `projects.json` area coverage and `AGENTS.md` documentation.

Out of scope (later slices):

- Slice 2: one amount/atomic-unit formatter and its tests.
- Slice 3: colors, ordering, symbols and full chain identity in
  `data/chains.json`; wiring `src/generated/chains.rs` into `ChainHub` and
  `crate::chain`; labels such as `zkSync` vs `zkSync Era`.
- Slice 4: vendor hashes, one detector manifest and the SEO route table.

## Impacted domains

- `browser-client` / `site`: provider lookup uses the generated globals; no UI,
  derivation or network behavior change except the intended Polygon/Optimism
  fallback unification.
- `coordinator`: embeds and serves one new fingerprinted asset and injects it
  into served HTML. No API or state change.
- `desktop-tools`: a generated Rust module compiles; it is not wired into
  `ChainHub` yet.
- `ops/docs`: generator, gate, CI and `AGENTS.md`.

## Acceptance (slice 1)

- `node scripts/gen-ssot.mjs --check` and `node scripts/check-ssot.mjs` pass.
- `grep -nE 'publicnode|drpc|tronscan|mempool\.space|etherscan|blockchain\.info' apps/site/*.js`
  has hits only in `chains.generated.js`, the two vendored bundles and the
  reviewed `data/ssot-allow.json` textual exceptions.
- All `apps/site/*-test.mjs` suites pass, `cargo test --release` passes,
  `cargo clippy --workspace --all-targets -- -D warnings` passes and
  `node scripts/ui-audit.mjs --serve` passes.
