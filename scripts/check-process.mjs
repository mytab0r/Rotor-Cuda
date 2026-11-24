#!/usr/bin/env node
// Mechanical pull-request process contract.
//
// A product PR must fill the required sections of .github/pull_request_template.md
// and carry a `Task: ROT-<n>` line. A docs/process-only PR may use the reduced
// contract (`Task: none — <reason>`) and skip the sections. A `process-exempt`
// label waives the sections only when the body states a one-line reason.
//
// What CI can check is presence and shape: a section exists, its content is not
// just the template's HTML comments, `## Spec` points into openspec/, `## Tests`
// names a command and a failure mode, `## Mutation proof` carries a command and
// output, `## Independent review` names a reviewer other than the author with a
// passing verdict, and `## Verification` carries commands and results. Whether
// the content is true is the reviewer's job; the role chain and the re-run rule
// are in docs/process/verification.md.
//
// Usage:
//   node scripts/check-process.mjs --pr 123 [--repo owner/name]
//   node scripts/check-process.mjs --body-file body.md --files a,b \
//       [--labels process-exempt] [--author login]
//
// No dependencies beyond Node builtins and `gh` for the --pr form.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  automationPullRequestReason,
  isProcessOnly,
  parseTaskDirective,
} from "./lib/task-tracking.mjs";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let repoRoot = DEFAULT_REPO_ROOT;

export const REQUIRED_SECTIONS = [
  "Spec",
  "Tests",
  "Mutation proof",
  "Independent review",
  "Verification",
];

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
// One command-shaped token at the start of a line, with or without a shell
// prompt. Kept deliberately narrow: the gate wants evidence a command ran.
const COMMAND_RE =
  /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\$\s+)?`?(?:(?:node|cargo|npm|pnpm|yarn|sh|bash|gh|python3?|go|dotnet|deno|bun)\b|\.\/[^\s`]+)/m;
const FAILURE_RE = /\b(?:fails?|failing|failure|red|without the (?:change|fix)|regression)\b/i;
const MUTATION_RE = /\b(?:revert(?:ed|s)?|mutat(?:e|ed|ion)|fails?|failure|FAILED|red)\b/i;
const SPEC_RE = /openspec\/(?:changes|specs)\/[A-Za-z0-9._/-]+/i;
const REVIEWER_RE = /^Reviewer:\s*(.+?)\s*$/im;
const VERDICT_RE = /^Verdict:\s*(.+?)\s*$/im;
const PASS_VERDICT_RE = /^(?:APPROVE[D]?|PASS(?:ED)?|LGTM)$/i;
const PROCESS_EXEMPT_RE = /^Process-exempt:\s*(\S.*)$/im;
const SELF_REVIEW_RE = /\b(?:self|author|same agent|same author)\b/i;

export function stripHtmlComments(body) {
  return String(body ?? "").replace(HTML_COMMENT_RE, "");
}

export function normalizeHeading(value) {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

// H2 sections outside fenced code blocks. A `## something` inside a pasted
// output does not open a section.
export function parseSections(body) {
  const sections = new Map();
  let current = null;
  let fence = false;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) fence = !fence;
    if (!fence) {
      const match = /^##\s+(.+?)\s*$/.exec(line);
      if (match) {
        current = normalizeHeading(match[1]);
        if (!sections.has(current)) sections.set(current, []);
        continue;
      }
    }
    if (current) sections.get(current).push(line);
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join("\n")]));
}

function nonBlankLines(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function fencedBlocks(value) {
  const blocks = [];
  let current = null;
  for (const line of String(value ?? "").split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      if (current === null) current = [];
      else {
        blocks.push(current);
        current = null;
      }
      continue;
    }
    if (current !== null) current.push(line);
  }
  return blocks;
}

// A command and its result. Verification accepts a command line plus a result
// line anywhere; Mutation proof (below) requires an explicit block because the
// reviewer must be able to re-run it as pasted.
export function hasCommandEvidence(content) {
  const text = String(content ?? "");
  if (COMMAND_RE.test(text) && nonBlankLines(text).length >= 2) return true;
  return /\bcommand\b\s*:/.test(text) && /\boutput\b\s*:/.test(text);
}

// A fenced block (or Command:/Output: pair) holding a command and at least one
// output line. A sentence that merely claims "mutations tested" does not count.
export function hasFencedEvidence(content) {
  const text = String(content ?? "");
  const blocks = fencedBlocks(text);
  if (
    blocks.some(
      (block) =>
        COMMAND_RE.test(block.join("\n")) && nonBlankLines(block.join("\n")).length >= 2,
    )
  ) {
    return true;
  }
  return /\bcommand\b\s*:/.test(text) && /\boutput\b\s*:/.test(text);
}

function hasTestEvidence(content) {
  return hasCommandEvidence(content) && FAILURE_RE.test(content);
}

function hasMutationEvidence(content) {
  return hasFencedEvidence(content) && MUTATION_RE.test(content);
}

function hasSpecLink(content) {
  return SPEC_RE.test(content);
}

function labelNames(labels = []) {
  return (labels ?? [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((name) => typeof name === "string" && name.length > 0);
}

export function normalizeVerdict(value) {
  return String(value ?? "")
    .trim()
    .replace(/[.!]+$/, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

// Pure verdict used by the CLI and by tests. The caller supplies the body, the
// changed paths, labels and (when known) the PR author.
export function checkPullRequest({
  number = null,
  body,
  files = [],
  labels = [],
  author = null,
  isBot = false,
  headRefName = null,
}) {
  // Automation PRs (release-please, github-actions, app actors) have no human
  // author to satisfy this contract. Skip them with a printed notice.
  const automationReason = automationPullRequestReason({ author, isBot, headRefName });
  if (automationReason) {
    return {
      ok: true,
      errors: [],
      summary: `PR #${number ?? "(local)"} automation PR (${automationReason}); process contract not required`,
      skipped: true,
      automationReason,
      processOnly: isProcessOnly(files),
      waivedBy: null,
      directive: parseTaskDirective(body),
    };
  }

  const errors = [];
  const rendered = stripHtmlComments(body);
  const sections = parseSections(rendered);
  const processOnly = isProcessOnly(files);
  const names = labelNames(labels);
  const exemptReasonMatch = PROCESS_EXEMPT_RE.exec(rendered);
  const exemptReason = exemptReasonMatch ? exemptReasonMatch[1].trim() : null;
  const exemptLabel = names.includes("process-exempt");

  // Task line: product PRs need the key, docs/process-only PRs may use `none`.
  const directive = parseTaskDirective(rendered);
  if (!directive.present) {
    errors.push(
      processOnly
        ? "PR body must contain `Task: none — <reason>` (docs/process-only reduced contract)."
        : "PR body must contain `Task: ROT-<n>`.",
    );
  } else if (processOnly) {
    if (directive.kind === "none" && directive.reason.length === 0) {
      errors.push("`Task: none` requires a one-line reason after the dash.");
    } else if (directive.kind === "invalid") {
      errors.push("`Task:` must carry `ROT-<n>` or `none — <reason>`.");
    }
  } else if (directive.kind !== "key") {
    errors.push("product PRs require `Task: ROT-<n>`; `Task: none` is only for docs/process-only changes.");
  }

  let waivedBy = null;
  if (exemptLabel) {
    if (!exemptReason || exemptReason.length < 3 || /^<[^>]*>$/.test(exemptReason) || /^todo$/i.test(exemptReason)) {
      errors.push(
        "the `process-exempt` label requires a one-line `Process-exempt: <reason>` in the body; the reason cannot be empty, a placeholder or `TODO`.",
      );
    } else {
      waivedBy = exemptReason;
    }
  }

  if (!processOnly && !waivedBy) {
    for (const name of REQUIRED_SECTIONS) {
      const content = sections.get(normalizeHeading(name));
      if (content === undefined) {
        errors.push(`missing section \`## ${name}\` (template: .github/pull_request_template.md).`);
        continue;
      }
      if (nonBlankLines(content).length === 0) {
        errors.push(`section \`## ${name}\` is empty; HTML comments and blank lines do not count.`);
      }
    }

    if (sections.has(normalizeHeading("Spec")) && !hasSpecLink(sections.get(normalizeHeading("Spec")))) {
      errors.push("`## Spec` must link an openspec/changes/<id>/ folder or a spec file.");
    }

    if (sections.has(normalizeHeading("Tests")) && !hasTestEvidence(sections.get(normalizeHeading("Tests")))) {
      errors.push(
        "`## Tests` must name the command(s) and how each test fails without the change (include a failure word such as `fails` or `without the change`).",
      );
    }

    if (
      sections.has(normalizeHeading("Mutation proof")) &&
      !hasMutationEvidence(sections.get(normalizeHeading("Mutation proof")))
    ) {
      errors.push(
        "`## Mutation proof` must carry a command and its output (a fenced block) showing a test or gate fails when the fix is reverted.",
      );
    }

    const reviewSection = sections.get(normalizeHeading("Independent review"));
    const review = reviewSection ?? "";
    if (reviewSection !== undefined && nonBlankLines(review).length > 0) {
      const reviewer = REVIEWER_RE.exec(review)?.[1]?.trim();
      const verdict = normalizeVerdict(VERDICT_RE.exec(review)?.[1]);
      if (!reviewer) {
        errors.push("`## Independent review` must name `Reviewer: <agent/role>`.");
      } else {
        const reviewerKey = reviewer.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
        const authorKey = String(author ?? "").trim().toLowerCase();
        if (SELF_REVIEW_RE.test(reviewerKey) || mentionsAuthor(reviewerKey, authorKey)) {
          errors.push("`## Independent review` names the author; the reviewer must be a different agent.");
        }
      }
      if (!verdict) {
        errors.push("`## Independent review` must state `Verdict: APPROVE`.");
      } else if (!PASS_VERDICT_RE.test(verdict)) {
        errors.push(`\`## Independent review\` verdict is "${verdict}"; only APPROVE, PASS or LGTM pass.`);
      }
    }

    if (sections.has(normalizeHeading("Verification")) && !hasCommandEvidence(sections.get(normalizeHeading("Verification")))) {
      errors.push("`## Verification` must carry the commands run and at least one line of their results.");
    }
  }

  const ok = errors.length === 0;
  const contract = processOnly ? "docs/process-only reduced contract" : waivedBy ? "process-exempt" : "product contract";
  const task = directive.kind === "key" ? `Task ${directive.key}` : directive.kind === "none" ? `Task: none (${directive.reason})` : "no Task line";
  const summary = ok ? `PR #${number ?? "(local)"} ${contract}: ${task}` : null;
  return { ok, errors, summary, processOnly, waivedBy, directive };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsAuthor(reviewer, author) {
  if (!author) return false;
  const pattern = new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(author)}([^a-z0-9_-]|$)`, "i");
  return pattern.test(reviewer);
}

function gh(args) {
  try {
    return execFileSync("gh", args, {
      cwd: repoRoot,
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

function resolveRepo(args) {
  if (args.repo) return args.repo;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return JSON.parse(gh(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
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

function usage() {
  return [
    "Usage:",
    "  node scripts/check-process.mjs --pr <number> [--repo owner/name] [--repo-root <path>]",
    "  node scripts/check-process.mjs --body-file <path> --files <a,b> [--labels process-exempt] [--author login] [--head-ref branch] [--repo-root <path>]",
    "",
    "Product PRs need `## Spec`, `## Tests`, `## Mutation proof`,",
    "`## Independent review`, `## Verification` and `Task: ROT-<n>`.",
    "Docs/process-only PRs may use `Task: none — <reason>` and skip the",
    "sections. `process-exempt` waives the sections only with a one-line",
    "`Process-exempt: <reason>` in the body.",
    "Automation PRs (a `[bot]`/`app/*` author or a `release-please--*` head",
    "branch) are skipped with a notice; they have no human author to satisfy",
    "the contract.",
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  // The workflow runs a copy of this file extracted from the base branch, so
  // the checkout it judges is given explicitly (see .github/workflows/).
  if (args["repo-root"]) repoRoot = path.resolve(args["repo-root"]);

  let result;
  if (args.pr) {
    const prNumber = Number(args.pr);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`--pr needs a positive number, got ${args.pr}`);
    }
    const repo = resolveRepo(args);
    const view = JSON.parse(
      gh([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "number,body,files,labels,author,headRefName",
      ]),
    );
    result = checkPullRequest({
      number: view.number ?? prNumber,
      body: view.body ?? "",
      files: (view.files ?? []).map((file) => file.path),
      labels: view.labels ?? [],
      author: view.author?.login ?? null,
      isBot: view.author?.is_bot === true,
      headRefName: view.headRefName ?? null,
    });
  } else if (args["body-file"]) {
    const body = fs.readFileSync(path.resolve(repoRoot, args["body-file"]), "utf8");
    const files = (args.files ?? "")
      .split(",")
      .map((file) => file.trim())
      .filter(Boolean);
    const labels = (args.labels ?? "")
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean);
    result = checkPullRequest({
      body,
      files,
      labels,
      author: args.author ?? null,
      headRefName: args["head-ref"] ?? null,
    });
  } else {
    throw new Error(usage());
  }

  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.error("process-contract FAILED");
    process.exitCode = 1;
    return;
  }
  if (result.skipped) {
    console.log(`process-contract SKIPPED: ${result.summary}`);
    return;
  }
  console.log(`process-contract OK: ${result.summary}`);
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
