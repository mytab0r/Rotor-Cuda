# Verification contract

Status: adopted 2026-11-24. Owner: `ops` area. This is the source of truth for
what a pull request must prove, which agent may edit what, and what CI checks.
UI evidence rules stay in [review-and-skills.md](review-and-skills.md); task
keys stay in [task-tracking.md](task-tracking.md).

## 1. The failure modes this closes

| Failure mode | Mechanical countermeasure |
|---|---|
| Tests written to be green: an assertion that cannot fail | `## Tests` names a command and how it fails without the change; `## Mutation proof` must paste a command and output; the mutation jobs break a changed comparison/return and require the test to go red |
| The author reviews or edits their own tests | `## Independent review` names a reviewer and a passing verdict; `process-contract` rejects the PR author as reviewer; the role chain below forbids the implementer from touching the tests that judge it |
| "Verification" claimed without evidence | `## Verification` must carry commands and at least one result line; a prose "all green" is not evidence |
| Spec-less implementation | A product PR needs `## Spec` with an `openspec/changes/<id>/` or spec link; an empty section fails |
| The template's comments look like content | `scripts/check-process.mjs` strips all HTML comments before checking; an unfilled section is empty |

Prose is not the gate: `.github/workflows/process-contract.yml` runs
`scripts/check-process.mjs` on every `pull_request` event, and
`.github/workflows/mutation.yml` runs the mutation smoke. The template is
`.github/pull_request_template.md`; issue forms are in
`.github/ISSUE_TEMPLATE/` (bug with severity, task with area/acceptance/
dependencies, epic).

## 2. What CI checks in the PR body

`scripts/check-process.mjs` is dependency-free. It reads the body, the changed
paths, the labels and the PR author through `gh`, or a local body for tests.

A **product PR** fails when any of these is true:

- `## Spec` is missing or empty, or contains no `openspec/changes/...` or
  `openspec/specs/...` path;
- `## Tests` is missing or empty, or has no command and no failure word
  (`fails`, `without the change`, `regression`, ...);
- `## Mutation proof` is missing or empty, or has no fenced command/output
  block (or an explicit `Command:` / `Output:` pair) that mentions a revert or
  a mutation;
- `## Independent review` is missing or empty, names no reviewer, names the PR
  author or `self`/`author`, or does not carry `Verdict: APPROVE` (or `PASS` /
  `LGTM`);
- `## Verification` is missing or empty, or has no command and result line;
- the `Task: ROT-<n>` line is missing or malformed.

A **docs/process-only PR** uses the reduced contract: it needs a `Task:` line
(a `ROT-<n>` key is allowed, or `Task: none — <reason>` with a non-empty
reason) and skips the five sections. "Docs/process-only" is the existing
definition in [task-tracking.md](task-tracking.md): every changed path is under
`docs/`, `openspec/`, `scripts/`, `.github/`, or a root Markdown file.

A **`process-exempt` label** skips the five sections only when the body carries
a one-line `Process-exempt: <reason>`. An empty, placeholder (`<...>`) or
`TODO` reason fails, and the label never waives the `Task:` line.

HTML comments are stripped before every check, including fenced code inside a
comment. Headings inside a fenced block are not sections. These rules are unit
tested in `scripts/check-process.test.mjs`.

What the script cannot check: whether the pasted output is real, whether the
test is a good test, or whether the reviewer actually ran anything. That is
why the reviewer re-runs the proof and why the mutation jobs exist.

## 3. The role chain

Work moves in this order, with a different agent at each edit:

1. **Spec** — `analyst` produces or updates the OpenSpec change
   (`Proposal` / `design.md` / delta specs). No implementation starts without a
   `## Spec` target.
2. **Tests first** — `tester` writes or extends the failing tests from the
   acceptance lines, records the command and the expected failure, and does not
   edit product code.
3. **Implementation** — `developer` implements against the spec and the tests.
   It may fix a test only by asking the tester; it never edits the tests that
   judge its own change.
4. **Review** — `critic` (or a separately spawned reviewer) reads the diff, the
   spec and the evidence, and re-runs the mutation proof itself. It does not
   trust the author's paste. Its verdict goes into `## Independent review`.
5. **Verification** — `tester` re-runs the commands in `## Verification` on the
   reviewed commit and reports PASS/FAIL with output. A PASS from the author is
   not a verification.

Hard rules:

- The author never approves its own change and never edits the tests that
  judge it. If one agent did both, the review did not happen.
- The reviewer runs the mutation proof (`## Mutation proof`) from the branch,
  not from the author's transcript.
- A failing verdict (`REWORK`, `REJECT`, `FAIL`) blocks the PR; do not rewrite
  the verdict to merge.
- UI changes still walk `ui-checklist` and the evidence bundle in
  [review-and-skills.md](review-and-skills.md) §5.2.

## 4. Mutation smoke

Mutation testing answers one question: does a test notice when the code it
claims to cover changes behaviour? A mutation that survives is a test that
cannot fail for that line.

### Rust: `cargo-mutants`, changed lines only

`.github/workflows/mutation.yml` job `rust-mutation`:

```sh
git diff "origin/$BASE...HEAD" -- '*.rs' > target/changed.diff
cargo mutants --in-diff target/changed.diff --jobs 2 --timeout 120
```

- PR-only; `--in-diff` restricts mutants to changed files and lines.
- 15-minute shell timebox (`timeout 900`), 25-minute job timeout. A timeboxed
  run logs a warning and the partial `target/mutants.log` is uploaded as the
  `mutants-log-<run id>` artifact (7 days).
- The job has `continue-on-error: true` for a two-week observation window
  ending **2026-12-08**. On that date remove `continue-on-error: true` from the
  job and make `rust mutation` a required check. Do not silently extend the
  date; change it in the workflow and in this document in the same PR.
- A surviving mutant is reported by cargo-mutants; add or strengthen a test,
  or mark the line with a documented `#[mutants::skip]` when the mutation is
  genuinely equivalent.

### JavaScript: `scripts/mutate-changed.mjs`

```sh
node scripts/mutate-changed.mjs --base origin/main
node scripts/mutate-changed.mjs --file apps/site/amount.js --test apps/site/amount-test.mjs
node scripts/mutate-changed.mjs --base origin/main --dry-run
```

The script scans changed `apps/site/*.js`, keeps files that have a matching
`*-test.mjs`, takes an added line from the diff, flips one comparison
(`===`↔`!==`, `<`↔`>=`, ...) or return (`return true`↔`false`, `return x` →
`return !(x)`), runs the test, restores the file in `finally`, and prints:

```text
result: test proven
result: test did not catch the mutation
```

Exit 0 means every evaluated mutation was caught (or there was nothing to
mutate); exit 1 means a test stayed green on a mutation or its baseline was
already red. The CI job is blocking and runs the selector unit tests first.
`--file` accepts any source with a matching test (`scripts/foo.mjs` →
`scripts/foo.test.mjs`).

## 5. Proof that the gate works

Local scratch bodies (no network):

```sh
# missing sections -> FAILED
node scripts/check-process.mjs --body-file scratch-missing.md \
  --files apps/site/site.js --labels "" --author mytab0r

# full template body -> OK
node scripts/check-process.mjs --body-file scratch-full.md \
  --files apps/site/site.js --labels "" --author mytab0r
```

The same check runs in CI with `--pr <number>`. The PR that introduced this
contract pastes both outputs in its `## Verification` section. A green
`process-contract` check means the body has the required shape; it does not
mean the evidence is true — that is the reviewer's re-run.

## 6. Commands

```sh
node --test scripts/check-process.test.mjs scripts/mutate-changed.test.mjs
node scripts/check-process.mjs --pr 123
node scripts/check-process.mjs --body-file body.md --files a,b \
  --labels process-exempt --author login
node scripts/check-task-links.mjs --pr 123
node scripts/mutate-changed.mjs --base origin/main
node scripts/mutate-changed.mjs --file apps/site/amount.js --test apps/site/amount-test.mjs
```
