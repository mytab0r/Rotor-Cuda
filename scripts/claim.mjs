#!/usr/bin/env node
// Work claims for concurrent sessions (see docs/process/concurrency.md).
//
// Usage:
//   node scripts/claim.mjs start <issue> --session <id> --branch <branch>
//        [--worktree <path>] [--repo owner/name]
//   node scripts/claim.mjs release <issue> [--session <id>]
//   node scripts/claim.mjs check <issue>          # exit 2 when a live claim blocks
//   node scripts/claim.mjs status [--json]
//
// A claim is a comment marker on the issue, so every checkout and every human
// sees the same state. Exit codes: 0 = free or done, 2 = a live claim blocks,
// 1 = error.

import { execFileSync } from "node:child_process";
import { claimState, latestClaim, parseClaimComment, CLAIM_STALE_MS } from "./lib/claims.mjs";

const REPO = process.env.GH_REPO || "mytab0r/Rotor-Cuda";

function gh(args) {
  try {
    return execFileSync("gh", args, {
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
  const out = gh(args);
  return out ? JSON.parse(out) : null;
}

function issueView(number) {
  return ghJson([
    "issue",
    "view",
    String(number),
    "--repo",
    REPO,
    "--json",
    "number,title,state,comments,url",
  ]);
}

function lastCommitAt(branch) {
  if (!branch || branch === "main") return null;
  try {
    const out = gh([
      "api",
      `repos/${REPO}/commits?sha=${encodeURIComponent(branch)}&per_page=1`,
      "--jq",
      '.[0].commit.committer.date // ""',
    ]);
    return out || null;
  } catch {
    return null;
  }
}

function openPrUpdatedAt(branch) {
  if (!branch) return null;
  try {
    const out = gh([
      "pr",
      "list",
      "--repo",
      REPO,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "updatedAt",
      "--jq",
      '.[0].updatedAt // ""',
    ]);
    return out || null;
  } catch {
    return null;
  }
}

function evaluate(claim) {
  if (!claim) return "none";
  return claimState(claim, {
    lastCommitAt: lastCommitAt(claim.branch),
    prUpdatedAt: openPrUpdatedAt(claim.branch),
  });
}

function humanClaim(claim, state) {
  if (!claim) return "free";
  if (claim.released) return "released";
  const hours = Math.round(CLAIM_STALE_MS / 3_600_000);
  return `${state}: ${claim.session} on ${claim.branch} since ${claim.at} (stale after ${hours}h of silence)`;
}

function parseArgs(argv) {
  const [command, number, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      options[name] = true;
    } else {
      options[name] = value;
      i += 1;
    }
  }
  return { command, number, options };
}

function start(number, options, session) {
  if (!session) throw new Error("start needs --session <id>");
  if (!options.branch) throw new Error("start needs --branch <branch>");
  const issue = issueView(number);
  if (issue.state !== "OPEN") {
    console.error(`#${number} is ${issue.state}; nothing to claim.`);
    return 1;
  }
  const claim = latestClaim(issue.comments ?? []);
  const state = evaluate(claim);
  if (state === "live") {
    console.error(
      `#${number} is claimed by ${claim.session} on ${claim.branch} (live). ` +
        `Take it over only after the claim is stale; see docs/process/concurrency.md.`,
    );
    return 2;
  }
  const at = new Date().toISOString();
  const marker = JSON.stringify({
    session,
    branch: options.branch,
    worktree: options.worktree ?? null,
    at,
  });
  const previous = claim && !claim.released ? ` Replaces the stale claim by ${claim.session} on ${claim.branch}.` : "";
  const body = [
    `<!-- work-claim:${marker} -->`,
    `Claimed by session \`${session}\` on branch \`${options.branch}\`${options.worktree ? ` (worktree \`${options.worktree}\`)` : ""}.`,
    `Claimed at ${at}. Live while the branch has commits or an open pull request within 2 hours.${previous}`,
    `Release with \`node scripts/claim.mjs release ${number}\`.`,
  ].join("\n\n");
  gh(["issue", "comment", String(number), "--repo", REPO, "--body", body]);
  console.log(`claimed #${number}: ${humanClaim({ ...JSON.parse(marker), released: false }, "live")}`);
  return 0;
}

function release(number, session) {
  const at = new Date().toISOString();
  const marker = JSON.stringify({ released: true, session: session ?? null, at });
  gh([
    "issue",
    "comment",
    String(number),
    "--repo",
    REPO,
    "--body",
    `<!-- work-claim:${marker} -->\n\nReleased by ${session ? `session \`${session}\`` : "a session"} at ${at}.`,
  ]);
  console.log(`released #${number}`);
  return 0;
}

function check(number) {
  const issue = issueView(number);
  const claim = latestClaim(issue.comments ?? []);
  const state = evaluate(claim);
  console.log(`#${number}: ${humanClaim(claim, state)}`);
  return state === "live" ? 2 : 0;
}

function status(asJson) {
  const issues = ghJson([
    "issue",
    "list",
    "--repo",
    REPO,
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number,title,comments",
  ]);
  const rows = [];
  for (const issue of issues ?? []) {
    const claim = latestClaim(issue.comments ?? []);
    if (!claim) continue;
    const state = evaluate(claim);
    if (state === "released") continue;
    rows.push({
      number: issue.number,
      title: issue.title,
      state,
      session: claim.session,
      branch: claim.branch,
      at: claim.at,
    });
  }
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log("no claims");
    return 0;
  }
  for (const row of rows) {
    console.log(`#${row.number}\t${row.state}\t${row.session}\t${row.branch}\t${row.at}\t${row.title}`);
  }
  return 0;
}

function main(argv) {
  const { command, number, options } = parseArgs(argv);
  if (command === "start") return start(number, options, options.session);
  if (command === "release") return release(number, options.session);
  if (command === "check") return check(number);
  if (command === "status") return status(Boolean(options.json));
  console.error(
    "usage: claim.mjs start <issue> --session <id> --branch <b> [--worktree <p>] | release <issue> | check <issue> | status [--json]",
  );
  return 1;
}

import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
