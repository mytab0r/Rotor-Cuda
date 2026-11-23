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
  evaluateBoardFields,
  evaluateTaskLinks,
  listIssueMetadata,
  parseTaskDirective,
} from "./lib/task-tracking.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MILESTONES_PATH = path.join(REPO_ROOT, "data", "milestones.json");
const BOARD_EXCEPTIONS_PATH = path.join(REPO_ROOT, "data", "board-exceptions.json");
const PROJECT_OWNER = "mytab0r";
const PROJECT_NUMBER = 3;

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
  const items =
    ghJson([
      "project",
      "item-list",
      String(PROJECT_NUMBER),
      "--owner",
      PROJECT_OWNER,
      "--limit",
      "1000",
      "--format",
      "json",
    ])?.items ?? [];
  const values = {};
  for (const item of items) {
    const number = Number(item.content?.number ?? item.number);
    if (!Number.isInteger(number)) continue;
    values[number] = {
      priority: item.priority ?? null,
      severity: item.severity ?? null,
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
}) {
  const result = evaluateBoardFields({ issues, allowlist, milestones, projectItems });
  const summary = result.ok
    ? `board-fields OK: ${result.checked} synced open issues have a Type, Milestone and Priority`
    : null;
  return { ...result, summary };
}

// Pure verdict used by the CLI and by tests: the caller supplies the body, the
// changed paths and (when known) whether the keyed issue exists.
export function checkPullRequest({ number = null, body, files, issueExists: exists = null }) {
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
    "  node scripts/check-task-links.mjs --body-file <path> --files <a,b> [--issue-exists yes|no|skip]",
    "  node scripts/check-task-links.mjs --board [--repo owner/name]",
    "",
    "Fails when the PR body lacks `Task: ROT-<n>`, when the keyed issue does",
    "not exist, or when the closing reference is missing. Docs/process-only PRs",
    "may use `Task: none — <reason>`.",
    "",
    "`--board` fails when a synced open issue has no native issue Type, no",
    "Milestone or no project Priority; when its `Blocked by:` text disagrees",
    "with its native blockedBy links; when an open issue is blocked by a closed",
    "one; when the native graph has a cycle; or when one epic spans milestones.",
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (args.board) {
    const repo = resolveRepo(args);
    const [owner, name] = repo.split("/");
    const issues = listIssueMetadata({ ghJson, owner, name, states: ["OPEN"] });
    const result = checkBoardFields({
      issues,
      allowlist: loadBoardExceptions(),
      milestones: loadMilestones(),
      projectItems: projectFieldValues(),
    });
    if (!result.ok) {
      for (const error of result.errors) console.error(`error: ${error}`);
      console.error("board-fields FAILED");
      process.exitCode = 1;
      return;
    }
    console.log(result.summary);
    return;
  }

  let prNumber = null;
  let body;
  let files;
  let exists = null;

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
      "number,body,files",
    ]);
    body = view?.body ?? "";
    files = (view?.files ?? []).map((file) => file.path);
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
  });

  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.error("task-links FAILED");
    process.exitCode = 1;
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
