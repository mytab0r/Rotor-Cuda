<!-- Keep this to one screen. Replace each comment with real content; a comment
     does not count as content and `scripts/check-process.mjs` fails on it. -->

## Spec
<!-- Link one: openspec/changes/<change-id>/ or the spec file this implements. -->

## What changed
<!-- The user-visible or behavioural change, in two or three lines. -->

## For users
<!-- One to three bullets a visitor or wallet user understands, or
     "No user-visible change". The release changelog (docs/changelog.md) is
     filled from this line. -->

## Tests
<!-- Command per test and how it fails without this change:
     - node scripts/foo.test.mjs — asserts the new rejection; fails with ENOENT before the change
     - cargo test -p rotor-wasm --test x — panics on the old default -->

## Mutation proof
<!-- Paste a command and its output proving that reverting the fix turns a new or
     changed test/gate red. The reviewer re-runs it; do not trust this paste.
```text
$ <command that applies one mutation or reverts the fix>
<the failing assertion or gate output>
```
-->

## Independent review
<!-- Reviewer: <agent name/role>, never the author.
Verdict: APPROVE -->
Reviewer:
Verdict:

## Verification
<!-- Commands actually run in this branch and their results (exit code or summary). -->

## Task
<!-- Task: ROT-<n>
Closes #<n> -->
