# Tasks — task tracking

## 1. Convention (blocked by: —)

- [x] `docs/process/task-tracking.md`: key `ROT-<n>` from the issue number, the
      epic/sub-issue anatomy, the commit trailer, the PR body, the branch
      convention and the GitHub/Bitbucket/Jira mapping table.
- [x] `AGENTS.md`: short rule block pointing at the doc; agents open PRs with
      the `Task:` line and close the sub-issue they finish.
- [x] `PROJECTS.md`, `projects.json` and `docs/process/board.md` describe the
      mechanics and the new commands.

## 2. Sync engine (blocked by: 1)

- [x] `scripts/lib/task-tracking.mjs`: `ROT` key parsing, `tasks.md` section
      parsing (`## 1.`, `Phase 0 -`, `Slice 4b -`, `P0 —`), blocker extraction
      (multi-blocker, ranges, notes, unresolved), title/slug/marker generation.
- [x] `scripts/sync-board.mjs`: keep the epic issue; create or update one
      sub-issue per unfinished section with the marker
      `<!-- openspec-task: <change>/<slug> -->`; `change:<id>` and `area:<area>`
      labels; `Blocked by: ROT-<n> (#<n>)`; epic progress from closed
      sub-issues; project `Area` for sub-issues; never close an issue.
- [x] Native sub-issue links through the GraphQL `addSubIssue` mutation, with a
      parent query for idempotency and a loud error path naming both issues.
- [x] PR linking: read `Task: ROT-<n>` from the body, append `Closes #<n>` only
      when the branch follows `<type>/<change-id>-<slug>` or the diff touches
      the change folder; report ambiguous PRs instead of editing.
- [x] Archive merged/closed PR project items with the GraphQL
      `archiveProjectV2Item` mutation; issue items are never touched and only
      open PRs remain as cards.
- [x] Report changes without `tasks.md` (or without checkbox tasks) loudly
      instead of skipping them; `openspec/changes/frontend-platform/tasks.md`
      (phases 0-7, already on main) is adopted by the merge, so the sync tracks
      it instead of silently skipping the change.
- [x] `--dry-run` prints the whole plan (including `§2 <- §1` /
      `§2 <- ROT-<n>` blocker edges) and performs no mutation; unit tests inject
      a fake `gh`.
- [x] Tests: key parsing, blocked-by extraction including multi-blocker lines,
      idempotent create/edit on a second run, dry-run with a throwing fake,
      real blocker edges for `key-leak-monitor` and `tx-sign-broadcast`, and
      the stale-PR archive planner.

## 3. PR gate (blocked by: 1)

- [x] `scripts/check-task-links.mjs`: fail on a missing `Task:` line, an
      invalid key, a non-existent issue, or a missing/wrong closing reference;
      accept `Task: none — <reason>` for docs/process-only PRs.
- [x] `.github/workflows/task-links.yml`: `pull_request` on opened/edited/
      synchronize/reopened, default token, read-only permissions, unit tests
      and the gate in the same job.
- [x] `.github/workflows/board-sync.yml`: daily off-peak cron (03:17 UTC) and
      `workflow_dispatch`, running `sync-board` with the owner
      `BOARD_SYNC_TOKEN` secret (repo + project scopes) so the board cannot lag
      behind merged PRs.
- [x] Tests: every pass/fail case for the gate, both in the pure function and
      through the exported `checkPullRequest`.
- [x] Gates: `node scripts/check-projects.mjs`, `check-defect-ledger`,
      `check-ssot`, `gen-detector-docs --check`, the two new test files and
      `node --check` for every new script.

## 4. Rollout (blocked by: 2, 3) [owner]

- [ ] Merge this change, then run the first live
      `node scripts/sync-board.mjs --dry-run` and inspect the plan; a dry run
      must not mutate anything.
- [ ] Run `node scripts/sync-board.mjs` once to create the `change:*` labels,
      epics and sub-issues, and make `task-links` a required status check after
      the first keys exist.
