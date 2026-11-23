#!/usr/bin/env node
// Mirror OpenSpec changes and open pull requests into the "Rotor" GitHub
// Project (owner mytab0r, number 3), and keep the task-tracking issues in
// sync: one epic issue per change, one sub-issue per task section in
// `tasks.md`, `Blocked by: ROT-<n>` edges, and a `Closes #<n>` reference in
// every PR that names a task key.
//
// Node 20 built-ins only; the script uses the local `gh` login and needs no
// extra token or secret. The convention is docs/process/task-tracking.md.
//
// Usage:
//   node scripts/sync-board.mjs --dry-run   # print the plan, change nothing
//   node scripts/sync-board.mjs             # apply
//
// Idempotency: epics are found by `<!-- openspec-change: <id> -->`, tasks by
// `<!-- openspec-task: <change>/<slug> -->`. Project items are matched by URL.
// This script creates and updates issues; it never closes or deletes one.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveStalePullRequestItems,
  boardMetadataFor,
  branchMatchesChange,
  changeIdForIssue,
  closingIssueNumbers,
  declarationLines,
  epicBody,
  filesBelongToChange,
  isSyncManagedIssue,
  issueNumberFromKey,
  linkSubIssueToEpic,
  listIssueMetadata,
  parseTaskDirective,
  parseTasksMarkdown,
  priorityFor,
  severityFor,
  syncChangeTasks,
} from "./lib/task-tracking.mjs";

const REPO = "mytab0r/Rotor-Cuda";
const [REPO_OWNER, REPO_NAME] = REPO.split("/");
const OWNER = "mytab0r";
const PROJECT_NUMBER = 3;
const REPO_URL = `https://github.com/${REPO}`;
const PROJECT_URL = `https://github.com/users/${OWNER}/projects/${PROJECT_NUMBER}`;
const AREA_OPTIONS = ["site", "coordinator", "desktop", "infra", "design", "docs"];
const EPIC_MARKER_RE = /<!--\s*openspec-change:\s*([^\s>]+)\s*-->/;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANGES_DIR = path.join(REPO_ROOT, "openspec", "changes");
const MILESTONES_PATH = path.join(REPO_ROOT, "data", "milestones.json");
const DRY_RUN = process.argv.slice(2).includes("--dry-run");

function gh(args) {
  let stdout;
  try {
    stdout = execFileSync("gh", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = [error.stderr, error.stdout]
      .map((value) => (value ? String(value).trim() : ""))
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `gh ${args.slice(0, 3).join(" ")} failed: ${detail || error.message}`,
    );
  }
  return stdout.trim();
}

function ghJson(args) {
  const output = gh(args);
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} returned invalid JSON: ${error.message}`);
  }
}

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const AREA_KEYWORDS = [
  ["desktop", ["desktop"]],
  ["coordinator", ["monitor", "orders", "coordinator", "proxy"]],
  ["infra", ["infra", "deploy", "ci"]],
  ["design", ["design"]],
  ["docs", ["docs"]],
  ["site", ["wallet", "seed", "site", "seo", "donor", "parity"]],
];

function areaFromText(text) {
  const tokens = new Set(tokenize(text));
  for (const [area, words] of AREA_KEYWORDS) {
    if (words.some((word) => tokens.has(word))) return area;
  }
  return null;
}

function areaFromPath(file) {
  const p = file.replace(/\\/g, "/");
  if (p.startsWith("apps/site/") || p.startsWith("crates/rotor-wasm/")) return "site";
  if (
    p.startsWith("src/coordinator/") ||
    p.startsWith("src/bin/rotor-coord") ||
    p.startsWith("tests/coordinator_")
  ) {
    return "coordinator";
  }
  if (
    p.startsWith(".github/") ||
    p.startsWith("deploy/") ||
    p.startsWith("scripts/")
  ) {
    return "infra";
  }
  if (p.startsWith("docs/")) return "docs";
  if (p.startsWith("openspec/") || p === "PROJECTS.md" || p === "AGENTS.md") {
    return "docs";
  }
  if (
    p.startsWith("src/") ||
    p.startsWith("crates/") ||
    p.startsWith("Rotor-Cuda/") ||
    p === "Cargo.toml" ||
    p === "build.rs"
  ) {
    return "desktop";
  }
  return null;
}

function firstHeading(file) {
  if (!fs.existsSync(file)) return null;
  const line = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((candidate) => /^#\s+\S/.test(candidate));
  return line ? line.replace(/^#\s+/, "").trim() : null;
}

function titleFor(id) {
  const dir = path.join(CHANGES_DIR, id);
  let heading = firstHeading(path.join(dir, "tasks.md"));
  if (!heading || /^tasks$/i.test(heading)) {
    heading = firstHeading(path.join(dir, "proposal.md"));
  }
  if (!heading) heading = id;
  heading = heading
    .replace(/^(proposal|tasks):\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (heading) heading = heading[0].toUpperCase() + heading.slice(1);
  if (heading.length > 120) heading = `${heading.slice(0, 117).trimEnd()}...`;
  return `[${id}] ${heading}`;
}

export function readChanges() {
  if (!fs.existsSync(CHANGES_DIR)) {
    throw new Error(`missing ${path.relative(REPO_ROOT, CHANGES_DIR)}`);
  }
  const changes = [];
  const skipped = [];
  const empty = [];
  const ids = fs
    .readdirSync(CHANGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "archive")
    .sort();

  for (const id of ids) {
    const tasksPath = path.join(CHANGES_DIR, id, "tasks.md");
    if (!fs.existsSync(tasksPath)) {
      skipped.push(id);
      continue;
    }

    const parsed = parseTasksMarkdown(fs.readFileSync(tasksPath, "utf8"));
    const taskSections = parsed.sections.filter(
      (section) => section.total > 0 && !section.excluded,
    );
    const total = taskSections.reduce((sum, section) => sum + section.total, 0);
    const done = taskSections.reduce((sum, section) => sum + section.done, 0);
    if (total === 0) {
      empty.push(id);
      continue;
    }

    const idText = `${id} ${titleFor(id)}`;
    const inferred = areaFromText(idText);
    changes.push({
      id,
      folder: `openspec/changes/${id}`,
      title: titleFor(id),
      sections: parsed.sections,
      done,
      total,
      percent: Math.round((done / total) * 100),
      area: inferred ?? "site",
      defaultArea: inferred === null,
    });
  }
  return { changes, skipped, empty, allIds: ids };
}

function provisionalEpicBody(change) {
  const lines = [
    `Folder: [\`${change.folder}/\`](${REPO_URL}/tree/main/${change.folder})`,
    "",
    "Progress: pending sub-issue sync",
    "",
    `Source of truth: \`${change.folder}/tasks.md\``,
    "",
    `<!-- openspec-change: ${change.id} -->`,
  ];
  if (change.defaultArea) lines.push("", "<!-- area-default: site -->");
  return `${lines.join("\n")}\n`;
}

function issueNumberFromUrl(url) {
  const match = /\/issues\/(\d+)$/.exec(url);
  if (!match) throw new Error(`cannot parse issue number from ${url}`);
  return Number(match[1]);
}

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}

function itemUrl(item) {
  return item.content?.url ?? item.url ?? null;
}

function statusName(percent) {
  if (percent === 0) return "todo";
  if (percent === 100) return "done";
  return "in progress";
}

function epicPercent(change, sync) {
  const total = sync.subIssues.length + sync.planned;
  if (total > 0) {
    const closed = sync.subIssues.filter((issue) => issue.state === "CLOSED").length;
    return Math.round((closed / total) * 100);
  }
  return change.percent;
}

// A PR belongs to a change when its head branch follows the branch convention
// `<type>/<change-id>-<slug>` and no longer registered change id makes that
// ambiguous, or when its diff touches the change folder. Any other match is
// reported instead of editing the body.
function prBelongsToChange(pr, changeId, changeIds) {
  if (branchMatchesChange(pr.headRefName, changeId, changeIds) === "match") {
    return true;
  }
  try {
    const files =
      ghJson(["pr", "view", String(pr.number), "--repo", REPO, "--json", "files"])
        ?.files ?? [];
    return filesBelongToChange(
      files.map((file) => file.path),
      changeId,
    );
  } catch (error) {
    console.log(`warning: cannot read files of PR #${pr.number}: ${error.message}`);
    return false;
  }
}

function readMilestones() {
  if (!fs.existsSync(MILESTONES_PATH)) {
    throw new Error(`missing ${path.relative(REPO_ROOT, MILESTONES_PATH)}`);
  }
  const parsed = JSON.parse(fs.readFileSync(MILESTONES_PATH, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("data/milestones.json must be an array of milestones");
  }
  const titles = new Set();
  return parsed.map((entry) => {
    const title = String(entry?.title ?? "").trim();
    if (!title) throw new Error("data/milestones.json: every milestone needs a title");
    if (titles.has(title)) {
      throw new Error(`data/milestones.json: duplicate milestone "${title}"`);
    }
    titles.add(title);
    return {
      title,
      description: entry.description ? String(entry.description) : null,
      due: entry.due ? String(entry.due) : null,
      match: {
        areas: Array.isArray(entry.match?.areas) ? entry.match.areas : [],
        epics: Array.isArray(entry.match?.epics) ? entry.match.epics : [],
      },
    };
  });
}

function dueOn(due) {
  if (!due) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T00:00:00Z` : due;
}

// Milestones are releases; data/milestones.json is the source. Create a
// missing one, update a changed description or due date, and reuse the rest.
function ensureMilestones(milestones) {
  const existing = ghJson([
    "api",
    `repos/${REPO}/milestones?state=all&per_page=100`,
  ]);
  if (!Array.isArray(existing)) {
    throw new Error("cannot list repository milestones");
  }
  const byTitle = new Map(existing.map((milestone) => [milestone.title, milestone]));
  let created = 0;
  let updated = 0;

  for (const milestone of milestones) {
    const current = byTitle.get(milestone.title);
    const due = dueOn(milestone.due);

    if (!current) {
      if (DRY_RUN) {
        console.log(
          `[dry-run] create milestone "${milestone.title}"` +
            `${milestone.due ? ` (due ${milestone.due})` : ""}`,
        );
        created += 1;
      } else {
        const args = [
          "api",
          "--method",
          "POST",
          `repos/${REPO}/milestones`,
          "-f",
          `title=${milestone.title}`,
        ];
        if (milestone.description) args.push("-f", `description=${milestone.description}`);
        if (due) args.push("-f", `due_on=${due}`);
        const made = ghJson(args);
        if (!made?.number) {
          throw new Error(`cannot create milestone "${milestone.title}"`);
        }
        byTitle.set(made.title, made);
        created += 1;
        console.log(`created milestone "${milestone.title}" (#${made.number})`);
      }
      continue;
    }

    const patch = {};
    if (milestone.description && milestone.description !== (current.description ?? "")) {
      patch.description = milestone.description;
    }
    if (due && due !== current.due_on) patch.due_on = due;
    if (Object.keys(patch).length === 0) continue;
    if (DRY_RUN) {
      console.log(
        `[dry-run] update milestone "${milestone.title}": ${Object.keys(patch).join(", ")}`,
      );
      updated += 1;
    } else {
      const args = [
        "api",
        "--method",
        "PATCH",
        `repos/${REPO}/milestones/${current.number}`,
      ];
      for (const [key, value] of Object.entries(patch)) args.push("-f", `${key}=${value}`);
      ghJson(args);
      updated += 1;
      console.log(`updated milestone "${milestone.title}"`);
    }
  }

  return { created, updated, existing: existing.length };
}

function listIssueTypes() {
  const query =
    "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issueTypes(first:20){nodes{id name}}}}";
  const result = ghJson([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${REPO_OWNER}`,
    "-f",
    `name=${REPO_NAME}`,
  ]);
  if (result?.errors?.length) {
    throw new Error(
      `cannot read repository issue types: ${result.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  const types = new Map();
  for (const node of result?.data?.repository?.issueTypes?.nodes ?? []) {
    types.set(node.name, node.id);
  }
  for (const required of ["Task", "Bug", "Feature"]) {
    if (!types.has(required)) {
      throw new Error(`repository has no issue type "${required}"`);
    }
  }
  return types;
}

function main() {
  const repoInfo = ghJson([
    "repo",
    "view",
    REPO,
    "--json",
    "hasIssuesEnabled,hasProjectsEnabled",
  ]);
  if (!repoInfo?.hasProjectsEnabled) {
    throw new Error(`projects are disabled for ${REPO}`);
  }
  if (!repoInfo.hasIssuesEnabled && !DRY_RUN) {
    throw new Error(
      `GitHub Issues are disabled for ${REPO}. ` +
        `Enable them first: gh repo edit ${REPO} --enable-issues`,
    );
  }

  const labels = ghJson(["label", "list", "--repo", REPO, "--limit", "200", "--json", "name"]) ?? [];
  const labelNames = new Set(labels.map((label) => label.name));
  for (const required of ["epic", ...AREA_OPTIONS.map((area) => `area:${area}`)]) {
    if (!labelNames.has(required)) {
      throw new Error(`missing label "${required}" in ${REPO}; create it before syncing`);
    }
  }

  function ensureLabel(name) {
    if (labelNames.has(name)) return;
    if (DRY_RUN) {
      console.log(`[dry-run] create label ${name}`);
      labelNames.add(name);
      return;
    }
    gh([
      "label",
      "create",
      name,
      "--repo",
      REPO,
      "--color",
      "5319E7",
      "--description",
      `OpenSpec change ${name.replace(/^change:/, "")}`,
    ]);
    labelNames.add(name);
    console.log(`created label ${name}`);
  }

  const project = ghJson([
    "project",
    "view",
    String(PROJECT_NUMBER),
    "--owner",
    OWNER,
    "--format",
    "json",
  ]);
  if (!project?.id) {
    throw new Error(`cannot read project ${PROJECT_NUMBER} for owner ${OWNER}`);
  }

  const fieldList =
    ghJson([
      "project",
      "field-list",
      String(PROJECT_NUMBER),
      "--owner",
      OWNER,
      "--format",
      "json",
    ])?.fields ?? [];
  const fieldByName = new Map(fieldList.map((field) => [field.name, field]));

  function ensureField(name, type, options) {
    const existing = fieldByName.get(name);
    if (existing) {
      if (type === "SINGLE_SELECT") {
        const have = new Set((existing.options ?? []).map((option) => option.name));
        const missing = options.filter((option) => !have.has(option));
        if (missing.length > 0) {
          throw new Error(
            `project field "${name}" has no options: ${missing.join(", ")}; ` +
              "add them in the project UI (gh cannot edit single-select options)",
          );
        }
      }
      return existing;
    }
    if (DRY_RUN) {
      console.log(`[dry-run] create project field ${name} (${type})`);
      return null;
    }
    const args = [
      "project",
      "field-create",
      String(PROJECT_NUMBER),
      "--owner",
      OWNER,
      "--name",
      name,
      "--data-type",
      type,
      "--format",
      "json",
    ];
    if (options) args.push("--single-select-options", options.join(","));
    const created = ghJson(args);
    console.log(`created project field ${name} (${type})`);
    fieldByName.set(name, created);
    return created;
  }

  const areaField = ensureField("Area", "SINGLE_SELECT", AREA_OPTIONS);
  const priorityField = ensureField("Priority", "SINGLE_SELECT", [
    "P0",
    "P1",
    "P2",
    "P3",
  ]);
  const severityField = ensureField("Severity", "SINGLE_SELECT", [
    "S1",
    "S2",
    "S3",
    "S4",
    "S-",
  ]);
  const progressField = ensureField("Progress", "NUMBER");
  const statusField = fieldByName.get("Status");
  if (!statusField?.options) {
    throw new Error("project has no Status single-select field");
  }
  const statusOption = (percent) => {
    const wanted = statusName(percent);
    const option = statusField.options.find(
      (candidate) => candidate.name.toLowerCase() === wanted,
    );
    if (!option) {
      throw new Error(`Status field has no option "${wanted}"`);
    }
    return option;
  };

  const items =
    ghJson([
      "project",
      "item-list",
      String(PROJECT_NUMBER),
      "--owner",
      OWNER,
      "--limit",
      "1000",
      "--format",
      "json",
    ])?.items ?? [];
  const itemsByUrl = new Map();
  for (const item of items) {
    const url = itemUrl(item);
    if (url) itemsByUrl.set(url, item);
  }

  function ensureItem(url, label) {
    const existing = itemsByUrl.get(url);
    if (existing) return existing;
    if (DRY_RUN) {
      console.log(`[dry-run] add project item ${label}: ${url}`);
      return null;
    }
    const added = ghJson([
      "project",
      "item-add",
      String(PROJECT_NUMBER),
      "--owner",
      OWNER,
      "--url",
      url,
      "--format",
      "json",
    ]);
    if (!added?.id) throw new Error(`gh project item-add returned no id for ${url}`);
    const item = { id: added.id, content: { url } };
    itemsByUrl.set(url, item);
    console.log(`added project item ${label}: ${url}`);
    return item;
  }

  function setField(item, field, value, valueLabel) {
    if (!item) return;
    if (!field) {
      console.log(`[dry-run] set ${valueLabel} on ${itemUrl(item)} (field not created yet)`);
      return;
    }
    if (DRY_RUN) {
      console.log(`[dry-run] set ${field.name}=${valueLabel} on ${itemUrl(item)}`);
      return;
    }
    // item-list exposes custom fields by lowercased name; skip an unchanged
    // value so a daily run only writes what drifted.
    const current = item[field.name.toLowerCase()];
    if (current !== undefined && String(current) === String(value)) return;
    const args = [
      "project",
      "item-edit",
      "--id",
      item.id,
      "--project-id",
      project.id,
      "--field-id",
      field.id,
    ];
    if (field.type === "ProjectV2SingleSelectField") {
      const option = (field.options ?? []).find(
        (candidate) => candidate.name.toLowerCase() === value.toLowerCase(),
      );
      if (!option) throw new Error(`field ${field.name} has no option ${value}`);
      args.push("--single-select-option-id", option.id);
    } else {
      args.push("--number", String(value));
    }
    gh(args);
  }

  const milestones = readMilestones();
  const milestoneState = ensureMilestones(milestones);

  // Issue types and native blockedBy links are GraphQL-only. One paginated
  // listing gives the current type, milestone and blockers for every open
  // issue, so a repeat run only mutates what drifted.
  const issueMetadata = new Map(
    listIssueMetadata({
      ghJson,
      owner: REPO_OWNER,
      name: REPO_NAME,
      states: ["OPEN", "CLOSED"],
    }).map((issue) => [issue.number, issue]),
  );
  const issueTypes = listIssueTypes();
  let typesSet = 0;
  let milestonesAssigned = 0;
  let dependenciesAdded = 0;
  let dependenciesRemoved = 0;
  const dependencyEdges = [];
  const metadataWarnings = [];

  function issueIdFor(number, known = null) {
    const metadata = issueMetadata.get(Number(number));
    if (metadata?.id) return metadata.id;
    if (known) return known;
    if (DRY_RUN) return null;
    const viewed = ghJson([
      "issue",
      "view",
      String(number),
      "--repo",
      REPO,
      "--json",
      "id",
    ]);
    if (!viewed?.id) throw new Error(`cannot resolve issue #${number} id`);
    return viewed.id;
  }

  function setIssueType(number, type, id = null) {
    const issueId = issueIdFor(number, id);
    const typeId = issueTypes.get(type);
    if (!typeId) throw new Error(`repository has no issue type "${type}"`);
    if (!issueId) return;
    const mutation =
      "mutation($issueId:ID!,$issueTypeId:ID!){updateIssueIssueType(input:{issueId:$issueId,issueTypeId:$issueTypeId}){issue{number issueType{name}}}}";
    const result = ghJson([
      "api",
      "graphql",
      "-f",
      `query=${mutation}`,
      "-f",
      `issueId=${issueId}`,
      "-f",
      `issueTypeId=${typeId}`,
    ]);
    if (result?.errors?.length) {
      throw new Error(
        `cannot set Type=${type} on #${number}: ${result.errors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
    const current = issueMetadata.get(Number(number)) ?? {};
    issueMetadata.set(Number(number), { ...current, id: issueId, issueType: type });
    typesSet += 1;
    console.log(`set Type=${type} on #${number}`);
  }

  function setMilestone(number, title) {
    if (DRY_RUN) {
      console.log(`[dry-run] set Milestone="${title}" on #${number}`);
      return;
    }
    gh(["issue", "edit", String(number), "--repo", REPO, "--milestone", title]);
    const current = issueMetadata.get(Number(number)) ?? {};
    issueMetadata.set(Number(number), { ...current, milestone: title });
    milestonesAssigned += 1;
    console.log(`set Milestone="${title}" on #${number}`);
  }

  // Applies Type, Milestone, Priority and Severity to one synced issue. The
  // rules live in the pure helpers, so a dry run and a real run agree.
  function applyIssueMetadata({
    number = null,
    id = null,
    title,
    body = "",
    labels = [],
    state = "OPEN",
    changeId = null,
    area = null,
    isEpic = false,
    epicPriority = null,
    epicSeverity = null,
    item = null,
    planned = false,
    typeOverride = null,
  }) {
    const issue = { number, title, body, labels };
    const info = boardMetadataFor({ issue, changeId, area, milestones });
    const type = typeOverride ?? info.type;
    for (const warning of info.warnings) {
      if (typeOverride && warning.includes("no issue-type rule matched")) continue;
      metadataWarnings.push(warning);
      console.log(`warning: ${warning}`);
    }
    const priority = priorityFor({ issue, isEpic, epicPriority });
    const severity = severityFor({ issue, issueType: type, epicSeverity });

    if (planned || !number) {
      const label = number ? `#${number}` : `new issue "${title}"`;
      if (type) {
        console.log(`[dry-run] set Type=${type} on ${label}`);
        typesSet += 1;
      }
      if (info.milestone) {
        console.log(`[dry-run] set Milestone="${info.milestone.title}" on ${label}`);
        milestonesAssigned += 1;
      }
      console.log(
        `[dry-run] set Priority=${priority}, Severity=${severity} on ${label}`,
      );
      return { type, milestone: info.milestone, priority, severity };
    }

    // Closed epics and sub-issues get a Type and a Milestone too: they can be
    // project items, and the board's Type column must not be empty.
    const current = issueMetadata.get(Number(number)) ?? {};
    if (type && current.issueType !== type) {
      if (DRY_RUN) {
        console.log(`[dry-run] set Type=${type} on #${number}`);
        typesSet += 1;
      } else {
        setIssueType(number, type, id);
      }
    }
    if (info.milestone && current.milestone !== info.milestone.title) {
      if (DRY_RUN) {
        console.log(
          `[dry-run] set Milestone="${info.milestone.title}" on #${number}`,
        );
        milestonesAssigned += 1;
      } else {
        setMilestone(number, info.milestone.title);
      }
    }

    setField(item, priorityField, priority, priority);
    setField(item, severityField, severity, severity);
    return { type, milestone: info.milestone, priority, severity };
  }

  // Keep the native blockedBy graph equal to the `Blocked by:` text. Add a
  // missing link, remove a link the text no longer lists, and report the edge.
  function syncNativeBlockers({ number, blockedByKeys, id = null }) {
    const desired = blockedByKeys
      .map((key) => issueNumberFromKey(key))
      .filter((value) => Number.isInteger(value));
    const current = (issueMetadata.get(Number(number))?.blockedBy ?? []).map(
      (blocker) => Number(blocker.number),
    );
    const issueId = issueIdFor(number, id);
    if (!issueId) return;

    for (const blocker of desired) {
      if (current.includes(blocker)) continue;
      if (DRY_RUN) {
        console.log(`[dry-run] add native blockedBy: #${number} <- #${blocker}`);
        continue;
      }
      const blockerId = issueIdFor(blocker);
      if (!blockerId) throw new Error(`cannot resolve blocker #${blocker} id`);
      const mutation =
        "mutation($issueId:ID!,$blockingIssueId:ID!){addBlockedBy(input:{issueId:$issueId,blockingIssueId:$blockingIssueId}){issue{number}}}";
      const result = ghJson([
        "api",
        "graphql",
        "-f",
        `query=${mutation}`,
        "-f",
        `issueId=${issueId}`,
        "-f",
        `blockingIssueId=${blockerId}`,
      ]);
      if (result?.errors?.length) {
        throw new Error(
          `cannot add blockedBy #${blocker} to #${number}: ${result.errors
            .map((error) => error.message)
            .join("; ")}`,
        );
      }
      dependenciesAdded += 1;
      console.log(`added native blockedBy: #${number} <- #${blocker}`);
    }

    for (const blocker of current) {
      if (desired.includes(blocker)) continue;
      if (DRY_RUN) {
        console.log(`[dry-run] remove native blockedBy: #${number} <- #${blocker}`);
        continue;
      }
      const blockerId = issueIdFor(blocker);
      if (!blockerId) continue;
      const mutation =
        "mutation($issueId:ID!,$blockingIssueId:ID!){removeBlockedBy(input:{issueId:$issueId,blockingIssueId:$blockingIssueId}){issue{number}}}";
      const result = ghJson([
        "api",
        "graphql",
        "-f",
        `query=${mutation}`,
        "-f",
        `issueId=${issueId}`,
        "-f",
        `blockingIssueId=${blockerId}`,
      ]);
      if (result?.errors?.length) {
        throw new Error(
          `cannot remove blockedBy #${blocker} from #${number}: ${result.errors
            .map((error) => error.message)
            .join("; ")}`,
        );
      }
      dependenciesRemoved += 1;
      console.log(`removed native blockedBy: #${number} <- #${blocker}`);
    }

    const metadata = issueMetadata.get(Number(number)) ?? {};
    issueMetadata.set(Number(number), {
      ...metadata,
      id: issueId,
      blockedBy: desired.map((blocker) => ({ number: blocker, state: null })),
    });
  }

  const { changes, skipped, empty, allIds } = readChanges();
  if (skipped.length > 0) {
    console.log(
      `warning: OpenSpec changes without tasks.md are not synced: ${skipped.join(", ")}`,
    );
  }
  if (empty.length > 0) {
    console.log(
      `warning: OpenSpec changes with no checkbox tasks are not synced: ${empty.join(", ")}`,
    );
  }
  const issuesEnabled = repoInfo.hasIssuesEnabled;
  const issues = issuesEnabled
    ? ghJson([
        "issue",
        "list",
        "--repo",
        REPO,
        "--state",
        "all",
        "--limit",
        "1000",
        "--json",
        "number,id,title,body,url,labels,state",
      ]) ?? []
    : [];
  if (!issuesEnabled) {
    console.log("warning: GitHub Issues are disabled; dry run assumes no existing issues");
  }

  const epicByChange = new Map();
  for (const issue of issues) {
    const match = EPIC_MARKER_RE.exec(issue.body ?? "");
    if (match && !epicByChange.has(match[1])) epicByChange.set(match[1], issue);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rotor-board-"));
  let epicsCreated = 0;
  let epicsUpdated = 0;
  let epicsUnchanged = 0;
  let tasksCreated = 0;
  let tasksUpdated = 0;
  let tasksUnchanged = 0;
  const subIssueByNumber = new Map();
  const processedNumbers = new Set();

  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  try {
    for (const change of changes) {
      let epic = epicByChange.get(change.id) ?? null;

      if (!epic) {
        epicsCreated += 1;
        if (DRY_RUN) {
          console.log(
            `[dry-run] create epic issue ${change.title} ` +
              `[epic, area:${change.area}]`,
          );
          const plannedBody = provisionalEpicBody(change);
          applyIssueMetadata({
            title: change.title,
            body: plannedBody,
            labels: ["epic", `area:${change.area}`],
            changeId: change.id,
            area: change.area,
            isEpic: true,
            epicPriority: priorityFor({
              issue: { title: change.title, body: plannedBody },
              isEpic: true,
            }),
            epicSeverity: severityFor({
              issue: { title: change.title, body: plannedBody },
              issueType: "Feature",
            }),
            planned: true,
          });
        } else {
          const bodyPath = path.join(tempDir, `epic-${change.id}.md`);
          fs.writeFileSync(bodyPath, provisionalEpicBody(change));
          const url = gh([
            "issue",
            "create",
            "--repo",
            REPO,
            "--title",
            change.title,
            "--body-file",
            bodyPath,
            "--label",
            "epic",
            "--label",
            `area:${change.area}`,
          ]);
          if (!url) throw new Error(`gh issue create returned no URL for ${change.id}`);
          const number = issueNumberFromUrl(url);
          const viewed = ghJson([
            "issue",
            "view",
            String(number),
            "--repo",
            REPO,
            "--json",
            "id,number",
          ]);
          epic = {
            number,
            id: viewed?.id ?? null,
            url,
            title: change.title,
            body: provisionalEpicBody(change),
            state: "OPEN",
            labels: ["epic", `area:${change.area}`],
          };
          console.log(`created epic issue ${url}`);
        }
      }

      const epicIssue = epic ?? {
        title: change.title,
        body: provisionalEpicBody(change),
        labels: ["epic", `area:${change.area}`],
      };
      const epicPriority = priorityFor({ issue: epicIssue, isEpic: true });
      const epicSeverity = severityFor({ issue: epicIssue, issueType: "Feature" });
      const taskArea = (task) =>
        areaFromText(`${change.id} ${task.title}`) ?? change.area;

      const sync = syncChangeTasks({
        changeId: change.id,
        epicNumber: epic?.number ?? null,
        tasks: change.sections,
        existingIssues: issues,
        gh,
        ghJson,
        repo: REPO,
        dryRun: DRY_RUN,
        tempDir,
        log: (line) => console.log(line),
        areaForTask: taskArea,
        ensureLabel,
        onPlanned: (planned) => {
          console.log(
            `[dry-run] planned sub-issue ${planned.changeId}/${planned.slug}: ${planned.title}`,
          );
          const area = taskArea(planned.task);
          applyIssueMetadata({
            title: planned.title,
            body: "",
            labels: [`change:${change.id}`, `area:${area}`],
            changeId: change.id,
            area,
            isEpic: false,
            epicPriority,
            epicSeverity,
            planned: true,
          });
        },
      });
      tasksCreated += sync.created;
      tasksUpdated += sync.updated;
      tasksUnchanged += sync.unchanged;
      for (const issue of sync.subIssues) {
        subIssueByNumber.set(issue.number, { ...issue, changeId: change.id });
      }

      const percent = epicPercent(change, sync);

      if (epic) {
        const body = epicBody({
          change,
          subIssues: sync.subIssues,
          planned: sync.planned,
          percent,
          repoUrl: REPO_URL,
          declarations: declarationLines(epic.body),
        });
        const currentLabels = labelsOf(epic);
        const areaToRemove = currentLabels.filter(
          (name) => name.startsWith("area:") && name !== `area:${change.area}`,
        );
        const needsEdit =
          epic.title !== change.title ||
          (epic.body ?? "").trim() !== body.trim() ||
          !currentLabels.includes("epic") ||
          !currentLabels.includes(`area:${change.area}`) ||
          areaToRemove.length > 0;

        if (needsEdit) {
          if (DRY_RUN) {
            console.log(`[dry-run] update epic issue #${epic.number}: ${change.title}`);
          } else {
            const bodyPath = path.join(tempDir, `epic-${change.id}.md`);
            fs.writeFileSync(bodyPath, body);
            const args = [
              "issue",
              "edit",
              String(epic.number),
              "--repo",
              REPO,
              "--title",
              change.title,
              "--body-file",
              bodyPath,
              "--add-label",
              "epic",
              "--add-label",
              `area:${change.area}`,
            ];
            for (const label of areaToRemove) args.push("--remove-label", label);
            gh(args);
            epicsUpdated += 1;
            console.log(`updated epic issue #${epic.number} (${percent}%)`);
          }
        } else {
          epicsUnchanged += 1;
          console.log(`epic issue #${epic.number} is current (${percent}%)`);
        }

        // The project's "Auto-close issue" workflow closes an issue when Status
        // becomes Done. If tasks regress, put the epic back on the board.
        if (epic.state === "CLOSED" && percent < 100) {
          if (DRY_RUN) {
            console.log(`[dry-run] reopen epic issue #${epic.number} (${percent}%)`);
          } else {
            gh(["issue", "reopen", String(epic.number), "--repo", REPO]);
            epic.state = "OPEN";
            console.log(`reopened epic issue #${epic.number} (${percent}%)`);
          }
        }

        const epicItem = ensureItem(epic.url, `epic #${epic.number}`);
        processedNumbers.add(epic.number);
        setField(epicItem, areaField, change.area, change.area);
        setField(epicItem, progressField, String(percent), `${percent}%`);
        setField(epicItem, statusField, statusOption(percent).name, statusOption(percent).name);
        applyIssueMetadata({
          number: epic.number,
          id: epic.id ?? null,
          title: change.title,
          body: epic.body ?? "",
          labels: labelsOf(epic),
          state: epic.state,
          changeId: change.id,
          area: change.area,
          isEpic: true,
          epicPriority,
          epicSeverity,
          item: epicItem,
        });
      }

      for (const issue of sync.subIssues) {
        const area = issue.area ?? change.area;
        processedNumbers.add(issue.number);
        const item = ensureItem(issue.url, `sub-issue #${issue.number}`);
        setField(item, areaField, area, area);
        applyIssueMetadata({
          number: issue.number,
          title: issue.title,
          body: issueByNumber.get(issue.number)?.body ?? "",
          labels: [`change:${change.id}`, `area:${area}`],
          state: issue.state,
          changeId: change.id,
          area,
          isEpic: false,
          epicPriority,
          epicSeverity,
          item,
        });
        if (issue.state === "OPEN") {
          syncNativeBlockers({
            number: issue.number,
            blockedByKeys: issue.blockedBy,
          });
        }
        for (const key of issue.blockedBy) {
          const blocker = issueNumberFromKey(key);
          if (blocker) dependencyEdges.push(`#${issue.number} <- #${blocker}`);
        }
      }

      if (epic) {
        for (const issue of sync.subIssues) {
          linkSubIssueToEpic({
            ghJson,
            repo: REPO,
            epicNumber: epic.number,
            epicId: epic.id ?? null,
            subIssueNumber: issue.number,
            dryRun: DRY_RUN,
            log: (line) => console.log(line),
          });
        }
      } else if (DRY_RUN) {
        for (const issue of sync.subIssues) {
          console.log(
            `[dry-run] link sub-issue #${issue.number} under a new epic for ${change.id}`,
          );
        }
      }
    }

    // Archived changes no longer appear in openspec/changes, but their issues
    // can still be project items. Classify those so the board's Type column is
    // never empty; do not add a closed archived issue that is not an item yet.
    // A manual item that already has a native Type keeps it and gets a
    // milestone/priority; an untyped manual issue is left alone.
    for (const issue of issues) {
      if (processedNumbers.has(issue.number)) continue;
      const managed = isSyncManagedIssue(issue);
      if (managed) {
        if (issue.state !== "OPEN" && !itemsByUrl.has(issue.url)) continue;
      } else if (!itemsByUrl.has(issue.url)) {
        continue;
      }
      const existingType = issueMetadata.get(issue.number)?.issueType ?? null;
      if (!managed && !existingType) continue;
      const labels = labelsOf(issue);
      const areaLabel = labels.find((name) => name.startsWith("area:"));
      const area =
        areaLabel?.slice("area:".length) ?? areaFromText(issue.title ?? "") ?? "site";
      const isEpic = labels.includes("epic");
      const item = ensureItem(
        issue.url,
        `${isEpic ? "epic" : "sub-issue"} #${issue.number}`,
      );
      applyIssueMetadata({
        number: issue.number,
        id: issue.id,
        title: issue.title,
        body: issue.body ?? "",
        labels,
        state: issue.state,
        changeId: changeIdForIssue(issue),
        area,
        isEpic,
        epicPriority: "P1",
        epicSeverity: "S-",
        item,
        typeOverride: managed ? null : existingType,
      });
    }

    const prs = ghJson([
      "pr",
      "list",
      "--repo",
      REPO,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,headRefName,body",
    ]) ?? [];

    let prsAdded = 0;
    let prLinksAdded = 0;
    const prsWithoutTask = [];
    const prReports = [];

    for (const pr of prs) {
      let area = areaFromText(`${pr.headRefName} ${pr.title}`);
      if (!area) {
        try {
          const files =
            ghJson(["pr", "view", String(pr.number), "--repo", REPO, "--json", "files"])
              ?.files ?? [];
          for (const file of files) {
            area = areaFromPath(file.path);
            if (area) break;
          }
        } catch (error) {
          console.log(`warning: cannot read files of PR #${pr.number}: ${error.message}`);
        }
      }
      area = area ?? "site";
      const existed = itemsByUrl.has(pr.url);
      const item = ensureItem(pr.url, `PR #${pr.number}`);
      if (!DRY_RUN && !existed) prsAdded += 1;
      setField(item, areaField, area, area);
      if (DRY_RUN && !existed) {
        console.log(`[dry-run] project fields for PR #${pr.number}: Area=${area}`);
      }

      const directive = parseTaskDirective(pr.body ?? "");
      if (directive.kind === "missing") {
        prsWithoutTask.push(pr.number);
      } else if (directive.kind === "invalid") {
        prReports.push(
          `PR #${pr.number}: \`Task:\` line is not a ROT key: ${directive.raw}`,
        );
      } else if (directive.kind === "key") {
        const record = subIssueByNumber.get(directive.number);
        if (!record) {
          prReports.push(
            `PR #${pr.number}: ${directive.key} does not match a synced sub-issue (issue #${directive.number}).`,
          );
          continue;
        }
        const closes = closingIssueNumbers(pr.body ?? "");
        if (closes.includes(directive.number)) continue;
        const other = closes.filter((number) => number !== directive.number);
        if (other.length > 0) {
          prReports.push(
            `PR #${pr.number}: closes #${other[0]}, expected #${directive.number}; body left unchanged.`,
          );
          continue;
        }
        if (!prBelongsToChange(pr, record.changeId, allIds)) {
          prReports.push(
            `PR #${pr.number}: cannot prove the diff belongs to ${record.changeId}; ` +
              `add \`Closes #${directive.number}\` manually.`,
          );
          continue;
        }
        if (DRY_RUN) {
          console.log(
            `[dry-run] append \`Closes #${directive.number}\` to PR #${pr.number} (${directive.key})`,
          );
        } else {
          const bodyPath = path.join(tempDir, `pr-${pr.number}.md`);
          const nextBody = `${(pr.body ?? "").trimEnd()}\n\nCloses #${directive.number}\n`;
          fs.writeFileSync(bodyPath, nextBody);
          gh([
            "pr",
            "edit",
            String(pr.number),
            "--repo",
            REPO,
            "--body-file",
            bodyPath,
          ]);
          prLinksAdded += 1;
          console.log(`linked PR #${pr.number} to #${directive.number} (${directive.key})`);
        }
      }
    }

    const archive = archiveStalePullRequestItems({
      items,
      openPullRequestNumbers: new Set(prs.map((pr) => pr.number)),
      projectId: project.id,
      ghJson,
      repo: REPO,
      dryRun: DRY_RUN,
      log: (line) => console.log(line),
    });

    const projectItems =
      DRY_RUN
        ? items.length
        : ghJson([
            "project",
            "item-list",
            String(PROJECT_NUMBER),
            "--owner",
            OWNER,
            "--limit",
            "1000",
            "--format",
            "json",
          ])?.items?.length ?? 0;

    console.log("");
    console.log(`changes: ${changes.length}`);
    console.log(
      `epics created: ${epicsCreated}, updated: ${epicsUpdated}, unchanged: ${epicsUnchanged}`,
    );
    console.log(
      `sub-issue tasks created: ${tasksCreated}, updated: ${tasksUpdated}, unchanged: ${tasksUnchanged}`,
    );
    console.log(`open PRs seen: ${prs.length}; new PR items: ${prsAdded}; PR links added: ${prLinksAdded}`);
    console.log(`stale PR items archived: ${archive.archived}`);
    if (DRY_RUN) {
      console.log(
        `issue Types planned: ${typesSet}; milestones planned: ${milestonesAssigned}; ` +
          `milestones to create: ${milestoneState.created}, to update: ${milestoneState.updated}`,
      );
    } else {
      console.log(
        `issue Types set: ${typesSet}; milestones assigned: ${milestonesAssigned}; ` +
          `milestones created: ${milestoneState.created}, updated: ${milestoneState.updated}`,
      );
    }
    console.log(
      `native dependencies added: ${dependenciesAdded}, removed: ${dependenciesRemoved}, edges: ${dependencyEdges.length}`,
    );
    for (const edge of dependencyEdges) console.log(`dependency: ${edge}`);
    if (metadataWarnings.length > 0) {
      console.log(`board metadata warnings: ${metadataWarnings.length}`);
    }
    if (skipped.length > 0) console.log(`changes without tasks.md: ${skipped.join(", ")}`);
    if (empty.length > 0) console.log(`changes without checkbox tasks: ${empty.join(", ")}`);
    if (prsWithoutTask.length > 0) {
      console.log(`PRs without a Task line: ${prsWithoutTask.join(", ")}`);
    }
    for (const report of prReports) console.log(`report: ${report}`);
    console.log(`project items: ${projectItems}`);
    console.log(`project: ${PROJECT_URL}`);
    if (DRY_RUN) console.log("dry run: no changes were made");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
