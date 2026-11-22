# Rotor board sync

The **Rotor** GitHub Project (`mytab0r`, number 3,
<https://github.com/users/mytab0r/projects/3>) mirrors the repository work so
the owner can see status without opening `openspec/` or the pull-request list.
The task-tracking convention itself is `docs/process/task-tracking.md`.

## What is mirrored

- **One epic issue per OpenSpec change** that has at least one checkbox in
  `openspec/changes/<id>/tasks.md`. The issue title is
  `[<id>] <first heading>`; labels are `epic` plus one `area:*`.
- **One sub-issue per task section** that still has an unchecked box (or already
  has a sub-issue). The title is `ROT-<n> — <task>`, labels are
  `change:<id>` and `area:<area>`. Idempotency uses the body marker
  `<!-- openspec-task: <change>/<slug> -->`.
- **Blockers** from the section's `(blocked by: ...)` line become
  `Blocked by: ROT-7 (#7), ROT-8 (#8)`. Section numbers and ranges (`1-5`,
  `T1-T8`) resolve to the keys of the other sub-issues; a name that cannot be
  resolved is written as `Blocked by (unresolved): <text>` and reported.
- **Native sub-issue links** are created with the GraphQL `addSubIssue`
  mutation. The sync queries the current parent first, so a repeat run is a
  no-op; a GraphQL failure aborts with the issue numbers in the message.
- **Epic progress** is `closed sub-issues / total sub-issues`. The body lists
  the sub-issues, the unresolved blockers and
  `Source of truth: openspec/changes/<id>/tasks.md`.
- **Idempotency** for epics uses the body marker
  `<!-- openspec-change: <id> -->`. A second run updates the existing issue
  instead of creating another one.
- **Open pull requests** are added as project items, with `Area` inferred from
  the head branch (falling back to the changed files). A PR whose body contains
  `Task: ROT-<n>` gets `Closes #<n>` appended when the body lacks a closing
  reference and the branch follows `<type>/<change-id>-<slug>` (or the diff
  touches the change folder). An ambiguous PR is reported, not edited.
- **Merged and closed PR items are archived** (`archiveProjectV2Item` over
  GraphQL), so the board keeps only open PR cards and the epics carry the
  history. Issue items are never archived. A PR-state read failure is reported
  and leaves that item in place for the next run.
- **Changes without `tasks.md`, or with no checkbox tasks, are printed as a
  warning** instead of being skipped silently.
- **Project fields**:
  - `Area` (single select): `site`, `coordinator`, `desktop`, `infra`,
    `design`, `docs`. Sub-issues carry the same field.
  - `Progress` (number): the epic's sub-issue percentage.
  - `Status`: `Todo` at 0%, `Done` at 100%, `In Progress` in between.
    The project's built-in **Auto-close issue** workflow closes a `Done`
    issue; if tasks regress below 100%, the next sync reopens the epic.
    The sync itself never closes an issue.

Area mapping for changes (first match on the id and title words):

| Area | Keywords |
|---|---|
| `desktop` | desktop |
| `coordinator` | monitor, orders, coordinator, proxy |
| `infra` | infra, deploy, ci |
| `design` | design |
| `docs` | docs |
| `site` | wallet, seed, site, seo, donor, parity |

Anything unmatched defaults to `site` and carries an
`<!-- area-default: site -->` marker in the issue body so the fallback is
visible.

## Run

Prerequisites: a local `gh` login with `repo` and `project` scopes, and GitHub
Issues enabled on the repository (Projects alone cannot host the issues this
script maintains):

```sh
gh auth status
gh repo edit mytab0r/Rotor-Cuda --enable-issues   # once, only if disabled
```

Then, from the repository root:

```sh
node scripts/sync-board.mjs --dry-run   # print the plan, change nothing
node scripts/sync-board.mjs             # create/update issues and project items
```

The script exits non-zero and prints the `gh` error text when a call fails. It
uses Node 20 built-ins only and no npm dependency.

## CI

`.github/workflows/task-links.yml` runs `scripts/check-task-links.mjs` on every
`pull_request` event with the default `GITHUB_TOKEN` (read-only `issues` and
`pull-requests`) and no secret. See `docs/process/task-tracking.md` for the PR
rules.

`.github/workflows/board-sync.yml` runs `scripts/sync-board.mjs` daily at 03:17
UTC and on `workflow_dispatch`, so the board cannot lag behind merged PRs. A
user-owned Project v2 cannot be edited by the default `GITHUB_TOKEN`, so the
workflow reads the repository secret `BOARD_SYNC_TOKEN`: a personal token with
`repo` and `project` scopes (classic) or issues/pull-requests write plus
user-project access (fine-grained). The secret value is never stored in the
repository; the job fails with an explicit error when it is missing. The same
sync still runs locally with the owner's `gh` login for `--dry-run` plans.
