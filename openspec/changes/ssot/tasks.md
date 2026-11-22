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

- [x] Add one formatter module `apps/site/amount.js` (`window.RotorAmount`:
      `formatUnits`, `parseUnits`, `coin`, `receivedText`) with BigInt-only
      conversion. The exact rules are documented in the module: trailing zeros
      are trimmed, `maximumFractionDigits` truncates, `minimumFractionDigits`
      pads, grouping and a symbol suffix are opt-in, and `coin` groups
      thousands and rounds half-up at 6 fraction digits above 8 decimals.
- [x] Replace `site.js formatUnits`, `key.js formatUnits6`/`formatEth`,
      `tx-decoders.js formatUnits`, `wallet-btc.js`/`wallet-evm.js`
      `formatUnits`/`parseUnits`, `wallet.js formatUnits`, `send.js
      parseTokenUnits`, `browse.js`, `brainwallet.js`,
      `brainwallet-directory.js`, `mnemonic-seeds.js`, `seed-page.js` and
      `key-tools.js formatAtomic` with the shared module; delete the local
      copies. `tron-tx.js` TRX conversion delegates too, keeping its donor error
      text.
- [x] Add a detector to `scripts/check-ssot.mjs` that fails when a first-party
      `apps/site/*.js` (except `amount.js`) defines or aliases `formatUnits`,
      `formatUnits6`, `parseUnits`, `coin` or `formatEth` (declaration,
      `function` expression or `const/let/var` assignment), keeps a
      `Math.pow(10,` conversion, or hard-codes a `10n ** ...` amount scale.
      Allowlist entries keep the existing reason/owner/expires schema; the
      detector id is `lossy-amount-formatter`. The three new shapes are
      mutation-proven.
- [x] Pin the existing atomic-unit vectors and add exact 0/8/9/18/24-decimal,
      above-2^53 and near-2^256 cases in `apps/site/amount-test.mjs`; add the
      suite to `projects.json` and require `amount.js` before every consumer in
      the Node tests.
- [ ] Move the chain-slug decimals table into `data/chains.json` with the
      symbol/identity work in slice 3. Until then `amount.js` takes `decimals`
      from the caller because token decimals are user-supplied, not a chain
      constant.

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

## Slice 4a - vendored copies and the detector manifest (this PR)

- [x] Add `data/vendor.lock.json` with `{source, target, sha256}` for every
      byte-identical pair between `apps/site/**` and `web/public/**`, plus the
      intentional `nonCopies` (`walletconnect.js`, `ton.js` and its license)
      with a reason. Regenerate the three diverged copies (`site.css`,
      `site.js`, `theme.js`) from `apps/site`; add `chains.generated.js` and
      `amount.js`, which the current `site.js` needs, and load them before it
      in the Astro page.
- [x] `scripts/check-ssot.mjs` verifies every lock digest against both files,
      fails on a drifted copy or a stale digest, and fails when `web/public`
      contains an unlocked file. Detector id `vendor-lock-digest`;
      mutation-proven by changing one byte in a copy.
- [x] Regenerate the stale hashes in `web/README.md` and replace the duplicate
      table with the lock reference; the web-area contract in `projects.json`
      names the lock as the machine source.
- [x] Add `data/detectors.json` (`id`, `rule`, `batch`, `implemented_in`,
      `doc_anchor`, `status`) built from `scripts/ui-audit.mjs`, the other
      gates and `docs/process/defects.json`; planned backlog ids stay `planned`.
- [x] Add `scripts/gen-detector-docs.mjs` (`--check`) and generate the three
      tables in `.claude/skills/ui-self-review/SKILL.md`,
      `DESIGN-SYSTEM.md` §8 and `plan.md` §3 from the registry.
- [x] `check-ssot` fails when a defect-ledger detector has no implemented
      registry entry, when an id emitted by `ui-audit.mjs` is missing from the
      registry, and when a generated table is stale. `check-defect-ledger.mjs`
      consults the same registry.
- [x] Reconcile the four known disagreements: `control-height-scale` is
      {28,36,44,56} everywhere, `table-grammar` is in plan §3,
      `field-hero-height` is in the skill table, and `status-pill-geometry`
      enforces the documented 20px minimum in both spec and gate.
- [x] Wire `gen-detector-docs --check` and the new checks into
      `.github/workflows/ui.yml` and `.github/workflows/rust.yml`, and add the
      commands to `projects.json`; defect-ledger entries cover the vendor and
      registry gates.

## Slice 4b - SEO route table (open)

- [ ] Restore the per-detector "Fix at the right level" hints: add a `fix`
      field to `data/detectors.json`, render it as an extra column in the
      generated skill table, and regenerate the docs with
      `scripts/gen-detector-docs.mjs`.
- [ ] Single-source the SEO route table used by `render_sitemap`,
      `render_robots` and `docs/site-map`.
- [ ] Generate the vendor/SRI hash list consumed by the coordinator, HTML and
      tests from one manifest.
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
