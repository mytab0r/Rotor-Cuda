// CI gate cases for scripts/check-task-links.mjs. The check is a pure verdict
// over the PR body, changed paths and (optionally) issue existence; no network.

import test from "node:test";
import assert from "node:assert/strict";

import {
  checkBoardFields,
  checkPullRequest,
  findDuplicateTypeLabels,
} from "./check-task-links.mjs";

const product = ["apps/site/site.js", "src/coordinator/mod.rs"];
const docs = ["docs/process/task-tracking.md", "openspec/changes/x/tasks.md"];

test("passes a keyed PR with a closing reference", () => {
  const result = checkPullRequest({
    number: 77,
    body: "## Summary\n\nDoes the work.\n\nTask: ROT-12\n\nCloses #12\n",
    files: product,
    issueExists: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary, "PR #77 Task: ROT-12, closes #12");
});

test("automation PRs are skipped with a notice", () => {
  const cases = [
    { author: "github-actions[bot]" },
    { author: "release-please[bot]" },
    { author: "app/github-actions" },
    { author: "mytab0r", isBot: true },
    { author: "mytab0r", headRefName: "release-please--branches--main--components--rotor" },
  ];
  for (const overrides of cases) {
    const result = checkPullRequest({
      number: 78,
      body: "",
      files: product,
      ...overrides,
    });
    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(result.skipped, true);
    assert.match(result.summary, /automation PR/);
    assert.match(result.summary, /task line not required/);
  }
});

test("a human PR without a Task line still fails", () => {
  const result = checkPullRequest({
    number: 79,
    body: "",
    files: product,
    author: "mytab0r",
    headRefName: "fix/release-please-pat",
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.skipped, true);
  assert.match(result.errors[0], /Task:/);
});

test("fails when the Task line is missing", () => {
  const result = checkPullRequest({
    number: 1,
    body: "No task line.",
    files: product,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /Task:/);
});

test("fails when the closing reference is missing", () => {
  const result = checkPullRequest({
    number: 2,
    body: "Task: ROT-12\n",
    files: product,
    issueExists: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Closes #12/);
});

test("fails when the closing reference names another issue", () => {
  const result = checkPullRequest({
    number: 3,
    body: "Task: ROT-12\nCloses #99\n",
    files: product,
    issueExists: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Closes #12/);
});

test("fails when the keyed issue does not exist", () => {
  const result = checkPullRequest({
    number: 4,
    body: "Task: ROT-12\nCloses #12\n",
    files: product,
    issueExists: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /does not exist/);
});

test("docs-only PR may use Task: none with a reason", () => {
  const result = checkPullRequest({
    number: 5,
    body: "Task: none — docs: fix the wording\n",
    files: docs,
  });
  assert.equal(result.ok, true);
  assert.equal(result.docsOnly, true);
  assert.match(result.summary, /Task: none/);
});

test("Task: none without a reason fails", () => {
  const result = checkPullRequest({
    number: 6,
    body: "Task: none\n",
    files: docs,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /needs a reason/);
});

test("Task: none on a product PR fails even with a reason", () => {
  const result = checkPullRequest({
    number: 7,
    body: "Task: none — no issue for this\n",
    files: product,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /only allowed/);
});

test("process-only PR (scripts, workflows, agent rules) may use Task: none", () => {
  const result = checkPullRequest({
    number: 8,
    body: "Task: none — bootstrap: the mechanics have no issue yet\n",
    files: [
      "scripts/sync-board.mjs",
      ".github/workflows/task-links.yml",
      "AGENTS.md",
      "projects.json",
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.processOnly, true);
});

test("an invalid key shape fails", () => {
  const result = checkPullRequest({
    number: 9,
    body: "Task: ROT-zero\nCloses #1\n",
    files: product,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /must name/);
});

test("issue existence is skipped when the caller does not know it", () => {
  const result = checkPullRequest({
    number: 10,
    body: "Task: ROT-12\nFixes #12\n",
    files: product,
    issueExists: null,
  });
  assert.equal(result.ok, true);
});

test("board gate passes a fully classified synced issue", () => {
  const result = checkBoardFields({
    issues: [
      {
        number: 1,
        state: "OPEN",
        title: "[demo] Demo",
        labels: ["epic"],
        issueType: "Feature",
        milestone: "Wallet",
        body: "",
        blockedBy: [],
      },
    ],
    milestones: [
      { title: "Wallet", due: "2027-03-31", match: { epics: ["demo"], areas: [] } },
    ],
    projectItems: {
      1: { priority: "P1", targetDate: "2027-03-31", startDate: "2026-01-01" },
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.summary, /1 synced issues/);
});

test("board gate reports every missing native field", () => {
  const result = checkBoardFields({
    issues: [
      {
        number: 2,
        state: "OPEN",
        title: "ROT-2 — A",
        labels: ["change:demo"],
        issueType: null,
        milestone: null,
        body: "",
        blockedBy: [],
      },
    ],
    milestones: [
      { title: "Wallet", due: "2027-03-31", match: { epics: ["demo"], areas: [] } },
    ],
    projectItems: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /no issue Type/);
  assert.match(result.errors.join("\n"), /no Milestone/);
  assert.match(result.errors.join("\n"), /no Priority/);
  assert.match(result.errors.join("\n"), /no Plan start/);
  assert.match(result.errors.join("\n"), /no Plan end/);
});

test("board gate requires actual dates on closed issues", () => {
  const result = checkBoardFields({
    issues: [
      {
        number: 3,
        state: "CLOSED",
        title: "ROT-3 — C",
        labels: ["change:demo"],
        issueType: "Task",
        milestone: "Wallet",
        body: "",
        blockedBy: [],
      },
    ],
    milestones: [
      { title: "Wallet", due: "2027-03-31", match: { epics: ["demo"], areas: [] } },
    ],
    projectItems: {
      3: { priority: "P1", targetDate: "2027-03-31", startDate: "2026-01-01" },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /no Actual start/);
  assert.match(result.errors.join("\n"), /no Actual end/);
});

test("board gate honors a reasoned allowlist entry", () => {
  const result = checkBoardFields({
    issues: [
      {
        number: 271,
        state: "CLOSED",
        title: "historical",
        labels: ["change:demo"],
        issueType: null,
        milestone: null,
        body: "",
        blockedBy: [],
      },
    ],
    allowlist: [{ number: 271, reason: "predates the sync" }],
    milestones: [
      { title: "Wallet", due: "2027-03-31", match: { epics: ["demo"], areas: [] } },
    ],
    projectItems: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 1);
});

test("labels that duplicate the native Type fail the board gate", () => {
  assert.deepEqual(findDuplicateTypeLabels(["bug", "type:bug", "epic"]), [
    "bug",
    "type:bug",
  ]);
  const result = checkBoardFields({
    issues: [
      {
        number: 1,
        state: "OPEN",
        title: "[demo] Demo",
        labels: ["epic"],
        issueType: "Feature",
        milestone: "Wallet",
        body: "",
        blockedBy: [],
      },
    ],
    milestones: [
      { title: "Wallet", due: "2027-03-31", match: { epics: ["demo"], areas: [] } },
    ],
    projectItems: {
      1: { priority: "P1", targetDate: "2027-03-31", startDate: "2026-01-01" },
    },
    labels: ["bug", "epic", "area:site"],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /labels duplicate the native issue Type/);
});
