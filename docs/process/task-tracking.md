# Task tracking

Every task has one key, `ROT-<n>`, where `<n>` is the GitHub issue number. The
same key appears in the issue title, every commit that implements the task, the
pull-request body, and the sub-issue's `Blocked by:` line. The convention is
provider-neutral: GitHub is the current backend, and the same text works with
Bitbucket Cloud's issue tracker or Jira without a second identifier.

## Decisions

1. **The key is the issue number, not a separate counter.** `ROT-12` means
   issue #12 in `mytab0r/Rotor-Cuda`. A provider carries the issue number in
   plain text (`#12`, `ROT-12`), so nothing has to be looked up to interpret a
   commit or a PR body. A local incrementing counter would drift after a
   provider migration or a deleted issue; a UUID would not fit a commit
   trailer. The number is the only identifier every provider can preserve.
2. **A task is a section in `openspec/changes/<change-id>/tasks.md`.** The
   section is the unit that owns a `blocked by:` line and a checkbox list, so
   it maps one-to-one to a sub-issue. Individual checkboxes stay in the file and
   are the task's progress detail.
3. **One epic issue per OpenSpec change.** The epic is the change, not a task.
   It has no `ROT-` key; its title is `[<change-id>] <heading>` and its body
   lists the sub-issues and the aggregate progress.
4. **Blockers are text plus native sub-issue links.** `Blocked by: ROT-7 (#7)`
   gives a provider-neutral key and a GitHub-native link. The sync writes it
   from the section's `blocked by:` line; a blocker that cannot be resolved to a
   synced task is written as `Blocked by (unresolved): <text>` and reported.
5. **The sync never closes issues.** It creates and updates. An agent (or the
   project's auto-close workflow) closes a finished issue. This keeps the board
   a mirror, not a second source of truth.
6. **The branch does not need the key.** Forks and Bitbucket workspaces cannot
   guarantee that a contributor has an issue number before pushing. The branch
   convention is `<type>/<change-id>-<slug>`; the key lives in the PR body and
   the commit trailer, which are written after the issue exists.
7. **PR titles stay free-form.** The PR body carries `Task: ROT-<n>` and a
   closing reference. The title is for humans and stays readable in the merge
   history.

## Anatomy

### Epic

- Title: `[<change-id>] <first heading of tasks.md>`.
- Labels: `epic`, `area:<area>`.
- Marker: `<!-- openspec-change: <change-id> -->` (idempotency).
- Body: folder link, `Progress: <closed>/<total> sub-issues closed (<p>%)`, the
  sub-issue list, unresolved blockers and `Source of truth: tasks.md`.
- Board: `Area`, `Progress` (closed sub-issues / total sub-issues) and `Status`
  (`Todo` at 0%, `Done` at 100%, `In Progress` otherwise).

### Sub-issue

- Title: `ROT-<n> — <task title>` (for example `ROT-12 — Providers and watcher`).
- Labels: `change:<change-id>`, `area:<area>`.
- Marker: `<!-- openspec-task: <change-id>/<slug> -->`, where the slug is the
  heading without its number, tags or `blocked by:` parenthetical.
- Body: epic reference, source path and section, checkbox counts,
  `Blocked by: ROT-7 (#7), ROT-8 (#8)`, unresolved blockers and notes.
- Native sub-issue relationship: `addSubIssue` over GraphQL. The sync queries
  the current parent first, so a second run is a no-op. A GraphQL error aborts
  with the issue numbers in the message; there is no silent fallback.

The sync creates a sub-issue only for a section that still has an unchecked box
or already has a sub-issue. A fully checked section that never had one is
historical work and is not retroactively opened. An existing sub-issue is
updated even when its section becomes fully checked; the sync never closes it.

### Commit

Put the key in a trailer at the end of the commit message:

```text
fix(site): serve Litecoin directories from litecoinspace on SoChain 429

Task: ROT-12
```

The trailer is provider-neutral and survives a rebase, a squash and a provider
migration. A commit may serve several tasks; repeat the trailer
(`Task: ROT-12`, `Task: ROT-15`) or put the main task first. Do not add
`Closes`/`Fixes` to a commit: closing belongs to the PR, where the provider can
act on it.

### Pull request

The body must contain both lines:

```text
Task: ROT-12

Closes #12
```

`Task:` identifies the sub-issue. The closing reference is what the provider
uses to close it on merge; it is also what makes the PR appear as a linked item
on the board. `Closes`, `Fixes` and `Resolves` are accepted by the check.
Closing a different issue than the keyed one fails the check.

A docs/process-only PR has no product task. It may use:

```text
Task: none — docs: fix the task-tracking example
```

The reason is mandatory. "Docs/process-only" means every changed path is under
`docs/`, `openspec/`, `scripts/` or `.github/`, is `projects.json`, or is a
Markdown file at the repository root (`README.md`, `AGENTS.md`,
`PROJECTS.md`, ...). A Markdown file inside product code
(`apps/site/README.md`) is product and needs a key. Any product path
(`apps/`, `web/`, `src/`, `crates/`, `data/`, `design/`, `tests/`) requires a
key.

The PR body also follows `.github/pull_request_template.md`.
`scripts/check-process.mjs` gates the evidence sections and accepts the same
docs/process-only reduced contract; see
[verification.md](verification.md).

### Branch

```text
<type>/<change-id>-<slug>
```

For example `feat/task-tracking-board-sync` or
`fix/wallet-mainnet-signing-erc20-approvals`. `<type>` is the usual
`feat`/`fix`/`docs`/`refactor`/`test`/`chore`. The change id is the OpenSpec
folder name. The slug is short and lowercase. The key is deliberately absent:
the branch may be pushed before the sub-issue exists, and a fork cannot be
forced to carry it.

If a longer registered change id starts with this one (for example
`wallet-mainnet-signing` and `wallet-mainnet-signing-erc20`), a branch
`<type>/<change-id>-<slug>` is ambiguous. The sync then requires a changed file
under `openspec/changes/<change-id>/` before it appends `Closes`; otherwise it
reports the PR for a manual decision.

## Native fields: Type, Priority, Severity

GitHub issues carry a native **Type** (`Task`, `Bug`, `Feature`). A label does
not duplicate it: the sync sets the issue type, and the project's `Type` column
reads that native value.

| Rule (first match) | Type |
|---|---|
| title starts with `fix(` or contains `defect`, or the body names the defect ledger (`docs/process/defects.json` or `Defect: <id>`) | `Bug` |
| label `epic` | `Feature` |
| label `change:<id>` or body marker `<!-- openspec-task: ... -->` | `Task` |
| no match | left unset; the sync prints a warning naming the issue |

Priority and Severity are Project v2 single-select fields, not labels:

- `Priority` options are `P0`–`P3`; `Severity` options are `S1`–`S4` plus `S-`
  ("no severity").
- An epic defaults to `P1` / `S-`. A sub-issue inherits the epic priority; a
  defect (`Bug`) defaults to `S2` unless the body declares a severity.
- An issue declares its own value with a body line: `Priority: P2` or
  `Severity: S3`. The sync preserves those lines when it regenerates the body.
- The sync never leaves `Priority` empty for a synced issue; the board gate
  fails otherwise.

Labels `epic`, `area:<area>` and `change:<id>` stay because no native field
expresses the OpenSpec grouping or the board area. Labels that duplicate a
native field (`bug`, `enhancement`, `type:bug`, `type:feature`) are not used;
they were audited and removed. `documentation`, `question`, `duplicate`,
`invalid`, `wontfix`, `good first issue` and `help wanted` remain: they carry
triage information that the three native types cannot express.

## Milestones are releases

`data/milestones.json` is the single source for release milestones. Each entry
has `title`, a required `due` (a quarter-end planning default, `YYYY-MM-DD`), an
optional `description`, and `match: { epics: [...], areas: [...] }`. The sync
refuses a milestone without `due`, and the board gate fails one: the Roadmap
needs both ends of the bar.

The sync creates a missing milestone over REST, assigns every synced issue and
matches **epic first, then area**. The epic mapping wins, so every issue of one
OpenSpec change shares the epic's milestone. The board gate fails when one
change spans milestones, and when a milestone title is not in this file. Never
copy a milestone title into another script.

Release plan:

| Milestone | Epics | Target (planning default) |
|---|---|---|
| Wallet: signing, history and portfolio | cabinet-wallet, product-strategy, send-wif-keys, site-wallet-studio, tx-sign-broadcast, wallet-account-link, wallet-history, wallet-mainnet-signing, wallet-portfolio, wallet-seed-phrase, wallet-top-assets-wif, walletconnect-deeplinks | 2027-03-31 |
| Desktop and coordinator parity | key-leak-monitor, rust-desktop-all-chains | 2027-03-31 |
| Astro frontend cutover | admin-cabinet, donor-copy-parity, frontend-platform, seo-strategy, site-parity-audit | 2026-12-31 |
| Design system and process foundations | design-system-process, edge-privacy, repo-structure, security-advisories, ssot, task-tracking | 2027-03-31 |

The dates are planning defaults at quarter ends, not promises; change them in
`data/milestones.json`, never in the project UI.

## Dates: plan, facts and the Roadmap

The Roadmap bar reads the built-in `Start date` → `Target date` pair, so those
two fields are the **plan**: Plan start → Plan end. Two custom date fields hold
the **facts**, and the sync never writes a fact into a plan field.

| Field | Kind | Value | Source |
|---|---|---|---|
| `Start date` | plan start | when the work is planned to start; currently the first `In Progress` transition when the project item exposes one, otherwise the issue's native `createdAt` | project item / GraphQL `createdAt` |
| `Target date` | plan end | the due date of the issue's milestone (the planned end of the bar) | `data/milestones.json` |
| `Actual start` | fact | the first `In Progress` transition when readable, otherwise `createdAt` | project item / GraphQL `createdAt` |
| `Actual end` | fact | the native `closedAt` date; empty while the issue is open | GraphQL |

The status-transition timestamp is not exposed by `gh project item-list` today;
the documented fallback for both start values is `createdAt`. When the API
starts exposing the transition, the sync reads it and the two starts diverge
without a schema change.

On every sync the report prints, for each closed issue with all four dates:

```text
actual: #298 plan 2026-11-22 -> 2026-12-31, actual 2026-11-22 -> 2026-12-20, slip -11 day(s) (on time)
actual: #305 plan 2026-11-22 -> 2027-03-31, actual 2026-11-22 -> 2027-04-02, slip 2 day(s) (late by 2 days)
actuals: 8 on time, 2 late
```

Slip is `Actual end - Target date` in whole days; zero or negative is on time.
The weekly comparison is the same computation over the closed issues at that
moment, so a slipped issue stays visible after its close and the plan fields
keep the original commitment. The board gate requires both plan dates on every
synced issue and both actual dates on every closed one; the allowlist may only
name historical closed issues.

## Adopted issues

An issue created outside the sync still belongs to the board when its title
carries a `ROT-<n>` key or it has an `area:*`, `change:*` or `epic` label. The
sync adopts it instead of ignoring it:

- **Area** comes from the `area:*` label, then from the title, then `site`.
- **Type**: `fix(...)` in the title is `Bug`; an epic is `Feature`; any other
  adopted issue is `Task`. An existing native Type is kept.
- **Priority** defaults to `P2` for adopted non-epic work, unless the epic's
  body declares `Priority: Pn`; an adopted epic follows the epic rule
  (`P1` unless declared).
- **Milestone** follows the normal epic-first, then area mapping.
- **Plan dates**: `Start date` = the issue `createdAt` date, `Target date` =
  the milestone due date.
- **Actual dates** for a closed issue: `Actual start` = `createdAt`,
  `Actual end` = `closedAt`.

This is why the gate can stay strict: #421, #423 and #425 are adopted and get
real fields rather than an allowlist entry. Historical allowlist entries remain
only for issues whose work predates the sync and is not adopted.

## Native dependencies

The `Blocked by: ROT-7 (#7), ROT-8 (#8)` line stays for humans. The sync also
creates GitHub's native issue dependencies (`addBlockedBy` over GraphQL) and
removes a native link that the text no longer lists. The gate fails when:

- the text and the native links disagree;
- a blocker is closed while the dependent is open;
- the native graph has a cycle.

The sync report prints every resulting edge (`dependency: #366 <- #365`), so the
dependency graph is visible without opening each issue.

## Future work (explicitly deferred)

- A staging environment with branch deploys and end-to-end runs. The owner
  deferred it; it is recorded here so the sync work does not grow into it.

## Provider mapping

| Provider | Where the key lives | Closing reference | Notes |
|---|---|---|---|
| GitHub | issue number → `ROT-<n>`; sub-issue title, PR body `Task: ROT-<n>`, commit trailer | `Closes #<n>` (or `Fixes`/`Resolves`) in the PR body; merge closes the issue | `scripts/sync-board.mjs` maintains epics, sub-issues, blockers and project items; `scripts/check-task-links.mjs` is the CI gate. |
| Bitbucket Cloud | issue-tracker id → `ROT-<n>` in the PR description and commit trailer | `Closes #<n>` / `Fixes #<n>` in the PR description or a commit message; Bitbucket's issue tracker acts on the keyword | The sync adapter becomes a Bitbucket REST client; the text convention and the marker comments stay the same. |
| Jira | issue key `ROT-<n>` (project key `ROT`); the key is also the Jira key | Smart commit `ROT-<n> #close` in a commit message, or the transition configured in the Jira/GitHub or Jira/Bitbucket app | Jira links the PR through the app; the `Task:` line and the key text stay readable either way. |

A provider migration keeps the numbers. If the project key changes, update this
table and the sync adapter; old commit text still names a valid historical key
and needs no rewrite.

## Lifecycle

1. Add or edit a section in `openspec/changes/<change-id>/tasks.md`, including
   `(blocked by: ...)` on the heading.
2. The owner runs `node scripts/sync-board.mjs` (or `--dry-run` first). It
   creates the epic if needed, creates or updates sub-issues, resolves the
   blocker sections to `ROT-` keys, links the sub-issues to the epic and adds
   them to the project with an `Area`.
3. An agent picks a sub-issue, uses the branch convention, commits with
   `Task: ROT-<n>`, opens a PR whose body has `Task: ROT-<n>` and
   `Closes #<n>`.
4. Review and merge. The provider closes the issue. When the work lands without
   a PR, the agent closes the sub-issue it finished.
5. The next sync recomputes the epic progress from the closed sub-issues and
   reports PRs that still lack a Task line or cannot be linked. It also archives
   merged/closed PR project items so only open PR cards remain. The daily
   `board-sync` workflow runs this without a manual step.

## Commands

```sh
node scripts/sync-board.mjs --dry-run   # print the plan, change nothing
node scripts/sync-board.mjs             # apply (owner's gh login, project scope)

node scripts/check-task-links.mjs --pr 123
node scripts/check-task-links.mjs --body-file body.md \
  --files scripts/sync-board.mjs,AGENTS.md --issue-exists skip
node scripts/check-task-links.mjs --board   # native fields, blockers, cycles
```

`sync-board` needs `gh` with `repo` and `project` scopes; it also creates the
`change:<id>` labels and the `Priority` / `Severity` / `Start date` /
`Target date` / `Actual start` / `Actual end` project fields on demand.
Projects v2 has its own points budget: project calls retry with 60/120/240/240s
backoff, and if the quota stays exhausted the sync and the gate exit 0 with
`sync deferred: Projects quota` (green run, step-summary note) instead of a red
one. The report prints `project API calls: N`.
`.github/workflows/board-sync.yml` runs the sync and then
`check-task-links.mjs --board`; the gate fails when a synced issue (open or
closed) has no native Type, no Milestone, no Priority or not both plan dates,
when a closed issue has no Actual start or Actual end, when the text blockers
disagree with the native links, when an open issue is blocked by a closed one,
when the native graph has a cycle, when one epic spans milestones, when a
milestone has no due date, or when a label duplicates the native Type. The
allowlist in `data/board-exceptions.json` may name historical closed issues
only, each with a reason.

`.github/workflows/task-links.yml` runs the PR check on every `pull_request`
event (`opened`, `edited`, `synchronize`, `reopened`) with the default
`GITHUB_TOKEN` and read-only `issues` / `pull-requests` permissions. The check
fails when:

- the body has no `Task:` line;
- the key shape is invalid or the keyed issue does not exist;
- the closing reference to the keyed issue is missing;
- `Task: none` has no reason, or is used on a PR that changes product paths.

The workflow needs no secret. An automation PR (a `[bot]` or `app/*` author, or
a `release-please--*` head branch) is skipped with a notice: it has no human
author to carry a key. If the repository moves under a provider without
GitHub's issue tracker, the check is replaced by the provider's own status
context; the text convention does not change.

## What the owner must configure once

- Keep GitHub Issues enabled in `mytab0r/Rotor-Cuda`; the sync and the check
  rely on them.
- Add the repository secret `BOARD_SYNC_TOKEN`: a personal token with `repo`
  and `project` scopes (classic) or issues/pull-requests write plus user-project
  access (fine-grained). `.github/workflows/board-sync.yml` runs the sync daily
  at 03:17 UTC and on demand. The value is never stored in the repository.
- Run the first `node scripts/sync-board.mjs` after this mechanics change lands
  (the daily workflow does the same on its next run). That run creates the
  `change:*` labels, the epics and the sub-issues, and populates the board.
  Existing fully checked sections are not retroactively opened.
- Make the `task-links` check a required status check in the branch protection
  for `main` after the first sync exists; until then it reports without
  blocking.
- The project (owner `mytab0r`, number 3) must keep the `Area`, `Progress`,
  `Status`, `Priority`, `Severity`, `Start date`, `Target date`, `Actual start`
  and `Actual end` fields. The sync creates `Priority` (`P0`–`P3`), `Severity`
  (`S1`–`S4`, `S-`) and the four date fields when they are missing. `Area`
  options are `site`, `coordinator`, `desktop`, `infra`, `design`, `docs`; `gh`
  cannot edit the options of an existing single-select field, so a field that
  already exists without an option must be fixed in the project UI. The sync
  reuses an existing field whose name differs only in case instead of creating
  a duplicate.
- The repository issue types `Task`, `Bug` and `Feature` must stay enabled
  (`repository.issueTypes` over GraphQL). The sync sets them and the project's
  `Type` column reads them; no label duplicates them.
- The release milestones are created from `data/milestones.json`; do not create
  or rename a milestone by hand, or the next sync and the board gate will
  disagree with the file.
