# Gates

One table of every mechanical gate. Cost is the observed or expected added
wall-clock time on one PR; "required" means a red result blocks the merge
(advisory runs are visible but do not). The PR evidence contract is
[verification.md](verification.md); this file is the gate inventory.

| Gate | Where / command | What it catches | Cost | Status |
|---|---|---|---|---|
| rustfmt | `cargo fmt --all --check` (`.github/workflows/rust.yml` → `build`) | formatting drift | ~10 s | required |
| clippy | `cargo clippy --workspace --all-targets -- -D warnings` (`rust.yml`) | lint, correctness classes | ~1–2 min | required |
| Rust tests | `cargo test --release` on Ubuntu and Windows (`rust.yml`) | unit and integration regressions | ~3–6 min | required |
| wasm build + test | `cargo build -p rotor-wasm --target wasm32-unknown-unknown --release`; smoke and worker protocol (`rust.yml` → `wasm`) | wasm artifact, protocol drift | ~1–2 min | required |
| area map + SSOT | `node scripts/check-projects.mjs`, `gen-ssot --check`, `check-ssot`, `gen-detector-docs --check`, `check-defect-ledger`, `check-advisories`, `check-screenshots` (`rust.yml` → `projects`) | unowned paths, cache tokens, stale generated data/vendor copies, detector tables, committed screenshots, advisory schema | ~30 s | required |
| web SEO | `npm --prefix web run check`, `npm --prefix web test`, `npm --prefix web run build`, `node scripts/check-seo.mjs` (`rust.yml` → `web-seo`) | Astro type errors, route tests, build, SEO route table | ~1–2 min | required |
| UI audit | `node scripts/ui-audit.mjs --serve` (`ui.yml`) | overflow, tiny text/targets, unlabeled icon controls, component/table/card/field geometry at 375/768/1280 | ~3–5 min | required |
| process contract | `node scripts/check-process.mjs --pr <n>` (`process-contract.yml`) | missing Spec/Tests/Mutation proof/Review/Verification sections, weak evidence shape | ~20 s | required |
| task links | `node scripts/check-task-links.mjs --pr <n>` (`task-links.yml`) | missing `Task: ROT-<n>`, unknown issue, missing closing reference | ~15 s | required |
| commitlint | `npx --package @commitlint/cli@21.2.4 … commitlint --from origin/main --to HEAD` (`commitlint.yml`) | commit type outside the conventional set, empty subject; keeps release-please changelog correct | ~20 s | required |
| gitleaks | `gitleaks dir .` and `gitleaks git --log-opts=origin/<base>..HEAD` (`gitleaks.yml`) | secrets in the working tree and in the PR commits, including a secret added then removed | ~20 s | required |
| revert-fix (universal mutation) | `node scripts/revert-fix.mjs --base origin/<base> --projects-area <area> [--source-glob …]` (`mutation.yml` → `revert-fix`) | a changed executable hunk whose area tests stay green after it is reverted; refuses a dirty tree or a red baseline. CUDA/C/C++ are out of the source globs (covered by `gpu-bsgs-compile`) | ~2–8 min (affected areas only) | required |
| js mutation adapter | `node scripts/mutate-changed.mjs --base origin/<base>` (`mutation.yml` → `js-mutation`) | a surviving flipped comparison/return in changed `apps/site/*.js` | ~1–3 min | required |
| rust mutation adapter | `cargo mutants --in-diff …` (`mutation.yml` → `rust-mutation`) | surviving mutants in changed Rust lines | up to 25 min, timeboxed | advisory until 2026-12-08 |
| Lighthouse budgets | `npx @lhci/cli@0.16.1 autorun --config=lighthouserc.json` (`lighthouse.yml`) | performance/accessibility/best-practices/SEO below 0.9, JS > 60 KB per route, total > 400 KB on `/` and a chain page. `errors-in-console` is skipped because the static-local run has no analytics backend | ~2–3 min | advisory until 2026-12-08 |
| CodeQL | `.github/workflows/codeql.yml` | static-analysis findings | ~2–5 min | required |
| CodeQL alert monitor | `.github/workflows/codeql-alerts.yml` (daily) | any open code-scanning alert left untriaged | daily, no PR cost | required |
| dependency audit | `.github/workflows/audit.yml` (weekly) | RustSec/npm advisories; one tracking issue | weekly, no PR cost | advisory |
| dead links | `.github/workflows/links.yml` (weekly, lychee 0.24.2) | dead links under `docs/**` and `web/src/**`; one tracking issue | weekly, no PR cost | advisory |
| Dependabot | `.github/dependabot.yml` (weekly) | out-of-date Cargo, npm and action dependencies | weekly, no PR cost | advisory (no automerge) |
| SBOM | `cargo cyclonedx` + `cyclonedx-npm` in `rust-release.yml` → `sbom` | missing/incorrect CycloneDX SBOM release assets | release tags only | required for a release |
| release assets | `.github/workflows/rust-release.yml` | missing binaries, checksums, self-update manifest | release tags only | required for a release |
| coordinator image | `.github/workflows/coordinator-image.yml` | Docker build/runtime drift | on its paths | required on its triggers |
| CUDA compile | `.github/workflows/gpu-bsgs-compile.yml` | CUDA toolchain/build regressions | on its paths | required on its triggers |

## Local commit hook (no husky)

The commit check is the same one `commitlint.yml` runs. Install it once per clone:

```sh
cat > .git/hooks/commit-msg <<'HOOK'
#!/bin/sh
npx --yes --package @commitlint/cli@21.2.4 \
  --package @commitlint/config-conventional@21.2.4 \
  commitlint --config .commitlintrc.json --edit "$1"
HOOK
chmod +x .git/hooks/commit-msg
```

## Running the mutation tier locally

```sh
node scripts/revert-fix.mjs --base origin/main --cmd "npm --prefix web test"
node scripts/revert-fix.mjs --base origin/main --projects-area site
node --test scripts/revert-fix.test.mjs
```

`--base` diffs `base...HEAD`, so the change must be committed. The script
refuses a dirty tracked tree, runs the command once before reverting (a red
baseline aborts), reverts only files outside the test globs, requires a red
second run, and restores the tree in `finally`. Exit 0 = `test proven`, 1 =
`test did not catch the change`, 2 = usage/baseline/apply error, 3 = the tree
could not be restored. `--source-glob` keeps documentation, workflow and
data-only changes out of the mutation (there is no executable behaviour for a
test to catch).
