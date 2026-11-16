# Tasks: repo structure and agent coordination

Legend: `[ ]` todo, `[x]` done. No task below moves runtime code unless it is in
Phase 2 or 3. Every phase ends with a cross-area sync checkpoint.

## Lanes (transition-aware)

Work is split by area so parallel agents do not collide. A lane owns only the
paths listed in its `projects.json` entry.

- Lane A `site-ui`: `web/**` (later `apps/site/**`).
- Lane B `coordinator-server`: `src/coordinator/**`,
  `src/bin/rotor-coord.rs`, `tests/coordinator_*`.
- Lane C `desktop-cli`: `src/main.rs`, CLI/search/GPU/BSGS modules,
  `build.rs`, `Rotor-Cuda/**`.
- Lane D `wasm-core`: `crates/rotor-wasm/**`, `web/rotor_wasm.wasm`.
- Lane E `release-infra`: `.github/**`, `scripts/**`, `deploy/**`,
  `Dockerfile`, `Cargo.*`, `openspec/**`.
- Lane F `rust-core`: shared crypto and search primitives.

Cross-area changes (for example wasm core plus site) are one PR with both lanes
listed; the affected-areas script produces the checklist.

## Phase 0 - coordination layer (this change, no moves)

- [ ] Add `projects.json` with exclusive, overlap-free paths covering every
      `git ls-files` entry. Owner: Lane E.
- [ ] Add `PROJECTS.md` (area table, contracts, reading order) and `OWNERS.md`
      (area to agent role to human maintainer). Owner: Lane E.
- [ ] Add per-area `AGENTS.md` under `web/`, `src/coordinator/`,
      `crates/rotor-wasm/`, `deploy/`, and at the root. Owner: each lane.
      Each file states build/test commands, invariants and "what else to check".
- [ ] Add `scripts/affected-areas.mjs` with `--diff <range>` and `--json`.
      Owner: Lane E.
- [ ] Add `scripts/check-projects.mjs` (coverage, exclusivity, legacy warning).
      Owner: Lane E.
- [ ] Add `.github/PULL_REQUEST_TEMPLATE.md` asking for the affected-areas
      output and the list of touched areas. Owner: Lane E.
- [ ] Add `.github/workflows/repo-guard.yml` in report-only mode (does not block
      merges yet). Owner: Lane E.
- [ ] Document in each active openspec change one `Areas:` line
      (`key-leak-monitor`, `product-strategy`, `seo-strategy`,
      `tx-sign-broadcast`). Owner: Lane E.
- [ ] Register the new spec domain `openspec/specs/repo-structure/spec.md` when
      this change is archived. Owner: Lane E.
- [ ] Phase 0 sync checkpoint: `node scripts/check-projects.mjs` passes,
      `affected-areas.mjs` answers three sample diffs in under 60 seconds, and
      no source or asset file moved.

## Phase 1 - enforce the guardrails

- [ ] Make `repo-guard.yml` a required check with one aggregate status.
- [ ] Make the asset version single-source: a version field in
      `projects.json` or `web/asset-version.txt`, imported by every page.
      Fix the existing drift (`web/key.html:124` uses `20261116` while other
      pages use `20261116c`). Owner: Lane A.
- [ ] Add `scripts/bump-asset-version.mjs` and a CI rule: any UI change under
      `web/**` requires a version bump in the same diff. Owner: Lane E.
- [ ] Add a wasm freshness job: build `crates/rotor-wasm`, run `smoke.mjs` and
      `worker-test.mjs` against the fresh artifact and against the committed
      `web/rotor_wasm.wasm`. Owner: Lane D.
- [ ] Split `rust.yml` into `site.yml`, `coordinator.yml`, `wasm.yml`,
      `desktop-gpu.yml`, with path filters generated from `projects.json`.
      Owner: Lane E.
- [ ] Keep `coordinator-image.yml` triggering on site, coordinator and infra
      paths; verify a site-only PR still produces an image. Owner: Lane E.
- [ ] Phase 1 sync checkpoint: a site-only PR, a wasm-only PR and a
      coordinator-only PR each run only the relevant jobs plus `repo-guard`.

## Phase 2 - extract the site package

- [ ] `git mv web apps/site` and restructure into `pages/` and `assets/`
      without content changes. Owner: Lane A, reviewed by Lane B.
- [ ] Add `apps/site/build.mjs`: validate pages, read the asset version, emit
      `apps/site/dist/` and `site-manifest.json` (files, SHA-256, version, git
      SHA). Owner: Lane A.
- [ ] Update `src/coordinator/mod.rs:31-41` include paths to the dist output.
      Owner: Lane B.
- [ ] Update `Dockerfile` `COPY` and the wasm copy target, and
      `scripts/build-wasm.sh` output path. Owner: Lane E.
- [ ] Update `web/worker-test.mjs` path usage and both JS test invocations.
      Owner: Lane A.
- [ ] Update all CI path filters and `projects.json` globs in the same commit.
      Owner: Lane E.
- [ ] Verify the single-binary guarantee: coordinator image runs, all routes
      and assets serve, `tests/coordinator_api.rs` passes. Owner: Lane B.
- [ ] Phase 2 sync checkpoint: site-only PR touches only `apps/site/**`; the
      coordinator build consumes the manifest; no behavior change.

## Phase 3 - split the Rust workspace

- [ ] Create `crates/rotor-core` from the shared primitives; keep public API
      names or add re-exports, then update `use rotor::...` in tests.
      Owner: Lane F.
- [ ] Create `crates/rotor-coordinator` from `src/coordinator/**` and the
      `rotor-coord` binary entry point in `apps/coordinator`. Owner: Lane B.
- [ ] Move the desktop binary and its modules to `tools/desktop`. Owner: Lane C.
- [ ] `git mv Rotor-Cuda vendor/rotor-cuda` and update `build.rs:15-18` and
      `gpu-bsgs-compile.yml`. Owner: Lane C plus Lane E.
- [ ] Make `crates/rotor-wasm` depend on `rotor-core` where the code is shared,
      without changing the wasm exports. Owner: Lane D.
- [ ] Re-run release workflows: `rust-release.yml`, `windows-release.yml`,
      `gpu-bsgs-compile.yml`, `coordinator-image.yml`. Owner: Lane E.
- [ ] Review `cargo tree -e features` for `gpu` and `wasm` builds. Owner: Lane F.
- [ ] Phase 3 sync checkpoint: workspace builds and tests on Linux and Windows;
      no behavior change; release artifacts produced.

## Phase 4 - conditional extraction (do not start without a trigger)

- [ ] Confirm one trigger from design.md (independent deploy cadence, access
      boundary, or CI cost).
- [ ] Publish the site as a versioned release artifact; pin version and SHA-256
      in the coordinator; verify at build time.
- [ ] Keep `projects.json` and the affected-areas checklist in the coordinator
      repository or a meta-repo.
- [ ] Do not use submodules for this extraction.

## Cross-area checklist (used by every phase)

- [ ] Asset version bumped when any site file changes.
- [ ] Wasm rebuilt and both JS tests run when `crates/rotor-wasm` changes.
- [ ] Coordinator built when site dist, embedded assets or API paths change.
- [ ] Docker and CI path filters updated when paths move.
- [ ] `projects.json`, `PROJECTS.md` and `OWNERS.md` updated when ownership
      changes.
- [ ] OpenSpec change declares `Areas:` and, if a contract changed, carries a
      delta spec for the affected domain.
