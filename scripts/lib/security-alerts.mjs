// Security-alert routing and lifecycle, without network access.
//
// One GitHub issue per open GitHub security alert (code scanning, Dependabot,
// secret scanning), deduplicated by a hidden marker in the issue body. The
// module is pure so the planner can be tested and the CLI can run a real
// `--dry-run` against the repository without mutating anything.
//
// The CLI is `scripts/security-alerts-sync.mjs`; the convention is
// `docs/process/security-alerts.md`.

import { milestoneFor } from "./task-tracking.mjs";

export const ALERT_KINDS = ["code-scanning", "dependabot", "secret-scanning"];

export const KIND_LABELS = {
  "code-scanning": "code scanning",
  dependabot: "Dependabot",
  "secret-scanning": "secret scanning",
};

// `data/milestones.json` is the source for release names; the security issue
// itself is routed by area, never by an OpenSpec change.
export const SEVERITY_TO_PRIORITY = {
  critical: "P0",
  high: "P0",
  medium: "P1",
  low: "P2",
};
export const PRIORITY_TO_SEVERITY = {
  P0: "S1",
  P1: "S2",
  P2: "S3",
  P3: "S4",
};

// Area inference is deliberately ordered: `src/coordinator/` must win over
// the general `src/` rule. The mapping follows AGENTS.md: crates are owned by
// the coordinator area, deploy and .github by infra.
const AREA_RULES = [
  { area: "site", prefixes: ["apps/site/", "web/", "data/"] },
  {
    area: "coordinator",
    prefixes: [
      "src/coordinator/",
      "src/bin/rotor-coord",
      "tests/coordinator_",
      "crates/",
    ],
  },
  {
    area: "desktop",
    prefixes: [
      "src/",
      "tests/",
      "Rotor-Cuda/",
      "BinSort/",
      "Others/",
      "Release/",
    ],
    files: ["build.rs", "Cargo.toml", "Cargo.lock"],
  },
  { area: "infra", prefixes: [".github/", "deploy/", "scripts/"] },
  { area: "docs", prefixes: ["docs/", "openspec/"] },
  { area: "design", prefixes: ["design/"] },
];

export function normalizePath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

export function inferArea(file) {
  const path = normalizePath(file);
  if (!path) return "infra";
  for (const rule of AREA_RULES) {
    if (rule.prefixes?.some((prefix) => path.startsWith(prefix))) return rule.area;
    if (rule.files?.includes(path)) return rule.area;
  }
  return "infra";
}

export function priorityForSeverity(severity) {
  return SEVERITY_TO_PRIORITY[String(severity ?? "").toLowerCase()] ?? "P2";
}

export function severityFieldForPriority(priority) {
  return PRIORITY_TO_SEVERITY[String(priority ?? "").toUpperCase()] ?? "S4";
}

export function markerFor(kind, number) {
  return `<!-- security-alert:${kind}:${Number(number)} -->`;
}

export function markerKey(kind, number) {
  return `${kind}:${Number(number)}`;
}

const MARKER_RE = /<!--\s*security-alert:(code-scanning|dependabot|secret-scanning):([1-9]\d*)\s*-->/i;

export function parseMarker(body) {
  const match = MARKER_RE.exec(String(body ?? ""));
  if (!match) return null;
  const kind = match[1].toLowerCase();
  const number = Number(match[2]);
  return { kind, number, key: markerKey(kind, number) };
}

export function reopenNoticeMarker(kind, number) {
  return `<!-- security-alert-reopen:${kind}:${Number(number)} -->`;
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function tableCell(value) {
  return text(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function short(value, max = 120) {
  const line = text(value).replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line;
}

function lineSuffix(file, line) {
  const path = normalizePath(file);
  if (!path) return "(unknown path)";
  return line ? `${path}:${line}` : path;
}

function codeScanningSeverity(alert) {
  const security = text(alert?.rule?.security_severity_level).toLowerCase();
  if (security) return security;
  const legacy = text(alert?.rule?.severity).toLowerCase();
  if (legacy === "error") return "high";
  if (legacy === "warning") return "medium";
  if (legacy === "note" || legacy === "recommendation") return "low";
  return "unknown";
}

// Normalizes one API alert into the facts the planner and the issue body use.
// Returns null for malformed records: a missing number would break the marker
// and therefore idempotency.
export function normalizeAlert(kind, alert) {
  if (!alert || !Number.isInteger(Number(alert.number)) || Number(alert.number) <= 0) {
    return null;
  }
  const number = Number(alert.number);
  const state = text(alert.state).toLowerCase() || "open";
  const base = {
    kind,
    number,
    state,
    marker: markerFor(kind, number),
    key: markerKey(kind, number),
    url: text(alert.html_url) || null,
    firstSeen: iso(alert.created_at),
    closedAt:
      iso(alert.dismissed_at) || iso(alert.fixed_at) || iso(alert.resolved_at),
    dismissedBy: null,
    dismissedReason: null,
    dismissedComment: null,
    resolvedBy: null,
    resolution: null,
    resolutionComment: null,
    fixedAt: iso(alert.fixed_at),
    path: "",
    line: null,
    severity: "unknown",
    rule: "",
    summary: "",
  };

  if (kind === "code-scanning") {
    const location = alert.most_recent_instance?.location ?? {};
    const message = alert.most_recent_instance?.message ?? {};
    return {
      ...base,
      severity: codeScanningSeverity(alert),
      rule: text(alert.rule?.id) || text(alert.rule?.name) || "code-scanning-rule",
      path: normalizePath(location.path),
      line: location.start_line ?? null,
      summary: text(message.text) || text(alert.rule?.description),
      dismissedBy: text(alert.dismissed_by?.login) || null,
      dismissedReason: text(alert.dismissed_reason) || null,
      dismissedComment: text(alert.dismissed_comment) || null,
    };
  }

  if (kind === "dependabot") {
    const advisory = alert.security_advisory ?? {};
    const vulnerability = alert.security_vulnerability ?? {};
    const dependency = alert.dependency ?? {};
    const packageName =
      text(vulnerability.package?.name) ||
      text(dependency.package?.name) ||
      text(advisory.summary) ||
      "dependency";
    return {
      ...base,
      severity:
        text(advisory.severity).toLowerCase() ||
        text(vulnerability.severity).toLowerCase() ||
        "unknown",
      rule:
        text(advisory.ghsa_id) ||
        text(advisory.cve_id) ||
        "dependency-vulnerability",
      path: normalizePath(dependency.manifest_path),
      line: null,
      package: packageName,
      ecosystem: text(vulnerability.package?.ecosystem) || text(dependency.package?.ecosystem),
      vulnerableRange: text(vulnerability.vulnerable_version_range),
      firstPatched: text(vulnerability.first_patched_version?.identifier),
      summary: text(advisory.summary),
      dismissedBy: text(alert.dismissed_by?.login) || null,
      dismissedReason: text(alert.dismissed_reason) || null,
      dismissedComment: text(alert.dismissed_comment) || null,
    };
  }

  if (kind === "secret-scanning") {
    const location = alert.first_location_detected ?? {};
    return {
      ...base,
      // The secret scanning API has no severity field. An exposed credential
      // is treated as critical (P0) until a human records a resolution.
      severity: "critical",
      rule:
        text(alert.secret_type_display_name) ||
        text(alert.secret_type) ||
        "secret",
      path: normalizePath(location.path),
      line: location.start_line ?? null,
      validity: text(alert.validity) || null,
      pushProtectionBypassed: alert.push_protection_bypassed === true,
      resolvedBy: text(alert.resolved_by?.login) || null,
      resolution: text(alert.resolution) || null,
      resolutionComment: text(alert.resolution_comment) || null,
    };
  }

  return null;
}

export function issueTitle(facts) {
  const path = lineSuffix(facts.path, facts.line);
  let title;
  if (facts.kind === "dependabot") {
    const name = facts.package || facts.rule;
    const range = facts.vulnerableRange ? ` ${facts.vulnerableRange}` : "";
    title = `[security] ${name}${range} in ${path === "(unknown path)" ? "(unknown manifest)" : path}`;
  } else {
    title = `[security] ${facts.rule} in ${path}`;
  }
  return title.length > 250 ? `${title.slice(0, 247).trimEnd()}...` : title;
}

export function requiredAction(facts) {
  if (facts.kind === "code-scanning") {
    return (
      "Fix the finding, or dismiss the alert in the Security tab with a written " +
      "reason and evidence (AGENTS.md -> Security alerts). Dismissing is allowed " +
      "only for a false positive or an accepted risk; never suppress a whole rule. " +
      "The next sync closes this issue when the alert is dismissed or fixed."
    );
  }
  if (facts.kind === "dependabot") {
    const patched = facts.firstPatched
      ? ` The first patched version is ${facts.firstPatched}.`
      : "";
    return (
      `Update ${facts.package || "the dependency"} to a patched version, or ` +
      `dismiss the alert with a written reason (no patch / not exploitable) and ` +
      `evidence in the Security tab.${patched} The next sync closes this issue ` +
      "when the alert is fixed or dismissed."
    );
  }
  return (
    "Revoke and rotate the secret now, then resolve the alert in the Security " +
    "tab with the resolution and a comment naming the evidence. Never paste the " +
    "secret itself into this issue. The next sync closes this issue when the " +
    "alert is resolved."
  );
}

export function lifecycleSummary(facts) {
  const parts = [];
  if (facts.state === "fixed") {
    parts.push(
      facts.fixedAt
        ? `Alert fixed upstream at ${facts.fixedAt}.`
        : "Alert fixed upstream.",
    );
  } else if (facts.state === "resolved") {
    const who = facts.resolvedBy ? ` by @${facts.resolvedBy}` : "";
    const resolution = facts.resolution ? ` (resolution: ${facts.resolution})` : "";
    parts.push(`Alert resolved${who}${resolution}.`);
    if (facts.resolutionComment) parts.push(`Comment: ${facts.resolutionComment}`);
  } else if (facts.state === "dismissed") {
    const who = facts.dismissedBy ? ` by @${facts.dismissedBy}` : "";
    const reason = facts.dismissedReason
      ? ` (reason: ${facts.dismissedReason})`
      : " (no reason recorded)";
    parts.push(`Alert dismissed${who}${reason}.`);
    if (facts.dismissedComment) parts.push(`Comment: ${facts.dismissedComment}`);
  } else {
    parts.push(`Alert state is "${facts.state}".`);
  }
  return parts.join(" ");
}

export function issueBody(facts, { area, priority, milestone, repoUrl } = {}) {
  const path = lineSuffix(facts.path, facts.line);
  const link = facts.url || `${repoUrl ?? ""}/security`;
  const rows = [
    ["Kind", KIND_LABELS[facts.kind] ?? facts.kind],
    ["Severity", facts.severity],
    ["Rule", facts.rule],
    ["Path", `\`${path}\``],
    ["First seen", facts.firstSeen ?? "unknown"],
    ["State", facts.state],
    ["Area", area],
    ["Milestone", milestone?.title ?? "unmatched"],
    ["Alert", `[open the alert](${link})`],
  ];
  if (facts.kind === "dependabot") {
    rows.splice(4, 0, ["Package", facts.package ?? "unknown"]);
    if (facts.ecosystem) rows.splice(5, 0, ["Ecosystem", facts.ecosystem]);
    if (facts.vulnerableRange) rows.splice(6, 0, ["Vulnerable range", `\`${facts.vulnerableRange}\``]);
    if (facts.firstPatched) rows.splice(7, 0, ["First patched", `\`${facts.firstPatched}\``]);
  }
  if (facts.kind === "secret-scanning") {
    if (facts.validity) rows.splice(4, 0, ["Validity", facts.validity]);
    if (facts.pushProtectionBypassed) {
      rows.splice(5, 0, ["Push protection", "bypassed"]);
    }
  }

  const lines = [
    facts.marker,
    "<!-- generated by scripts/security-alerts-sync.mjs; add comments instead of editing this body -->",
    "",
    `## Security alert: ${short(facts.summary || facts.rule, 200)}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map(([name, value]) => `| ${name} | ${tableCell(value)} |`),
    "",
    `Priority: ${priority}`,
    "",
    `**Required action:** ${requiredAction(facts)}`,
  ];
  if (facts.summary && facts.summary !== facts.rule) {
    lines.push(
      "",
      "<details><summary>Detection message</summary>",
      "",
      facts.summary,
      "",
      "</details>",
    );
  }
  lines.push(
    "",
    "Policy: `AGENTS.md` -> Security alerts and `docs/process/security-alerts.md`.",
  );
  return `${lines.join("\n")}\n`;
}

export function closeComment(facts) {
  return [
    `<!-- security-alert-close:${facts.kind}:${facts.number} -->`,
    lifecycleSummary(facts),
    "",
    `The detection is no longer open, so this tracking issue is closed. ` +
      `Reopen it only if the alert returns.`,
    facts.url ? `\nAlert: ${facts.url}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function reopenNotice(facts) {
  return [
    reopenNoticeMarker(facts.kind, facts.number),
    `This tracking issue is closed, but the ${KIND_LABELS[facts.kind]} alert ` +
      `#${facts.number} is still open (severity: ${facts.severity}).`,
    "",
    "The sync does not reopen a human-closed issue. Reopen it if the alert " +
      "should be tracked again, or dismiss/fix the alert in the Security tab.",
    facts.url ? `\nAlert: ${facts.url}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function escalationLine(entry, now = new Date()) {
  const facts = entry.facts;
  const ageHours = facts.firstSeen
    ? Math.floor((now.getTime() - new Date(facts.firstSeen).getTime()) / 3_600_000)
    : null;
  const age = ageHours === null ? "unknown age" : `${ageHours}h old`;
  const where = lineSuffix(facts.path, facts.line);
  const issue = entry.issue ? `tracking issue #${entry.issue.number}` : "no tracking issue";
  return (
    `${facts.kind} #${facts.number} ${facts.rule} ${where} — ` +
    `${age}, ${issue} ${entry.reason}`
  );
}

function chooseIssue(matches) {
  if (!matches || matches.length === 0) return null;
  return matches.find((issue) => issue.state === "OPEN") ?? matches[0];
}

// Pure planner. `issues` are `{number,title,body,state,labels,assignees,url,
// milestone,closedAt}`; `commentsFor(number)` returns the comment bodies for
// one issue (used only to make the "comment once" rule idempotent).
export function planSync({
  alerts = [],
  issues = [],
  commentsFor = () => [],
  now = new Date(),
  staleHours = 24,
  milestones = [],
  repoUrl = "",
} = {}) {
  const actions = [];
  const warnings = [];
  const escalations = [];
  const byMarker = new Map();
  const ordered = [...alerts].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.number - b.number,
  );

  for (const issue of issues) {
    const marker = parseMarker(issue.body);
    if (!marker) continue;
    const list = byMarker.get(marker.key) ?? [];
    list.push(issue);
    byMarker.set(marker.key, list);
  }
  for (const [key, list] of byMarker) {
    if (list.length > 1) {
      warnings.push(
        `duplicate tracking issues for ${key}: ${list
          .map((issue) => `#${issue.number}`)
          .join(", ")}; using #${chooseIssue(list).number}`,
      );
    }
  }

  for (const facts of ordered) {
    const matches = byMarker.get(facts.key) ?? [];
    const issue = chooseIssue(matches);
    const area = inferArea(facts.path);
    const priority = priorityForSeverity(facts.severity);
    const milestone = milestoneFor({ area, milestones });
    const title = issueTitle(facts);
    const body = issueBody(facts, { area, priority, milestone, repoUrl });

    if (facts.state === "open") {
      if (!issue) {
        actions.push({
          type: "create",
          facts,
          area,
          priority,
          milestone,
          title,
          body,
          labels: ["security", `area:${area}`],
        });
        continue;
      }
      if (issue.state === "OPEN") {
        const changes = [];
        if (text(issue.title) !== title) changes.push("title");
        if (text(issue.body) !== body.trim()) changes.push("body");
        actions.push({
          type: "update",
          number: issue.number,
          issue,
          facts,
          area,
          priority,
          milestone,
          title,
          body,
          changes,
        });
        continue;
      }
      // A human closed the issue while the alert is still open. Never reopen:
      // leave one comment and stop.
      const notice = reopenNoticeMarker(facts.kind, facts.number);
      const alreadyCommented = commentsFor(issue.number).some((comment) =>
        String(comment).includes(notice),
      );
      actions.push(
        alreadyCommented
          ? {
              type: "noop",
              facts,
              reason:
                "alert still open; tracking issue was closed by a human " +
                "(reopen notice already posted)",
            }
          : {
              type: "comment",
              number: issue.number,
              issue,
              facts,
              comment: reopenNotice(facts),
            },
      );
      continue;
    }

    // dismissed / fixed / resolved
    if (!issue) {
      actions.push({
        type: "noop",
        facts,
        reason: `${lifecycleSummary(facts)} No tracking issue to close.`,
      });
    } else if (issue.state === "OPEN") {
      actions.push({
        type: "close",
        number: issue.number,
        issue,
        facts,
        area,
        priority,
        milestone,
        comment: closeComment(facts),
      });
    } else {
      actions.push({
        type: "noop",
        facts,
        reason: `${lifecycleSummary(facts)} Tracking issue #${issue.number} is already closed.`,
      });
    }
  }

  // Escalation is the only red signal: an open alert older than the window
  // with no assigned tracking issue.
  for (const facts of ordered) {
    if (facts.state !== "open" || !facts.firstSeen) continue;
    const ageHours = (now.getTime() - new Date(facts.firstSeen).getTime()) / 3_600_000;
    if (!(ageHours > staleHours)) continue;
    const issue = chooseIssue(byMarker.get(facts.key));
    if (!issue) {
      escalations.push({ facts, issue: null, reason: "has no tracking issue" });
    } else if (issue.state === "OPEN" && (issue.assignees ?? []).length === 0) {
      escalations.push({ facts, issue, reason: "is unassigned" });
    }
  }

  return { actions, warnings, escalations };
}

export function summarize(alerts) {
  const counts = { total: alerts.length, open: 0, dismissed: 0, fixed: 0, resolved: 0 };
  for (const facts of alerts) {
    if (facts.state === "open") counts.open += 1;
    else if (facts.state === "dismissed") counts.dismissed += 1;
    else if (facts.state === "fixed") counts.fixed += 1;
    else if (facts.state === "resolved") counts.resolved += 1;
  }
  return counts;
}
