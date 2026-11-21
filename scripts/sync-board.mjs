#!/usr/bin/env node
// Mirror OpenSpec changes and open pull requests into the "Rotor" GitHub
// Project (owner mytab0r, number 3). Node 20 built-ins only; the script uses
// the local `gh` login and needs no extra token or secret.
//
// Usage:
//   node scripts/sync-board.mjs --dry-run   # print the plan, change nothing
//   node scripts/sync-board.mjs             # apply
//
// Idempotency: one issue per change, found by the body marker
// `<!-- openspec-change: <id> -->`. Project items are matched by URL.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "mytab0r/Rotor-Cuda";
const OWNER = "mytab0r";
const PROJECT_NUMBER = 3;
const REPO_URL = `https://github.com/${REPO}`;
const PROJECT_URL = `https://github.com/users/${OWNER}/projects/${PROJECT_NUMBER}`;
const MAX_TASKS_IN_BODY = 100;
const AREA_OPTIONS = ["site", "coordinator", "desktop", "infra", "design", "docs"];
const MARKER_RE = /<!--\s*openspec-change:\s*([^\s>]+)\s*-->/;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANGES_DIR = path.join(REPO_ROOT, "openspec", "changes");
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

function readChanges() {
  if (!fs.existsSync(CHANGES_DIR)) {
    throw new Error(`missing ${path.relative(REPO_ROOT, CHANGES_DIR)}`);
  }
  const changes = [];
  const ids = fs
    .readdirSync(CHANGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const id of ids) {
    const tasksPath = path.join(CHANGES_DIR, id, "tasks.md");
    if (!fs.existsSync(tasksPath)) continue;

    const remaining = [];
    let done = 0;
    let total = 0;
    for (const line of fs.readFileSync(tasksPath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*-\s*\[([ xX])\]/);
      if (!match) continue;
      total += 1;
      if (match[1] === " ") remaining.push(line.trimEnd());
      else done += 1;
    }
    if (total === 0) continue;

    const idText = `${id} ${titleFor(id)}`;
    const inferred = areaFromText(idText);
    changes.push({
      id,
      folder: `openspec/changes/${id}`,
      done,
      total,
      percent: Math.round((done / total) * 100),
      remaining,
      title: titleFor(id),
      area: inferred ?? "site",
      defaultArea: inferred === null,
    });
  }
  return changes;
}

function issueBody(change) {
  const lines = [
    `Folder: [\`${change.folder}/\`](${REPO_URL}/tree/main/${change.folder})`,
    "",
    `Progress: ${change.done}/${change.total} tasks (${change.percent}%)`,
    "",
  ];
  if (change.remaining.length === 0) {
    lines.push("No remaining tasks.");
  } else {
    lines.push("Remaining tasks:");
    for (const task of change.remaining.slice(0, MAX_TASKS_IN_BODY)) lines.push(task);
    const hidden = change.remaining.length - MAX_TASKS_IN_BODY;
    if (hidden > 0) {
      lines.push("", `- ... and ${hidden} more tasks not shown; see the tasks file.`);
    }
  }
  lines.push("", `Source of truth: \`${change.folder}/tasks.md\``);
  if (change.defaultArea) lines.push("", "<!-- area-default: site -->");
  lines.push("", `<!-- openspec-change: ${change.id} -->`);
  return `${lines.join("\n")}\n`;
}

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}

function issueNumberFromUrl(url) {
  const match = /\/issues\/(\d+)$/.exec(url);
  if (!match) throw new Error(`cannot parse issue number from ${url}`);
  return Number(match[1]);
}

function itemUrl(item) {
  return item.content?.url ?? item.url ?? null;
}

function statusName(percent) {
  if (percent === 0) return "todo";
  if (percent === 100) return "done";
  return "in progress";
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

  const changes = readChanges();
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
        "500",
        "--json",
        "number,title,body,url,labels,state",
      ]) ?? []
    : [];
  if (!issuesEnabled) {
    console.log("warning: GitHub Issues are disabled; dry run assumes no existing issues");
  }

  const issueByChange = new Map();
  for (const issue of issues) {
    const match = MARKER_RE.exec(issue.body ?? "");
    if (match) issueByChange.set(match[1], issue);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rotor-board-"));
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  try {
    for (const change of changes) {
      const body = issueBody(change);
      const desiredLabels = ["epic", `area:${change.area}`];
      const existing = issueByChange.get(change.id);

      if (!existing) {
        const status = statusOption(change.percent).name;
        if (DRY_RUN) {
          console.log(
            `[dry-run] create issue ${change.title} ` +
              `[${desiredLabels.join(", ")}] progress ${change.done}/${change.total}`,
          );
          console.log(
            `[dry-run] project fields for ${change.id}: ` +
              `Area=${change.area}, Progress=${change.percent}, Status=${status}`,
          );
          continue;
        }
        const bodyPath = path.join(tempDir, `${change.id}.md`);
        fs.writeFileSync(bodyPath, body);
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
        created += 1;
        console.log(`created issue ${url} (${change.done}/${change.total})`);
        const number = issueNumberFromUrl(url);
        const item = ensureItem(url, `issue #${number}`);
        setField(item, areaField, change.area, change.area);
        setField(item, progressField, String(change.percent), `${change.percent}%`);
        setField(item, statusField, status, status);
        continue;
      }

      const currentLabels = labelsOf(existing);
      const areaToRemove = currentLabels.filter(
        (name) => name.startsWith("area:") && name !== `area:${change.area}`,
      );
      const needsEdit =
        existing.title !== change.title ||
        (existing.body ?? "").trim() !== body.trim() ||
        !currentLabels.includes("epic") ||
        !currentLabels.includes(`area:${change.area}`) ||
        areaToRemove.length > 0;

      if (needsEdit) {
        if (DRY_RUN) {
          console.log(`[dry-run] update issue #${existing.number}: ${change.title}`);
        } else {
          const bodyPath = path.join(tempDir, `${change.id}.md`);
          fs.writeFileSync(bodyPath, body);
          const args = [
            "issue",
            "edit",
            String(existing.number),
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
          updated += 1;
          console.log(`updated issue #${existing.number} (${change.done}/${change.total})`);
        }
      } else {
        unchanged += 1;
        console.log(`issue #${existing.number} is current (${change.done}/${change.total})`);
      }

      // The project's "Auto-close issue" workflow closes an issue when Status
      // becomes Done. If tasks regress, put the issue back on the board.
      if (existing.state === "CLOSED" && change.percent < 100) {
        if (DRY_RUN) {
          console.log(`[dry-run] reopen issue #${existing.number} (${change.percent}%)`);
        } else {
          gh(["issue", "reopen", String(existing.number), "--repo", REPO]);
          console.log(`reopened issue #${existing.number} (${change.percent}%)`);
        }
      }

      const item = ensureItem(existing.url, `issue #${existing.number}`);
      setField(item, areaField, change.area, change.area);
      setField(item, progressField, String(change.percent), `${change.percent}%`);
      setField(item, statusField, statusOption(change.percent).name, statusOption(change.percent).name);
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
      "number,title,url,headRefName",
    ]) ?? [];

    let prsAdded = 0;
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
    }

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
    console.log(`issues created: ${created}, updated: ${updated}, unchanged: ${unchanged}`);
    console.log(`open PRs seen: ${prs.length}; new PR items: ${prsAdded}`);
    console.log(`project items: ${projectItems}`);
    console.log(`project: ${PROJECT_URL}`);
    if (DRY_RUN) console.log("dry run: no changes were made");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
