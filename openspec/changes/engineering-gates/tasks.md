# Tasks — engineering gates

## 1. Universal mutation tier (blocked by: —)

- [x] `scripts/revert-fix.mjs`: `--base`, `--cmd`, `--projects-area`,
      `--test-glob`, `--include`, `--source-glob`, `--timeout`, `--dry-run`;
      dirty-tree guard, baseline check, reverse patch, `finally` restore.
- [x] Tests: glob selection, test-path exclusion, a real git repo where a
      covered change is proven and an untested change is not, dirty-tree
      refusal.
- [x] `mutation.yml` job per affected area, with SHA-pinned checkout/setup-node
      and the base-branch script.

## 2. Commit messages (blocked by: —)

- [x] `.commitlintrc.json` extends `@commitlint/config-conventional`; trailers
      allowed.
- [x] `.github/workflows/commitlint.yml` lints `origin/<base>..HEAD`.
- [x] Husky-free `commit-msg` hook documented in `gates.md`.

## 3. Secrets (blocked by: —)

- [x] `.github/workflows/gitleaks.yml` scans the working tree and the PR
      commits with the pinned 8.30.1 binary.
- [x] `.gitleaks.toml` allowlists only reviewed public test vectors and a
      README placeholder.

## 4. Links, budgets, SBOM (blocked by: —)

- [x] `.github/workflows/links.yml`: weekly lychee report, one tracking issue,
      never fails a PR.
- [x] `lighthouserc.json` and `.github/workflows/lighthouse.yml`: four
      categories >= 0.9, JS <= 60 KB/route, total <= 400 KB; advisory until
      2026-12-08.
- [x] `rust-release.yml` → `sbom`: CycloneDX for the Rust workspace and `web/`,
      uploaded on tags.

## 5. Documentation and ownership (blocked by: 1, 2, 3, 4)

- [x] `docs/process/gates.md`: one table with gate, command, catches, cost,
      required/advisory.
- [x] `docs/process/verification.md` §4 describes the revert tier.
- [x] `projects.json` owns `.commitlintrc.json`, `lighthouserc.json` and
      `.gitleaks.toml`; the process-only classification accepts them.
