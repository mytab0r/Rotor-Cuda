#!/usr/bin/env node
// Route GitHub security alerts (code scanning, Dependabot, secret scanning)
// into one tracking issue each, and keep the lifecycle closed:
//
//   open alert, no issue           -> create `[security] ...` issue
//   open alert, open issue         -> reconcile title, body, labels, project
//   open alert, human-closed issue -> comment once; never reopen
//   dismissed/fixed/resolved       -> close the open issue with who/why
//   open alert >24h, unassigned    -> escalation (`--check-escalation` exits 1)
//
// Deduplication is the hidden body marker
// `<!-- security-alert:<kind>:<number> -->`. The token comes from the
// environment (`GH_TOKEN` in CI); it is never printed or stored.
//
// Usage:
//   node scripts/security-alerts-sync.mjs --dry-run
//   node scripts/security-alerts-sync.mjs
//   node scripts/security-alerts-sync.mjs --check-escalation
//
// Node 20 built-ins and the local `gh` login only; no npm dependency.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectsRateLimitError,
  appendRunSummary,
  listProjectItems,
  withProjectsRetry,
} from "./lib/project-api.mjs";
import {
  KIND_LABELS,
  escalationLine,
  lifecycleSummary,
  normalizeAlert,
  planSync,
  severityFieldForPriority,
  summarize,
} from "./lib/security-alerts.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO =
  process.env.SECURITY_ALERTS_REPO ||
  process.env.GITHUB_REPOSITORY ||
  "mytab0r/Rotor-Cuda";
const [REPO_OWNER, REPO_NAME] = REPO.split("/");
const REPO_URL = `https://github.com/${REPO}`;
const PROJECT_OWNER = process.env.SECURITY_ALERTS_PROJECT_OWNER || "mytab0r";
const PROJECT_NUMBER = Number(process.env.SECURITY_ALERTS_PROJECT_NUMBER || 3);
const STALE_HOURS = Number(process.env.SECURITY_ALERT_STALE_HOURS || 24);
const MILESTONES_PATH = path.join(REPO_ROOT, "data", "milestones.json");

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has("--dry-run");
const CHECK_ESCALATION = ARGS.has("--check-escalation");

// The alert API states differ per kind: code scanning and Dependabot use
// open/dismissed/fixed, secret scanning uses open/resolved.
const ENDPOINTS = {
  "code-scanning": {
    path: "code-scanning/alerts",
    states: ["open", "dismissed", "fixed"],
  },
  dependabot: {
    path: "dependabot/alerts",
    states: ["open", "dismissed", "fixed"],
  },
  "secret-scanning": {
    path: "secret-scanning/alerts",
    states: ["open", "resolved"],
  },
};

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
    throw new Error(
      `gh ${args.slice(0, 3).join(" ")} failed: ${detail || error.message}`,
    );
  }
}

function ghJson(args) {
  const output = gh(args);
  if (!output) return null;
  return JSON.parse(output);
}

// `gh api --paginate --jq '.[] | @json'` prints one JSON value per line, so a
// paginated array is collected without concatenating pages into invalid JSON.
function apiLines(args) {
  const output = withProjectsRetry(() => gh(args), {
    label: `api ${args[2] ?? ""}`,
    log: (line) => console.log(line),
  });
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`cannot parse a line from ${args[2]}: ${error.message}`);
      }
    });
}

// A repository can legitimately have an alert type turned off; that is not a
// sync failure, but a token-scope error is.
function endpointUnavailable(error) {
  const message = String(error?.message ?? error);
  if (/HTTP 404|\bNot Found\b/i.test(message)) return true;
  return (
    /HTTP 403/i.test(message) &&
    /(disabled|not enabled|not available for this repository)/i.test(message)
  );
}

function fetchAlerts() {
  const alerts = [];
  const warnings = [];
  for (const [kind, config] of Object.entries(ENDPOINTS)) {
    let kindUnavailable = false;
    for (const state of config.states) {
      if (kindUnavailable) break;
      const url = `repos/${REPO}/${config.path}?state=${state}&per_page=100`;
      try {
        const raw = apiLines(["api", "--paginate", url, "--jq", ".[] | @json"]);
        for (const item of raw) {
          const facts = normalizeAlert(kind, item);
          if (facts) alerts.push(facts);
        }
      } catch (error) {
        if (endpointUnavailable(error)) {
          kindUnavailable = true;
          warnings.push(
            `${KIND_LABELS[kind]} alerts are not available on ${REPO}; ` +
              "enable them in the repository security settings to route them",
          );
          continue;
        }
        throw error;
      }
    }
  }
  // GitHub can return the same alert from `state=dismissed` and `state=fixed`
  // when a fix landed and was later dismissed (the object's own `state` is the
  // current one). Deduplicate by the marker key; an open record wins.
  const byKey = new Map();
  for (const facts of alerts) {
    const existing = byKey.get(facts.key);
    if (!existing || (existing.state !== "open" && facts.state === "open")) {
      byKey.set(facts.key, facts);
    }
  }
  return { alerts: [...byKey.values()], warnings };
}

function fetchIssues() {
  const url = `repos/${REPO}/issues?state=all&per_page=100`;
  const jq =
    ".[] | select(.pull_request == null) | " +
    "{number,title,body,state,url:.html_url,nodeId:.node_id," +
    "labels:[.labels[].name],assignees:[.assignees[].login]," +
    "milestone:(.milestone.title // null),closedAt:.closed_at} | @json";
  return apiLines(["api", "--paginate", url, "--jq", jq]);
}

function commentsFor(number) {
  const url = `repos/${REPO}/issues/${number}/comments?per_page=100`;
  return apiLines(["api", "--paginate", url, "--jq", ".[] | .body | @json"]);
}

function readMilestones() {
  if (!fs.existsSync(MILESTONES_PATH)) return [];
  const parsed = JSON.parse(fs.readFileSync(MILESTONES_PATH, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("data/milestones.json must be an array of milestones");
  }
  return parsed;
}

function dateOnly(value) {
  if (!value) return null;
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function issueNumberFromUrl(url) {
  const match = /\/issues\/(\d+)$/.exec(String(url).trim());
  if (!match) throw new Error(`cannot parse an issue number from ${url}`);
  return Number(match[1]);
}

function updateSummary(line) {
  appendRunSummary(line);
  console.log(line);
}

function labelList() {
  return withProjectsRetry(
    () => ghJson(["label", "list", "--repo", REPO, "--limit", "200", "--json", "name"]),
    { label: "label list", log: (line) => console.log(line) },
  ) ?? [];
}

function ensureLabels(actions) {
  const relevant = actions.filter(
    (action) =>
      action.type === "create" ||
      action.type === "update" ||
      action.type === "reopen",
  );
  if (relevant.length === 0) return;
  const needed = new Set(["security"]);
  for (const action of relevant) {
    for (const label of action.labels ?? []) needed.add(label);
  }
  const existing = new Set(labelList().map((label) => label.name));
  for (const name of needed) {
    if (existing.has(name)) continue;
    if (DRY_RUN) {
      console.log(`[dry-run] create label ${name}`);
      continue;
    }
    gh([
      "label",
      "create",
      name,
      "--repo",
      REPO,
      "--color",
      name === "security" ? "B60205" : "FBCA04",
      "--description",
      name === "security"
        ? "Security alert tracking"
        : `Area ${name.replace(/^area:/, "")}`,
    ]);
    console.log(`created label ${name}`);
  }
}

function ensureMilestones(actions, milestones) {
  const wanted = new Set(
    actions
      .filter(
        (action) =>
          action.type === "create" ||
          action.type === "update" ||
          action.type === "reopen",
      )
      .map((action) => action.milestone?.title)
      .filter(Boolean),
  );
  if (wanted.size === 0) return;
  const existing = new Map(
    (withProjectsRetry(
      () => ghJson(["api", `repos/${REPO}/milestones?state=all&per_page=100`]),
      { label: "milestone list", log: (line) => console.log(line) },
    ) ?? []).map((milestone) => [milestone.title, milestone]),
  );
  for (const title of wanted) {
    if (existing.has(title)) continue;
    const entry = milestones.find((milestone) => milestone.title === title);
    if (!entry?.due) {
      console.log(
        `warning: milestone "${title}" is not in data/milestones.json; leaving it unset`,
      );
      continue;
    }
    if (DRY_RUN) {
      console.log(`[dry-run] create milestone "${title}" (due ${entry.due})`);
      continue;
    }
    const created = ghJson([
      "api",
      "--method",
      "POST",
      `repos/${REPO}/milestones`,
      "-f",
      `title=${title}`,
      "-f",
      `due_on=${entry.due}T00:00:00Z`,
      "-f",
      `description=${entry.description ?? title}`,
    ]);
    existing.set(title, created);
    console.log(`created milestone "${title}"`);
  }
}

// --- Projects v2 fields -----------------------------------------------------

function projectState() {
  const project = listProjectItems({
    ghJson,
    owner: PROJECT_OWNER,
    number: PROJECT_NUMBER,
    log: (line) => console.log(line),
  });
  const fields =
    withProjectsRetry(
      () =>
        ghJson([
          "project",
          "field-list",
          String(PROJECT_NUMBER),
          "--owner",
          PROJECT_OWNER,
          "--format",
          "json",
        ]),
      { label: "project field-list", log: (line) => console.log(line) },
    )?.fields ?? [];
  const itemsByUrl = new Map();
  for (const item of project.items) {
    const url = item.content?.url;
    if (url) itemsByUrl.set(url, item);
  }
  return {
    projectId: project.projectId,
    items: project.items,
    itemsByUrl,
    fields: new Map(fields.map((field) => [field.name, field])),
    missingFields: new Set(),
  };
}

function ensureItem(state, url, label) {
  const existing = state.itemsByUrl.get(url);
  if (existing) return existing;
  if (DRY_RUN) {
    console.log(`[dry-run] add project item ${label}: ${url}`);
    return null;
  }
  const added = withProjectsRetry(
    () =>
      ghJson([
        "project",
        "item-add",
        String(PROJECT_NUMBER),
        "--owner",
        PROJECT_OWNER,
        "--url",
        url,
        "--format",
        "json",
      ]),
    { label: `project item-add ${label}`, log: (line) => console.log(line) },
  );
  if (!added?.id) throw new Error(`gh project item-add returned no id for ${url}`);
  const item = { id: added.id, content: { url } };
  state.itemsByUrl.set(url, item);
  state.items.push(item);
  console.log(`added project item ${label}: ${url}`);
  return item;
}

const DATE_FIELDS = new Set([
  "Start date",
  "Target date",
  "Actual start",
  "Actual end",
]);

function setField(state, item, name, value, label = null) {
  if (value === null || value === undefined || value === "") return;
  const field = state.fields.get(name);
  if (!field) {
    if (!state.missingFields.has(name)) {
      state.missingFields.add(name);
      console.log(`warning: project has no "${name}" field; skipping it`);
    }
    return;
  }
  if (!item) {
    if (DRY_RUN) console.log(`[dry-run] set ${name}=${value} on a new project item`);
    return;
  }
  if (DRY_RUN) {
    console.log(`[dry-run] set ${name}=${value} on ${label ?? item.content?.url}`);
    return;
  }
  const current = item[name.toLowerCase()];
  if (current !== undefined && String(current) === String(value)) return;
  const args = [
    "project",
    "item-edit",
    "--id",
    item.id,
    "--project-id",
    state.projectId,
    "--field-id",
    field.id,
  ];
  if (field.type === "ProjectV2SingleSelectField") {
    const option = (field.options ?? []).find(
      (candidate) => candidate.name.toLowerCase() === String(value).toLowerCase(),
    );
    if (!option) throw new Error(`project field ${name} has no option ${value}`);
    args.push("--single-select-option-id", option.id);
  } else if (DATE_FIELDS.has(name) || /date/i.test(name)) {
    args.push("--date", String(value));
  } else {
    args.push("--number", String(value));
  }
  withProjectsRetry(() => gh(args), {
    label: `project item-edit ${name}`,
    log: (line) => console.log(line),
  });
}

function applyProjectFields(
  state,
  { number, url, facts, area, priority, milestone, closed },
) {
  const label = `#${number}`;
  const item = ensureItem(state, url, label);
  const firstSeen = dateOnly(facts.firstSeen) ?? dateOnly(new Date().toISOString());
  setField(state, item, "Area", area, label);
  setField(state, item, "Priority", priority, label);
  setField(state, item, "Severity", severityFieldForPriority(priority), label);
  setField(state, item, "Start date", firstSeen, label);
  setField(state, item, "Target date", milestone?.due ?? null, label);
  setField(state, item, "Actual start", firstSeen, label);
  if (closed) {
    const actualEnd = dateOnly(facts.closedAt) ?? dateOnly(new Date().toISOString());
    setField(state, item, "Actual end", actualEnd, label);
  }
}

function issueTypeId(typeName) {
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
  const node = (result?.data?.repository?.issueTypes?.nodes ?? []).find(
    (candidate) => candidate.name === typeName,
  );
  if (!node) throw new Error(`repository has no issue type "${typeName}"`);
  return node.id;
}

function setIssueType(issueId, typeId, number) {
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
      `cannot set Type=Bug on #${number}: ${result.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
}

function planLabel(action) {
  if (action.type === "create") {
    const parts = [
      `create issue "${action.title}" labels=[${action.labels.join(", ")}] ` +
        `type=Bug priority=${action.priority} severity=${severityFieldForPriority(action.priority)}`,
    ];
    if (action.milestone) parts.push(`milestone="${action.milestone.title}"`);
    return `[dry-run] ${parts.join(" ")}`;
  }
  if (action.type === "update") {
    const changed = action.changes.length > 0 ? action.changes.join(", ") : "metadata";
    return `[dry-run] update #${action.number}: ${changed}`;
  }
  if (action.type === "reopen") {
    return `[dry-run] reopen #${action.number}: alert is open again`;
  }
  if (action.type === "close") {
    return `[dry-run] close #${action.number}: ${lifecycleSummary(action.facts)}`;
  }
  if (action.type === "comment") {
    return `[dry-run] comment once on closed #${action.number}: alert is still open`;
  }
  return null;
}

function applyIssueEdit(action, context) {
  const args = ["issue", "edit", String(action.number), "--repo", REPO];
  let changed = false;
  if ((action.changes ?? []).includes("title")) {
    args.push("--title", action.title);
    changed = true;
  }
  if ((action.changes ?? []).includes("body")) {
    args.push("--body", action.body);
    changed = true;
  }
  const labels = new Set(action.issue.labels ?? []);
  for (const label of action.labels ?? []) {
    if (!labels.has(label)) {
      args.push("--add-label", label);
      changed = true;
    }
  }
  if (action.milestone && action.issue.milestone !== action.milestone.title) {
    args.push("--milestone", action.milestone.title);
    changed = true;
  }
  if (changed) gh(args);
  applyProjectFields(context.project, {
    number: action.number,
    url: action.issue.url,
    facts: action.facts,
    area: action.area,
    priority: action.priority,
    milestone: action.milestone,
    closed: false,
  });
  return (action.changes ?? []).length > 0
    ? action.changes.join(", ")
    : "metadata";
}

function applyAction(action, context) {
  if (action.type === "noop") {
    console.log(`no-op ${action.facts.kind} #${action.facts.number}: ${action.reason}`);
    return;
  }
  if (DRY_RUN) {
    console.log(planLabel(action));
    return;
  }

  if (action.type === "create") {
    const url = gh([
      "issue",
      "create",
      "--repo",
      REPO,
      "--title",
      action.title,
      "--body",
      action.body,
      "--label",
      "security",
      "--label",
      `area:${action.area}`,
    ]);
    const number = issueNumberFromUrl(url);
    const viewed = ghJson([
      "issue",
      "view",
      String(number),
      "--repo",
      REPO,
      "--json",
      "id,number,url",
    ]);
    if (!viewed?.id) throw new Error(`cannot resolve the id of new issue #${number}`);
    setIssueType(viewed.id, context.issueTypeId, number);
    if (action.milestone) {
      gh([
        "issue",
        "edit",
        String(number),
        "--repo",
        REPO,
        "--milestone",
        action.milestone.title,
      ]);
    }
    applyProjectFields(context.project, {
      number,
      url,
      facts: action.facts,
      area: action.area,
      priority: action.priority,
      milestone: action.milestone,
      closed: false,
    });
    console.log(`created issue ${url}`);
    return;
  }

  if (action.type === "update") {
    const changed = applyIssueEdit(action, context);
    console.log(`updated #${action.number} (${changed})`);
    return;
  }

  if (action.type === "reopen") {
    gh([
      "issue",
      "reopen",
      String(action.number),
      "--repo",
      REPO,
      "--comment",
      action.comment,
    ]);
    const changed = applyIssueEdit(action, context);
    console.log(`reopened #${action.number} (${changed})`);
    return;
  }

  if (action.type === "close") {
    const reason = action.facts.state === "fixed" ? "completed" : "not planned";
    // Add the project item before the issue closes, so a closed issue is never
    // the reason a project write fails.
    ensureItem(context.project, action.issue.url, `#${action.number}`);
    gh([
      "issue",
      "close",
      String(action.number),
      "--repo",
      REPO,
      "--reason",
      reason,
      "--comment",
      action.comment,
    ]);
    applyProjectFields(context.project, {
      number: action.number,
      url: action.issue.url,
      facts: action.facts,
      area: action.area,
      priority: action.priority,
      milestone: action.milestone,
      closed: true,
    });
    console.log(`closed #${action.number}: ${lifecycleSummary(action.facts)}`);
    return;
  }

  if (action.type === "comment") {
    gh([
      "issue",
      "comment",
      String(action.number),
      "--repo",
      REPO,
      "--body",
      action.comment,
    ]);
    console.log(`commented once on closed #${action.number}`);
  }
}

function printEscalations(plan, now, { fail = false } = {}) {
  for (const entry of plan.escalations) {
    const line = escalationLine(entry, now);
    console.log(`ESCALATION: ${line}`);
    if (fail) console.log(`::error::security alert escalation: ${line}`);
  }
}

async function main() {
  const milestones = readMilestones();
  const { alerts, warnings } = fetchAlerts();
  const issues = fetchIssues();
  const now = new Date();
  const plan = planSync({
    alerts,
    issues,
    commentsFor,
    now,
    staleHours: STALE_HOURS,
    milestones,
    repoUrl: REPO_URL,
  });
  for (const warning of [...warnings, ...plan.warnings]) {
    console.log(`warning: ${warning}`);
    appendRunSummary(`warning: ${warning}`);
  }

  if (CHECK_ESCALATION) {
    if (plan.escalations.length === 0) {
      console.log(
        `security-alert escalation: none (0 open alerts older than ${STALE_HOURS}h ` +
          "without an assigned tracking issue)",
      );
      appendRunSummary(
        `security-alert escalation: none (0 open alerts older than ${STALE_HOURS}h unassigned)`,
      );
      return;
    }
    console.log(
      `security-alert escalation: ${plan.escalations.length} open alert(s) older than ` +
        `${STALE_HOURS}h without an assigned tracking issue`,
    );
    printEscalations(plan, now, { fail: true });
    appendRunSummary(
      `security-alert escalation: ${plan.escalations.length} open alert(s) need an assignee`,
    );
    process.exitCode = 1;
    return;
  }

  const counts = summarize(alerts);
  updateSummary(
    `security-alerts: ${counts.open} open, ${counts.dismissed} dismissed, ` +
      `${counts.fixed} fixed, ${counts.resolved} resolved ` +
      `(repository issues scanned: ${issues.length})`,
  );

  const mutable = plan.actions.filter((action) =>
    ["create", "update", "reopen", "close"].includes(action.type),
  );
  ensureLabels(plan.actions);
  ensureMilestones(plan.actions, milestones);

  let context = null;
  if (!DRY_RUN && mutable.length > 0) {
    const created = plan.actions.filter((action) => action.type === "create");
    context = {
      project: projectState(),
      issueTypeId: created.length > 0 ? issueTypeId("Bug") : null,
    };
  }
  for (const action of plan.actions) applyAction(action, context);

  const created = plan.actions.filter((action) => action.type === "create").length;
  const updated = plan.actions.filter((action) => action.type === "update").length;
  const closed = plan.actions.filter((action) => action.type === "close").length;
  const comments = plan.actions.filter((action) => action.type === "comment").length;
  const noops = plan.actions.filter((action) => action.type === "noop").length;
  updateSummary(
    `security-alerts plan: ${created} create, ${updated} update, ${closed} close, ` +
      `${comments} comment, ${noops} no-op, ${plan.escalations.length} escalation(s)`,
  );
  if (plan.escalations.length > 0) {
    printEscalations(plan, now);
    appendRunSummary(
      `security-alerts escalation: ${plan.escalations.length} open alert(s) older than ` +
        `${STALE_HOURS}h without an assigned tracking issue`,
    );
  }
}

main().catch((error) => {
  if (error instanceof ProjectsRateLimitError) {
    console.log(`warning: security-alerts sync deferred: ${error.message}`);
    appendRunSummary(
      "security-alerts sync deferred: API rate limit; the next daily run finishes the idempotent sync",
    );
    process.exitCode = 0;
    return;
  }
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
