#!/usr/bin/env node
// Donor-literal gate.
//
// The repository is public and must not name the private reference sites we
// studied for parity. The real identities live in one private source:
//   - DONOR_REFS_JSON (repository secret in CI), or
//   - ~/.rotor-donor-refs.json (local machine).
//
// This gate reads that source and scans every tracked file (content and path)
// for the real names and hosts. It fails closed when no source is available: a
// fork must set DONOR_REFS_JSON. DONOR_REFS_OPTIONAL=1 is the explicit escape
// hatch for a deliberate, local skip.
//
// Zero dependencies. Findings print file:line and the neutral token only; the
// real literal is never echoed into CI logs, a PR or a commit.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const REFS_PATH = path.join(homedir(), ".rotor-donor-refs.json");
const OPTIONAL = process.env.DONOR_REFS_OPTIONAL === "1";

function usage() {
  return `check-donor-literals - fail when a tracked file names a private reference site

Refs source:
  DONOR_REFS_JSON          JSON: { donors: [{ token, name, hosts: [] }] }
  ${REFS_PATH}
  (the env var wins; the file is the local fallback)

Env:
  DONOR_REFS_OPTIONAL=1    skip the gate when no refs source exists

Exit: 0 = clean or explicitly skipped, 1 = literals found or no refs source.`;
}

function loadRefs() {
  const raw = process.env.DONOR_REFS_JSON;
  if (raw && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("DONOR_REFS_JSON is not valid JSON");
    }
  }
  if (existsSync(REFS_PATH)) {
    try {
      return JSON.parse(readFileSync(REFS_PATH, "utf8"));
    } catch (error) {
      throw new Error(`cannot read ${REFS_PATH}: ${error.code || "read error"}`);
    }
  }
  return null;
}

function buildNeedles(refs) {
  if (!refs || !Array.isArray(refs.donors) || refs.donors.length === 0) {
    throw new Error("refs source has no donors array");
  }
  const needles = new Map();
  const add = (value, token) => {
    if (typeof value !== "string") return;
    const needle = value.trim().toLowerCase();
    // Short strings would false-positive on binary files and ordinary prose.
    if (needle.length < 4) return;
    needles.set(needle, token);
  };
  for (const donor of refs.donors) {
    if (!donor || typeof donor.token !== "string" || !donor.token) {
      throw new Error("every donor needs a non-empty token");
    }
    add(donor.name, donor.token);
    for (const host of donor.hosts || []) add(host, donor.token);
    // The brand stem catches a name rendered without its TLD.
    if (typeof donor.name === "string") {
      add(donor.name.replace(/\.[a-z0-9-]+$/i, ""), donor.token);
    }
  }
  if (needles.size === 0) throw new Error("refs source produced no needles");
  return needles;
}

function findingsFor(text, needles) {
  const found = new Set();
  const lower = text.toLowerCase();
  for (const [needle, token] of needles) {
    if (lower.includes(needle)) found.add(token);
  }
  return found;
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  let refs;
  try {
    refs = loadRefs();
  } catch (error) {
    process.stderr.write(`check-donor-literals: ${error.message}\n`);
    return 1;
  }
  if (!refs) {
    if (OPTIONAL) {
      process.stdout.write("check-donor-literals: no refs source; skipped (DONOR_REFS_OPTIONAL=1)\n");
      return 0;
    }
    process.stderr.write(
      "check-donor-literals: no refs source. Set DONOR_REFS_JSON (repository secret) " +
        `or create ${REFS_PATH}. A fork must set the env var. ` +
        "Use DONOR_REFS_OPTIONAL=1 only to skip deliberately.\n",
    );
    return 1;
  }

  let needles;
  try {
    needles = buildNeedles(refs);
  } catch (error) {
    process.stderr.write(`check-donor-literals: ${error.message}\n`);
    return 1;
  }

  // Resolve the repository root so the gate is correct when run from a
  // subdirectory; `git ls-files` is otherwise scoped to the current directory.
  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    process.stderr.write("check-donor-literals: not inside a git repository\n");
    return 1;
  }
  const files = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

  const findings = [];
  let scanned = 0;
  for (const file of files) {
    const pathTokens = findingsFor(file, needles);
    for (const token of pathTokens) {
      findings.push(`${file}:path: contains ${token} identity`);
    }

    let buffer;
    try {
      buffer = readFileSync(path.join(root, file));
    } catch {
      continue;
    }
    // latin1 keeps byte offsets stable and never throws on binary files.
    const text = buffer.toString("latin1");
    scanned += 1;
    let lineNumber = 0;
    let offset = 0;
    while (offset <= text.length) {
      const newline = text.indexOf("\n", offset);
      const end = newline === -1 ? text.length : newline;
      lineNumber += 1;
      const tokens = findingsFor(text.slice(offset, end), needles);
      for (const token of tokens) {
        findings.push(`${file}:${lineNumber}: contains ${token} identity`);
      }
      if (newline === -1) break;
      offset = newline + 1;
    }
  }

  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`${finding}\n`);
    process.stderr.write(
      `check-donor-literals: FAIL - ${findings.length} finding(s) in ` +
        `${new Set(findings.map((line) => line.split(":")[0])).size} file(s)\n`,
    );
    return 1;
  }

  process.stdout.write(
    `check-donor-literals: clean (${refs.donors.length} donors, ` +
      `${needles.size} needles, ${scanned} files)\n`,
  );
  return 0;
}

process.exitCode = main();
