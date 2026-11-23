// Task-tracking conventions: key parsing, blocked-by extraction (including
// multi-blocker and range lines), and idempotent sub-issue creation through a
// fake `gh`. No network; the archive-container case reads the local
// `openspec/changes` tree.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  archiveStalePullRequestItems,
  boardMetadataFor,
  branchMatchesChange,
  closingIssueNumbers,
  declarationLines,
  epicBody,
  evaluateBoardFields,
  evaluateTaskLinks,
  filesBelongToChange,
  findDependencyCycles,
  inferIssueType,
  isDocsOnly,
  isProcessOnly,
  isSyncManagedIssue,
  issueNumberFromKey,
  linkSubIssueToEpic,
  listIssueMetadata,
  milestoneFor,
  parseBlockers,
  parseBlockedByText,
  parseTaskDirective,
  parseTasksMarkdown,
  priorityFor,
  resolveBlockedBy,
  severityFor,
  slugify,
  subIssueBody,
  syncChangeTasks,
  targetDelta,
  taskKey,
} from "./lib/task-tracking.mjs";
import { readChanges } from "./sync-board.mjs";

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotor-task-tracking-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function fakeGh({ start = 100 } = {}) {
  let next = start;
  const issues = new Map();
  const calls = [];

  function gh(args) {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "create") {
      while (issues.has(next)) next += 1;
      const number = next;
      next += 1;
      const labels = [];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--label") labels.push(args[index + 1]);
      }
      const issue = {
        number,
        id: `I_${number}`,
        title: argValue(args, "--title"),
        body: fs.readFileSync(argValue(args, "--body-file"), "utf8"),
        url: `https://github.com/o/r/issues/${number}`,
        state: "OPEN",
        labels,
      };
      issues.set(number, issue);
      return issue.url;
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const number = Number(args[2]);
      const issue = issues.get(number);
      if (!issue) throw new Error(`fake gh: unknown issue ${number}`);
      issue.title = argValue(args, "--title");
      issue.body = fs.readFileSync(argValue(args, "--body-file"), "utf8");
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--add-label" && !issue.labels.includes(args[index + 1])) {
          issue.labels.push(args[index + 1]);
        }
      }
      return issue.url;
    }
    throw new Error(`fake gh: unexpected call ${args.join(" ")}`);
  }

  return { gh, issues, calls };
}

test("ROT keys are derived from the issue number", () => {
  assert.equal(taskKey(12), "ROT-12");
  assert.equal(issueNumberFromKey("ROT-12"), 12);
  assert.equal(issueNumberFromKey(" ROT-12 "), 12);
  assert.equal(issueNumberFromKey("ROT-0"), null);
  assert.equal(issueNumberFromKey("ROT-012"), null);
  assert.equal(issueNumberFromKey("rot-12"), null);
  assert.throws(() => taskKey(0));
});

test("Task directives: key, none with reason, missing and invalid", () => {
  assert.deepEqual(parseTaskDirective("body\nTask: ROT-7\n").kind, "key");
  assert.equal(parseTaskDirective("Task: ROT-7").number, 7);

  const none = parseTaskDirective("Task: none — docs: fix a typo");
  assert.equal(none.kind, "none");
  assert.equal(none.reason, "docs: fix a typo");

  assert.equal(parseTaskDirective("no directive").kind, "missing");
  assert.equal(parseTaskDirective("Task: ROT-abc").kind, "invalid");
});

test("Closing references accept GitHub keywords and repo-qualified numbers", () => {
  assert.deepEqual(closingIssueNumbers("Closes #12"), [12]);
  assert.deepEqual(closingIssueNumbers("fixes #3 and resolves other/repo#4"), [3, 4]);
  assert.deepEqual(closingIssueNumbers("Closed by #9"), []);
  assert.deepEqual(closingIssueNumbers("Closes #12, closes #12"), [12]);
});

test("parseTasksMarkdown extracts sections, titles, slugs and multi-blockers", () => {
  const markdown = [
    "# Tasks",
    "",
    "## 1. First task (blocked by: —) [back]",
    "",
    "- [x] done",
    "- [ ] todo",
    "      continuation text",
    "",
    "## 2. Second task (blocked by: 1, 3)",
    "",
    "- [ ] only",
    "",
    "## 3. Third task (blocked by: 1-2; follows other-change)",
    "",
    "- [x] one",
    "- [x] two",
    "",
    "## 4a. Suffixed section (blocked by: 4a)",
    "",
    "- [ ] self typo",
    "",
    "## Out of scope",
    "",
    "No checkboxes here.",
  ].join("\n");

  const { sections } = parseTasksMarkdown(markdown);
  assert.equal(sections.length, 5);

  const first = sections[0];
  assert.equal(first.number, "1");
  assert.equal(first.title, "First task");
  assert.equal(first.slug, "first-task");
  assert.equal(first.total, 2);
  assert.equal(first.done, 1);
  assert.equal(first.hasUnchecked, true);

  const second = sections[1];
  assert.equal(second.title, "Second task");
  assert.deepEqual(second.blockers.sectionNumbers, ["1", "3"]);

  const third = sections[2];
  assert.deepEqual(third.blockers.sectionNumbers, ["1", "2"]);
  assert.deepEqual(third.blockers.notes, ["follows other-change"]);
  assert.equal(third.done, 2);
  assert.equal(third.hasUnchecked, false);

  const suffixed = sections[3];
  assert.equal(suffixed.number, "4a");
  assert.deepEqual(suffixed.blockers.sectionNumbers, ["4a"]);

  const excluded = sections[4];
  assert.equal(excluded.excluded, true);
  assert.equal(excluded.total, 0);
});

test("parseTasksMarkdown handles an implicit section before any h2", () => {
  const { sections } = parseTasksMarkdown("- [ ] lone task\n");
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, "Tasks");
  assert.equal(sections[0].total, 1);
});

test("parseBlockers expands ranges, keeps keys, notes and unresolved names", () => {
  assert.deepEqual(parseBlockers("1-3").sectionNumbers, ["1", "2", "3"]);
  assert.deepEqual(parseBlockers("T1-T2").sectionNumbers, ["1", "2"]);
  assert.deepEqual(parseBlockers("ROT-9").keys, ["ROT-9"]);
  assert.deepEqual(parseBlockers("#12").keys, ["ROT-12"]);
  assert.deepEqual(parseBlockers("ROT-9, #12").keys, ["ROT-9", "ROT-12"]);
  assert.deepEqual(parseBlockers("—").sectionNumbers, []);
  assert.deepEqual(parseBlockers("demand gate").unresolved, ["demand gate"]);
  assert.deepEqual(parseBlockers("developer + designer").notes, [
    "developer + designer",
  ]);
  assert.deepEqual(parseBlockers("1; follows other-change"), {
    sectionNumbers: ["1"],
    keys: [],
    unresolved: [],
    notes: ["follows other-change"],
  });
});

test("resolveBlockedBy maps sections to keys, drops self-loops and reports leftovers", () => {
  const blockers = parseBlockers("1, 2a, 4a, ROT-90, demand gate");
  const keyByNumber = new Map([
    ["1", "ROT-10"],
    ["2", "ROT-20"],
    ["4a", "ROT-40"],
  ]);
  const resolved = resolveBlockedBy(blockers, keyByNumber, "4a");
  assert.deepEqual(resolved.keys, ["ROT-10", "ROT-20", "ROT-90"]);
  assert.deepEqual(resolved.unresolved, ["4a (self)", "demand gate"]);

  const self = resolveBlockedBy(parseBlockers("4a"), keyByNumber, "4a");
  assert.deepEqual(self.keys, []);
  assert.deepEqual(self.unresolved, ["4a (self)"]);
});

test("docs/process-only classification", () => {
  assert.equal(isDocsOnly(["docs/process/x.md"]), true);
  assert.equal(isDocsOnly(["openspec/changes/a/tasks.md"]), true);
  assert.equal(isDocsOnly(["README.md", "docs/process/x.md"]), true);
  assert.equal(isDocsOnly(["apps/site/README.md"]), false);
  assert.equal(isDocsOnly(["docs/process/x.md", "apps/site/x.js"]), false);
  assert.equal(isDocsOnly([]), false);
  assert.equal(isProcessOnly(["scripts/sync-board.mjs"]), true);
  assert.equal(isProcessOnly(["docs/x.md", ".github/workflows/task-links.yml"]), true);
  assert.equal(isProcessOnly(["README.md", "scripts/sync-board.mjs"]), true);
  assert.equal(isProcessOnly(["apps/site/README.md"]), false);
  assert.equal(isProcessOnly(["src/coordinator/mod.rs"]), false);
});

test("branch matching does not confuse a change id with a longer registered id", () => {
  const ids = ["wallet-mainnet-signing", "wallet-mainnet-signing-erc20"];
  assert.equal(
    branchMatchesChange("fix/wallet-mainnet-signing", "wallet-mainnet-signing", ids),
    "match",
  );
  assert.equal(
    branchMatchesChange(
      "fix/wallet-mainnet-signing-approvals",
      "wallet-mainnet-signing",
      ids,
    ),
    "ambiguous",
  );
  assert.equal(
    branchMatchesChange(
      "fix/wallet-mainnet-signing-erc20-approvals",
      "wallet-mainnet-signing",
      ids,
    ),
    "ambiguous",
  );
  assert.equal(
    branchMatchesChange(
      "fix/wallet-mainnet-signing-erc20-approvals",
      "wallet-mainnet-signing-erc20",
      ids,
    ),
    "match",
  );
  assert.equal(
    branchMatchesChange(
      "feat/other-change",
      "wallet-mainnet-signing",
      ids,
    ),
    "no",
  );
  assert.equal(
    filesBelongToChange(
      ["openspec/changes/wallet-mainnet-signing/tasks.md"],
      "wallet-mainnet-signing",
    ),
    true,
  );
  assert.equal(
    filesBelongToChange(
      ["openspec/changes/wallet-mainnet-signing-erc20/tasks.md"],
      "wallet-mainnet-signing",
    ),
    false,
  );
});

test("evaluateTaskLinks passes and fails the CI cases", () => {
  const product = ["apps/site/site.js"];

  const ok = evaluateTaskLinks({
    body: "Task: ROT-12\n\nCloses #12\n",
    files: product,
    issueExists: true,
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.ok, true);

  const missing = evaluateTaskLinks({ body: "No directive", files: product });
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /Task:/);

  const noClose = evaluateTaskLinks({
    body: "Task: ROT-12\n",
    files: product,
    issueExists: true,
  });
  assert.equal(noClose.ok, false);
  assert.match(noClose.errors.join("\n"), /Closes #12/);

  const wrongClose = evaluateTaskLinks({
    body: "Task: ROT-12\nCloses #99\n",
    files: product,
    issueExists: true,
  });
  assert.equal(wrongClose.ok, false);

  const noIssue = evaluateTaskLinks({
    body: "Task: ROT-12\nCloses #12\n",
    files: product,
    issueExists: false,
  });
  assert.equal(noIssue.ok, false);
  assert.match(noIssue.errors.join("\n"), /does not exist/);

  const docsNone = evaluateTaskLinks({
    body: "Task: none — docs: fix a typo\n",
    files: ["docs/process/task-tracking.md"],
  });
  assert.equal(docsNone.ok, true);

  const noReason = evaluateTaskLinks({
    body: "Task: none\n",
    files: ["docs/process/task-tracking.md"],
  });
  assert.equal(noReason.ok, false);
  assert.match(noReason.errors.join("\n"), /needs a reason/);

  const productNone = evaluateTaskLinks({
    body: "Task: none — skipping\n",
    files: product,
  });
  assert.equal(productNone.ok, false);
  assert.match(productNone.errors.join("\n"), /only allowed/);

  const processNone = evaluateTaskLinks({
    body: "Task: none — bootstrap: mechanics have no issue yet\n",
    files: ["scripts/sync-board.mjs", ".github/workflows/task-links.yml", "AGENTS.md"],
  });
  assert.equal(processNone.ok, true);

  const productMarkdown = evaluateTaskLinks({
    body: "Task: none — docs: a readme\n",
    files: ["apps/site/README.md"],
  });
  assert.equal(productMarkdown.ok, false);
  assert.match(productMarkdown.errors.join("\n"), /only allowed/);

  const invalid = evaluateTaskLinks({
    body: "Task: ROT-zero\nCloses #1\n",
    files: product,
  });
  assert.equal(invalid.ok, false);
});

test("epicBody shows sub-issue progress and unresolved blockers", () => {
  const body = epicBody({
    change: {
      id: "demo",
      folder: "openspec/changes/demo",
      defaultArea: false,
    },
    subIssues: [
      { key: "ROT-1", title: "One", state: "CLOSED", unresolved: [] },
      { key: "ROT-2", title: "Two", state: "OPEN", unresolved: ["demand gate"] },
    ],
    planned: 0,
    percent: 50,
    repoUrl: "https://github.com/o/r",
  });
  assert.match(body, /Progress: 1\/2 sub-issues closed \(50%\)/);
  assert.match(body, /- \[x\] ROT-1 — One/);
  assert.match(body, /- \[ \] ROT-2 — Two/);
  assert.match(body, /Unresolved blockers: ROT-2: demand gate/);
  assert.match(body, /<!-- openspec-change: demo -->/);
});

test("syncChangeTasks creates once, updates nothing on a second run and writes blockers", () =>
  withTempDir((tempDir) => {
    const { sections } = parseTasksMarkdown(
      [
        "# Tasks",
        "## 1. First (blocked by: —)",
        "- [ ] a",
        "## 2. Second (blocked by: 1, 3)",
        "- [ ] b",
        "## 3. Third (blocked by: 1)",
        "- [ ] c",
        "## 4. Already done",
        "- [x] shipped",
      ].join("\n"),
    );

    const fake = fakeGh({ start: 100 });
    const labels = [];
    const options = {
      changeId: "demo",
      epicNumber: 42,
      tasks: sections,
      gh: fake.gh,
      ghJson: () => {
        throw new Error("syncChangeTasks must not need GraphQL");
      },
      repo: "o/r",
      dryRun: false,
      tempDir,
      log: () => {},
      areaForTask: () => "site",
      ensureLabel: (name) => labels.push(name),
    };

    const first = syncChangeTasks({ ...options, existingIssues: [] });
    assert.equal(first.created, 3, "only sections with unchecked boxes are created");
    assert.equal(first.planned, 0);
    assert.equal(fake.issues.size, 3);
    assert.deepEqual([...new Set(labels)].sort(), ["area:site", "change:demo"]);

    const second = fake.issues.get(101);
    assert.equal(second.title, "ROT-101 — Second");
    assert.match(
      second.body,
      /Blocked by: ROT-100 \(#100\), ROT-102 \(#102\)/,
    );
    assert.match(second.body, /<!-- openspec-task: demo\/second -->/);
    assert.equal(second.labels.includes("change:demo"), true);
    assert.equal(second.labels.includes("area:site"), true);

    const rerun = syncChangeTasks({
      ...options,
      existingIssues: [...fake.issues.values()],
    });
    assert.equal(rerun.created, 0, "marker lookup makes creation idempotent");
    assert.equal(rerun.updated, 0, "stable body and title need no edit");
    assert.equal(rerun.unchanged, 3);
    assert.equal(fake.issues.size, 3, "no duplicate issues");
  }));

test("syncChangeTasks --dry-run prints the plan and performs no mutation", () =>
  withTempDir((tempDir) => {
    const { sections } = parseTasksMarkdown(
      [
        "# Tasks",
        "## 1. First (blocked by: —)",
        "- [ ] a",
        "## 2. Second (blocked by: 1)",
        "- [ ] b",
      ].join("\n"),
    );

    const lines = [];
    const planned = [];
    const result = syncChangeTasks({
      changeId: "demo",
      epicNumber: null,
      tasks: sections,
      existingIssues: [],
      gh: () => {
        throw new Error("dry run must not call gh");
      },
      ghJson: () => {
        throw new Error("dry run must not call GraphQL");
      },
      repo: "o/r",
      dryRun: true,
      tempDir,
      log: (line) => lines.push(line),
      areaForTask: () => "site",
      ensureLabel: () => {
        throw new Error("dry run must not create labels");
      },
      onPlanned: (entry) => planned.push(entry),
    });

    assert.equal(result.created, 2);
    assert.equal(result.planned, 2);
    assert.deepEqual(planned.map((entry) => entry.slug), ["first", "second"]);
    const text = lines.join("\n");
    assert.match(text, /\[dry-run\] create sub-issue demo\/first/);
    assert.match(text, /\[dry-run\] blockers demo\/second: §2 <- §1/);
  }));

test("syncChangeTasks --dry-run prints an unresolved blocker once", () =>
  withTempDir((tempDir) => {
    const { sections } = parseTasksMarkdown(
      [
        "# Tasks",
        "## 1. First (blocked by: 2, demand gate)",
        "- [ ] a",
      ].join("\n"),
    );

    const lines = [];
    syncChangeTasks({
      changeId: "demo",
      epicNumber: null,
      tasks: sections,
      existingIssues: [],
      gh: () => {
        throw new Error("dry run must not call gh");
      },
      repo: "o/r",
      dryRun: true,
      tempDir,
      log: (line) => lines.push(line),
      areaForTask: () => "site",
    });

    const line = lines.find((value) => value.includes("blockers demo/first"));
    assert.equal(line, "[dry-run] blockers demo/first: §1 <- §2, unresolved: demand gate");
  }));

test("syncChangeTasks keeps an existing sub-issue when its section is fully checked", () =>
  withTempDir((tempDir) => {
    const { sections } = parseTasksMarkdown(
      ["# Tasks", "## 1. Done later", "- [x] a", "## 2. New", "- [ ] b"].join("\n"),
    );
    const fake = fakeGh({ start: 7 });
    const existing = {
      number: 7,
      id: "I_7",
      title: "ROT-7 — Done later",
      body: "<!-- openspec-task: demo/done-later -->\n",
      url: "https://github.com/o/r/issues/7",
      state: "OPEN",
      labels: ["change:demo"],
    };
    fake.issues.set(7, existing);

    const result = syncChangeTasks({
      changeId: "demo",
      epicNumber: 1,
      tasks: sections,
      existingIssues: [existing],
      gh: fake.gh,
      ghJson: null,
      repo: "o/r",
      dryRun: false,
      tempDir,
      log: () => {},
      areaForTask: () => "site",
      ensureLabel: () => {},
    });

    assert.equal(result.created, 1, "only the new section creates an issue");
    assert.equal(fake.issues.size, 2);
    assert.equal(result.subIssues.find((issue) => issue.number === 7).state, "OPEN");
    assert.match(fake.issues.get(7).body, /Checkboxes: 1\/1 done/);
  }));

test("slugify is stable and bounded", () => {
  assert.equal(slugify("Phase 0 — trust, measurement and demand capture"), "phase-0-trust-measurement-and-demand-capture");
  assert.equal(slugify("!!!"), "task");
  assert.ok(slugify("x".repeat(120)).length <= 60);
});

test("linkSubIssueToEpic skips an existing link and links once over GraphQL", () => {
  const calls = [];
  const alreadyLinked = (args) => {
    calls.push(args);
    return {
      data: {
        repository: {
          issue: { id: "I_SUB", parent: { number: 42 } },
        },
      },
    };
  };
  assert.equal(
    linkSubIssueToEpic({
      ghJson: alreadyLinked,
      repo: "o/r",
      epicNumber: 42,
      epicId: "I_EPIC",
      subIssueNumber: 7,
    }),
    false,
  );
  assert.equal(calls.length, 1, "a parent query is enough when the link exists");

  const linked = [];
  const result = linkSubIssueToEpic({
    ghJson: (args) => {
      linked.push(args);
      if (args.join(" ").includes("addSubIssue")) {
        return { data: { addSubIssue: { subIssue: { number: 7 } } } };
      }
      return {
        data: {
          repository: { issue: { id: "I_SUB", parent: null } },
        },
      };
    },
    repo: "o/r",
    epicNumber: 42,
    epicId: "I_EPIC",
    subIssueNumber: 7,
  });
  assert.equal(result, true);
  assert.equal(linked.length, 2);
  assert.match(linked[1].join(" "), /addSubIssue/);

  assert.throws(
    () =>
      linkSubIssueToEpic({
        ghJson: () => ({ errors: [{ message: "sub-issues are not available" }] }),
        repo: "o/r",
        epicNumber: 42,
        epicId: "I_EPIC",
        subIssueNumber: 7,
      }),
    /sub-issues are not available/,
  );

  const lines = [];
  assert.equal(
    linkSubIssueToEpic({
      ghJson: () => {
        throw new Error("dry run must not call GraphQL");
      },
      repo: "o/r",
      epicNumber: 42,
      subIssueNumber: 7,
      dryRun: true,
      log: (line) => lines.push(line),
    }),
    false,
  );
  assert.match(lines[0], /\[dry-run\] link sub-issue #7 under epic #42/);
});

function repoFile(relative) {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

function sectionEdges(relative) {
  const { sections } = parseTasksMarkdown(fs.readFileSync(repoFile(relative), "utf8"));
  const map = new Map();
  for (const section of sections) {
    if (section.number) map.set(section.number, section.blockers.sectionNumbers);
  }
  return map;
}

test("real key-leak-monitor blockers match its blocked-by lines", () => {
  const edges = sectionEdges("openspec/changes/key-leak-monitor/tasks.md");
  assert.deepEqual(edges.get("2"), ["1"]);
  assert.deepEqual(edges.get("3"), ["1"]);
  assert.deepEqual(edges.get("4"), ["2"]);
  assert.deepEqual(edges.get("5"), ["4"]);
  assert.deepEqual(edges.get("6"), ["3", "5"]);
  assert.deepEqual(edges.get("7"), ["3"]);
  assert.deepEqual(edges.get("8"), ["6", "7"]);
  assert.deepEqual(edges.get("9"), ["1", "2", "3", "4", "5", "6", "7", "8"]);
});

test("real tx-sign-broadcast blockers match its blocked-by lines", () => {
  const edges = sectionEdges("openspec/changes/tx-sign-broadcast/tasks.md");
  assert.deepEqual(edges.get("1"), ["0"]);
  assert.deepEqual(edges.get("2"), ["0"]);
  assert.deepEqual(edges.get("3"), ["0"]);
  assert.deepEqual(edges.get("4"), ["3"]);
  assert.deepEqual(edges.get("5"), ["1", "4"]);
  assert.deepEqual(edges.get("6"), ["1", "5"]);
  assert.deepEqual(edges.get("7"), ["1", "4"]);
  assert.deepEqual(edges.get("8"), ["5"]);
  assert.deepEqual(edges.get("9"), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.deepEqual(edges.get("10"), ["9"]);
});

test("dry-run resolves real section blockers to ROT keys when the issues exist", () =>
  withTempDir((tempDir) => {
    const { sections } = parseTasksMarkdown(
      fs.readFileSync(repoFile("openspec/changes/key-leak-monitor/tasks.md"), "utf8"),
    );
    const numbered = sections.filter((section) => section.number);
    const existing = numbered.map((section, index) => ({
      number: 300 + index,
      id: `I_${300 + index}`,
      title: section.title,
      body: `<!-- openspec-task: key-leak-monitor/${section.slug} -->\n`,
      url: `https://github.com/o/r/issues/${300 + index}`,
      state: "OPEN",
      labels: ["change:key-leak-monitor"],
    }));

    const lines = [];
    syncChangeTasks({
      changeId: "key-leak-monitor",
      epicNumber: 88,
      tasks: sections,
      existingIssues: existing,
      gh: () => {
        throw new Error("dry run must not call gh");
      },
      repo: "o/r",
      dryRun: true,
      tempDir,
      log: (line) => lines.push(line),
      areaForTask: () => "site",
    });

    const text = lines.join("\n");
    assert.match(
      text,
      /\[dry-run\] blockers key-leak-monitor\/providers-and-watcher: §2 <- ROT-300 \(#300\)/,
    );
    assert.match(
      text,
      /\[dry-run\] blockers key-leak-monitor\/cabinet-ui: §6 <- ROT-302 \(#302\), ROT-304 \(#304\)/,
    );
    assert.match(
      text,
      /\[dry-run\] blockers key-leak-monitor\/acceptance-and-rollout: §9 <- ROT-300 \(#300\), ROT-301 \(#301\), ROT-302 \(#302\), ROT-303 \(#303\), ROT-304 \(#304\), ROT-305 \(#305\), ROT-306 \(#306\), ROT-307 \(#307\)/,
    );
  }));

test("archiveStalePullRequestItems archives non-open PR items and leaves issues alone", () => {
  const items = [
    { id: "item-1", content: { url: "https://github.com/o/r/pull/1" } },
    { id: "item-2", content: { url: "https://github.com/o/r/pull/2" } },
    { id: "item-3", content: { url: "https://github.com/o/r/pull/3" } },
    { id: "item-4", content: { url: "https://github.com/o/r/issues/4" } },
  ];
  const calls = [];
  const ghJson = (args) => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("archiveProjectV2Item")) {
      return { data: { archiveProjectV2Item: { item: { id: "ok" } } } };
    }
    if (args[0] === "pr" && args[1] === "view") {
      const number = Number(args[2]);
      if (number === 1) return { state: "MERGED" };
      if (number === 3) return { state: "CLOSED" };
      return { state: "OPEN" };
    }
    throw new Error(`unexpected call ${joined}`);
  };

  const result = archiveStalePullRequestItems({
    items,
    openPullRequestNumbers: new Set([2]),
    projectId: "P_1",
    ghJson,
    repo: "o/r",
  });
  assert.equal(result.archived, 2);

  const mutations = calls.filter((args) => args.join(" ").includes("archiveProjectV2Item"));
  assert.equal(mutations.length, 2);
  assert.match(mutations[0].join(" "), /itemId=item-1/);
  assert.match(mutations[1].join(" "), /itemId=item-3/);
  assert.equal(
    calls.some((args) => args.join(" ").includes("itemId=item-4")),
    false,
    "issue items are never archived",
  );
});

test("archiveStalePullRequestItems --dry-run prints the plan without a mutation", () => {
  const lines = [];
  const result = archiveStalePullRequestItems({
    items: [{ id: "item-1", content: { url: "https://github.com/o/r/pull/1" } }],
    openPullRequestNumbers: new Set(),
    projectId: "P_1",
    ghJson: (args) => {
      const joined = args.join(" ");
      if (args[0] === "pr" && args[1] === "view") return { state: "MERGED" };
      throw new Error(`dry run must not call ${joined}`);
    },
    repo: "o/r",
    dryRun: true,
    log: (line) => lines.push(line),
  });
  assert.equal(result.archived, 1);
  assert.match(lines[0], /\[dry-run\] archive project item for PR #1 \(MERGED\)/);
});

test("issue type inference: Bug wins, then epic Feature, then sub-issue Task", () => {
  assert.equal(
    inferIssueType({ title: "[frontend-platform] Frontend platform", labels: ["epic"] }),
    "Feature",
  );
  assert.equal(
    inferIssueType({
      title: "ROT-299 — Seed and puzzle",
      labels: ["change:frontend-platform"],
    }),
    "Task",
  );
  assert.equal(
    inferIssueType({ title: "ROT-3 — x", body: "<!-- openspec-task: c/x -->" }),
    "Task",
  );
  assert.equal(
    inferIssueType({ title: "fix(wallet): history", labels: ["change:wallet-history"] }),
    "Bug",
  );
  assert.equal(
    inferIssueType({ title: "ROT-4 — memory defect scanner", labels: ["change:x"] }),
    "Bug",
  );
  assert.equal(
    inferIssueType({
      title: "ROT-5 — report",
      body: "Tracked in docs/process/defects.json",
      labels: ["change:x"],
    }),
    "Bug",
  );
  assert.equal(inferIssueType({ title: "plain issue", labels: [] }), null);
});

test("milestone matching uses the epic first, then the area", () => {
  const milestones = [
    {
      title: "Wallet: signing, history and portfolio",
      match: { areas: [], epics: ["cabinet-wallet"] },
    },
    {
      title: "Desktop and coordinator parity",
      match: { areas: ["desktop", "coordinator"], epics: ["rust-desktop-all-chains"] },
    },
    {
      title: "Astro frontend cutover",
      match: { areas: ["site"], epics: ["frontend-platform"] },
    },
    {
      title: "Design system and process foundations",
      match: { areas: ["design", "docs", "infra"], epics: ["ssot"] },
    },
  ];

  assert.equal(
    milestoneFor({ changeId: "cabinet-wallet", area: "site", milestones }).title,
    "Wallet: signing, history and portfolio",
    "epic mapping beats the area",
  );
  assert.equal(
    milestoneFor({ changeId: "frontend-platform", area: "site", milestones }).title,
    "Astro frontend cutover",
  );
  assert.equal(
    milestoneFor({ changeId: "brand-new", area: "desktop", milestones }).title,
    "Desktop and coordinator parity",
    "an unmapped epic falls back to its area",
  );
  assert.equal(
    milestoneFor({ changeId: "brand-new", area: "site", milestones }).title,
    "Astro frontend cutover",
  );
  assert.equal(milestoneFor({ changeId: "brand-new", area: "unknown", milestones }), null);
});

test("priority and severity defaults, inheritance and explicit declarations", () => {
  assert.equal(priorityFor({ issue: { title: "epic" }, isEpic: true }), "P1");
  assert.equal(
    priorityFor({ issue: { title: "epic", body: "Priority: P0" }, isEpic: true }),
    "P0",
  );
  assert.equal(
    priorityFor({ issue: { title: "sub" }, isEpic: false, epicPriority: "P2" }),
    "P2",
  );
  assert.equal(
    priorityFor({
      issue: { title: "sub", body: "Priority: P3" },
      isEpic: false,
      epicPriority: "P2",
    }),
    "P3",
    "a sub-issue declaration beats inheritance",
  );

  assert.equal(severityFor({ issue: { title: "epic" }, issueType: "Feature" }), "S-");
  assert.equal(
    severityFor({ issue: { title: "fix(x)" }, issueType: "Bug" }),
    "S2",
    "a defect defaults to S2",
  );
  assert.equal(
    severityFor({
      issue: { title: "fix(x)", body: "Severity: S1" },
      issueType: "Bug",
    }),
    "S1",
    "an explicit severity beats the defect default",
  );
});

test("declaration lines survive a generated body", () => {
  const body = "Priority: P0\nSeverity: S1\nNoise";
  assert.deepEqual(declarationLines(body), ["Priority: P0", "Severity: S1"]);

  const sub = subIssueBody({
    changeId: "demo",
    epicNumber: 1,
    task: { title: "A", number: "1", done: 0, total: 1 },
    declarations: declarationLines(body),
  });
  assert.match(sub, /Priority: P0/);
  assert.match(sub, /Severity: S1/);

  const epic = epicBody({
    change: { id: "demo", folder: "openspec/changes/demo", defaultArea: false },
    subIssues: [],
    percent: 0,
    repoUrl: "https://github.com/o/r",
    declarations: ["Priority: P2"],
  });
  assert.match(epic, /Priority: P2/);
});

test("board metadata warns when no type or milestone rule matches", () => {
  const result = boardMetadataFor({
    issue: { number: 9, title: "loose issue", labels: [] },
    changeId: null,
    area: null,
    milestones: [],
  });
  assert.equal(result.type, null);
  assert.equal(result.milestone, null);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /#9 "loose issue": no issue-type rule/);
  assert.match(result.warnings[1], /#9 "loose issue": no milestone rule/);
});

test("sync-managed detection adopts ROT titles and area-labelled issues", () => {
  assert.equal(isSyncManagedIssue({ title: "[demo] Epic", labels: ["epic"] }), true);
  assert.equal(
    isSyncManagedIssue({ title: "ROT-421 — Page", labels: ["area:site"] }),
    true,
  );
  assert.equal(isSyncManagedIssue({ title: "ROT-421 — Page", labels: [] }), true);
  assert.equal(isSyncManagedIssue({ title: "manual", labels: ["area:site"] }), true);
  assert.equal(isSyncManagedIssue({ title: "manual", labels: [] }), false);
});

test("parseBlockedByText reads the human line only", () => {
  assert.deepEqual(parseBlockedByText("Blocked by: ROT-7 (#7), ROT-8 (#8)\n"), [7, 8]);
  assert.deepEqual(parseBlockedByText("Blocked by (unresolved): demand gate"), []);
  assert.deepEqual(parseBlockedByText("Blocked by: ROT-7 (#7), ROT-7 (#7)"), [7]);
  assert.deepEqual(parseBlockedByText("no blockers"), []);
});

test("findDependencyCycles reports each cycle once", () => {
  assert.deepEqual(findDependencyCycles([{ from: 1, to: 2 }, { from: 2, to: 1 }]), [
    [1, 2, 1],
  ]);
  assert.deepEqual(findDependencyCycles([{ from: 1, to: 2 }, { from: 2, to: 3 }]), []);
  const cycles = findDependencyCycles([
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 3, to: 1 },
    { from: 4, to: 4 },
  ]);
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles[1], [4, 4]);
});

test("targetDelta reports on-time, late and invalid dates", () => {
  assert.deepEqual(targetDelta("2026-12-31", "2026-12-20"), {
    days: -11,
    verdict: "on time",
  });
  assert.deepEqual(targetDelta("2027-03-31", "2027-03-31T10:00:00Z"), {
    days: 0,
    verdict: "on time",
  });
  assert.deepEqual(targetDelta("2027-03-31", "2027-04-01"), {
    days: 1,
    verdict: "late by 1 day",
  });
  assert.deepEqual(targetDelta("2027-03-31", "2027-04-02"), {
    days: 2,
    verdict: "late by 2 days",
  });
  assert.equal(targetDelta("not-a-date", "2027-04-02"), null);
});

test("board gate checks type, milestone, priority, dates, blockers and release grouping", () => {
  const milestones = [
    { title: "Wallet", due: "2027-03-31", match: { epics: ["wallet"], areas: [] } },
    {
      title: "Astro",
      due: "2026-12-31",
      match: { epics: ["frontend"], areas: ["site"] },
    },
  ];
  const fields = (priority) => ({
    priority,
    targetDate: "2027-03-31",
    startDate: "2026-01-01",
    actualStart: "2026-01-01",
    actualEnd: "2027-03-20",
  });
  const projectItems = {
    1: fields("P1"),
    2: fields("P2"),
    3: fields("P2"),
    4: fields("P1"),
  };
  const base = [
    {
      number: 1,
      state: "OPEN",
      title: "[wallet] Wallet",
      labels: ["epic"],
      issueType: "Feature",
      milestone: "Wallet",
      body: "",
      blockedBy: [],
    },
    {
      number: 2,
      state: "OPEN",
      title: "ROT-2 — A",
      labels: ["change:wallet"],
      issueType: "Task",
      milestone: "Wallet",
      body: "",
      blockedBy: [],
    },
    {
      number: 3,
      state: "OPEN",
      title: "ROT-3 — B",
      labels: ["change:wallet"],
      issueType: "Task",
      milestone: "Wallet",
      body: "",
      blockedBy: [],
    },
    {
      number: 4,
      state: "OPEN",
      title: "manual",
      labels: [],
      issueType: null,
      milestone: null,
      body: "",
      blockedBy: [],
    },
  ];

  const ok = evaluateBoardFields({ issues: base, milestones, projectItems });
  assert.equal(ok.ok, true, ok.errors.join("\n"));
  assert.equal(ok.checked, 3, "a manual issue is not gated");

  const missing = evaluateBoardFields({
    issues: [{ ...base[1], issueType: null, milestone: null }],
    milestones,
    projectItems: {},
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join("\n"), /no issue Type/);
  assert.match(missing.errors.join("\n"), /no Milestone/);
  assert.match(missing.errors.join("\n"), /no Priority/);
  assert.match(missing.errors.join("\n"), /no Plan start/);
  assert.match(missing.errors.join("\n"), /no Plan end/);

  const closedMissingActuals = evaluateBoardFields({
    issues: [{ ...base[1], state: "CLOSED" }],
    milestones,
    projectItems: {
      2: { priority: "P1", targetDate: "2027-03-31", startDate: "2026-01-01" },
    },
  });
  assert.equal(closedMissingActuals.ok, false);
  assert.match(closedMissingActuals.errors.join("\n"), /no Actual start/);
  assert.match(closedMissingActuals.errors.join("\n"), /no Actual end/);

  const missingDue = evaluateBoardFields({
    issues: [base[1]],
    milestones: [{ title: "Wallet", match: { epics: ["wallet"], areas: [] } }],
    projectItems,
  });
  assert.equal(missingDue.ok, false);
  assert.match(missingDue.errors.join("\n"), /milestone "Wallet" has no due date/);

  const allowed = evaluateBoardFields({
    issues: [
      {
        ...base[1],
        state: "CLOSED",
        issueType: null,
        milestone: null,
      },
    ],
    allowlist: [{ number: 2, reason: "historical" }],
    milestones,
    projectItems: {},
  });
  assert.equal(allowed.ok, true, "an allowlisted historical issue is skipped");
  assert.equal(allowed.skipped, 1);

  const openAllowed = evaluateBoardFields({
    issues: [base[1]],
    allowlist: [{ number: 2, reason: "historical" }],
    milestones,
    projectItems,
  });
  assert.equal(openAllowed.ok, false);
  assert.match(openAllowed.errors.join("\n"), /only historical closed issues/);

  const badReason = evaluateBoardFields({
    issues: [base[0]],
    allowlist: [{ number: 1 }],
    milestones,
    projectItems,
  });
  assert.equal(badReason.ok, false);
  assert.match(badReason.errors.join("\n"), /needs a reason/);

  const allowedGroup = evaluateBoardFields({
    issues: [
      { ...base[1], state: "CLOSED", issueType: null, milestone: null },
      { ...base[2], milestone: "Wallet" },
    ],
    allowlist: [{ number: 2, reason: "historical" }],
    milestones,
    projectItems: { 3: fields("P1") },
  });
  assert.equal(
    allowedGroup.ok,
    true,
    "an allowlisted closed issue does not break its change's milestone grouping",
  );

  const mismatch = evaluateBoardFields({
    issues: [
      {
        ...base[1],
        body: "Blocked by: ROT-3 (#3)",
        blockedBy: [],
      },
    ],
    milestones,
    projectItems: { 2: fields("P1") },
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.errors.join("\n"), /disagree with native blockedBy/);

  const closedBlocker = evaluateBoardFields({
    issues: [
      {
        ...base[1],
        body: "Blocked by: ROT-3 (#3)",
        blockedBy: [{ number: 3, state: "CLOSED" }],
      },
    ],
    milestones,
    projectItems: { 2: fields("P1") },
  });
  assert.equal(closedBlocker.ok, false);
  assert.match(closedBlocker.errors.join("\n"), /blocked by closed issue #3/);

  const cycle = evaluateBoardFields({
    issues: [
      {
        ...base[1],
        body: "Blocked by: ROT-3 (#3)",
        blockedBy: [{ number: 3, state: "OPEN" }],
      },
      {
        ...base[2],
        body: "Blocked by: ROT-2 (#2)",
        blockedBy: [{ number: 2, state: "OPEN" }],
      },
    ],
    milestones,
    projectItems: { 2: fields("P1"), 3: fields("P1") },
  });
  assert.equal(cycle.ok, false);
  assert.match(cycle.errors.join("\n"), /dependency cycle/);

  const releaseSpread = evaluateBoardFields({
    issues: [
      { ...base[1], milestone: "Wallet" },
      { ...base[2], milestone: "Astro" },
    ],
    milestones,
    projectItems: { 2: fields("P1"), 3: fields("P1") },
  });
  assert.equal(releaseSpread.ok, false);
  assert.match(releaseSpread.errors.join("\n"), /spans milestones/);
});

test("listIssueMetadata paginates over GraphQL and normalizes blockedBy", () => {
  const pages = [
    {
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: true, endCursor: "C1" },
            nodes: [
              {
                number: 1,
                id: "I_1",
                title: "epic",
                body: "body",
                url: "https://github.com/o/r/issues/1",
                state: "OPEN",
                createdAt: "2026-01-02T03:04:05Z",
                closedAt: null,
                issueType: { name: "Feature" },
                milestone: { title: "Wallet" },
                labels: { nodes: [{ name: "epic" }] },
                blockedBy: { nodes: [{ number: 2, state: "OPEN", title: "b" }] },
              },
            ],
          },
        },
      },
    },
    {
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 2,
                id: "I_2",
                title: "sub",
                body: "",
                url: "https://github.com/o/r/issues/2",
                state: "OPEN",
                issueType: { name: "Task" },
                milestone: null,
                labels: { nodes: [{ name: "change:x" }] },
                blockedBy: { nodes: [] },
              },
            ],
          },
        },
      },
    },
  ];
  const calls = [];
  const issues = listIssueMetadata({
    ghJson: (args) => {
      calls.push(args);
      return pages.shift();
    },
    owner: "o",
    name: "r",
  });
  assert.equal(issues.length, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[1].join(" "), /cursor=C1/);
  assert.equal(issues[0].issueType, "Feature");
  assert.equal(issues[0].milestone, "Wallet");
  assert.equal(issues[0].createdAt, "2026-01-02T03:04:05Z");
  assert.equal(issues[0].closedAt, null);
  assert.deepEqual(issues[0].blockedBy, [
    { number: 2, state: "OPEN", title: "b" },
  ]);
  assert.deepEqual(issues[1].labels, ["change:x"]);
});

test("readChanges never reports the archive container as a change", () => {
  const { allIds, skipped } = readChanges();
  assert.equal(
    allIds.includes("archive"),
    false,
    "openspec/changes/archive is a container, not a change",
  );
  assert.equal(skipped.includes("archive"), false);
});
