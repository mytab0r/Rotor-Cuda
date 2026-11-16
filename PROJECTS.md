# Projects and contracts

`projects.json` is the machine-readable source of truth. Every tracked path is
owned by exactly one area; the most-specific glob wins.

| Area | Owner | Owns | Build | Test |
|---|---|---|---|---|
| `site` | site-ui | `apps/site/**` | `node --check apps/site/*.js` | `node apps/site/worker-test.mjs apps/site/rotor_wasm.wasm` |
| `coordinator` | coordinator | `src/coordinator/**`, `src/bin/rotor-coord.rs`, `tests/coordinator_*` | `cargo build --release --bin rotor-coord` | `cargo test --test coordinator_api --test coordinator_client` |
| `wasm-core` | wasm-core | `crates/rotor-wasm/**` | `sh scripts/build-wasm.sh` | `cargo test -p rotor-wasm`; `smoke.mjs`; `worker-test.mjs` |
| `desktop` | desktop-tools | remaining `src/**` and `tests/**`, `Rotor-Cuda/**`, legacy trees, `build.rs`, `Cargo.toml` | `cargo build --release [--features gpu]` | `cargo test --release [--features gpu]` |
| `ops` | ops/docs | `.github/**`, `deploy/**`, `scripts/**`, `openspec/**`, `Dockerfile`, root docs | `node scripts/check-projects.mjs` | `node scripts/check-projects.mjs` |

## Cross-area contracts

- **Site -> coordinator (compile time).** `src/coordinator/mod.rs:31-41`
  embeds `apps/site/*.html`, `site.css`, `site.js`, `key.js`, `rotor-worker.js` with
  `include_str!`/`include_bytes!`. The coordinator cannot build if a site file
  is missing or renamed.
- **Wasm -> site -> coordinator.** `apps/site/rotor_wasm.wasm` is a committed
  artifact rebuilt by `scripts/build-wasm.sh` from `crates/rotor-wasm`, then
  embedded by the coordinator. The `Dockerfile` rebuilds it during the image
  build. After any `crates/rotor-wasm` change, rebuild, run
  `crates/rotor-wasm/smoke.mjs` and `apps/site/worker-test.mjs`, and commit the
  artifact.
- **Asset cache busting.** Bump `?v=` in every `apps/site/*.html` when `site.css`,
  `site.js` or `key.js` changes. `projects.json.asset_version` tracks the
  current value; Phase 1 will make it single-source.
- **Routes.** `/`, `/app`, `/run`, `/me`, `/docs`, `/key` and the static asset
  routes are a fixed set in `src/coordinator/mod.rs`; changing one is a
  coordinator + site change.
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
```

Reading order: `AGENTS.md` -> this file -> the area `AGENTS.md` -> the
`openspec/` change or spec.
