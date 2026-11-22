# Task tracking: one key per task, linked sub-issues and a PR gate

## Summary

Introduce a provider-neutral task convention and the mechanics that enforce it.
Every task has a key `ROT-<n>` derived from its GitHub issue number. Each
OpenSpec change owns one epic issue; each task section in `tasks.md` becomes a
sub-issue titled `ROT-<n> — <task>` with the change label and
`Blocked by: ROT-<n>` edges from the section's `blocked by:` line. Commits carry
a `Task: ROT-<n>` trailer; a PR body carries the same line plus a provider
closing reference (`Closes #<n>` on GitHub). A `pull_request` CI check enforces
the PR half; `scripts/sync-board.mjs` maintains the issues and the board.

## Problem / motivation

- There is no task identifier. A commit, a PR and an `openspec` task section
  cannot be joined without reading three systems. A reviewer cannot answer
  "which task does this PR finish?" from the diff or the merge history.
- The board already mirrors OpenSpec changes as one issue with a percentage,
  but it has no task-level objects. A blocker such as
  `(blocked by: 1, 2)` is prose in `tasks.md`; the board shows neither the
  dependency nor the linked PR.
- The current sync takes the first heading of `tasks.md` as the issue title and
  counts checkboxes. It has no PR body check, so a PR can merge without a
  traceable task.
- A key derived from a local counter or a UUID would drift on a provider
  migration and does not fit a commit trailer. The issue number is the only
  identifier that GitHub, Bitbucket Cloud and Jira can all carry in text.

## Scope

In scope:

- `docs/process/task-tracking.md`: the key, title, marker, commit trailer, PR
  body, branch naming and the GitHub/Bitbucket/Jira mapping.
- `scripts/sync-board.mjs`: epics, sub-issues, `change:<id>` labels, blocker
  text, native sub-issue links, epic progress from sub-issue state, and
  `Closes #<n>` in PRs that name a key.
- `scripts/check-task-links.mjs` and `.github/workflows/task-links.yml`: the
  PR gate with a docs/process-only escape hatch.
- `.github/workflows/board-sync.yml`: a daily off-peak sync with the owner
  token, plus `workflow_dispatch`, so the board cannot lag behind merged PRs.
- Stale PR project items (merged/closed) are archived; only open PR cards
  remain. Changes without `tasks.md` are reported loudly, and
  `openspec/changes/frontend-platform/tasks.md` is added so that change is
  tracked.
- Unit tests for parsing, blockers (including the real `key-leak-monitor` and
  `tx-sign-broadcast` edges), idempotent creation with a fake `gh`, stale-PR
  archiving and the gate's pass/fail cases.
- `AGENTS.md`, `PROJECTS.md`, `projects.json`, `docs/process/board.md`.

Out of scope:

- Creating or editing any live issue in this change. The first sync is an owner
  action after merge.
- Bitbucket and Jira clients. The convention and markers are provider-neutral;
  the adapter is future work.
- A local commit hook. The trailer is reviewable in the PR and checked there.

## Impacted domains

- `process` / `ops`: docs, scripts, CI, no runtime behavior.
- No `site`, `coordinator`, `wasm-core`, `desktop` or `web` path changes.

## Acceptance criteria

1. `docs/process/task-tracking.md` states the key, the epic/sub-issue shape, the
   blocker text, the commit trailer, the PR body, the branch convention and the
   GitHub/Bitbucket/Jira table.
2. `node scripts/sync-board.mjs --dry-run` prints the epic, sub-issue, blocker
   and PR-link plan with no mutation; the same run without `--dry-run` is
   idempotent by the body markers.
3. A sub-issue title contains `ROT-<n>`; its body contains the change marker,
   the source section and `Blocked by: ROT-<n>` for resolved blockers. Native
   sub-issue linking uses GraphQL and fails loud.
4. `node scripts/check-task-links.mjs --pr <n>` fails on a missing Task line, a
   missing issue, a wrong/missing closing reference, an invalid key and a
   `Task: none` without a reason or on a product PR. It passes a valid keyed PR
   and a docs/process-only `Task: none` PR.
5. The dry-run plan shows the blocker edges for the real
   `key-leak-monitor` and `tx-sign-broadcast` changes; a second non-dry run is
   idempotent. Merged/closed PR items are archived, changes without tasks are
   reported, and `frontend-platform` has a tracked `tasks.md`.
6. `node scripts/check-projects.mjs`, `node scripts/check-defect-ledger.mjs`,
   `node scripts/check-ssot.mjs`, `node scripts/gen-detector-docs.mjs --check`
   and the new unit tests pass.

## Risks / unknowns

- GitHub's sub-issue GraphQL API may be unavailable on an older Enterprise
  deployment. The sync throws with the issue numbers; the text edges still
  exist. This is deliberate: a silent skip would make the tree look complete.
- The first sync creates one sub-issue per unfinished section, which can be a
  few dozen issues. That is the intended decomposition; `--dry-run` shows the
  count first.
- A PR may name a key but have a branch that does not contain the change id.
  The sync reports it instead of appending `Closes`, because editing the wrong
  PR body is worse than a manual fix.
- Existing fully checked sections are not retroactively opened as sub-issues.
  Historical work stays in `tasks.md`; new work gets keys.

## References

- `docs/process/board.md` (current board behavior)
- `scripts/sync-board.mjs` (current epic mirror)
- `openspec/changes/repo-structure/tasks.md` (the `(blocked by: ...)` heading
  convention this change formalizes)
