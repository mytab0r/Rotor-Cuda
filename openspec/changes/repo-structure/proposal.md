# Repo structure: independent product areas without losing cross-area context

## Summary

The repository currently exposes one Rust package, one coordinator binary, a
committed browser site, a wasm workspace member, and a historical C++ tree, with
no written map of which path belongs to which product area. This proposal keeps
the monorepo and makes the areas explicit and machine-readable: a
`projects.json` area map, `PROJECTS.md`/`OWNERS.md`, per-area `AGENTS.md`,
path-scoped CI, an `affected-areas` script, and a phased directory layout. The
static site is extracted first, behind a build contract that preserves the
single coordinator binary. No git submodules. No code moves in this change.

## Problem / motivation

Verified facts:

- The root `Cargo.toml` is one package `rotor` with two binaries (`src/main.rs`
  desktop CLI, `src/bin/rotor-coord.rs`) and one workspace member
  `crates/rotor-wasm`. Desktop search/BSGS/GPU code and shared crypto live in
  the same crate (`src/lib.rs`).
- The coordinator mixes HTTP server, API, accounts/leaderboard, persistence and
  site serving in `src/coordinator/*` (5,265 lines; `state.rs` alone is 3,464).
- The public site is a compile-time input of the coordinator:
  `include_str!`/`include_bytes!` at `src/coordinator/mod.rs:31-41`; the binary
  cannot build without `web/rotor_wasm.wasm`.
- `web/rotor_wasm.wasm` is a committed artifact rebuilt by
  `scripts/build-wasm.sh` and the Dockerfile (`README.md:245-247`,
  `Dockerfile:14-17`).
- CI path filters are coarse: `rust.yml` and `coordinator-image.yml` both trigger
  on `src/**`, `web/**`, `crates/**`, `scripts/**`;
  `gpu-bsgs-compile.yml` lists individual files.
- No `AGENTS.md`, `PROJECTS.md`, `ARCHITECTURE.md`, `OWNERS.md` or
  `projects.json` exists anywhere in the repo (glob search, 2026-11-16), so an
  agent cannot answer "who owns this path and what else must change" from the
  repository.
- Active openspec changes (`key-leak-monitor`, `product-strategy`,
  `seo-strategy`, `tx-sign-broadcast`) do not declare which areas they touch;
  spec domains are `browser-client`, `coordinator`, `filters`, `key-explorer`,
  `mnemonic`, `search`.
- Legacy/vendor trees are tracked and indistinguishable from product code:
  `BinSort/` (8 files), `Others/` (4), `Release/` (6), `Rotor-Cuda/` (77, CUDA
  sources compiled by `build.rs:15-18`).
- Asset cache busting is already drifting: all pages use
  `?v=20261116c` except `web/key.html:124` (`/key.js?v=20261116`). There is no
  automated bump check (grep over `web/*.html`, CI workflows).

Consequences: an agent editing the site may forget the asset-version bump or
the wasm rebuild; an agent editing the coordinator may break the site contract;
parallel agents collide because ownership is implicit; reviewers cannot scope a
diff to an area.

## Scope

In scope:

- Area map as data (`projects.json`) and prose (`PROJECTS.md`, `OWNERS.md`).
- Per-area `AGENTS.md` with build/test commands and invariants.
- `scripts/affected-areas.mjs` (diff to areas + cross-area checklist) and
  `scripts/check-projects.mjs` (coverage/overlap validator).
- CI guards: full path coverage, asset-version bump, wasm freshness, path-scoped
  workflows.
- Target layout `apps/site`, `apps/coordinator`, `tools/desktop`,
  `crates/{rotor-core,rotor-coordinator,rotor-wasm}` and a site `dist/` contract.
- Trigger conditions for eventually extracting the site into its own repository.

Out of scope:

- Moving files in this change.
- Splitting into separate git repositories now.
- Publishing shared crates to crates.io or another registry.
- Any HTTP API, state-schema, CLI or UI behavior change.
- Deleting legacy trees (separate change).

## Impacted domains

- `coordinator`: build input paths and static-asset serving contract only; no
  protocol change.
- `browser-client`: site/build location and asset-version mechanism only; no
  behavior change.
- New process domain `repo-structure`: ownership map, affected-area reporting,
  CI guards.

No runtime behavior change is intended. Acceptance includes proving that.

## Acceptance criteria

1. From a clean checkout, `node scripts/affected-areas.mjs --diff origin/main...HEAD`
   prints touched areas, owners and required follow-ups in under 60 seconds,
   with no network and no cargo build. Verified on three real diffs: site-only,
   coordinator-only, wasm-only.
2. `node scripts/check-projects.mjs` exits non-zero if any tracked path is
   unowned or claimed by two areas; `projects.json` covers 100% of `git ls-files`.
3. CI fails a `web/` (later `apps/site/`) UI change that does not bump the
   single asset version.
4. Every active openspec change names its areas; a PR template asks for the
   `affected-areas` output.
5. Phase 0 changes no runtime behavior: `cargo test` and the Docker image build
   behave as before; no source or asset file is moved.

## Risks / unknowns

- Wasm build reproducibility is **not verified**. A byte comparison between a
  fresh build and the committed `web/rotor_wasm.wasm` may be impossible, so the
  freshness check must build and run `crates/rotor-wasm/smoke.mjs` plus
  `web/worker-test.mjs` rather than rely on hashes. Marked unverified.
- Moving `web/` breaks `include_str!` paths, Docker `COPY` and both CI path
  filters atomically; it must be one commit in Phase 2.
- Splitting the root crate touches `build.rs` C++ paths, the `gpu` feature
  boundary and 14 test files importing `rotor::...`; a workspace split can
  change feature unification.
- `projects.json` will drift unless the coverage check is enforced from day one.
- A separate site repository adds deploy credentials, cross-repo CI triggers
  and version pinning; it is deferred until a trigger is met.

## References

- `Cargo.toml:1-40`, `src/lib.rs:1-25`
- `src/coordinator/mod.rs:31-41`, `:491-499`
- `Dockerfile:1-27`, `scripts/build-wasm.sh:1-30`
- `.github/workflows/rust.yml`, `coordinator-image.yml`, `gpu-bsgs-compile.yml`
- `README.md:245-252`
- `web/key.html:124`, `web/site.css` version query in all pages
- `openspec/specs/{coordinator,browser-client}/spec.md`
