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
const DOC_PATH_RE = /^(?:docs\/|openspec\/)|\.(?:md|mdx)$/i;
const PROCESS_PATH_RE =
  /^(?:scripts\/|\.github\/)|^(?:projects\.json|AGENTS\.md|PROJECTS\.md)$/;

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
  return (
    list.length > 0 &&
    list.every((file) => DOC_PATH_RE.test(normalizeFile(file)))
  );
}

// Docs plus the process machinery that cannot be gated by a key before the
// first sync exists: scripts, workflows, the area map and the agent rules.
export function isProcessOnly(files) {
  const list = Array.isArray(files) ? files : [];
  return (
    list.length > 0 &&
    list.every((file) => {
      const normalized = normalizeFile(file);
      return DOC_PATH_RE.test(normalized) || PROCESS_PATH_RE.test(normalized);
    })
  );
}

function normalizeFile(file) {
  return String(file).replaceAll("\\", "/").replace(/^\.\//, "");
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

export function subIssueBody({
  changeId,
  epicNumber,
  task,
  blockedBy = [],
  unresolved = [],
  notes = [],
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
  if (blockedBy.length + unresolved.length + notes.length > 0) lines.push("");
  lines.push(`<!-- openspec-task: ${changeId}/${task.slug} -->`);
  return `${lines.join("\n")}\n`;
}

export function epicBody({
  change,
  subIssues,
  planned = 0,
  percent,
  repoUrl,
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

    if (!record.issue.number) {
      if (record.task.blockers.sectionNumbers.length > 0 || resolved.keys.length > 0) {
        log(
          `[dry-run] set blockers on ${changeId}/${record.task.slug}: ` +
            `${
              resolved.keys.join(", ") ||
              record.task.blockers.sectionNumbers.map((value) => `§${value}`).join(", ")
            }`,
        );
      }
      continue;
    }

    const key = taskKey(record.issue.number);
    const title = truncate(`${key} — ${record.task.title}`, 200);
    const body = subIssueBody({
      changeId,
      epicNumber,
      task: record.task,
      blockedBy: resolved.keys,
      unresolved: resolved.unresolved,
      notes: resolved.notes,
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
