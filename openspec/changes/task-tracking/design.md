# Design — task tracking

## Decisions

### 1. Key = `ROT-` + GitHub issue number

Alternatives:

- **Local counter in a file** (`ROT-0001`): drifts on imports, deletions and a
  provider migration; two writers need a lock.
- **UUID / content hash**: unreadable, does not fit a trailer, no provider
  object behind it.
- **Branch-derived key**: forks and Bitbucket workspaces cannot guarantee it.

The issue number is a provider-owned, immutable, publicly visible integer. The
text prefix `ROT-` makes the key greppable and survives a move to Jira's
project key. `ROT-0` and leading zeros are invalid; the parser rejects them so
a typo cannot silently point at another issue.

The key is used in the sub-issue title, the commit trailer and the PR body. The
epic and the branch do not need it.

### 2. Task = an `##` section with checkboxes

`tasks.md` already uses `## <n>. <title> (blocked by: ...)` for units that own a
dependency and a checkbox list. Parsing that section is stable across the
existing files (`## 1.`, `## Phase 0 -`, `## Slice 4b -`, `## P0 —`).

Rules:

- Only `##` headings start a section; a checkbox before the first heading forms
  an implicit `Tasks` section.
- A section is a task when it has at least one checkbox and its title is not
  `Out of scope`, `References`, `Background`, `Legend`, `Notes` or
  `MVP status`.
- The title strips the heading number (`1.`, `Phase 0 -`, `P0 —`), the trailing
  tag groups (`[back] [ops]`) and the `(blocked by: ...)` parenthetical.
- The slug is the lowercased title with non-alphanumerics collapsed to `-`,
  capped at 60 characters and de-duplicated per change. The marker
  `<!-- openspec-task: <change>/<slug> -->` is the idempotency key.

A fully checked section with no existing sub-issue is historical and is not
retroactively created. A section that already has a sub-issue is updated even
after it becomes fully checked; the sync never closes it.

### 3. Blockers

`(blocked by: ...)` is split on `,` and `;`. Each token resolves in this order:

1. `ROT-<n>` or `#<n>`: an explicit key.
2. A range (`1-5`, `T1-T8`): expands to section numbers.
3. A section number (`1`, `4a`, `T0`): resolves to that section's key. A
   suffix such as `4a` falls back to section 4; a self-reference is dropped and
   reported.
4. A role list (`developer + designer`, `analyst + critic`) or a `follows ...`
   phrase: a note, not an edge.
5. Anything else (`demand gate`): unresolved and reported verbatim.

The body writes `Blocked by: ROT-7 (#7), ROT-8 (#8)`. The key is
provider-neutral; `#7` is the GitHub-native link. Unresolved text goes to
`Blocked by (unresolved): ...` and into the epic body, so the gap is visible
without inventing an edge.

### 4. Sync algorithm

For each change with at least one checkbox:

1. Find the epic by `<!-- openspec-change: <id> -->`, or create it with a
   provisional body. The epic number is needed before sub-issues can reference
   it.
2. Pass 1: for each candidate task, look up the sub-issue by marker; create it
   with a provisional title and the marker body when absent. Collect issue
   numbers. A `change:<id>` label is created on demand; `area:<area>` is added
   from the change id and the task title.
3. Pass 2: build the section-number → key map, resolve blockers, and edit each
   sub-issue to `ROT-<n> — <title>` plus the final body. Compare title, body and
   labels first: a stable second run performs no edit.
4. Link each sub-issue under the epic with `addSubIssue` over GraphQL. Query the
   current parent first; skip when it already matches. A GraphQL error throws
   with both issue numbers.
5. Recompute the epic: progress from closed sub-issues, body with the
   sub-issue list, unresolved blockers and the source path. Add/update the
   project item and the `Area` field.
6. Add each sub-issue to the project with `Area` only. Setting `Status=Done`
   would let the board's auto-close workflow close an issue, which this script
   must not cause.
7. For every open PR, parse `Task:`. If the key resolves to a synced sub-issue
   and the body lacks a closing reference, append `Closes #<n>` when the branch
   matches `<type>/<change-id>-<slug>` or the diff touches the change folder.
   Otherwise report. A body that already closes a different issue is never
   edited.

`--dry-run` performs no create/edit/link/project mutation. It prints the
planned epics, sub-issues, blocker resolutions and PR body edits. The unit
tests inject a fake `gh`/`ghJson` so the algorithm is testable without a
network or a repository.

### 5. PR gate

`scripts/check-task-links.mjs` resolves the PR body, the changed paths and
(when running with `gh`) issue existence. The verdict is a pure function in
`scripts/lib/task-tracking.mjs`; the CLI is a thin wrapper.

Rules:

- No `Task:` line → fail.
- `Task: ROT-<n>` → the issue must exist; the body must contain
  `Closes|Fixes|Resolves #<n>`. A closing reference to a different issue does
  not satisfy it.
- `Task: none — <reason>` → pass only when every changed path is docs/process
  (`docs/`, `openspec/`, `scripts/`, `.github/`, `projects.json`, or a
  repository-root Markdown file such as `AGENTS.md`) and the reason is
  non-empty. A Markdown file inside product code (`apps/site/README.md`) does
  not qualify.
- Any product path needs a key. Empty/unknown file lists are treated as
  product, so a broken `gh` call fails safe.

The workflow runs on `opened`, `edited`, `synchronize` and `reopened` with the
default token and read-only `issues`/`pull-requests`. A bootstrap process PR can
use `Task: none — <reason>` because the key machinery does not exist yet; this
is the documented process-only exception, not a general bypass.

### 6. Provider mapping

The text convention is the contract; the adapter is replaceable. GitHub uses
the issue number, Bitbucket Cloud its issue-tracker id and Jira the project key.
All three can act on a closing keyword in a PR description or commit; the exact
edges are in `docs/process/task-tracking.md`. A migration keeps the numbers; a
project-key rename changes the prefix and the adapter, not the historical keys.

### 7. The board is kept fresh by a daily workflow; stale PR cards are archived

The sync remains a local script with an owner `gh` login for `--dry-run`
inspection, but `.github/workflows/board-sync.yml` runs it daily at 03:17 UTC
and on `workflow_dispatch` with the `BOARD_SYNC_TOKEN` secret. A user-owned
Project v2 cannot be edited by the default `GITHUB_TOKEN`; the secret is a
personal token with `repo` and `project` scopes, referenced by name only. The
job fails with an explicit error if the secret is absent.

Project items whose content is a pull request and whose state is no longer
`OPEN` are archived with the GraphQL `archiveProjectV2Item` mutation. The board
therefore shows open PR cards and the epics carry the history. Issue items are
never archived. A state read failure is reported and leaves that item for the
next run, so one inaccessible PR cannot abort the whole sync.

### 8. Silent skips are forbidden

A change with no `tasks.md` (today `frontend-platform`) or with no checkbox
tasks is printed as a warning and named in the summary. The same change adds
`openspec/changes/frontend-platform/tasks.md` with phases 0-7 from its proposal
so it is tracked rather than skipped. A future change that adds specs without
tasks is visible in the sync output instead of disappearing.

## Failure paths

- `gh issue create` / `edit` failure: the sync aborts with the `gh` stderr.
  Because the marker is written before any body update, the next run resumes
  instead of duplicating.
- GraphQL unavailable or a missing issue id: `linkSubIssueToEpic` throws naming
  the epic and sub-issue; the text blocker edges are already in the bodies.
- A PR body cannot be attributed to a change: the sync prints
  `cannot prove the diff belongs to <change>` and leaves the body alone.
- A key with no synced sub-issue: reported. This catches a stale key after a
  provider migration or a manual issue deletion.

## Test plan

- `scripts/task-tracking.test.mjs`: key parsing, directive parsing, closing
  keywords, section parsing (titles, slugs, tags, implicit section), blocker
  parsing (multi-blocker, ranges, notes, unresolved), self-loop dropping,
  docs/process classification, the gate verdict matrix, epic body, idempotent
  create/update with a fake `gh`, dry-run with a fake that throws on any call.
- `scripts/check-task-links.test.mjs`: the CLI verdict for every pass/fail case.
- Gates: `check-projects`, `check-defect-ledger`, `check-ssot`,
  `gen-detector-docs --check`, `node --test` for the two new files.
