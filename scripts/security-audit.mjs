#!/usr/bin/env node
// Build the weekly dependency-audit report and upsert it as ONE tracking
// issue. The workflow runs on a schedule, never on pull requests, so a finding
// is recorded here instead of failing a PR.
//
// Usage:
//   node scripts/security-audit.mjs [reports-dir] [--dry-run]
//
// Reports expected in reports-dir (all optional; a missing one is reported):
//   cargo-audit.json                     `cargo audit --json`
//   npm-web.json                         `npm audit --omit=dev --json` in web/
//   npm-cloudflare.json                  same in deploy/cloudflare/ (or a note)
//
// Environment:
//   GH_TOKEN / GITHUB_TOKEN   token with issues:write
//   GITHUB_REPOSITORY         owner/repo
//   GITHUB_RUN_URL            link to the workflow run
//   GITHUB_SHA                audited commit
//   DRY_RUN                   "true" prints the body and makes no API call

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ISSUE_TITLE = "Security audit: weekly dependency report";
const ISSUE_MARKER = "<!-- security-audit-tracking -->";

function usage() {
  process.stdout.write(
    "usage: node scripts/security-audit.mjs [reports-dir] [--dry-run]\n",
  );
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    process.exit(0);
  }
  const dryRun = argv.includes("--dry-run") || process.env.DRY_RUN === "true";
  const dir = argv.find((arg) => !arg.startsWith("-")) || "reports";
  return { dir, dryRun };
}

function readReport(dir, name) {
  const path = join(dir, name);
  if (!existsSync(path)) return { missing: true, path };
  try {
    return { data: JSON.parse(readFileSync(path, "utf8")), path };
  } catch (error) {
    return { invalid: error.message, path };
  }
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function cargoSection(report) {
  if (report.missing) {
    return ["_No cargo-audit report was uploaded (the job failed or was skipped)._"];
  }
  if (report.invalid) {
    return [`_cargo-audit report is not valid JSON: ${cell(report.invalid)}_`];
  }
  if (report.data?.error) {
    return [`_cargo-audit failed: ${cell(report.data.error)}_`];
  }

  const vulnerabilities = report.data?.vulnerabilities ?? {};
  const list = Array.isArray(vulnerabilities.list) ? vulnerabilities.list : [];
  const warnings = report.data?.warnings ?? {};
  const unmaintained = Array.isArray(warnings.unmaintained) ? warnings.unmaintained.length : 0;
  const unsound = Array.isArray(warnings.unsound) ? warnings.unsound.length : 0;
  const yanked = Array.isArray(warnings.yanked) ? warnings.yanked.length : 0;

  const lines = [];
  if (!vulnerabilities.found || list.length === 0) {
    lines.push("No known RustSec advisories.");
  } else {
    lines.push(`**${list.length} advisory(ies).**`, "");
    lines.push(
      "| Advisory | Package | Severity | Title | Patched | Link |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const item of list) {
      const advisory = item.advisory ?? {};
      const pkg = item.package ?? {};
      const patched = Array.isArray(item.versions?.patched) && item.versions.patched.length > 0
        ? item.versions.patched.join(", ")
        : "none";
      lines.push(
        `| ${cell(advisory.id ?? "?")} | ${cell(pkg.name ?? "?")} ${cell(pkg.version ?? "")} | ` +
          `${cell(advisory.severity ?? "unknown")} | ${cell(advisory.title ?? "")} | ` +
          `${cell(patched)} | ${cell(advisory.url ?? "")} |`,
      );
    }
  }
  const warningBits = [];
  if (unmaintained) warningBits.push(`${unmaintained} unmaintained`);
  if (unsound) warningBits.push(`${unsound} unsound`);
  if (yanked) warningBits.push(`${yanked} yanked`);
  if (warningBits.length > 0) {
    lines.push("", `Warnings (not failure): ${warningBits.join(", ")}.`);
  }
  return lines;
}

function npmSection(report, label) {
  if (report.missing) {
    return [`_No npm audit report for ${label} was uploaded (the job failed or was skipped)._`];
  }
  if (report.invalid) {
    return [`_npm audit report for ${label} is not valid JSON: ${cell(report.invalid)}_`];
  }
  if (report.data?.note) {
    return [cell(report.data.note)];
  }
  if (report.data?.error) {
    return [`_npm audit failed for ${label}: ${cell(report.data.error)}_`];
  }

  const vulnerabilities = report.data?.vulnerabilities ?? {};
  const high = Object.entries(vulnerabilities)
    .filter(([, entry]) => entry.severity === "high" || entry.severity === "critical")
    .sort((a, b) => a[0].localeCompare(b[0]));
  const counts = report.data?.metadata?.vulnerabilities ?? {};

  const lines = [];
  const summary = ["critical", "high", "moderate", "low"]
    .map((level) => `${counts[level] ?? 0} ${level}`)
    .join(", ");
  lines.push(`Counts: ${summary}.`);
  if (high.length === 0) {
    lines.push("No high or critical npm advisories in production dependencies.");
    return lines;
  }
  lines.push("", "| Package | Severity | Via | Fix |", "| --- | --- | --- | --- |");
  for (const [name, entry] of high) {
    const via = (entry.via ?? [])
      .map((item) => (typeof item === "string" ? item : item.title || item.url || ""))
      .filter(Boolean)
      .join("; ");
    const fix = typeof entry.fixAvailable === "object" && entry.fixAvailable
      ? `${entry.fixAvailable.name ?? ""} ${entry.fixAvailable.version ?? ""}`.trim()
      : entry.fixAvailable
        ? "available"
        : "none";
    lines.push(
      `| ${cell(name)} | ${cell(entry.severity)} | ${cell(via)} | ${cell(fix || "none")} |`,
    );
  }
  return lines;
}

function buildBody(reports) {
  const run = process.env.GITHUB_RUN_URL || "(local run)";
  const repo = process.env.GITHUB_REPOSITORY || "(unknown repository)";
  const sha = process.env.GITHUB_SHA || "(unknown commit)";
  const generated = new Date().toISOString();

  return [
    ISSUE_MARKER,
    "# Weekly dependency audit",
    "",
    "This issue is created and updated in place by `.github/workflows/audit.yml`.",
    "The workflow runs on a weekly schedule and never on a pull request, so a",
    "finding is recorded here instead of failing a PR.",
    "",
    `- Repository: \`${repo}\``,
    `- Commit: \`${sha}\``,
    `- Generated: ${generated}`,
    `- Run: ${run}`,
    "",
    "## Rust — `cargo audit`",
    "",
    ...cargoSection(reports.cargo),
    "",
    "## npm — `web/` (`npm audit --omit=dev --audit-level=high`)",
    "",
    ...npmSection(reports.web, "web"),
    "",
    "## npm — `deploy/cloudflare/`",
    "",
    ...npmSection(reports.cloudflare, "deploy/cloudflare"),
    "",
    "## Triage",
    "",
    "- A RustSec advisory: update the crate, or record a reviewed `ignore` in",
    "  the audit workflow with a reason and an expiry.",
    "- An npm advisory: bump the dependency; `web/` has a lockfile and the",
    "  Astro build is the gate.",
    "- Keep this issue open. The next scheduled run rewrites the body; closing",
    "  it only creates a duplicate on the next run.",
    "",
  ].join("\n");
}

async function github(path, init = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
  const base = process.env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "rotor-security-audit",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function upsertIssue(body, dryRun) {
  if (dryRun) {
    process.stdout.write(body);
    process.stdout.write("\n(dry run: the tracking issue was not changed)\n");
    return;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");

  const issues = await github(`/repos/${repo}/issues?state=open&per_page=100&sort=created&direction=desc`);
  const existing = (issues ?? []).find(
    (issue) => issue.title === ISSUE_TITLE && !issue.pull_request,
  );
  if (existing) {
    await github(`/repos/${repo}/issues/${existing.number}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    process.stdout.write(`updated issue #${existing.number}\n`);
    return;
  }

  const created = await github(`/repos/${repo}/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: ISSUE_TITLE, body }),
  });
  process.stdout.write(`created issue #${created.number}\n`);
}

const { dir, dryRun } = parseArgs(process.argv.slice(2));
const reports = {
  cargo: readReport(dir, "cargo-audit.json"),
  web: readReport(dir, "npm-web.json"),
  cloudflare: readReport(dir, "npm-cloudflare.json"),
};
const body = buildBody(reports);

upsertIssue(body, dryRun).catch((error) => {
  process.stderr.write(`security-audit: ${error.message}\n`);
  process.exit(1);
});
