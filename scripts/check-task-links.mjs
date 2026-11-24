#!/usr/bin/env node
// Pull-request gate for the task-tracking convention.
//
// Every PR body must carry a `Task: ROT-<n>` line whose issue exists and a
// closing reference to that issue. A docs/process-only PR may use
// `Task: none — <reason>` instead. The convention is documented in
// docs/process/task-tracking.md.
//
// Usage:
//   node scripts/check-task-links.mjs --pr 123 [--repo owner/name]
//   node scripts/check-task-links.mjs --body-file body.md --files docs/a.md,openspec/b.md
//       [--issue-exists yes|no|skip]
//
// The `--body-file` form is for local checks and tests; it never touches the
// network unless `--issue-exists` is omitted and a key is present (then it
// skips the existence check instead of guessing).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  automationPullRequestReason,
  evaluateBoardFields,
  evaluateTaskLinks,
  listIssueMetadata,
  parseTaskDirective,
} from "./lib/task-tracking.mjs";
import {
  ProjectsRateLimitError,
  appendRunSummary,
  isRateLimitError,
  listProjectItems,
  projectApiCalls,
} from "./lib/project-api.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MILESTONES_PATH = path.join(REPO_ROOT, "data", "milestones.json");
const BOARD_EXCEPTIONS_PATH = path.join(REPO_ROOT, "data", "board-exceptions.json");
const PROJECT_OWNER = "mytab0r";
const PROJECT_NUMBER = 3;

// GitHub issue types are native; these labels duplicated them and were
// removed. Keep the list empty or the board gate fails.
export const DUPLICATE_TYPE_LABELS = ["bug", "enhancement", "type:bug", "type:feature"];

export function findDuplicateTypeLabels(names = []) {
  return DUPLICATE_TYPE_LABELS.filter((name) => names.includes(name));
}

function gh(args) {
  try {
    return execFileSync("gh", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = [error.stderr, error.stdout]
      .map((value) => (value ? String(value).trim() : ""))
      .filter(Boolean)
      .join("\n");
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${detail || error.message}`);
  }
}

function ghJson(args) {
  const output = gh(args);
  return output ? JSON.parse(output) : null;
}

export function issueExists(repo, number) {
  try {
    ghJson(["issue", "view", String(number), "--repo", repo, "--json", "number"]);
    return true;
  } catch {
    return false;
  }
}

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function loadBoardExceptions() {
  return loadJson(BOARD_EXCEPTIONS_PATH, { entries: [] })?.entries ?? [];
}

function loadMilestones() {
  const parsed = loadJson(MILESTONES_PATH, []);
  return Array.isArray(parsed) ? parsed : [];
}

function projectFieldValues() {
  const { items } = listProjectItems({
    ghJson,
    owner: PROJECT_OWNER,
    number: PROJECT_NUMBER,
    log: (line) => console.log(line),
  });
  const values = {};
  for (const item of items) {
    const number = Number(item.content?.number);
    if (!Number.isInteger(number)) continue;
    values[number] = {
      priority: item.priority ?? null,
      severity: item.severity ?? null,
      targetDate: item["target date"] ?? null,
      startDate: item["start date"] ?? null,
      actualStart: item["actual start"] ?? null,
      actualEnd: item["actual end"] ?? null,
    };
  }
  return values;
}

// Pure verdict for `--board`: GitHub native Type, Milestone, Priority, the
// text/native blockedBy agreement, closed blockers, cycles and one-milestone-
// per-change. The caller supplies the issue and project-item data.
export function checkBoardFields({
  issues,
  allowlist = [],
  milestones = [],
  projectItems = {},
  labels = [],
}) {
  const result = evaluateBoardFields({ issues, allowlist, milestones, projectItems });
  const duplicates = findDuplicateTypeLabels(labels);
  if (duplicates.length > 0) {
    result.errors.push(
      `labels duplicate the native issue Type and must not exist: ${duplicates.join(", ")}.`,
    );
  }
  const ok = result.errors.length === 0;
  const summary = ok
    ? `board-fields OK: ${result.checked} synced issues have a Type, Milestone, Priority and plan dates; closed issues have actual dates`
    : null;
  return { ...result, ok, summary };
}

// Pure verdict used by the CLI and by tests: the caller supplies the body, the
// changed paths and (when known) whether the keyed issue exists.
export function checkPullRequest({
  number = null,
  body,
  files,
  issueExists: exists = null,
  author = null,
  isBot = false,
  headRefName = null,
}) {
  // Automation PRs (release-please, github-actions, app actors) have no human
  // author to satisfy the task contract. Skip them with a printed notice.
  const automationReason = automationPullRequestReason({ author, isBot, headRefName });
  if (automationReason) {
    return {
      ok: true,
      errors: [],
      skipped: true,
      automationReason,
      number,
      summary: `PR #${number ?? "(local)"} automation PR (${automationReason}); task line not required`,
    };
  }
  const result = evaluateTaskLinks({ body, files, issueExists: exists });
  let summary;
  if (!result.ok) summary = null;
  else if (result.directive.kind === "key") {
    summary = `PR #${number ?? "(local)"} Task: ${result.directive.key}, closes #${result.directive.number}`;
  } else {
    summary = `PR #${number ?? "(local)"} Task: none (${result.directive.reason})`;
  }
  return { ...result, number, summary };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--board") {
      args.board = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${token} needs a value`);
    args[token.slice(2)] = value;
    index += 1;
  }
  return args;
}

function resolveRepo(args) {
  if (args.repo) return args.repo;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/check-task-links.mjs --pr <number> [--repo owner/name]",
    "  node scripts/check-task-links.mjs --body-file <path> --files <a,b> [--issue-exists yes|no|skip] [--author login] [--head-ref branch]",
    "  node scripts/check-task-links.mjs --board [--repo owner/name]",
    "",
    "Fails when the PR body lacks `Task: ROT-<n>`, when the keyed issue does",
    "not exist, or when the closing reference is missing. Docs/process-only PRs",
    "may use `Task: none — <reason>`. Automation PRs (a `[bot]`/`app/*` author",
    "or a `release-please--*` head branch) are skipped with a notice.",
    "",
    "`--board` fails when a synced issue has no native issue Type, no",
    "Milestone, no Priority, or not both plan dates (Start date, Target",
    "date); when a closed issue has no Actual start or Actual end; when its",
    "`Blocked by:` text disagrees with its native blockedBy links; when an open",
    "issue is blocked by a closed one; when the native graph has a cycle; when",
    "one epic spans milestones; when a milestone has no due date; or when a",
    "label duplicates the native Type. The allowlist is for historical closed",
    "issues only.",
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (args.board) {
    try {
      const repo = resolveRepo(args);
      const [owner, name] = repo.split("/");
      const issues = listIssueMetadata({
        ghJson,
        owner,
        name,
        states: ["OPEN", "CLOSED"],
      });
      const labels =
        ghJson([
          "label",
          "list",
          "--repo",
          repo,
          "--limit",
          "200",
          "--json",
          "name",
        ])?.map((label) => label.name) ?? [];
      const result = checkBoardFields({
        issues,
        allowlist: loadBoardExceptions(),
        milestones: loadMilestones(),
        projectItems: projectFieldValues(),
        labels,
      });
      if (!result.ok) {
        for (const error of result.errors) console.error(`error: ${error}`);
        console.error("board-fields FAILED");
        process.exitCode = 1;
        return;
      }
      console.log(result.summary);
      console.log(`project API calls: ${projectApiCalls()}`);
      appendRunSummary(`project API calls: ${projectApiCalls()}`);
      return;
    } catch (error) {
      if (error instanceof ProjectsRateLimitError || isRateLimitError(error)) {
        console.log("warning: sync deferred: Projects quota");
        console.log(`warning: ${error.message}`);
        console.log(`project API calls: ${projectApiCalls()}`);
        appendRunSummary("### sync deferred: Projects quota");
        appendRunSummary(`project API calls: ${projectApiCalls()}`);
        if (process.env.GITHUB_ACTIONS) {
          console.log("::warning::sync deferred: Projects quota");
        }
        process.exitCode = 0;
        return;
      }
      throw error;
    }
  }

  let prNumber = null;
  let body;
  let files;
  let exists = null;
  let author = args.author ?? null;
  let headRefName = args["head-ref"] ?? null;
  let isBot = false;

  if (args.pr) {
    prNumber = Number(args.pr);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`--pr needs a positive number, got ${args.pr}`);
    }
    const repo = resolveRepo(args);
    const view = ghJson([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "number,body,files,author,headRefName",
    ]);
    body = view?.body ?? "";
    files = (view?.files ?? []).map((file) => file.path);
    author = view?.author?.login ?? null;
    headRefName = view?.headRefName ?? null;
    isBot = view?.author?.is_bot === true;
    const directive = parseTaskDirective(body);
    if (directive.kind === "key") exists = issueExists(repo, directive.number);
  } else if (args["body-file"]) {
    body = fs.readFileSync(path.resolve(REPO_ROOT, args["body-file"]), "utf8");
    files = (args.files ?? "")
      .split(",")
      .map((file) => file.trim())
      .filter(Boolean);
    if (args["issue-exists"]) {
      if (args["issue-exists"] === "yes") exists = true;
      else if (args["issue-exists"] === "no") exists = false;
      else if (args["issue-exists"] !== "skip") {
        throw new Error("--issue-exists must be yes, no or skip");
      }
    }
  } else {
    throw new Error(usage());
  }

  const result = checkPullRequest({
    number: prNumber,
    body,
    files,
    issueExists: exists,
    author,
    isBot,
    headRefName,
  });

  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.error("task-links FAILED");
    process.exitCode = 1;
    return;
  }
  if (result.skipped) {
    console.log(`task-links SKIPPED: ${result.summary}`);
    return;
  }
  console.log(`task-links OK: ${result.summary}`);
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
