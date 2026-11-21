# Projects and contracts

`projects.json` is the machine-readable source of truth. Every tracked path is
owned by exactly one area; the most-specific glob wins.

| Area | Owner | Owns | Build | Test |
|---|---|---|---|---|
| `site` | site-ui | `apps/site/**` | `node --check apps/site/*.js` | `node apps/site/worker-test.mjs apps/site/rotor_wasm.wasm` |
| `web` | site-ui | `web/**` (Astro pilot) | `npm --prefix web ci && npm --prefix web run build` | `npm --prefix web test` |
| `coordinator` | coordinator | `src/coordinator/**`, `src/bin/rotor-coord.rs`, `tests/coordinator_*` | `cargo build --release --bin rotor-coord` | `cargo test --test coordinator_api --test coordinator_client` |
| `wasm-core` | wasm-core | `crates/rotor-wasm/**` | `sh scripts/build-wasm.sh` | `cargo test -p rotor-wasm`; `smoke.mjs`; `worker-test.mjs` |
| `desktop` | desktop-tools | remaining `src/**` and `tests/**`, `Rotor-Cuda/**`, legacy trees, `build.rs`, `Cargo.toml` | `cargo build --release [--features gpu]` | `cargo test --release [--features gpu]` |
| `ops` | ops/docs | `.github/**`, `.claude/skills/**`, `deploy/**`, `scripts/**`, `openspec/**`, `docs/**`, `Dockerfile`, root docs | `node scripts/check-projects.mjs` | `node docs/site-map/site-map-test.mjs`; `node scripts/check-projects.mjs` |

## Cross-area contracts

- **Site -> coordinator (compile time).** `src/coordinator/mod.rs:31-41`
  embeds `apps/site/*.html`, `site.css`, `site.js`, `theme.js`, `key.js`,
  `rotor-worker.js` with `include_str!`/`include_bytes!`. The coordinator
  cannot build if a site file is missing or renamed.
- **Wasm -> site -> coordinator.** `apps/site/rotor_wasm.wasm` is a committed
  artifact rebuilt by `scripts/build-wasm.sh` from `crates/rotor-wasm`, then
  embedded by the coordinator. The `Dockerfile` rebuilds it during the image
  build. After any `crates/rotor-wasm` change, rebuild, run
  `crates/rotor-wasm/smoke.mjs` and `apps/site/worker-test.mjs`, and commit the
  artifact.
- **Asset revalidation.** Never stamp `?v=` tokens on served files. HTML is
  served with `no-store` and references every first-party asset as
  `/a/<build>/<path>`; those URLs are immutable (the build changes on every
  deploy), while bare asset paths (old links, curl) stay `no-cache` with a
  content `ETag`. `node scripts/check-projects.mjs` rejects a returning token.
- **Routes.** `/`, `/app`, `/run`, `/me`, `/docs`, `/key` and the static asset
  routes are a fixed set in `src/coordinator/mod.rs`; changing one is a
  coordinator + site change. Key utility pages `/hex-dec-bin`, `/public-key`,
  `/pubkey-add`, `/reconstruction` and `/keystore-parser` (plus `key-tools.js`
  and their per-page scripts) follow the same rule. The transaction decoders
  are served on `/tx`, `/tx/bitcoin` and `/tx/ethereum`, sharing
  `tx-decoders.js` (pure Bitcoin/EIP-2718 codecs) and `tx-page.js` (DOM
  wiring); they decode raw hex locally, make no network request, and a Bitcoin
  fee is only reported when prevout values are supplied. The cabinet wallet lives on
  `/cabinet/wallet` and shares `wallet-vault.js` (the pure encrypted-vault
  codec), `wallet-evm.js` (the pure Sepolia send flow: validation, chain-id
  guard, review and confirm over an injected RPC), `wallet-btc.js` (the pure
  Bitcoin testnet send flow: bech32 validation, coin selection, dust/change,
  review and confirm over injected UTXO/broadcast callbacks) and `wallet.js`
  (page logic);
  the coordinator never receives a key, WIF or passphrase. The seed studio is served
  on `/seed` and `/mnemonic-converter`, sharing `seed.js`, `seed-crypto.js`,
  `seed-page.js` and `seed-studio.css`; the directory remains on
  `/mnemonic-seeds`. Brainwallet pages share `brainwallet-engine.js`
  (138-word corpus, BigInt page math, phrase hash, chain row selection,
  explorer links), `brainwallet-directory.js` (18,890-passphrase directory,
  60 rows per page, 315 pages, optional balances) and `brainwallet.js` (the
  single-passphrase generator on `/brainwallet-generator`). `/brainwallet` is
  the index of 18 chain directories; `/brainwallet/<chain>` and
  `/brainwallet/<chain>/<page>` are the directory pages. SEO routes include
  `/bitcoin-puzzle`, `/bitcoin-puzzle/<n>` (canonical detail; the legacy
  `/bitcoin-puzzle/<n>/detail` permanently redirects to it),
  `/bitcoin-puzzle/<n>/random` and `/bitcoin-puzzle/unsolved` for n in 1..=160.
  The route/feature parity map is internal documentation, not a public route:
  it lives in `docs/site-map/index.html` with `site-map.css`, `site-map.js` and
  the single data file `site-map-data.js`. Update the data when a route or
  feature status changes; the coordinator neither embeds nor serves it.
- **Desktop -> infra.** `build.rs` compiles the CUDA sources under
  `Rotor-Cuda/`; moving them requires `build.rs`, `Cargo.toml` and
  `gpu-bsgs-compile.yml` in the same change.
- **Docs/specs.** Behavior or contract changes update `openspec/` and declare
  `Areas:` in the change.

## Scripts

```sh
node scripts/check-projects.mjs                  # schema, ownership, coverage
node scripts/affected-areas.mjs                  # diff origin/main + working tree
node scripts/affected-areas.mjs path/to/file ... # explicit paths
node scripts/ui-audit.mjs --serve                # headless UI self-review (site)
node scripts/sync-board.mjs [--dry-run]          # mirror changes + PRs to the Rotor board
```

`scripts/ui-audit.mjs` is the shared UI gate: headless Chrome/Edge over CDP
(zero dependencies), every route at 375/768/1280 in dark and light, with
screenshots and a JSON report. It checks overflow, text below 12px, touch
targets below 44px, icon-only controls without labels, duplicated address-type
components, uneven card widths, half-empty cards, manual balance controls and
the route-specific row counts. Exit 1 means a UI change is not done. The
failure table and workflow live in `.claude/skills/ui-self-review/SKILL.md`.

`scripts/sync-board.mjs` mirrors every OpenSpec change and open pull request
into the Rotor Project (owner `mytab0r`, number 3) with `Area`, `Progress` and
`Status` fields. It runs locally with the owner's `gh` login (`repo` and
`project` scopes) and requires Issues to be enabled; see
`docs/process/board.md`.

Reading order: `AGENTS.md` -> this file -> the area `AGENTS.md` -> the
`openspec/` change or spec.
