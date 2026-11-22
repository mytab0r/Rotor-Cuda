# Tasks: single source of truth

Legend: `[ ]` todo, `[x]` done. Slice 1 ships in this PR; slices 2-4 are the
follow-up work. Every slice ends with `node scripts/gen-ssot.mjs --check`,
`node scripts/check-ssot.mjs`, the site suites and `cargo test --release`.

## Slice 1 - providers and RPC (this PR)

- [x] Add `data/chains.json` with the 18 mainnet chains plus the testnet
      identities the send flow needs (`bitcoin-testnet`, `sepolia`,
      `bnb-testnet`, `tron-nile`): slug, name, symbol, family, explorer
      address template and optional transaction template.
- [x] Add `data/providers.json` with per-chain ordered `{id, url, label}`
      entries and named groups (`evm-mainnet`, `evm-testnet`, `btc-family`).
      HTTPS only, no credentials, no private hosts.
- [x] Add `scripts/gen-ssot.mjs`: schema-like validation (unique slugs, required
      fields, https URLs, no private hosts, groups reference known chains),
      deterministic ES5 output at `apps/site/chains.generated.js`
      (`window.RotorChains` / `window.RotorProviders`) and Rust output at
      `src/generated/chains.rs`. `--check` fails with a line diff summary when
      an output is stale.
- [x] Add `src/generated/mod.rs` (`ProviderEntry` alias) and
      `pub mod generated;` in `src/lib.rs`. The generated module compiles but is
      not wired into `ChainHub` yet.
- [x] Embed `apps/site/chains.generated.js` in `src/coordinator/mod.rs`, serve
      it at `/chains.generated.js` and inject the fingerprinted script into
      every served document before the page scripts.
- [x] Migrate the eight audited tables: `site.js`, `key.js`, `browse.js`,
      `mnemonic-seeds.js`, `brainwallet-engine.js`, `seed-page.js`, `wallet.js`,
      `wallet-evm.js`.
- [x] Migrate the other first-party consumers of the same endpoints:
      `search.js`, `public-key.js`, `reconstruction.js`, `keystore-parser.js`,
      `brainwallet.js`, `brainwallet-directory.js`, `puzzle-browser.js`,
      `send.js`, `wallet-btc.js`, `tron-tx.js`.
- [x] Unify the Polygon and Optimism fallback lists through the canonical file;
      `key.js` now carries the publicnode + dRPC list. Replace the false
      `wallet.js` "mirrors apps/site/key.js" comment with the data-file
      reference.
- [x] Load `chains.generated.js` first in every Node test that evaluates a
      migrated consumer.
- [x] Add `scripts/check-ssot.mjs`: validates the data, checks generated
      freshness and fails on canonical provider/explorer host literals in
      first-party `apps/site/*.js`. The generated file and
      `data/ssot-allow.json` (`file`, `match`, `reason`, `owner`, `expires`) are
      exempt; stale or expired entries fail.
- [x] Add `data/ssot-allow.json` for the reviewed textual/cache-name
      exceptions and the two vendored bundles (`ton.js`, `walletconnect.js`).
      An allowlist entry covers plain text only; a canonical host inside an
      `http(s)://` URL literal always fails.
- [x] Validate provider-id and chain-slug references: every static
      `RotorProviders.find('chain', 'id')`, `.first('chain')`, `.byChain` and
      `RotorChains.bySlug` use must resolve in the data. Renaming an id and
      regenerating still fails until every consumer is updated.
- [x] Pin testnet endpoints: testnet chains and their provider entries carry
      `testnet: true`; the generator rejects a shared mainnet host without a
      `nile`/`sepolia`/`prebsc`/`testnet` path marker and rejects testnet
      endpoints or markers on mainnet chains. Both directions are covered by
      mutation tests.
- [x] Prove the new gates by mutation: provider-id rename, testnet-to-mainnet
      URL, mainnet-to-testnet URL and a URL literal inside an allowlisted file
      each fail with file:line; restoring the data returns green.
- [x] Wire the generator and gate into `.github/workflows/rust.yml`
      (`projects-map`) and `.github/workflows/ui.yml`; add `data/**` to the
      `site` area and the commands to `projects.json`.
- [x] Document the domain, generator and gate in `AGENTS.md`.
- [x] Prove the gate by mutation: add a provider URL to a site script, show
      `check-ssot` fails, remove it and show green.

## Slice 2 - amount and atomic-unit formatting

- [ ] Add one formatter module (parsing, formatting, decimals and atomic units)
      and a generated or hand-maintained decimals table keyed by chain slug.
- [ ] Replace `site.js formatUnits`, `key.js formatEth`,
      `wallet-evm.js formatUnits`, `wallet.js` amount text, `send.js`,
      `browse.js`, `mnemonic-seeds.js` and `seed-page.js` formatting with the
      shared module.
- [ ] Add a detector that fails when a first-party script redefines
      `formatUnits`/`formatEth` or hard-codes `10**`/`1e18` amount math.
- [ ] Pin the existing atomic-unit vectors in the shared module's tests.

## Slice 3 - chain identity

- [ ] Move colors, order, symbols and labels into `data/chains.json`; resolve
      the `zkSync` vs `zkSync Era` disagreement in one review.
- [ ] Wire `src/generated/chains.rs` into `ChainHub` and `crate::chain` so the
      coordinator stops keeping a second table (`src/coordinator/mod.rs`) and
      `crate::chain` is the only Rust descriptor table.
- [ ] Migrate the JS chain catalogs (`search.js`, `wallet.js`,
      `brainwallet-engine.js`, `mnemonic-seeds.js`, `seed-page.js`,
      `brainwallet.js`) to the generated identity.
- [ ] Extend `check-ssot` to fail on duplicated chain names, symbols and
      explorer templates outside the generated files.

## Slice 4 - vendor hashes, detector manifest and SEO

- [ ] Generate the vendor/SRI hash list from one manifest consumed by the
      coordinator, HTML and tests.
- [ ] Single-source the defect-detector registry (`docs/process/defects.json`)
      so a detector cannot exist in the audit without a ledger entry.
- [ ] Single-source the SEO route table used by `render_sitemap`,
      `render_robots` and `docs/site-map`.
- [ ] Extend `check-ssot` (or a sibling gate) to fail on hand-written copies of
      those facts.

## Verify

- `node scripts/gen-ssot.mjs --check`
- `node scripts/check-ssot.mjs`
- `node scripts/check-projects.mjs`
- all `apps/site/*-test.mjs` suites from `projects.json`
- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --release`
- `node scripts/ui-audit.mjs --serve`
