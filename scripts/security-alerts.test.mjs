// Security-alert routing: marker parsing, area/severity mapping, issue body
// shape, lifecycle planning and the 24h escalation. No network, no browser.
//
// Usage: node --test scripts/security-alerts.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  closeComment,
  escalationLine,
  inferArea,
  issueBody,
  issueTitle,
  lifecycleSummary,
  markerFor,
  normalizeAlert,
  parseMarker,
  planSync,
  priorityForSeverity,
  reopenNotice,
  reopenNoticeMarker,
  severityFieldForPriority,
  summarize,
} from "./lib/security-alerts.mjs";

const REPO_URL = "https://github.com/mytab0r/Rotor-Cuda";

const MILESTONES = [
  {
    title: "Desktop and coordinator parity",
    due: "2027-03-31",
    match: { areas: ["desktop", "coordinator"], epics: [] },
  },
  {
    title: "Astro frontend cutover",
    due: "2026-12-31",
    match: { areas: ["site"], epics: [] },
  },
  {
    title: "Design system and process foundations",
    due: "2027-03-31",
    match: { areas: ["design", "docs", "infra"], epics: [] },
  },
];

const NOW = new Date("2026-11-25T12:00:00Z");

function codeScanningAlert(overrides = {}) {
  return {
    number: 16,
    state: "dismissed",
    html_url: `${REPO_URL}/security/code-scanning/16`,
    created_at: "2026-11-23T16:45:07Z",
    dismissed_at: "2026-11-23T22:43:15Z",
    dismissed_by: { login: "mytab0r" },
    dismissed_reason: "false positive",
    dismissed_comment:
      "Test-only fixture: deterministic nonce inside #[test]; production uses getrandom.",
    rule: {
      id: "rust/hard-coded-cryptographic-value",
      severity: "error",
      security_severity_level: "critical",
    },
    most_recent_instance: {
      location: { path: "src/monitor/auth.rs", start_line: 516 },
      message: { text: "Hard-coded cryptographic value." },
    },
    ...overrides,
  };
}

function dependabotAlert(overrides = {}) {
  return {
    number: 5,
    state: "open",
    html_url: `${REPO_URL}/security/dependabot/5`,
    created_at: "2026-11-24T10:00:00Z",
    dependency: {
      package: { ecosystem: "cargo", name: "serde" },
      manifest_path: "Cargo.lock",
    },
    security_advisory: {
      ghsa_id: "GHSA-xxxx-yyyy-zzzz",
      severity: "high",
      summary: "serde vulnerability",
    },
    security_vulnerability: {
      package: { ecosystem: "cargo", name: "serde" },
      severity: "high",
      vulnerable_version_range: "< 1.0.200",
      first_patched_version: { identifier: "1.0.200" },
    },
    ...overrides,
  };
}

function secretAlert(overrides = {}) {
  return {
    number: 3,
    state: "resolved",
    html_url: `${REPO_URL}/security/secret-scanning/3`,
    created_at: "2026-11-22T08:00:00Z",
    resolved_at: "2026-11-22T09:00:00Z",
    resolved_by: { login: "mytab0r" },
    resolution: "revoked",
    resolution_comment: "Rotated the token.",
    secret_type: "github_pat",
    secret_type_display_name: "GitHub Personal Access Token",
    validity: "active",
    first_location_detected: {
      path: "deploy/example.env",
      start_line: 4,
    },
    ...overrides,
  };
}

function issueFor(facts, { state = "OPEN", assignees = [], comments = [] } = {}) {
  const area = inferArea(facts.path);
  const priority = priorityForSeverity(facts.severity);
  const milestone =
    MILESTONES.find((entry) => entry.match.areas.includes(area)) ?? null;
  return {
    number: 123,
    url: `${REPO_URL}/issues/123`,
    title: issueTitle(facts),
    body: issueBody(facts, { area, priority, milestone, repoUrl: REPO_URL }),
    state,
    labels: ["security", `area:${area}`],
    assignees,
    milestone: milestone?.title ?? null,
    closedAt: state === "CLOSED" ? "2026-11-24T00:00:00Z" : null,
    comments,
  };
}

test("markers round-trip and reject other comments", () => {
  assert.equal(markerFor("code-scanning", 16), "<!-- security-alert:code-scanning:16 -->");
  assert.deepEqual(parseMarker("intro\n<!-- security-alert:code-scanning:16 -->\nbody"), {
    kind: "code-scanning",
    number: 16,
    key: "code-scanning:16",
  });
  assert.equal(parseMarker("<!-- openspec-task: change/slug -->"), null);
  assert.equal(parseMarker(""), null);
});

test("area inference follows the AGENTS.md ownership map", () => {
  assert.equal(inferArea("src/coordinator/api.rs"), "coordinator");
  assert.equal(inferArea("src/bin/rotor-coord.rs"), "coordinator");
  assert.equal(inferArea("crates/rotor-wasm/src/lib.rs"), "coordinator");
  assert.equal(inferArea("apps/site/site.js"), "site");
  assert.equal(inferArea("web/src/pages/index.astro"), "site");
  assert.equal(inferArea("deploy/cloudflare/worker.js"), "infra");
  assert.equal(inferArea(".github/workflows/ci.yml"), "infra");
  assert.equal(inferArea("scripts/security-alerts-sync.mjs"), "infra");
  assert.equal(inferArea("src/monitor/auth.rs"), "desktop");
  assert.equal(inferArea("Cargo.toml"), "desktop");
  assert.equal(inferArea("docs/process/security-alerts.md"), "docs");
  assert.equal(inferArea("design/tokens/tokens.json"), "design");
  assert.equal(inferArea("unmapped.txt"), "infra");
  assert.equal(inferArea(""), "infra");
});

test("severity maps to the board priority and severity fields", () => {
  assert.equal(priorityForSeverity("critical"), "P0");
  assert.equal(priorityForSeverity("high"), "P0");
  assert.equal(priorityForSeverity("medium"), "P1");
  assert.equal(priorityForSeverity("low"), "P2");
  assert.equal(priorityForSeverity("unknown"), "P2");
  assert.equal(severityFieldForPriority("P0"), "S1");
  assert.equal(severityFieldForPriority("P1"), "S2");
  assert.equal(severityFieldForPriority("P2"), "S3");
});

test("code scanning alert facts, title and body carry every required field", () => {
  const facts = normalizeAlert("code-scanning", codeScanningAlert());
  assert.equal(facts.kind, "code-scanning");
  assert.equal(facts.severity, "critical");
  assert.equal(facts.rule, "rust/hard-coded-cryptographic-value");
  assert.equal(facts.path, "src/monitor/auth.rs");
  assert.equal(facts.line, 516);
  assert.equal(facts.firstSeen, "2026-11-23T16:45:07.000Z");
  assert.equal(issueTitle(facts), "[security] rust/hard-coded-cryptographic-value in src/monitor/auth.rs:516");

  const body = issueBody(facts, {
    area: "coordinator",
    priority: "P0",
    milestone: MILESTONES[0],
    repoUrl: REPO_URL,
  });
  assert.match(body, /<!-- security-alert:code-scanning:16 -->/);
  assert.match(body, /\| Severity \| critical \|/);
  assert.match(body, /\| Rule \| rust\/hard-coded-cryptographic-value \|/);
  assert.match(body, /\| Path \| `src\/monitor\/auth\.rs:516` \|/);
  assert.match(body, /\| First seen \| 2026-11-23T16:45:07\.000Z \|/);
  assert.match(body, /\[open the alert\]\(https:\/\/github\.com\/mytab0r\/Rotor-Cuda\/security\/code-scanning\/16\)/);
  assert.match(body, /^Priority: P0$/m);
  assert.match(body, /^Severity: S1$/m);
  assert.match(body, /Required action:/);
});

test("dependabot facts use the package, manifest and patched version", () => {
  const facts = normalizeAlert("dependabot", dependabotAlert());
  assert.equal(facts.severity, "high");
  assert.equal(facts.package, "serde");
  assert.equal(facts.path, "Cargo.lock");
  assert.equal(facts.vulnerableRange, "< 1.0.200");
  assert.equal(facts.firstPatched, "1.0.200");
  assert.equal(issueTitle(facts), "[security] serde < 1.0.200 in Cargo.lock");
  const body = issueBody(facts, {
    area: "desktop",
    priority: "P0",
    milestone: MILESTONES[0],
    repoUrl: REPO_URL,
  });
  assert.match(body, /\| Package \| serde \|/);
  assert.match(body, /first patched version is 1\.0\.200/i);
});

test("secret scanning is treated as critical and never echoes the secret", () => {
  const raw = secretAlert({ secret: "ghp_SENTINEL_SHOULD_NOT_APPEAR" });
  const facts = normalizeAlert("secret-scanning", raw);
  assert.equal(facts.severity, "critical");
  assert.equal(priorityForSeverity(facts.severity), "P0");
  assert.equal(issueTitle(facts), "[security] GitHub Personal Access Token in deploy/example.env:4");
  const body = issueBody(facts, {
    area: "infra",
    priority: "P0",
    milestone: MILESTONES[2],
    repoUrl: REPO_URL,
  });
  assert.doesNotMatch(body, /SENTINEL_SHOULD_NOT_APPEAR/);
  assert.match(body, /Never paste the secret itself into this issue/);
});

test("an open alert with no tracking issue plans one create action", () => {
  const facts = normalizeAlert("code-scanning", codeScanningAlert({ state: "open" }));
  const plan = planSync({
    alerts: [facts],
    issues: [],
    now: NOW,
    milestones: MILESTONES,
    repoUrl: REPO_URL,
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, "create");
  assert.equal(plan.actions[0].area, "desktop");
  assert.equal(plan.actions[0].priority, "P0");
  assert.equal(plan.actions[0].milestone.title, "Desktop and coordinator parity");
  assert.deepEqual(plan.actions[0].labels, ["security"]);
});

test("an open alert with a matching open issue reconciles without a duplicate", () => {
  const facts = normalizeAlert("code-scanning", codeScanningAlert({ state: "open" }));
  const issue = issueFor(facts);
  const plan = planSync({
    alerts: [facts],
    issues: [issue],
    now: NOW,
    milestones: MILESTONES,
    repoUrl: REPO_URL,
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, "update");
  assert.deepEqual(plan.actions[0].changes, []);
  assert.equal(plan.warnings.length, 0);
});

test("a drifted title or body is reported as an update", () => {
  const facts = normalizeAlert("code-scanning", codeScanningAlert({ state: "open" }));
  const issue = { ...issueFor(facts), title: "old title" };
  const plan = planSync({
    alerts: [facts],
    issues: [issue],
    now: NOW,
    milestones: MILESTONES,
    repoUrl: REPO_URL,
  });
  assert.deepEqual(plan.actions[0].changes, ["title"]);
});

test("a dismissed alert closes its issue and names who/why", () => {
  const facts = normalizeAlert("code-scanning", codeScanningAlert());
  const issue = issueFor(facts);
  const plan = planSync({
    alerts: [facts],
    issues: [issue],
    now: NOW,
    milestones: MILESTONES,
    repoUrl: REPO_URL,
  });
  assert.equal(plan.actions[0].type, "close");
  const comment = plan.actions[0].comment;
  assert.match(comment, /@mytab0r/);
  assert.match(comment, /false positive/);
  assert.match(comment, /Test-only fixture/);
  assert.match(comment, /security-alert-close:code-scanning:16/);
});

test("a fixed alert and a resolved secret close their issues", () => {
  const fixed = normalizeAlert(
    "dependabot",
    dependabotAlert({ state: "fixed", fixed_at: "2026-11-24T12:00:00Z" }),
  );
  const resolved = normalizeAlert("secret-scanning", secretAlert());
  const plan = planSync({
    alerts: [fixed, resolved],
    issues: [issueFor(fixed), issueFor(resolved)],
    now: NOW,
    milestones: MILESTONES,
    repoUrl: REPO_URL,
  });
  assert.deepEqual(
    plan.actions.map((action) => [action.type, action.number]),
    [
      ["close", 123],
      ["close", 123],
    ],
  );
  assert.match(lifecycleSummary(fixed), /fixed upstream at 2026-11-24/);
  assert.match(lifecycleSummary(resolved), /@mytab0r/);
  assert.match(lifecycleSummary(resolved), /revoked/);
});

test("a dismissed alert with no tracking issue is a no-op", () => {
  const facts = normalizeAlert("code-scanning", codeScanningAlert());
  const plan = planSync({
    alerts: [facts],
    issues: [],
    now: NOW,
    milestones: MILESTONES,
    repoUrl: REPO_URL,
  });
  assert.equal(plan.actions[0].type, "noop");
  assert.match(plan.actions[0].reason, /dismissed by @mytab0r/);
  assert.match(plan.actions[0].reason, /false positive/);
  assert.match(plan.actions[0].reason, /No tracking issue to close/);
});

test("a human-closed issue is never reopened; the notice is posted once", () => {
  const facts = normalizeAlert("code-scanning", codeScanningAlert({ state: "open" }));
  const issue = issueFor(facts, { state: "CLOSED" });
  const first = planSync({
    alerts: [facts],
    issues: [issue],
    now: NOW,
    milestones: MILESTONES,
    repoUrl: REPO_URL,
  });
  assert.equal(first.actions[0].type, "comment");
  assert.match(first.actions[0].comment, /does not reopen a human-closed issue/);
  assert.match(first.actions[0].comment, /security-alert-reopen:code-scanning:16/);

  const second = planSync({
    alerts: [facts],
    issues: [issue],
    commentsFor: () => [reopenNotice(facts)],
    now: NOW,
    milestones: MILESTONES,
    repoUrl: REPO_URL,
  });
  assert.equal(second.actions[0].type, "noop");
  assert.match(second.actions[0].reason, /already posted/);
});

test("an issue closed by the sync is reopened when the alert returns", () => {
  const facts = normalizeAlert("code-scanning", codeScanningAlert({ state: "open" }));
  const issue = issueFor(facts, { state: "CLOSED" });
  const plan = planSync({
    alerts: [facts],
    issues: [issue],
    commentsFor: () => [closeComment(facts)],
    now: NOW,
    milestones: MILESTONES,
    repoUrl: REPO_URL,
  });
  assert.equal(plan.actions[0].type, "reopen");
  assert.match(plan.actions[0].comment, /security-alert-reopen-alert:code-scanning:16/);
  assert.deepEqual(plan.actions[0].changes, []);
  assert.deepEqual(plan.actions[0].labels, ["security"]);
});

test("duplicate markers produce one warning and no new issue", () => {
  const facts = normalizeAlert("code-scanning", codeScanningAlert({ state: "open" }));
  const first = issueFor(facts);
  const second = { ...issueFor(facts), number: 124, url: `${REPO_URL}/issues/124` };
  const plan = planSync({
    alerts: [facts],
    issues: [first, second],
    now: NOW,
    milestones: MILESTONES,
    repoUrl: REPO_URL,
  });
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /duplicate tracking issues/);
  assert.equal(plan.actions[0].type, "update");
  assert.equal(plan.actions[0].number, 123);
});

test("escalation fires only for an open alert older than 24h with no assignee", () => {
  const facts = normalizeAlert("dependabot", dependabotAlert());
  const issue = issueFor(facts);
  const base = { alerts: [facts], milestones: MILESTONES, repoUrl: REPO_URL };

  const unassigned = planSync({ ...base, issues: [issue], now: NOW });
  assert.equal(unassigned.escalations.length, 1);
  assert.match(escalationLine(unassigned.escalations[0], NOW), /is unassigned/);

  const assigned = planSync({
    ...base,
    issues: [{ ...issue, assignees: ["mytab0r"] }],
    now: NOW,
  });
  assert.equal(assigned.escalations.length, 0);

  const fresh = planSync({
    ...base,
    issues: [issue],
    now: new Date("2026-11-24T12:00:00Z"),
  });
  assert.equal(fresh.escalations.length, 0);

  const missing = planSync({ ...base, issues: [], now: NOW });
  assert.equal(missing.escalations.length, 1);
  assert.match(missing.escalations[0].reason, /no tracking issue/);
});

test("summarize counts every lifecycle state", () => {
  const alerts = [
    normalizeAlert("code-scanning", codeScanningAlert({ state: "open" })),
    normalizeAlert("code-scanning", codeScanningAlert()),
    normalizeAlert("dependabot", dependabotAlert({ state: "fixed" })),
    normalizeAlert("secret-scanning", secretAlert()),
  ];
  assert.deepEqual(summarize(alerts), {
    total: 4,
    open: 1,
    dismissed: 1,
    fixed: 1,
    resolved: 1,
  });
});

test("close and reopen comments carry their idempotency markers", () => {
  const facts = normalizeAlert("code-scanning", codeScanningAlert());
  assert.match(closeComment(facts), /<!-- security-alert-close:code-scanning:16 -->/);
  assert.equal(reopenNoticeMarker("code-scanning", 16), "<!-- security-alert-reopen:code-scanning:16 -->");
});
