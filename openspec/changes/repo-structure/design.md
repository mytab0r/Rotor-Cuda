# Design: area boundaries, contracts and coordination

## Decision

**Keep one git repository. Make areas explicit in-repo. Extract the static site
into its own package behind a build contract. Do not use git submodules.**

Recommended shape: monorepo (option 1) + machine-readable coordination map
(option 5) + site extraction (option 4), staged. Separate repositories (option
2) and submodules (option 3) are explicitly rejected for now.

## Option comparison for this repo

| Option | What it buys | Cost here | Agent impact | Verdict |
|---|---|---|---|---|
| 1. Monorepo with `apps/`/`tools/`/`crates/` + ownership map | Atomic cross-area commits; one clone; one CI graph; easy code search | Requires layout migration; root crate split is risky; coarse CI until split | Best: every area visible in one tree; a diff is self-contained | **Adopt** |
| 2. Separate repositories (site, cabinet, desktop) | Independent release cadence and permissions; smaller checkouts | Site is compiled into the coordinator (`include_str!`), so every deploy needs a cross-repo artifact flow; version skew; 3x CI; credentials; no atomic change | Worse: agents must locate a second repo, pin versions, and cannot land a site+coordinator change atomically | Defer; triggers below |
| 3a. Git submodules for wasm core | Nominal code sharing | Detached HEAD, pinned SHA drift, two-step commits, `--recursive` setup, CI sees only a gitlink, worktree friction | Worst: agents forget `submodule update`, commit the wrong SHA, or fail the atomicity test | **No** |
| 3b. Subtree | Read-only mirror with vendored history | Update ritual, merge conflicts on sync, duplicated history, still no atomic cross-repo change | Poor: agents must know a sync command and resolve artificial conflicts | No (only for external read-only snapshots) |
| 3c. Package registry for wasm/core | Semver, explicit contract, works across repos | Release ceremony for a GPL crate with one consumer; version skew; slows every wasm change | Medium: agents must bump versions and wait for a publish | Only if an external consumer appears |
| 4. Monorepo now + site as deployable package | Independent site dev + single-binary deploy | Needs a dist contract and a build step | Good: site area owns its package; coordinator consumes a versioned artifact | **Adopt in Phase 2** |
| 5. `projects.json` + affected-areas script + CI guards | Ownership and cross-area checklist independent of topology | Small maintenance; must be enforced | Directly answers "what does this touch, what else must change, who owns it" | **Adopt first** |

## Target directory layout

```
apps/
  coordinator/            # bin rotor-coord, HTTP/API/accounts glue
    src/main.rs
    Cargo.toml
  site/                   # static site package (was web/)
    pages/{landing,app,me,docs,run,key}.html
    assets/{site.css,site.js,key.js,rotor-worker.js}
    dist/                 # build output: embedded assets + manifest (generated)
    build.mjs             # validates routes, bumps/reads version, emits dist
    AGENTS.md
tools/
  desktop/                # native CLI/GPU tools (was src/main.rs + engine/gpu/bsgs)
    src/main.rs
    Cargo.toml
crates/
  rotor-core/             # crypto + search primitives shared by desktop/coordinator/wasm
  rotor-coordinator/      # server, state, accounts, API (was src/coordinator)
  rotor-wasm/             # browser wasm core (unchanged location)
vendor/
  rotor-cuda/             # C++ CUDA sources consumed by build.rs (was Rotor-Cuda/)
deploy/                   # unchanged; owned by infra area
openspec/                 # unchanged; change IDs declare areas
projects.json             # machine-readable area map
PROJECTS.md / OWNERS.md   # human-readable map
```

Moves happen in Phases 2-3. Phase 0 only adds docs, scripts and CI.

Why this split: `rotor-core` is the only true shared dependency (secp/scalar/
field/hashes/base58/filter/bsgs primitives). `rotor-coordinator` depends on it
plus `tiny_http`; `rotor-wasm` depends on the crypto subset only; `tools/desktop`
depends on core and optionally compiles `vendor/rotor-cuda` CUDA sources. The
dependency direction is one-way: `apps/*` -> `crates/*` -> `vendor/` at build
time.

## Area map (`projects.json`)

Schema (one source of truth; `OWNERS.md` and `AGENTS.md` are generated or
checked from it):

```json
{
  "asset_version": "20261116c",
  "areas": [
    {
      "id": "site",
      "owner": "site-ui",
      "paths": ["web/**", "apps/site/**"],
      "build": ["node apps/site/build.mjs --check"],
      "test": ["node web/worker-test.mjs web/rotor_wasm.wasm"],
      "docs": ["apps/site/AGENTS.md"],
      "consumes": ["wasm-core"],
      "contracts": ["asset-version", "served-routes", "no-secrets"]
    },
    {
      "id": "coordinator",
      "owner": "coordinator-server",
      "paths": ["src/coordinator/**", "src/bin/rotor-coord.rs",
                "tests/coordinator_api.rs", "tests/coordinator_client.rs"],
      "build": ["cargo build --release --bin rotor-coord"],
      "test": ["cargo test --test coordinator_api --test coordinator_client"],
      "docs": ["src/coordinator/AGENTS.md"],
      "consumes": ["site", "rust-core"],
      "contracts": ["api-v1", "state-schema", "embedded-assets"]
    },
    {
      "id": "desktop",
      "owner": "desktop-cli",
      "paths": ["src/main.rs", "src/cli.rs", "src/engine.rs", "src/gpu*.rs",
                "src/bsgs*.rs", "src/filter.rs", "src/checkpoint.rs",
                "src/mnemonic.rs", "src/selfupdate.rs", "src/selfcheck.rs",
                "src/benchmark.rs", "src/targets_text.rs", "build.rs",
                "Rotor-Cuda/**", "tests/**"],
      "build": ["cargo build --release", "cargo build --release --features gpu"],
      "test": ["cargo test --release", "cargo test --release --features gpu"],
      "docs": ["tools/desktop/AGENTS.md"],
      "consumes": ["rust-core"],
      "contracts": ["no-silent-cpu-fallback", "verified-results"]
    },
    {
      "id": "wasm-core",
      "owner": "wasm-core",
      "paths": ["crates/rotor-wasm/**", "web/rotor_wasm.wasm"],
      "build": ["scripts/build-wasm.sh"],
      "test": ["node crates/rotor-wasm/smoke.mjs <artifact>",
               "node web/worker-test.mjs <artifact>"],
      "docs": ["crates/rotor-wasm/AGENTS.md"],
      "consumes": ["rust-core"],
      "contracts": ["wasm-exports", "artifact-freshness"]
    },
    {
      "id": "rust-core",
      "owner": "rust-core",
      "paths": ["src/lib.rs", "src/base58.rs", "src/scalar.rs", "src/field.rs",
                "src/point.rs", "src/secp.rs", "src/hashes.rs",
                "tests/crypto.rs", "tests/engine.rs"],
      "build": ["cargo build --workspace"],
      "test": ["cargo test --release"],
      "docs": ["crates/rotor-core/AGENTS.md"],
      "contracts": ["no-behavior-change-without-test"]
    },
    {
      "id": "infra",
      "owner": "release-infra",
      "paths": [".github/workflows/**", "scripts/**", "deploy/**",
                "Dockerfile", "Cargo.toml", "Cargo.lock", "README.md",
                "openspec/**"],
      "build": [],
      "test": ["node scripts/check-projects.mjs"],
      "docs": ["deploy/AGENTS.md"],
      "contracts": ["path-filters-cover-areas", "secrets-by-name-only"]
    },
    {
      "id": "legacy",
      "owner": "none",
      "paths": ["BinSort/**", "Others/**", "Release/**"],
      "build": [],
      "test": [],
      "docs": [],
      "contracts": ["no-new-code"]
    }
  ]
}
```

Path ownership is exact and exclusive. During Phase 0 the map uses todays
locations (`web/**`, `src/coordinator/**`, and so on); Phases 2 and 3 swap path
globs in the same commit as the move. `legacy` owns the three historical trees
so the coverage check is total; `Rotor-Cuda/**` stays with `desktop` until it
moves to `vendor/`.

The sketch above deliberately overlaps (`src/bsgs*.rs`, `src/filter.rs` and
`tests/**` appear under more than one area). The exclusivity check would reject
it. Phase 0 must assign every `src/*.rs` file to exactly one area and express
"desktop consumes core" through `consumes`, not through overlapping `paths`.
The checker reports every overlap; the committed map must be overlap-free.

## Cross-area contracts

1. **Site to coordinator (build-time).** The coordinator embeds a site artifact.
   Contract: `apps/site/dist/site-manifest.json` lists `asset_version`, every
   file with its SHA-256, and the source git SHA. The coordinator build reads
   `dist/` and embeds it. A missing manifest or file is a loud build failure,
   matching the current missing-wasm rule (`src/coordinator/mod.rs:31-41`).
2. **Site to coordinator (runtime).** Served routes are a fixed set:
   `/`, `/app`, `/run`, `/me`, `/docs`, `/key`, `/site.css`, `/site.js`,
   `/key.js`, `/rotor-worker.js`, `/rotor_wasm.wasm`
   (`src/coordinator/mod.rs:491-499`). `web/key.js:6` and
   `web/rotor-worker.js:11` load `/rotor_wasm.wasm`. Adding or removing a route
   is a coordinator change too; the affected-areas script flags it.
3. **Wasm core to site.** `rotor_wasm.wasm` is a committed artifact pinned by
   `asset_version` and the manifest hash. Changing `crates/rotor-wasm/**`
   requires rebuilding it and re-running `crates/rotor-wasm/smoke.mjs` plus
   `web/worker-test.mjs`. Byte-level reproducibility is unverified; freshness is
   checked functionally.
4. **Desktop to infra.** `build.rs` compiles `Rotor-Cuda/GPU/GpuAddressAbi.cu`
   and `Rotor-Cuda/bsgs/BsgsGpuAbi.cu` (`build.rs:15-18`); moving them requires
   a matching `build.rs` and `gpu-bsgs-compile.yml` update in the same commit.
5. **Coordinator to clients.** `/api/v1/*` is a contract covered by
   `tests/coordinator_api.rs` and the `coordinator` spec. Browser and native
   clients must be listed in the change areas when endpoints change.

## Coordination mechanism (topology-independent)

- `projects.json` is the source of truth: paths to area to owner role to
  build/test to contracts.
- `scripts/affected-areas.mjs --diff <range>`:
  1. reads `git diff --name-only --diff-filter=ACMRD <range>`;
  2. matches each path against the globs (exactly one area; an unknown path is
     an error);
  3. prints touched areas, owners, and the derived cross-area checklist:
     site touched means asset version bump; `crates/rotor-wasm/**` means rebuild
     wasm and run both JS tests; site plus coordinator in one diff means both
     areas and a coordinator build; `Rotor-Cuda/**` or `build.rs` means the GPU
     compile job; `Cargo.toml`/`Cargo.lock` means workspace-wide jobs.
  4. `--json` mode for CI and agents; the default is short human text.
  Runtime target: under 1 second on a warm tree, under 60 seconds including a
  fresh clone. No cargo build, no network.
- `scripts/check-projects.mjs`: every `git ls-files` path matches exactly one
  area; warnings for `legacy` additions; validates that deleted paths are no
  longer claimed; fails on overlap.
- Every openspec change adds one line near the top:
  `Areas: site, coordinator, wasm-core`. The PR template requires the
  affected-areas output in the body.
- Per-area `AGENTS.md`: local invariants, build/test commands, what else to
  check, and the reading order (`PROJECTS.md` -> area AGENTS.md -> spec).

## CI design

Split the current coarse workflows by area while keeping one aggregate gate:

- `site.yml`: triggers on `web/**` (later `apps/site/**`); validates HTML/CSS/JS,
  runs `node web/worker-test.mjs`, enforces the asset-version bump.
- `coordinator.yml`: triggers on coordinator paths, the site dist manifest and
  Docker files; builds the image and runs `tests/coordinator_api.rs`.
- `desktop-gpu.yml`: keeps `gpu-bsgs-compile.yml` behavior, with its path list
  derived from `projects.json`.
- `wasm.yml`: `crates/rotor-wasm/**`; builds, smoke test, worker protocol test.
- `repo-guard.yml`: always runs on PRs; `check-projects.mjs`, asset-version
  check, affected-areas report as a sticky comment.
- Keep one required "all areas" status so a path-filter miss cannot merge.

GitHub Actions cannot read JSON at trigger time, so generate the path filters
from `projects.json` with a script and verify the generated YAML in
`repo-guard.yml`.

## Submodules: verdict and criteria

**Not recommended.** Concrete failure modes for AI agents in this repo:

- `git submodule update --init` is an extra setup step that agents skip; a stale
  checkout silently builds an old wasm core.
- The parent records only a gitlink SHA; `git diff` shows a hash bump, not the
  code, so an agent cannot review or reason about the change.
- Atomicity is lost: a wasm API change plus a site change needs two commits and
  two PRs with a coordinated merge; today they build together.
- Detached HEAD inside the submodule is the default state; agents commit there
  and lose the commit on the next checkout.
- CI path filters see the gitlink, not the files; a submodule bump needs an
  explicit rebuild trigger.
- Worktrees under `.claude/worktrees/` multiply the submodule setup cost.

**When a submodule or subtree is acceptable:** only for read-only third-party
snapshots you never patch, for example if `Rotor-Cuda/` upstream had to stay
byte-identical and be updated by pulling. Even then, subtree or a vendored copy
is preferable for agents. Never for `web/`, `src/coordinator`,
`crates/rotor-wasm` or `tools/desktop`.

## Separate-repository triggers (option 2, deferred)

Extract a component to its own repository only if at least one is true:

- The site or cabinet gets a separate deploy target and a release cadence that
  must not wait for coordinator releases.
- Contributors who must not see the desktop/GPU code need commit access to only
  that component.
- The component CI runtime or dependency set dominates the monorepo pipeline.

If triggered, use **release artifacts, not submodules**: the component publishes
`<name>-<sha>.tar.gz` plus `manifest.json` (files, SHA-256, asset version); the
consumer pins version and hash in a lockfile and verifies before embedding.
Deployment stays one image because the coordinator still embeds assets at
compile time. The coordinator repository keeps `projects.json` and the
cross-area checklist.

## Phased plan

Phase 0 (smallest first step, this change; docs and tooling only):
`projects.json`, `PROJECTS.md`/`OWNERS.md`, per-area `AGENTS.md`,
`scripts/affected-areas.mjs`, `scripts/check-projects.mjs`, PR template, and a
report-only `repo-guard.yml`. No moves and no new required checks.

Phase 1: make `repo-guard` required; single-source the asset version; add the
wasm freshness job; split `rust.yml` into area workflows with one aggregate
required status.

Phase 2: move `web/` to `apps/site/`, add `build.mjs` and the `dist/` manifest;
update `include_str!`/`include_bytes!`, `Dockerfile`, `scripts/build-wasm.sh`
and CI filters in one commit. Deployment remains a single binary.

Phase 3: split the Rust workspace into `crates/rotor-core`,
`crates/rotor-coordinator`, `apps/coordinator`, `tools/desktop`, `vendor/`;
update `build.rs`, tests and release workflows. Keep `crates/rotor-wasm`.

Phase 4 (conditional): site-only repository via release artifacts, only if a
trigger is met.

## Migration risks and mitigations

| Risk | Mitigation |
|---|---|
| `include_str!` path breakage mid-move | One commit per move; `cargo check` in the same PR; container build in CI |
| Stale committed wasm | Functional freshness job (build plus both JS tests); do not claim byte reproducibility |
| `build.rs` CUDA paths and `gpu` feature | Move the vendor tree and `build.rs` together; keep `gpu-bsgs-compile.yml` required |
| Feature unification changes after the workspace split | Review `cargo tree -e features` for the `gpu` and wasm builds |
| Test import paths (`use rotor::...` in 14 files) | Alias crate names or update imports in the split commit; tests are the gate |
| CI misses new directories | Generated path filters plus the `repo-guard` coverage check |
| History and blame loss | Use `git mv` in a single-purpose commit; never combine with behavior changes |
| Map drift | Required `check-projects.mjs` from Phase 1 |
| Agent confusion between `web/` and `apps/site/` | Transitional globs in `projects.json`; docs updated in the same commit |

## Acceptance trace

- Area answer under a minute: `affected-areas.mjs` prints areas, owners and the
  cross-area checklist from a diff; `PROJECTS.md` gives the same by hand.
- "What else must change": the contracts section plus the derived checklist
  (asset version, wasm rebuild, Docker and CI paths, coordinator build, docs).
- "Who owns it": the `owner` field per area, mirrored in `OWNERS.md`.
