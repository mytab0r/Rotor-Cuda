# Releases and delivery automation

Status: added by ROT-454. Source of truth for how a release is cut, what it
contains, and what the owner must do.

## Release-please

`release-please` automates the version, `CHANGELOG.md` and the GitHub release
from conventional commits on `main`.

| File | Role |
|---|---|
| `.github/workflows/release-please.yml` | Opens or updates the release PR on every push to `main`; tags and releases when the release PR is merged. Adds a manual `workflow_dispatch` dry run. |
| `release-please-config.json` | Single root package (`.`) with `release-type: rust`; changelog sections; `bootstrap-sha`. |
| `.release-please-manifest.json` | Current released version: `{".": "2.0.0"}`. |
| `CHANGELOG.md` | Maintained by release-please from the next release onward. Never edit it by hand. |

The release type is `rust`, so the release PR updates the version in
`Cargo.toml`, the matching entry in `Cargo.lock`, and `CHANGELOG.md`. The Rust
strategy treats the workspace as one release, so it also sets the version in
`crates/rotor-wasm/Cargo.toml` to the same number. The wasm crate is not a
separate release: its build is `scripts/build-wasm.sh`, and its committed
output is `apps/site/rotor_wasm.wasm`.

### Conventional commits → changelog sections

| Commit type | Changelog section | Version bump |
|---|---|---|
| `feat` | Features | minor |
| `fix` | Bug Fixes | patch |
| `perf` | Performance Improvements | patch |
| `refactor` | Code Refactoring | none |
| `docs` | Documentation | none |
| `test` | Tests | none |
| `chore` | Miscellaneous Chores | none |
| `deps` | Dependencies | patch |
| `build`, `ci` | hidden | none |
| `revert` | Reverts | patch |

A `!` after the type or a `BREAKING CHANGE:` footer bumps the major version. A
commit that only contains `chore`/`docs`/`test` does not open a release on its
own; it is included in the next release that has a bump.

`bootstrap-sha` is `fd778f80b9a256c349a73951a1c9ab4728b7f35a` (the `main` head
when this automation landed). release-please ignores commits at or before it,
so the first release contains only commits merged after that point. Once the
first release PR is merged the setting is ignored and can be removed.

There are no tags in the repository yet. The manifest baseline is `2.0.0` from
`Cargo.toml`, so the first release will be `v2.0.1` (fix-only) or `v2.1.0`
(feature), not `v2.0.0`.

## How a release is cut

1. A conventional commit merges to `main`.
2. `release-please.yml` opens or updates a single release PR
   (`chore(main): release rotor X.Y.Z`). The PR body is the proposed changelog.
3. Review the PR: the version follows the table above, and the notes name the
   commits. Merge it when the branch is green.
4. On the push created by that merge, release-please creates the `vX.Y.Z` tag
   and the GitHub release.
5. In the same job, `gh workflow run rust-release.yml --ref vX.Y.Z` starts the
   existing asset pipeline. This explicit dispatch is required: a tag pushed by
   the default `GITHUB_TOKEN` does **not** trigger a `push: tags` workflow.
   `workflow_dispatch` is one of the two events that token may trigger.
6. `rust-release.yml` builds and uploads:
   - `rotor.exe` + `rotor.exe.sha256` (CPU, Windows),
   - `rotor-coord-linux-x86_64` + `.sha256` (Linux coordinator),
   - `rotor-gpu.exe` + `rotor-gpu.exe.sha256` (static CUDA runtime).

If step 5 fails, run **Actions → rust-release → Run workflow** with the tag as
the ref. The tag and release are still correct; only the assets are missing.

### What a release contains

- `CHANGELOG.md` with the new section, newest first.
- The `version` in `Cargo.toml` and the root package entry in `Cargo.lock`.
- A GitHub release `vX.Y.Z` whose body is the same changelog section.
- The six asset files listed above, once `rust-release` finishes.

It does **not** contain a published container image or a Cloudflare deploy;
those workflows are separate and keyed by push to `main`, not by the tag.

## Single-package limitation: `web/` and `deploy/cloudflare/`

This repository is one release-please package at the root. That means:

- A commit touching `web/` or `deploy/cloudflare/` is part of the **same**
  root changelog and the **same** `vX.Y.Z` version. There is no separate version
  or tag for the Astro app or the Workers.
- The changelog groups entries by commit type, not by area. The area is only
  visible in the conventional-commit scope, for example
  `fix(web): ...` or `chore(cloudflare): ...`.
- release-please's `path` for a package restricts commits to that path. A
  second package for `web` would therefore ignore repository-wide commits (CI,
  docs, shared data) unless they are duplicated into its path. That is why the
  single root package is the deliberate choice here.

If separate release trains are needed later, add a package per path in
`release-please-config.json` (for example `web` and `deploy/cloudflare`), give
each its own manifest entry and changelog, and set
`include-component-in-tag: true` so the tags do not collide. Do not split them
without deciding what happens to repository-wide commits.

## Dependency updates

Dependabot is used instead of Renovate. Renovate requires the Mend Renovate app
to be installed on the repository (or a self-hosted runner with its own
credentials). That is an owner action and would add another credential;
Dependabot is built in and needs none.

`.github/dependabot.yml`:

| Ecosystem and directory | Groups |
|---|---|
| `cargo` at `/` (the workspace, including `crates/rotor-wasm` crates) | `cargo-major`, `cargo-minor`, `cargo-patch` |
| `npm` at `/web` | `web-major`, `web-minor`, `web-patch` |
| `npm` at `/deploy/cloudflare` | `cloudflare-major`, `cloudflare-minor`, `cloudflare-patch` |
| `github-actions` at `/` | `actions-major`, `actions-minor`, `actions-patch` |

All run weekly (Monday, UTC), with no automerge. The wasm toolchain — rustup,
the `wasm32-unknown-unknown` target and wasm-pack — is not declared in any
manifest and is not touched by Dependabot. Crates used by `crates/rotor-wasm`
are ordinary Cargo updates and stay in the root groups; the wasm build/test
gate decides whether they are safe.

`deploy/cloudflare` declares no npm dependencies, so its group is normally
quiet; it exists so that a future dependency is picked up without a config
change.

## Weekly security audit

`.github/workflows/audit.yml` runs every Monday at 04:41 UTC (and on manual
`workflow_dispatch`). It has no `pull_request` trigger, so **it never fails a
PR**.

- `cargo audit --json` from the RustSec project.
- `npm audit --omit=dev --audit-level=high --json` in `web/` and
  `deploy/cloudflare/` (the latter has no lockfile, so the report records that
  fact instead of failing).
- `scripts/security-audit.mjs` renders both into one body and creates or
  updates **one** issue titled `Security audit: weekly dependency report`.

The RustSec `audit-check` action was evaluated and not used: it files one issue
per advisory, which is the opposite of a single tracking issue. `cargo audit`
is the same RustSec scanner in JSON mode, so the report job can own one issue.

Triage the open issues and advisories in that tracking issue. Keep the issue
open: the next run rewrites its body, and closing it only causes a duplicate.
An advisory that is accepted is recorded as a reviewed `ignore` with a reason
and an expiry in the workflow, not by closing the issue.

## Repository security settings (checked through the API, 2026-11-24)

| Setting | State |
|---|---|
| Secret scanning | **enabled** |
| Secret scanning push protection | **enabled** |
| Secret scanning non-provider patterns | disabled |
| Secret scanning validity checks | disabled |
| Dependabot alerts / security updates | **enabled** |
| Default workflow permissions | read (each workflow declares what it needs) |
| Allow GitHub Actions to create and approve pull requests | false (owner action) |

The two disabled secret-scanning extras are optional; enabling
non-provider patterns and validity checks is an owner decision in
**Settings → Code security**.

## What the owner must do

1. **Enable Actions pull-request creation.** In **Settings → Actions →
   General → Workflow permissions**, tick **Allow GitHub Actions to create and
   approve pull requests**. The API currently reports
   `can_approve_pull_request_reviews: false`; without this, release-please
   cannot open the release PR with `GITHUB_TOKEN`.
2. **Merge the first release PR** after reviewing the proposed version and
   changelog, then confirm the tag, the GitHub release and the six assets.
3. **Decide on the two secret-scanning extras** above (non-provider patterns,
   validity checks). Both are currently off.
4. **Review dependency PRs.** No automerge is configured; grouped
   major/minor/patch PRs arrive weekly. Dependabot security updates are already
   enabled and bypass the weekly schedule for known advisories.
5. **Do not add a personal access token for releases.** The workflow uses the
   automatic `GITHUB_TOKEN`; a token would only be needed to make the tag push
   trigger other workflows, which the explicit `workflow_dispatch` avoids.

## Verifying the automation

- Release preview without side effects:
  **Actions → release-please → Run workflow**, `dry-run: true`. The log prints
  the proposed release PR body including the changelog; no PR, commit, tag or
  label is created.
- Local preview: see `scripts/security-audit.mjs --help` for the audit report;
  the release preview is the `release-pr --dry-run` command in the workflow.
- The first real run after this PR merges is the one that proves the full
  chain (release PR → merge → tag → assets).
