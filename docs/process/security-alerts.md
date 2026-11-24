# Security alert routing and lifecycle

Every open GitHub security alert gets one tracking issue, so an alert cannot
sit in the Security tab unnoticed. The workflow is
`.github/workflows/security-alerts-sync.yml`; the implementation is
`scripts/security-alerts-sync.mjs` (planner: `scripts/lib/security-alerts.mjs`).
The old `.github/workflows/codeql-alerts.yml` was folded into this workflow and
deleted: a daily red run is not a route to a person.

## Sources

The sync reads all states, because closing a tracking issue needs the alert's
dismissal or fix evidence:

| Kind | Endpoint | States fetched |
| --- | --- | --- |
| Code scanning | `GET /repos/{owner}/{repo}/code-scanning/alerts` | `open`, `dismissed`, `fixed` |
| Dependabot | `GET /repos/{owner}/{repo}/dependabot/alerts` | `open`, `dismissed`, `fixed` |
| Secret scanning | `GET /repos/{owner}/{repo}/secret-scanning/alerts` | `open`, `resolved` |

Code scanning can return the same alert from both `state=dismissed` and
`state=fixed` when a fix landed and was later dismissed; the sync deduplicates
by the marker and trusts the object's own `state`. A kind that is disabled on
the repository (`404`, or `403` with "disabled") is reported as a warning, not
a failure; any other read error fails the job. Pagination is
`gh api --paginate`.

## One issue per alert

The hidden marker in the issue body is the deduplication key:

```text
<!-- security-alert:code-scanning:<number> -->
<!-- security-alert:dependabot:<number> -->
<!-- security-alert:secret-scanning:<number> -->
```

Titles:

| Kind | Title |
| --- | --- |
| Code scanning | `[security] <rule> in <path>:<line>` |
| Dependabot | `[security] <package> <vulnerable-range> in <manifest>` |
| Secret scanning | `[security] <secret type> in <path>:<line>` |

The body carries severity, rule, path, first-seen, a direct link to the alert
page, the required action and a standalone `Priority: Pn` declaration so the
board sync preserves the value when it adopts the issue.

The label is `security`; the path picks the project `Area`:

| Path | Area | Milestone (`data/milestones.json`) |
| --- | --- | --- |
| `apps/site/**`, `web/**`, `data/**` | `site` | Astro frontend cutover |
| `src/coordinator/**`, `src/bin/rotor-coord*`, `tests/coordinator_*`, `crates/**` | `coordinator` | Desktop and coordinator parity |
| other `src/**`, `tests/**`, `Rotor-Cuda/**`, `BinSort/**`, `Cargo.toml`, `Cargo.lock`, `build.rs` | `desktop` | Desktop and coordinator parity |
| `.github/**`, `deploy/**`, `scripts/**` | `infra` | Design system and process foundations |
| `docs/**`, `openspec/**` | `docs` | Design system and process foundations |
| `design/**` | `design` | Design system and process foundations |
| anything unmatched | `infra` | Design system and process foundations |

The native issue Type is `Bug`. The release milestone is matched by area; a
missing milestone in `data/milestones.json` is created from that file.

## Severity to priority

| Alert severity | Project Priority | Project Severity |
| --- | --- | --- |
| `critical` | `P0` | `S1` |
| `high` | `P0` | `S1` |
| `medium` | `P1` | `S2` |
| `low` | `P2` | `S3` |
| unknown | `P2` | `S3` |

Code scanning uses `rule.security_severity_level`; when it is absent the legacy
`rule.severity` is mapped (`error` -> high, `warning` -> medium, `note` ->
low). Dependabot uses `security_advisory.severity`. Secret scanning has no
severity field in the API, so an exposed credential is treated as `critical`
(`P0`) until a human records a resolution.

The sync also writes the project `Area`, Start date, Target date and Actual
start so the daily `check-task-links.mjs --board` gate does not see a
half-populated card. On close it writes Actual end from the
dismissal/fix/resolution timestamp.

## Lifecycle

| Alert state | Tracking issue state | Action |
| --- | --- | --- |
| `open` | missing | Create one issue with the marker, labels, Type `Bug`, milestone, Priority and plan dates |
| `open` | open | Reconcile title/body if drifted; ensure labels, milestone and project fields. Never create a second issue |
| `open` | closed by the sync | The alert regressed: reopen and reconcile (the close comment carries `<!-- security-alert-close:<kind>:<number> -->`) |
| `open` | closed by a human | Post one comment saying the alert is still open and the sync never reopens a human-closed issue; later runs no-op (comment marker `<!-- security-alert-reopen:<kind>:<number> -->`) |
| `dismissed` | open | Close with a comment naming `dismissed_by`, `dismissed_reason` and `dismissed_comment` |
| `fixed` | open | Close with a comment naming `fixed_at`; close reason `completed` |
| `resolved` (secret) | open | Close with a comment naming `resolved_by`, `resolution` and `resolution_comment` |
| any non-open | missing or already closed | No-op |

A dismissed or resolved alert closes with GitHub's `not planned` reason; a
fixed alert closes with `completed`. Closing is the sync's only destructive
action, and it happens only for a tracked issue whose alert is no longer open.

## Who dismisses

The policy is in `AGENTS.md` -> Security alerts and is repeated in every issue
body:

- Fix a real finding.
- Dismiss a false positive only with `dismissed_reason` and a written comment
  naming the evidence (for example: deterministic test fixture inside
  `#[test]`, never used by production code).
- Never dismiss silently and never suppress a whole rule to clear a list.
- Production cryptographic values (keys, nonces, salts) come from the OS RNG
  or environment variables; only tests may use fixed vectors.

The sync never dismisses anything. A human (owner or reviewing agent) does the
dismissal in the Security tab; the next sync records who and why on the issue.

## 24h escalation

Creating an issue is not enough if nobody picks it up. The workflow runs a
second, read-only pass:

```sh
node scripts/security-alerts-sync.mjs --check-escalation
```

It exits `1` when an **open** alert is older than 24 hours and either has no
tracking issue or has an open tracking issue with no assignee. It prints one
`::error::` line per alert with the issue link. This is the only red signal:
a daily run that merely finds open alerts stays green because the issue is the
routing.

To clear an escalation, assign the tracking issue to the person taking it, or
fix/dismiss/resolve the alert. A tracking issue closed by a human stops the
escalation for that alert (the sync does not reopen it); the close comment
records the decision.

The window is configurable with `SECURITY_ALERT_STALE_HOURS` (default `24`).

## Run

```sh
node scripts/security-alerts-sync.mjs --dry-run          # plan, change nothing
node scripts/security-alerts-sync.mjs                    # apply
node scripts/security-alerts-sync.mjs --check-escalation # read-only; exit 1 on escalation
node --test scripts/security-alerts.test.mjs             # planner tests
```

The CLI uses the local `gh` login. In CI the workflow reads the repository
secret `BOARD_SYNC_TOKEN` (the owner's personal token, the same one the board
sync uses); the value is never stored in the repository or printed. The
workflow runs daily at 04:43 UTC and on `workflow_dispatch`.

## Idempotency and rate limits

- The marker is the identity; a second run updates or no-ops, never duplicates.
  Pre-existing duplicates are reported with their issue numbers.
- An update writes the title/body only when they drifted, and project fields
  only when the cached item differs.
- Rate-limit errors go through `scripts/lib/project-api.mjs`
  (`withProjectsRetry`): four retries with 60/120/240/240s backoff. If the
  quota is still exhausted, the run exits `0` with
  `security-alerts sync deferred: API rate limit`; the next daily run finishes
  the idempotent sync. A real error is not retried and fails the job.
- `--dry-run` performs only reads and prints every planned action.

## Dry-run evidence (2026-11-24)

```text
$ node scripts/security-alerts-sync.mjs --dry-run
security-alerts: 0 open, 8 dismissed, 3 fixed, 0 resolved (repository issues scanned: 164)
no-op code-scanning #1: Alert fixed upstream at 2026-11-18T05:40:51.000Z. No tracking issue to close.
no-op code-scanning #2: Alert fixed upstream at 2026-11-18T05:40:51.000Z. No tracking issue to close.
no-op code-scanning #3: Alert fixed upstream at 2026-11-18T05:40:51.000Z. No tracking issue to close.
no-op code-scanning #4: Alert dismissed by @mytab0r (reason: false positive). Comment: Test-only fixed vector: the hard-coded bytes are a deterministic fixture (nonce/message/key) inside #[test] code, never used by production signing or storage. No tracking issue to close.
no-op code-scanning #5: Alert dismissed by @mytab0r (reason: false positive). Comment: Test-only fixed vector: the hard-coded bytes are a deterministic fixture (nonce/message/key) inside #[test] code, never used by production signing or storage. No tracking issue to close.
no-op code-scanning #6: Alert dismissed by @mytab0r (reason: false positive). Comment: Test-only fixed vector: the hard-coded bytes are a deterministic fixture (nonce/message/key) inside #[test] code, never used by production signing or storage. No tracking issue to close.
no-op code-scanning #7: Alert dismissed by @mytab0r (reason: false positive). Comment: Test-only fixed vector: the hard-coded bytes are a deterministic fixture (nonce/message/key) inside #[test] code, never used by production signing or storage. No tracking issue to close.
no-op code-scanning #8: Alert dismissed by @mytab0r (reason: false positive). Comment: Test-only fixed vector: the hard-coded bytes are a deterministic fixture (nonce/message/key) inside #[test] code, never used by production signing or storage. No tracking issue to close.
no-op code-scanning #13: Alert dismissed by @mytab0r (reason: won't fix). Comment: False positive: the key finder intentionally prints the found private key/WIF to its local report. No network transmission; reviewed manually. No tracking issue to close.
no-op code-scanning #14: Alert dismissed by @mytab0r (reason: won't fix). Comment: Found.txt is the documented product output of the key-search tool: the operator searches authorized keys and expects the recovered private key here. write_block is the feature, not a log; nothing leaves the machine. README warns the file holds secrets. No tracking issue to close.
no-op code-scanning #16: Alert dismissed by @mytab0r (reason: false positive). Comment: Test-only fixture: deterministic nonce inside #[test] tron_sign_message_v2_recovers_the_signer (auth.rs:507-530). Never used in production; real nonces come from getrandom. No tracking issue to close.
security-alerts plan: 0 create, 0 update, 0 close, 0 comment, 11 no-op, 0 escalation(s)
```

`#16` is the critical alert from the incident. It is dismissed as a test-only
fixture with the evidence comment above, so the dry run has no issue to close
and reports a no-op. There were no open alerts at the time of the run, so no
create plan was produced against the live repository. The planner path is
covered by the unit tests, and a fixture simulation shows the create plan:

```text
[simulated] create "[security] rust/sql-injection in src/coordinator/query.rs:42" labels=[security] priority=P0 milestone="Desktop and coordinator parity"
```

`node scripts/security-alerts-sync.mjs --check-escalation` exits `0` with
`security-alert escalation: none (0 open alerts older than 24h without an
assigned tracking issue)` on the same repository state.
