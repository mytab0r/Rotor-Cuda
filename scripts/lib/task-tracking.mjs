// Task-tracking conventions and the issue sync used by scripts/sync-board.mjs.
//
// The key is provider-neutral: `ROT-<n>` where <n> is the GitHub issue number.
// That number is the only identifier every provider (GitHub, Bitbucket, Jira)
// can carry in plain text, so no second counter exists to drift. OpenSpec task
// sections map one-to-one to sub-issues; the section's `blocked by:` line maps
// to `Blocked by: ROT-<n> (#<n>)` text plus native sub-issue links.
//
// This module performs no network calls: callers inject `gh` (returns stdout)
// and `ghJson` (returns parsed JSON). Tests use the same seam with a fake.

import fs from "node:fs";
import path from "node:path";

export const KEY_PREFIX = "ROT";
export const TASK_MARKER_RE = /<!--\s*openspec-task:\s*([^\s/]+)\/([^\s>]+)\s*-->/;
export const EPIC_MARKER_RE = /<!--\s*openspec-change:\s*([^\s>]+)\s*-->/;

const TASK_DIRECTIVE_RE = /^\s*Task:\s*(.+?)\s*$/im;
const CLOSING_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*(?:[\w.-]+\/[\w.-]+)?#([1-9]\d*)/gi;
const NON_TASK_TITLE_RE =
  /^(?:out of scope|out-of-scope|references?|background|legend|notes?|mvp status)$/i;
const ROLE_NOTE_RE =
  /^(?:analyst|critic|developer|designer|tester|orchestrator|owner|product|legal|ops|back|front|qa|wasm|desktop|coordinator|site)(?:\s*[+&]\s*\w+)*$/i;
const SOFT_NOTE_RE = /^(?:follows|after|needs?|depends on|see)\b/i;
const DOC_PATH_RE = /^(?:docs\/|openspec\/)/i;
const ROOT_MARKDOWN_RE = /^[^/]+\.(?:md|mdx)$/i;
const PROCESS_PATH_RE =
  /^(?:scripts\/|\.github\/)|^(?:projects\.json|AGENTS\.md|PROJECTS\.md|\.commitlintrc\.json|lighthouserc\.json|\.gitleaks\.toml)$/;

export function taskKey(issueNumber) {
  const number = Number(issueNumber);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`task key needs a positive issue number, got ${issueNumber}`);
  }
  return `${KEY_PREFIX}-${number}`;
}

export function issueNumberFromKey(value) {
  const match = new RegExp(`^${KEY_PREFIX}-([1-9]\\d*)$`).exec(String(value).trim());
  return match ? Number(match[1]) : null;
}

// Accepts both `Task: ROT-12` (PR/commit trailer) and `Task: none — reason`
// (docs/process-only escape hatch). Returns a descriptor so the caller can
// distinguish "missing", "invalid", "key" and "none".
export function parseTaskDirective(body) {
  const match = TASK_DIRECTIVE_RE.exec(String(body ?? ""));
  if (!match) return { present: false, kind: "missing", raw: null };
  const value = match[1].trim();
  if (/^none\b/i.test(value)) {
    const reason = value
      .replace(/^none\b/i, "")
      .replace(/^[\s:—–-]+/, "")
      .trim();
    return { present: true, kind: "none", reason, raw: value };
  }
  const key = new RegExp(`^(${KEY_PREFIX}-[1-9]\\d*)\\b`, "i").exec(value);
  if (!key) return { present: true, kind: "invalid", raw: value };
  const number = issueNumberFromKey(key[1]);
  return { present: true, kind: "key", key: taskKey(number), number, raw: value };
}

export function closingIssueNumbers(body) {
  const numbers = [];
  for (const match of String(body ?? "").matchAll(CLOSING_RE)) {
    const number = Number(match[1]);
    if (!numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

export function isDocsOnly(files) {
  const list = Array.isArray(files) ? files : [];
  return list.length > 0 && list.every((file) => isDocsPath(normalizeFile(file)));
}

// Docs plus the process machinery that cannot be gated by a key before the
// first sync exists: scripts, workflows, the area map and the agent rules.
export function isProcessOnly(files) {
  const list = Array.isArray(files) ? files : [];
  return (
    list.length > 0 &&
    list.every((file) => {
      const normalized = normalizeFile(file);
      return isDocsPath(normalized) || PROCESS_PATH_RE.test(normalized);
    })
  );
}

// `docs/` and `openspec/` are documentation. A Markdown file counts only at
// the repository root: `apps/site/README.md` is product code and needs a task.
function isDocsPath(normalized) {
  return DOC_PATH_RE.test(normalized) || ROOT_MARKDOWN_RE.test(normalized);
}

function normalizeFile(file) {
  return String(file).replaceAll("\\", "/").replace(/^\.\//, "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Branch convention: `<type>/<change-id>-<slug>`. A longer registered change
// id that starts with this id (e.g. `wallet-mainnet-signing-erc20` after
// `wallet-mainnet-signing`) makes the branch ambiguous; the caller must then
// use `filesBelongToChange` instead of guessing.
export function branchMatchesChange(headRefName, changeId, changeIds = []) {
  const head = String(headRefName ?? "").replaceAll("\\", "/");
  const escaped = escapeRegExp(changeId);
  if (new RegExp(`(^|/)${escaped}(?=$|/)`).test(head)) return "match";
  if (!new RegExp(`(^|/)${escaped}-[a-z0-9]`, "i").test(head)) return "no";
  const longer = (changeIds ?? []).some(
    (id) => id !== changeId && id.startsWith(`${changeId}-`),
  );
  return longer ? "ambiguous" : "match";
}

export function filesBelongToChange(files, changeId) {
  return (files ?? []).some((file) =>
    normalizeFile(file).startsWith(`openspec/changes/${changeId}/`),
  );
}

// Pure verdict for a pull request. `issueExists` is true/false when the caller
// could check it, null when unknown (the CLI resolves it with `gh`; tests pass
// both values).
export function evaluateTaskLinks({ body, files, issueExists = null }) {
  const errors = [];
  const directive = parseTaskDirective(body);
  const docsOnly = isDocsOnly(files);
  const processOnly = isProcessOnly(files);

  if (!directive.present) {
    errors.push(
      "PR body must contain `Task: ROT-<n>` (or `Task: none — <reason>` for a docs/process-only PR).",
    );
    return { ok: false, errors, directive, docsOnly, processOnly };
  }

  if (directive.kind === "invalid") {
    errors.push(
      `\`Task:\` must name \`ROT-<n>\` or \`none\`; got: ${directive.raw}`,
    );
  }

  if (directive.kind === "none") {
    if (!directive.reason) {
      errors.push(
        "`Task: none` needs a reason after `—`, for example `Task: none — docs: fix a typo`.",
      );
    } else if (!processOnly) {
      errors.push(
        "`Task: none` is only allowed when every changed path is docs/process; this PR changes product code.",
      );
    }
  }

  if (directive.kind === "key") {
    if (issueExists === false) {
      errors.push(
        `task ${directive.key} does not exist: no issue #${directive.number} in this repository.`,
      );
    }
    if (!closingIssueNumbers(body).includes(directive.number)) {
      errors.push(
        `PR body must contain a closing reference to issue #${directive.number}, for example \`Closes #${directive.number}\`.`,
      );
    }
  }

  return { ok: errors.length === 0, errors, directive, docsOnly, processOnly };
}

// --- Board metadata: issue type, milestone, priority, severity -------------
//
// GitHub issue types (Task/Bug/Feature) and milestones are native fields, so a
// label must not duplicate them. `epic`, `area:<area>` and `change:<id>` stay:
// no native field expresses the OpenSpec grouping or the board area.

export function inferIssueType({ title = "", body = "", labels = [] } = {}) {
  const titleText = String(title);
  const bodyText = String(body);
  const names = labelsOf({ labels });
  const fromDefectLedger =
    /(?:docs\/process\/defects\.json|\bdefect:\s*\S+)/i.test(bodyText);
  if (/^fix\(/i.test(titleText) || /\bdefect\b/i.test(titleText) || fromDefectLedger) {
    return "Bug";
  }
  if (names.includes("epic")) return "Feature";
  if (
    names.some((name) => name.startsWith("change:")) ||
    /<!--\s*openspec-task:/i.test(bodyText)
  ) {
    return "Task";
  }
  return null;
}

// Milestones are releases. Epic mapping wins over area, so every issue of one
// OpenSpec change ships with its epic. The first matching entry in the file is
// the answer; `data/milestones.json` is the single source.
export function milestoneFor({ changeId = null, area = null, milestones = [] } = {}) {
  if (changeId) {
    const byEpic = milestones.find((milestone) =>
      (milestone.match?.epics ?? []).includes(changeId),
    );
    if (byEpic) return byEpic;
  }
  if (area) {
    const byArea = milestones.find((milestone) =>
      (milestone.match?.areas ?? []).includes(area),
    );
    if (byArea) return byArea;
  }
  return null;
}

export function declaredPriority(text) {
  const match = /\bPriority:\s*(P[0-3])\b/i.exec(String(text ?? ""));
  return match ? match[1].toUpperCase() : null;
}

export function declaredSeverity(text) {
  const match = /\bSeverity:\s*(S[1-4])\b/i.exec(String(text ?? ""));
  return match ? match[1].toUpperCase() : null;
}

// A `Priority: P2` / `Severity: S3` line is an issue's own declaration. The
// sync rewrites the body, so the generator must carry the line through.
export function declarationLines(body) {
  const lines = [];
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(?:Priority:\s*P[0-3]|Severity:\s*S[1-4])$/i.test(trimmed)) {
      if (!lines.includes(trimmed)) lines.push(trimmed);
    }
  }
  return lines;
}

export function priorityFor({ issue, isEpic = false, epicPriority = null } = {}) {
  const declared = declaredPriority(`${issue?.title ?? ""}\n${issue?.body ?? ""}`);
  if (declared) return declared;
  if (isEpic) return "P1";
  return epicPriority ?? "P1";
}

export function severityFor({ issue, issueType = null, epicSeverity = null } = {}) {
  const declared = declaredSeverity(`${issue?.title ?? ""}\n${issue?.body ?? ""}`);
  if (declared) return declared;
  if (issueType === "Bug") return "S2";
  return epicSeverity ?? "S-";
}

export function boardMetadataFor({
  issue,
  changeId = null,
  area = null,
  milestones = [],
}) {
  const type = inferIssueType(issue);
  const milestone = milestoneFor({ changeId, area, milestones });
  const warnings = [];
  const number = issue?.number ?? "?";
  const title = issue?.title ?? "";
  if (!type) {
    warnings.push(
      `issue #${number} "${title}": no issue-type rule matched; Type left unset`,
    );
  }
  if (!milestone) {
    warnings.push(
      `issue #${number} "${title}": no milestone rule matched; Milestone left unset`,
    );
  }
  return { type, milestone, warnings };
}

// A synced issue is one the board sync owns: an epic, an OpenSpec sub-issue,
// an area-labelled issue, or any issue whose title carries a ROT key. Manual
// issues without any of those markers are left alone.
export function isSyncManagedIssue(issue) {
  const names = labelsOf(issue);
  return (
    names.includes("epic") ||
    names.some((name) => name.startsWith("change:") || name.startsWith("area:")) ||
    /(?:^|\s)ROT-[1-9]\d*\b/.test(String(issue?.title ?? ""))
  );
}

export function changeIdForIssue(issue) {
  const label = labelsOf(issue).find((name) => name.startsWith("change:"));
  if (label) return label.slice("change:".length);
  const title = /^\[([^\]]+)\]/.exec(String(issue?.title ?? ""));
  return title ? title[1] : null;
}

export function parseBlockedByText(body) {
  const match = /^Blocked by:\s*(.+)$/m.exec(String(body ?? ""));
  if (!match) return [];
  const numbers = [];
  for (const found of match[1].matchAll(new RegExp(`\\b${KEY_PREFIX}-([1-9]\\d*)`, "gi"))) {
    const number = Number(found[1]);
    if (!numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

// `edges` are `{ from, to }` pairs where `from` depends on `to`. Returns one
// path per cycle, each path ending at its start (for example `[1, 2, 1]`).
export function findDependencyCycles(edges = []) {
  const adjacency = new Map();
  for (const edge of edges) {
    const from = Number(edge.from);
    const to = Number(edge.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
    if (!adjacency.has(from)) adjacency.set(from, []);
    if (!adjacency.get(from).includes(to)) adjacency.get(from).push(to);
  }

  const state = new Map(); // 0 unvisited, 1 on stack, 2 done
  const stack = [];
  const cycles = [];
  const seenCycles = new Set();

  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!state.has(next)) {
        visit(next);
      } else if (state.get(next) === 1) {
        const start = stack.indexOf(next);
        const cycle = [...stack.slice(start), next];
        const key = cycle.join(">");
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push(cycle);
        }
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of adjacency.keys()) {
    if (!state.has(node)) visit(node);
  }
  return cycles;
}

// Plan vs fact: `days` is closedAt minus the milestone due date (negative or
// zero is on time). The sync reports this; it never writes it back.
export function targetDelta(targetDate, actualDate) {
  const target = String(targetDate ?? "").slice(0, 10);
  const actual = String(actualDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target) || !/^\d{4}-\d{2}-\d{2}$/.test(actual)) {
    return null;
  }
  const days = Math.round(
    (Date.parse(`${actual}T00:00:00Z`) - Date.parse(`${target}T00:00:00Z`)) / 86400000,
  );
  return {
    days,
    verdict: days <= 0 ? "on time" : `late by ${days} day${days === 1 ? "" : "s"}`,
  };
}

// Board gate. `projectItems` is a map of issue number -> project field values
// (`{ priority, severity, startDate, targetDate, actualStart, actualEnd }`);
// `allowlist` is the parsed `data/board-exceptions.json` and may only name
// historical closed issues. Every synced issue must have a native Type, a
// Milestone, a non-empty Priority and both plan dates (Start date, Target
// date); a closed issue must also carry both actual dates. Its text blockers
// must equal its native blockedBy links; no open issue may be blocked by a
// closed one; the native graph must be acyclic; every issue of one change must
// share one milestone; and every milestone in data/milestones.json must have a
// due date.
export function evaluateBoardFields({
  issues = [],
  allowlist = [],
  milestones = [],
  projectItems = {},
} = {}) {
  const entries = Array.isArray(allowlist) ? allowlist : allowlist?.entries ?? [];
  const allowed = new Map();
  const errors = [];

  for (const entry of entries) {
    const number = Number(entry?.number);
    if (!Number.isInteger(number) || number <= 0) {
      errors.push(
        `board allowlist entry needs a positive issue number: ${JSON.stringify(entry)}`,
      );
      continue;
    }
    if (!String(entry?.reason ?? "").trim()) {
      errors.push(`board allowlist entry #${number} needs a reason.`);
      continue;
    }
    allowed.set(number, entry.reason);
  }

  const milestoneTitles = new Set((milestones ?? []).map((entry) => entry.title));
  for (const milestone of milestones ?? []) {
    if (!String(milestone?.due ?? "").trim()) {
      errors.push(
        `milestone "${milestone?.title ?? "(untitled)"}" has no due date; every release milestone needs one for the Roadmap.`,
      );
    }
  }
  const byNumber = new Map();
  const byChange = new Map();
  let checked = 0;
  let skipped = 0;
  const edges = [];

  for (const issue of issues) {
    if (!isSyncManagedIssue(issue)) continue;
    checked += 1;
    const number = Number(issue.number);
    byNumber.set(number, issue);
    const allow = allowed.has(number);
    if (allow) {
      skipped += 1;
      if (issue.state === "OPEN") {
        errors.push(
          `board allowlist entry #${number} is an open issue; only historical closed issues may be allowlisted.`,
        );
      }
    }

    const typeName =
      typeof issue.issueType === "string"
        ? issue.issueType
        : issue.issueType?.name ?? null;
    const milestone =
      typeof issue.milestone === "string"
        ? issue.milestone
        : issue.milestone?.title ?? null;
    const priority = projectItems?.[number]?.priority ?? null;
    const targetDate = projectItems?.[number]?.targetDate ?? null;
    const startDate = projectItems?.[number]?.startDate ?? null;
    const actualStart = projectItems?.[number]?.actualStart ?? null;
    const actualEnd = projectItems?.[number]?.actualEnd ?? null;

    if (!allow) {
      if (!typeName) {
        errors.push(
          `issue #${number} "${issue.title}" has no issue Type; add a rule in data/milestones.json or set it in the sync.`,
        );
      }
      if (!milestone) {
        errors.push(
          `issue #${number} "${issue.title}" has no Milestone; map its epic or area in data/milestones.json.`,
        );
      } else if (milestoneTitles.size > 0 && !milestoneTitles.has(milestone)) {
        errors.push(
          `issue #${number} "${issue.title}" has milestone "${milestone}", which is not in data/milestones.json.`,
        );
      }
      if (!priority) {
        errors.push(
          `issue #${number} "${issue.title}" has no Priority; the sync must never leave it empty.`,
        );
      }
      if (!startDate) {
        errors.push(
          `issue #${number} "${issue.title}" has no Plan start (Start date); the Roadmap bar needs both ends.`,
        );
      }
      if (!targetDate) {
        errors.push(
          `issue #${number} "${issue.title}" has no Plan end (Target date); the Roadmap bar needs both ends.`,
        );
      }
      if (issue.state === "CLOSED") {
        if (!actualStart) {
          errors.push(
            `issue #${number} "${issue.title}" is closed but has no Actual start.`,
          );
        }
        if (!actualEnd) {
          errors.push(
            `issue #${number} "${issue.title}" is closed but has no Actual end.`,
          );
        }
      }
    }

    const changeId = changeIdForIssue(issue);
    if (changeId && !allow) {
      if (!byChange.has(changeId)) byChange.set(changeId, []);
      byChange.get(changeId).push({ number, title: issue.title, milestone });
    }

    const native = (issue.blockedBy ?? []).map((blocker) => ({
      number: Number(blocker.number ?? blocker),
      state: blocker.state ?? null,
    }));
    if (issue.state === "OPEN") {
      for (const blocker of native) {
        edges.push({ from: number, to: blocker.number });
        if (!allow && blocker.state === "CLOSED") {
          errors.push(
            `issue #${number} "${issue.title}" is open but blocked by closed issue #${blocker.number}.`,
          );
        }
      }
    }

    if (!allow && issue.state === "OPEN") {
      const text = parseBlockedByText(issue.body).sort((a, b) => a - b);
      const linked = native.map((blocker) => blocker.number).sort((a, b) => a - b);
      if (text.join(",") !== linked.join(",")) {
        errors.push(
          `issue #${number} "${issue.title}" text blockers (${text.join(", ") || "none"}) ` +
            `disagree with native blockedBy links (${linked.join(", ") || "none"}).`,
        );
      }
    }
  }

  for (const [changeId, group] of byChange) {
    if (group.length < 2) continue;
    const titles = [...new Set(group.map((entry) => entry.milestone ?? "(none)"))];
    if (titles.length > 1) {
      errors.push(
        `change ${changeId} spans milestones ${titles.join(", ")}; every issue of one epic must share one release milestone (${group
          .map((entry) => `#${entry.number}`)
          .join(", ")}).`,
      );
    }
  }

  for (const cycle of findDependencyCycles(edges)) {
    errors.push(`dependency cycle: ${cycle.map((number) => `#${number}`).join(" -> ")}.`);
  }

  return { ok: errors.length === 0, errors, checked, skipped, edges };
}

// Open issue metadata over GraphQL: gh issue list cannot select issueType.
// The caller injects ghJson, so this module still performs no network calls.
export function listIssueMetadata({ ghJson, owner, name, states = ["OPEN"] }) {
  const stateArg = states.map((state) => String(state).toUpperCase()).join(",");
  const query = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,states:[${stateArg}],orderBy:{field:CREATED_AT,direction:ASC}){pageInfo{hasNextPage endCursor}nodes{number id title body url state createdAt closedAt issueType{name} milestone{title} labels(first:50){nodes{name}} blockedBy(first:50){nodes{number state title}}}}}}`;
  const issues = [];
  let cursor = null;
  for (;;) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const result = ghJson(args);
    if (result?.errors?.length) {
      throw new Error(
        `GraphQL issue listing failed: ${result.errors.map((error) => error.message).join("; ")}`,
      );
    }
    const page = result?.data?.repository?.issues;
    for (const node of page?.nodes ?? []) {
      issues.push({
        number: Number(node.number),
        id: node.id,
        title: node.title ?? "",
        body: node.body ?? "",
        url: node.url ?? null,
        state: node.state ?? "OPEN",
        createdAt: node.createdAt ?? null,
        closedAt: node.closedAt ?? null,
        issueType: node.issueType?.name ?? null,
        milestone: node.milestone?.title ?? null,
        labels: (node.labels?.nodes ?? []).map((label) => label.name),
        blockedBy: (node.blockedBy?.nodes ?? []).map((blocker) => ({
          number: Number(blocker.number),
          state: blocker.state ?? null,
          title: blocker.title ?? "",
        })),
      });
    }
    if (!page?.pageInfo?.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return issues;
}

export function slugify(text) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "task";
}

export function parseTasksMarkdown(markdown) {
  const sections = [];
  let current = null;

  const startSection = (heading) => {
    const { number, title } = headingParts(heading);
    const blockedByRaw = blockedByText(heading);
    current = {
      heading,
      number,
      title,
      blockedByRaw,
      blockers: parseBlockers(blockedByRaw),
      checkboxes: [],
    };
    sections.push(current);
  };

  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      startSection(heading[1]);
      continue;
    }
    const checkbox = /^\s*[-*]\s*\[([ xX])\]\s+(.*)$/.exec(line);
    if (!checkbox) continue;
    if (!current) startSection("Tasks");
    current.checkboxes.push({
      checked: checkbox[1].toLowerCase() === "x",
      text: checkbox[2].trim(),
    });
  }

  const usedSlugs = new Set();
  for (const section of sections) {
    section.slug = uniqueSlug(section.title, usedSlugs);
    section.total = section.checkboxes.length;
    section.done = section.checkboxes.filter((box) => box.checked).length;
    section.hasUnchecked = section.done < section.total;
    section.excluded = NON_TASK_TITLE_RE.test(section.title);
  }
  return { sections };
}

function headingParts(heading) {
  let text = heading
    .replace(/\([^)]*blocked by:[^)]*\)/gi, " ")
    .replace(/(\s*\[[^\]]*\])+\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let number = /^(\d+[a-z]?)[.)]?\s/i.exec(text)?.[1] ?? null;
  if (!number) number = /^(?:phase|slice|step)\s+(\d+[a-z]?)\b/i.exec(text)?.[1] ?? null;
  if (!number) number = /^p(\d+)\b/i.exec(text)?.[1] ?? null;
  if (!number) number = /^t(\d+)\b/i.exec(text)?.[1] ?? null;

  text = text
    .replace(/^\d+[a-z]?[.)]\s*/i, "")
    .replace(/^(?:phase|slice|step)\s+\d+[a-z]?\s*[-–—:]\s*/i, "")
    .replace(/^p\d+\s*[-–—:]\s*/i, "")
    .replace(/^t\d+\s*[-–—:]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return { number, title: text || heading.trim() };
}

function blockedByText(heading) {
  const match = /\([^)]*\bblocked by:\s*([^)]*)\)/i.exec(heading);
  return match ? match[1].trim() : "";
}

function uniqueSlug(title, used) {
  const base = slugify(title);
  let slug = base;
  let index = 2;
  while (used.has(slug)) {
    slug = `${base}-${index}`;
    index += 1;
  }
  used.add(slug);
  return slug;
}

export function parseBlockers(raw) {
  const result = { sectionNumbers: [], keys: [], unresolved: [], notes: [] };
  const text = String(raw ?? "").trim();
  if (!text || /^[—–-]+$/.test(text)) return result;

  for (const token of text.split(/[,;]/).map((part) => part.trim()).filter(Boolean)) {
    if (/^[—–-]+$/.test(token)) continue;
    if (expandRange(token, result)) continue;

    const hash = /^#([1-9]\d*)$/.exec(token);
    if (hash) {
      result.keys.push(taskKey(Number(hash[1])));
      continue;
    }

    const key = new RegExp(`(?:^|\\s)(${KEY_PREFIX}-[1-9]\\d*)(?:\\b|$)`, "i").exec(token);
    if (key) {
      result.keys.push(taskKey(issueNumberFromKey(key[1])));
      continue;
    }

    const number = /^(?:T)?(\d+[a-z]?)$/i.exec(token);
    if (number) {
      result.sectionNumbers.push(number[1]);
      continue;
    }

    if (SOFT_NOTE_RE.test(token) || ROLE_NOTE_RE.test(token)) result.notes.push(token);
    else result.unresolved.push(token);
  }
  return result;
}

function expandRange(token, result) {
  const match = /^(?:T)?(\d+)[a-z]?\s*[-–—]\s*(?:T)?(\d+)[a-z]?$/i.exec(token);
  if (!match) return false;
  let from = Number(match[1]);
  let to = Number(match[2]);
  if (to < from) [from, to] = [to, from];
  if (to - from > 50) {
    result.unresolved.push(token);
    return true;
  }
  for (let number = from; number <= to; number += 1) {
    result.sectionNumbers.push(String(number));
  }
  return true;
}

// `keyBySectionNumber` maps a tasks.md section number ("1", "4a") to its issue
// key. A suffix such as `4a` falls back to section 4; a section cannot block
// itself (guards against a typo turning into a self-loop).
export function resolveBlockedBy(blockers, keyBySectionNumber, currentNumber = null) {
  const keys = [];
  const unresolved = [];

  const pushKey = (key) => {
    if (key && !keys.includes(key)) keys.push(key);
  };

  for (const raw of blockers.sectionNumbers) {
    const key = lookupSection(raw, keyBySectionNumber);
    const base = raw.replace(/[a-z]+$/i, "");
    if (!key) unresolved.push(raw);
    else if (currentNumber && base === currentNumber.replace(/[a-z]+$/i, "")) {
      unresolved.push(`${raw} (self)`);
    } else pushKey(key);
  }
  for (const key of blockers.keys) pushKey(key);
  for (const value of blockers.unresolved) {
    if (!unresolved.includes(value)) unresolved.push(value);
  }
  return {
    keys,
    unresolved,
    notes: [...new Set(blockers.notes ?? [])],
  };
}

function lookupSection(raw, keyBySectionNumber) {
  if (keyBySectionNumber.has(raw)) return keyBySectionNumber.get(raw);
  const base = raw.replace(/[a-z]+$/i, "");
  if (base !== raw && keyBySectionNumber.has(base)) return keyBySectionNumber.get(base);
  return null;
}

// Human-readable `§2 <- §1` / `§2 <- ROT-11 (#11)` line for the dry-run plan.
function blockerEdge(task, resolved, keyBySectionNumber) {
  const current = task.number ? `§${task.number}` : "(no section number)";
  const parts = [];
  const represented = new Set();
  const push = (value) => {
    if (!parts.includes(value)) parts.push(value);
  };

  for (const number of task.blockers.sectionNumbers) {
    const key = lookupSection(number, keyBySectionNumber);
    if (key) {
      push(`${key} (#${issueNumberFromKey(key)})`);
      represented.add(key);
    } else if (resolved.unresolved.includes(`${number} (self)`)) {
      push(`unresolved: ${number} (self)`);
      represented.add(`${number} (self)`);
    } else {
      push(`§${number}`);
      represented.add(number);
    }
  }
  for (const key of task.blockers.keys) push(`${key} (#${issueNumberFromKey(key)})`);
  for (const value of task.blockers.unresolved) {
    push(`unresolved: ${value}`);
    represented.add(value);
  }
  for (const value of resolved.unresolved) {
    if (represented.has(value)) continue;
    if (value.endsWith(" (self)")) continue;
    push(`unresolved: ${value}`);
  }
  return parts.length > 0 ? `${current} <- ${parts.join(", ")}` : null;
}

export function subIssueBody({
  changeId,
  epicNumber,
  task,
  blockedBy = [],
  unresolved = [],
  notes = [],
  declarations = [],
}) {
  const epic = epicNumber ? `epic #${epicNumber}` : `the \`${changeId}\` epic`;
  const lines = [
    `Part of ${epic}.`,
    "",
    `Source: \`openspec/changes/${changeId}/tasks.md\`${
      task.number ? ` § ${task.number}` : ""
    } — ${task.title}`,
    `Checkboxes: ${task.done}/${task.total} done.`,
    "",
  ];
  if (blockedBy.length > 0) {
    lines.push(
      `Blocked by: ${blockedBy
        .map((key) => `${key} (#${issueNumberFromKey(key)})`)
        .join(", ")}`,
    );
  }
  if (unresolved.length > 0) {
    lines.push(`Blocked by (unresolved): ${unresolved.join(", ")}`);
  }
  if (notes.length > 0) lines.push(`Notes: ${notes.join(", ")}`);
  if (declarations.length > 0) lines.push(...declarations);
  if (blockedBy.length + unresolved.length + notes.length + declarations.length > 0) {
    lines.push("");
  }
  lines.push(`<!-- openspec-task: ${changeId}/${task.slug} -->`);
  return `${lines.join("\n")}\n`;
}

export function epicBody({
  change,
  subIssues,
  planned = 0,
  percent,
  repoUrl,
  declarations = [],
}) {
  const closed = subIssues.filter((issue) => issue.state === "CLOSED").length;
  const total = subIssues.length;
  const progress =
    total > 0
      ? `Progress: ${closed}/${total} sub-issues closed (${percent}%)`
      : `Progress: no sub-issues; ${percent}% of checkboxes done`;
  const lines = [
    `Folder: [\`${change.folder}/\`](${repoUrl}/tree/main/${change.folder})`,
    "",
    progress,
  ];
  if (declarations.length > 0) {
    lines.push("", ...declarations);
  }
  if (total > 0) {
    lines.push("", "Sub-issues:");
    for (const issue of subIssues) {
      const box = issue.state === "CLOSED" ? "x" : " ";
      lines.push(`- [${box}] ${issue.key} — ${issue.title}`);
    }
  }
  if (planned > 0) {
    lines.push("", `Sub-issues planned by this run: ${planned}.`);
  }
  const unresolved = subIssues.flatMap((issue) =>
    (issue.unresolved ?? []).map((value) => `${issue.key}: ${value}`),
  );
  if (unresolved.length > 0) {
    lines.push("", `Unresolved blockers: ${unresolved.join("; ")}`);
  }
  lines.push(
    "",
    `Source of truth: \`${change.folder}/tasks.md\``,
    "",
    `<!-- openspec-change: ${change.id} -->`,
  );
  if (change.defaultArea) lines.push("", "<!-- area-default: site -->");
  return `${lines.join("\n")}\n`;
}

function issueNumberFromUrl(url) {
  const match = /\/issues\/(\d+)$/.exec(String(url).trim());
  if (!match) throw new Error(`cannot parse issue number from ${url}`);
  return Number(match[1]);
}

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}

function markersFor(changeId, issue) {
  const match = TASK_MARKER_RE.exec(issue.body ?? "");
  if (!match || match[1] !== changeId) return null;
  return match[2];
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3).trimEnd()}...`;
}

// Create or update the sub-issues of one OpenSpec change. Existing issues are
// found by the body marker `<!-- openspec-task: <change>/<slug> -->`, so a
// second run edits instead of creating. It never closes or deletes an issue.
//
// `gh` and `ghJson` are the only side-effecting dependencies; a test passes a
// fake pair and asserts create-once/edit-on-change. `tempDir` must exist.
export function syncChangeTasks({
  changeId,
  epicNumber = null,
  tasks,
  existingIssues = [],
  gh,
  ghJson,
  repo,
  dryRun = false,
  tempDir,
  log = () => {},
  areaForTask = () => null,
  ensureLabel = () => {},
  onPlanned = () => {},
}) {
  const bySlug = new Map();
  for (const issue of existingIssues) {
    const slug = markersFor(changeId, issue);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, issue);
  }

  const candidates = tasks.filter(
    (task) =>
      task.total > 0 && !task.excluded && (task.hasUnchecked || bySlug.has(task.slug)),
  );

  const records = [];
  let created = 0;

  for (const task of candidates) {
    let issue = bySlug.get(task.slug) ?? null;
    if (!issue) {
      created += 1;
      if (dryRun) {
        log(`[dry-run] create sub-issue ${changeId}/${task.slug}: "${task.title}"`);
        onPlanned({ changeId, slug: task.slug, title: task.title, task });
        issue = { number: null, url: null, state: "OPEN", title: "", body: "" };
      } else {
        const area = areaForTask(task) ?? null;
        const labels = [`change:${changeId}`];
        if (area) labels.push(`area:${area}`);
        for (const label of labels) ensureLabel(label);
        const bodyPath = path.join(tempDir, `sub-${changeId}-${task.slug}.md`);
        fs.writeFileSync(
          bodyPath,
          `<!-- openspec-task: ${changeId}/${task.slug} -->\n`,
        );
        const args = [
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          truncate(task.title, 120),
          "--body-file",
          bodyPath,
        ];
        for (const label of labels) args.push("--label", label);
        const url = gh(args);
        const number = issueNumberFromUrl(url);
        issue = {
          number,
          url,
          state: "OPEN",
          title: task.title,
          body: "",
          labels,
        };
        log(`created sub-issue #${number} (${changeId}/${task.slug})`);
      }
    }
    records.push({ task, issue });
  }

  const keyByNumber = new Map();
  for (const record of records) {
    if (record.issue.number && record.task.number) {
      keyByNumber.set(record.task.number, taskKey(record.issue.number));
    }
  }

  let updated = 0;
  let unchanged = 0;
  const subIssues = [];

  for (const record of records) {
    const resolved = resolveBlockedBy(
      record.task.blockers,
      keyByNumber,
      record.task.number,
    );

    if (dryRun) {
      const edge = blockerEdge(record.task, resolved, keyByNumber);
      if (edge) log(`[dry-run] blockers ${changeId}/${record.task.slug}: ${edge}`);
    } else if (resolved.unresolved.length > 0) {
      log(
        `blocker report ${changeId}/${record.task.slug}: unresolved ` +
          resolved.unresolved.join(", "),
      );
    }

    if (!record.issue.number) continue;

    const key = taskKey(record.issue.number);
    const title = truncate(`${key} — ${record.task.title}`, 200);
    const body = subIssueBody({
      changeId,
      epicNumber,
      task: record.task,
      blockedBy: resolved.keys,
      unresolved: resolved.unresolved,
      notes: resolved.notes,
      declarations: declarationLines(record.issue.body),
    });
    const area = areaForTask(record.task) ?? null;
    const currentLabels = labelsOf(record.issue);
    const needsEdit =
      record.issue.title !== title ||
      (record.issue.body ?? "").trim() !== body.trim() ||
      !currentLabels.includes(`change:${changeId}`) ||
      (area && !currentLabels.includes(`area:${area}`));

    if (needsEdit) {
      updated += 1;
      if (dryRun) {
        log(`[dry-run] update sub-issue #${record.issue.number} (${changeId}/${record.task.slug})`);
      } else {
        const bodyPath = path.join(
          tempDir,
          `sub-${changeId}-${record.task.slug}.md`,
        );
        fs.writeFileSync(bodyPath, body);
        const args = [
          "issue",
          "edit",
          String(record.issue.number),
          "--repo",
          repo,
          "--title",
          title,
          "--body-file",
          bodyPath,
          "--add-label",
          `change:${changeId}`,
        ];
        if (area) args.push("--add-label", `area:${area}`);
        for (const label of currentLabels) {
          if (label.startsWith("area:") && label !== `area:${area}`) {
            args.push("--remove-label", label);
          }
        }
        gh(args);
        log(`updated sub-issue #${record.issue.number} (${key})`);
      }
    } else {
      unchanged += 1;
    }

    subIssues.push({
      number: record.issue.number,
      key,
      title: record.task.title,
      url: record.issue.url,
      state: record.issue.state ?? "OPEN",
      area,
      task: record.task,
      blockedBy: resolved.keys,
      unresolved: resolved.unresolved,
      notes: resolved.notes,
      created: record.issue.title === record.task.title,
    });
  }

  if (dryRun) {
    for (const record of records) {
      if (record.issue.number || epicNumber === null) continue;
      log(
        `[dry-run] link sub-issue for ${changeId}/${record.task.slug} under epic #${epicNumber}`,
      );
    }
  }

  return {
    changeId,
    created,
    updated,
    unchanged,
    subIssues,
    planned: records.filter((record) => !record.issue.number).length,
  };
}

// Archive project items for pull requests that are no longer open, so the
// board keeps only open PR cards and the epics carry the history. Issue items
// are never touched. The state is read from the item when the item-list output
// carries it, otherwise with `gh pr view`; a read failure is reported and the
// item is left in place.
export function archiveStalePullRequestItems({
  items,
  openPullRequestNumbers,
  projectId,
  ghJson,
  repo,
  dryRun = false,
  log = () => {},
}) {
  const open =
    openPullRequestNumbers instanceof Set
      ? openPullRequestNumbers
      : new Set(openPullRequestNumbers ?? []);
  let archived = 0;

  for (const item of items ?? []) {
    const url = item.content?.url ?? item.url ?? "";
    const match = /\/pull\/(\d+)$/.exec(url);
    if (!match) continue;
    const number = Number(match[1]);
    if (open.has(number)) continue;

    let state = item.content?.state ?? null;
    if (!state) {
      try {
        state =
          ghJson(["pr", "view", String(number), "--repo", repo, "--json", "state"])
            ?.state ?? null;
      } catch (error) {
        log(`warning: cannot read PR #${number} state: ${error.message}`);
        continue;
      }
    }
    if (state === "OPEN") continue;
    if (!item.id || !projectId) {
      throw new Error(
        `cannot archive the project item for PR #${number}: missing item or project id`,
      );
    }

    if (dryRun) {
      log(`[dry-run] archive project item for PR #${number} (${state ?? "unknown"})`);
      archived += 1;
      continue;
    }

    const mutation =
      "mutation($projectId:ID!,$itemId:ID!){archiveProjectV2Item(input:{projectId:$projectId,itemId:$itemId}){item{id}}}";
    const result = ghJson([
      "api",
      "graphql",
      "-f",
      `query=${mutation}`,
      "-f",
      `projectId=${projectId}`,
      "-f",
      `itemId=${item.id}`,
    ]);
    if (result?.errors?.length) {
      throw new Error(
        `cannot archive the project item for PR #${number}: ` +
          result.errors.map((error) => error.message).join("; "),
      );
    }
    log(`archived project item for PR #${number} (${state ?? "unknown"})`);
    archived += 1;
  }

  return { archived };
}

// Link a sub-issue under its epic with GitHub's native sub-issue API. GraphQL
// is the only supported path (`gh issue edit` cannot do it). A failed query,
// mutation error or missing id throws with the issue numbers in the message;
// the caller decides whether a link failure should abort the sync.
export function linkSubIssueToEpic({
  ghJson,
  repo,
  epicNumber,
  epicId = null,
  subIssueNumber,
  dryRun = false,
  log = () => {},
}) {
  if (dryRun) {
    log(`[dry-run] link sub-issue #${subIssueNumber} under epic #${epicNumber}`);
    return false;
  }
  const [owner, name] = String(repo).split("/");
  if (!owner || !name) throw new Error(`invalid repository "${repo}"`);

  const query =
    "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id parent{number}}}}";
  const result = ghJson([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${subIssueNumber}`,
  ]);
  if (result?.errors?.length) {
    throw new Error(
      `GraphQL query failed for issue #${subIssueNumber}: ` +
        result.errors.map((error) => error.message).join("; "),
    );
  }
  const issue = result?.data?.repository?.issue;
  if (!issue?.id) {
    throw new Error(`cannot resolve issue #${subIssueNumber} via GraphQL`);
  }
  if (issue.parent?.number === epicNumber) return false;

  let targetEpicId = epicId;
  if (!targetEpicId) {
    const epicQuery =
      "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id}}}";
    const epicResult = ghJson([
      "api",
      "graphql",
      "-f",
      `query=${epicQuery}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${epicNumber}`,
    ]);
    if (epicResult?.errors?.length) {
      throw new Error(
        `GraphQL query failed for epic #${epicNumber}: ` +
          epicResult.errors.map((error) => error.message).join("; "),
      );
    }
    targetEpicId = epicResult?.data?.repository?.issue?.id ?? null;
  }
  if (!targetEpicId) {
    throw new Error(`cannot resolve epic #${epicNumber} via GraphQL`);
  }

  const mutation =
    "mutation($issueId:ID!,$subIssueId:ID!){addSubIssue(input:{issueId:$issueId,subIssueId:$subIssueId}){subIssue{number}}}";
  const linked = ghJson([
    "api",
    "graphql",
    "-f",
    `query=${mutation}`,
    "-f",
    `issueId=${targetEpicId}`,
    "-f",
    `subIssueId=${issue.id}`,
  ]);
  if (linked?.errors?.length) {
    throw new Error(
      `cannot link issue #${subIssueNumber} under epic #${epicNumber}: ` +
        linked.errors.map((error) => error.message).join("; "),
    );
  }
  log(`linked sub-issue #${subIssueNumber} under epic #${epicNumber}`);
  return true;
}
