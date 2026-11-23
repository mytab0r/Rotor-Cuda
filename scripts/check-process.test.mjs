// CI gate cases for scripts/check-process.mjs. The check is a pure verdict over
// the PR body, changed paths, labels and (optionally) the author; no network.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_SECTIONS,
  checkPullRequest,
  hasCommandEvidence,
  hasFencedEvidence,
  parseSections,
  stripHtmlComments,
} from "./check-process.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const product = ["apps/site/site.js"];
const docs = ["docs/process/verification.md", ".github/workflows/process-contract.yml"];

const FULL_BODY = `## Spec
openspec/changes/process-contract/proposal.md

## What changed
Adds the process gate.

## Tests
- \`node --test scripts/check-process.test.mjs\` — fails with ERR_MODULE_NOT_FOUND before the script exists.
- \`node scripts/check-process.mjs --body-file scratch.md\` — fails on the missing section without the change.

## Mutation proof
Reverting the section check makes the scratch body pass; the test goes red.

\`\`\`text
$ git revert --no-commit HEAD
node --test scripts/check-process.test.mjs
not ok 2 - fails when a required section is missing
\`\`\`

## Independent review
Reviewer: critic
Verdict: APPROVE

## Verification
\`\`\`text
$ node --test scripts/check-process.test.mjs
pass 18
\`\`\`

## Task
Task: ROT-12
Closes #12
`;

function check(body, overrides = {}) {
  return checkPullRequest({ number: 1, body, files: product, author: "mytab0r", ...overrides });
}

function errorsFor(body, overrides = {}) {
  return check(body, overrides).errors.join("\n");
}

test("passes a filled product body", () => {
  const result = check(FULL_BODY);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.match(result.summary, /product contract: Task ROT-12/);
});

test("automation PRs are skipped with a notice, not the human contract", () => {
  const cases = [
    { author: "github-actions[bot]" },
    { author: "release-please[bot]" },
    { author: "app/github-actions" },
    { author: "mytab0r", isBot: true },
    { author: "mytab0r", headRefName: "release-please--branches--main--components--rotor" },
  ];
  for (const overrides of cases) {
    const result = checkPullRequest({ number: 21, body: "", files: product, ...overrides });
    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(result.skipped, true);
    assert.match(result.summary, /automation PR/);
    assert.match(result.summary, /process contract not required/);
  }
});

test("the release-please body fails for a human and passes only as an automation PR", () => {
  const releaseBody =
    ":robot: I have created a release *beep* *boop*\n\n" +
    "## [2.1.0](https://example.invalid/compare/v2.0.0...v2.1.0) (2026-11-23)\n\n" +
    "### Features\n\n* **ops:** route security alerts into issues\n";
  const files = ["Cargo.toml", "Cargo.lock", "CHANGELOG.md", ".release-please-manifest.json"];

  const bot = checkPullRequest({
    number: 465,
    body: releaseBody,
    files,
    author: "app/github-actions",
    isBot: true,
  });
  assert.equal(bot.ok, true, bot.errors.join("\n"));
  assert.equal(bot.skipped, true);

  const human = checkPullRequest({
    number: 465,
    body: releaseBody,
    files,
    author: "mytab0r",
    headRefName: "fix/manual-release",
  });
  assert.equal(human.ok, false);
  assert.match(human.errors.join("\n"), /missing section/);
  assert.match(human.errors.join("\n"), /Task: ROT-<n>/);
});

test("a human PR on a normal branch is not treated as automation", () => {
  const result = checkPullRequest({
    number: 22,
    body: "",
    files: product,
    author: "mytab0r",
    headRefName: "fix/release-please-pat",
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.skipped, true);
  assert.match(result.errors.join("\n"), /missing section/);
});

test("fails when each required section is missing", () => {
  for (const name of REQUIRED_SECTIONS) {
    const body = FULL_BODY.replace(new RegExp(`^## ${name}$.*?(?=^## )`, "ms"), "");
    const errors = errorsFor(body);
    assert.match(errors, new RegExp(`missing section .*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
});

test("the unfilled template fails: HTML comments do not count", () => {
  const template = fs.readFileSync(path.join(REPO_ROOT, ".github/pull_request_template.md"), "utf8");
  const result = check(template);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /is empty|Task: ROT-<n>/);
});

test("a section filled only with an HTML comment is empty", () => {
  const body = FULL_BODY.replace(
    "openspec/changes/process-contract/proposal.md",
    "<!-- openspec/changes/process-contract/proposal.md -->",
  );
  assert.match(errorsFor(body), /section `## Spec` is empty/);
});

test("Task: ROT-<n> inside an HTML comment does not satisfy the task line", () => {
  const body = FULL_BODY.replace("Task: ROT-12", "<!-- Task: ROT-12 -->");
  assert.match(errorsFor(body), /Task: ROT-<n>/);
});

test("Spec must link an openspec path", () => {
  const body = FULL_BODY.replace("openspec/changes/process-contract/proposal.md", "the design doc");
  assert.match(errorsFor(body), /`## Spec` must link an openspec/);
});

test("Tests must name a command and a failure mode", () => {
  const body = FULL_BODY.replace(
    /## Tests\n[\s\S]*?(?=\n## Mutation proof)/,
    "## Tests\nAll tests pass.\n",
  );
  assert.match(errorsFor(body), /`## Tests` must name the command/);
});

test("Mutation proof must carry a fenced command and output", () => {
  const body = FULL_BODY.replace(
    /## Mutation proof\n[\s\S]*?(?=\n## Independent review)/,
    "## Mutation proof\nI reverted the change and the test failed.\n",
  );
  assert.match(errorsFor(body), /`## Mutation proof` must carry a command/);
});

test("Independent review rejects the author and a non-passing verdict", () => {
  assert.match(
    errorsFor(FULL_BODY.replace("Reviewer: critic", "Reviewer: mytab0r")),
    /names the author/,
  );
  assert.match(
    errorsFor(FULL_BODY.replace("Reviewer: critic", "Reviewer: someone (mytab0r)")),
    /names the author/,
  );
  assert.match(
    errorsFor(FULL_BODY.replace("Verdict: APPROVE", "Verdict: REWORK")),
    /only APPROVE, PASS or LGTM/,
  );
});

test("Verification must carry a command and a result", () => {
  const body = FULL_BODY.replace(
    /## Verification\n[\s\S]*?(?=\n## Task)/,
    "## Verification\nLooks good.\n",
  );
  assert.match(errorsFor(body), /`## Verification` must carry the commands/);
});

test("product PR rejects Task: none", () => {
  const body = FULL_BODY.replace(/Task: ROT-12\nCloses #12/, "Task: none — docs: wording");
  assert.match(errorsFor(body), /product PRs require `Task: ROT-/);
});

test("docs/process-only PR uses the reduced contract", () => {
  const body = "Task: none — docs: describe the process gate\n";
  const result = checkPullRequest({ number: 7, body, files: docs });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.processOnly, true);
  assert.match(result.summary, /docs\/process-only reduced contract/);
});

test("docs/process-only PR needs a reason after Task: none", () => {
  const result = checkPullRequest({ number: 8, body: "Task: none\n", files: docs });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /requires a one-line reason/);
});

test("docs/process-only PR may still use a key", () => {
  const result = checkPullRequest({ number: 9, body: "Task: ROT-12\n", files: docs });
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("process-exempt label waives sections only with a one-line reason", () => {
  const waived = checkPullRequest({
    number: 10,
    body: "Task: ROT-12\nProcess-exempt: generated lockfile-only change\n",
    files: product,
    labels: ["process-exempt"],
    author: "mytab0r",
  });
  assert.equal(waived.ok, true, waived.errors.join("\n"));
  assert.equal(waived.waivedBy, "generated lockfile-only change");

  const noReason = checkPullRequest({
    number: 11,
    body: "Task: ROT-12\n",
    files: product,
    labels: ["process-exempt"],
  });
  assert.equal(noReason.ok, false);
  assert.match(noReason.errors.join("\n"), /requires a one-line `Process-exempt/);

  const placeholder = checkPullRequest({
    number: 12,
    body: "Task: ROT-12\nProcess-exempt: <reason>\n",
    files: product,
    labels: [{ name: "process-exempt" }],
  });
  assert.equal(placeholder.ok, false);
});

test("process-exempt does not waive the Task line", () => {
  const result = checkPullRequest({
    number: 13,
    body: "Process-exempt: no sections today\n",
    files: product,
    labels: ["process-exempt"],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Task: ROT-<n>/);
});

test("a heading inside a fenced block is not a section", () => {
  const body = FULL_BODY.replace(/## Verification\n[\s\S]*?(?=\n## Task)/, "");
  const withFakeHeading = body.replace(
    "\n## Task\n",
    "\n```text\n## Verification\n$ node --test\npass 1\n```\n\n## Task\n",
  );
  assert.match(errorsFor(withFakeHeading), /missing section `## Verification`/);
});

test("HTML comments spanning lines are removed before parsing", () => {
  const body = FULL_BODY.replace(
    "openspec/changes/process-contract/proposal.md",
    "<!--\n## Tests\nopenspec/changes/process-contract/proposal.md\n-->",
  );
  assert.match(errorsFor(body), /section `## Spec` is empty/);
});

test("evidence helpers require a command and an output line", () => {
  assert.equal(hasCommandEvidence("node scripts/x.mjs\npass 3"), true);
  assert.equal(hasCommandEvidence("all good"), false);
  assert.equal(hasFencedEvidence("```text\nnode scripts/x.mjs\npass 3\n```"), true);
  assert.equal(hasFencedEvidence("node scripts/x.mjs\npass 3"), false);
});

test("parseSections ignores headings inside fences and stripHtmlComments is global", () => {
  const sections = parseSections("## Spec\nx\n```text\n## Tests\ny\n```\n## Task\nz\n");
  assert.deepEqual([...sections.keys()], ["spec", "task"]);
  assert.doesNotMatch(stripHtmlComments("a <!-- b --> c <!-- d --> e"), /b|d/);
  assert.equal(stripHtmlComments("a <!--\nb\n--> c"), "a  c");
});
