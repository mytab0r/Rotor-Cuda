# Engineering gates: the missing cheap mechanical checks

## Summary

Adopt the baseline checks the repository lacks: a universal revert-based
mutation tier, commitlint, gitleaks, a weekly dead-link report, Lighthouse CI
budgets, release-tag CycloneDX SBOMs, and one honest gate inventory. Each gate
is mechanical and non-duplicative with the existing rust fmt/clippy/tests,
ui-audit, web-seo, process-contract, mutation adapters, CodeQL and Dependabot.

## Problem / motivation

- The JS mutation adapter only covers `apps/site/*.js`; a change outside that
  directory has no "does a test notice?" check.
- release-please reads conventional commits, but nothing rejects a commit whose
  type is not in the changelog configuration.
- A secret can enter the working tree or a PR commit without a dedicated scan.
- Documentation links rot silently; there is no scheduled report.
- The Astro pilot has no performance/accessibility/size budget.
- Releases ship binaries without an SBOM, which is increasingly requested.
- There is no single table saying which check is required, what it costs and
  what it catches.

## Scope

In scope: `scripts/revert-fix.mjs` and its tests; `mutation.yml` wiring;
`.commitlintrc.json` and `commitlint.yml`; `.gitleaks.toml` and `gitleaks.yml`;
`links.yml`; `lighthouserc.json` and `lighthouse.yml`; the `sbom` job in
`rust-release.yml`; `docs/process/gates.md`; the process-only classification
and `projects.json` ownership of the new root configs.

Out of scope: changing product behaviour, fixing the current Lighthouse
budgets, or adding a required check before its observation window ends.

## Acceptance criteria

1. `revert-fix` refuses a dirty tree, aborts on a red baseline, reverts only
   non-test executable hunks, requires a red second run, restores the tree, and
   prints `test proven` / `test did not catch the change`.
2. commitlint rejects `update stuff` and accepts a conventional commit with
   `Task:`/`Closes` trailers.
3. gitleaks scans the tree and the PR commits, catches a planted fake token,
   and the only allowlisted values are reviewed public test vectors.
4. The weekly link report opens/updates one issue and never fails a PR.
5. Lighthouse asserts four categories >= 0.9, script <= 60 KB per route and
   total <= 400 KB; advisory until 2026-12-08.
6. Release tags upload CycloneDX SBOMs for the Rust workspace and `web/`.
7. `docs/process/gates.md` lists every gate with cost and
   required/advisory status.
