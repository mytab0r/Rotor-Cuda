#!/usr/bin/env node
// Map changed or explicit paths to projects.json areas and print the
// cross-area checklist. No dependencies, no network, no cargo.

import { execFileSync } from "node:child_process";
import {
  IGNORED_PATHS,
  REPO_ROOT,
  loadProjects,
  normalizePath,
  resolvePath,
} from "./lib/area-map.mjs";

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function diffPaths(range) {
  const diffs = git(["diff", "--name-only", "--diff-filter=ACMRD", range]);
  return diffs.split(/\r?\n/).filter(Boolean).map(normalizePath);
}

function changedPaths() {
  let base = "origin/main";
  try {
    git(["rev-parse", "--verify", "--quiet", base]);
  } catch {
    base = "HEAD";
    try {
      git(["rev-parse", "--verify", "--quiet", base]);
    } catch {
      console.error("warning: no origin/main or HEAD; run from a git checkout");
      return [];
    }
    console.error("warning: origin/main not found; diffing against HEAD");
  }
  try {
    const tracked = git(["diff", "--name-only", base]);
    const untracked = git(["ls-files", "--others", "--exclude-standard"]);
    return [...new Set([...tracked.split(/\r?\n/), ...untracked.split(/\r?\n/)])]
      .filter(Boolean)
      .map(normalizePath);
  } catch (error) {
    console.error(`warning: cannot read git diff: ${error.message}`);
    return [];
  }
}

let projects;
try {
  projects = loadProjects(REPO_ROOT);
  if (!Array.isArray(projects.areas) || projects.areas.length === 0) {
    throw new Error("projects.json has no areas");
  }
} catch (error) {
  console.error(`error: broken area map: ${error.message}`);
  process.exit(1);
}

const argv = { json: false, range: null, paths: [] };
const rawArgs = process.argv.slice(2);
for (let i = 0; i < rawArgs.length; i += 1) {
  if (rawArgs[i] === "--json") {
    argv.json = true;
  } else if (rawArgs[i] === "--diff") {
    argv.range = rawArgs[i + 1];
    i += 1;
    if (!argv.range) {
      console.error("error: --diff requires a git range");
      process.exit(1);
    }
  } else {
    argv.paths.push(normalizePath(rawArgs[i]));
  }
}
const paths =
  argv.paths.length > 0 ? argv.paths : argv.range ? diffPaths(argv.range) : changedPaths();

if (paths.length === 0) {
  console.log("No changed paths.");
  process.exit(0);
}

const touched = new Map();
const unmapped = [];
for (const filePath of paths) {
  if (IGNORED_PATHS.has(filePath)) continue;
  const resolved = resolvePath(projects.areas, filePath);
  if (resolved === null || resolved.ambiguous.length > 0) {
    unmapped.push(filePath);
    continue;
  }
  if (!touched.has(resolved.area.id)) touched.set(resolved.area.id, { area: resolved.area, paths: [] });
  touched.get(resolved.area.id).paths.push(filePath);
}

const affected = [...touched.values()].map(({ area, paths: areaPaths }) => ({
  id: area.id,
  owner: area.owner,
  title: area.title,
  paths: areaPaths,
  test: area.test,
}));

const hasArea = (id) => touched.has(id);
const hasPath = (predicate) => paths.some(predicate);
const checklist = [];
if (
  hasArea("site") &&
  hasPath((p) => ["web/site.css", "web/site.js", "web/key.js"].includes(p))
) {
  checklist.push("Site assets changed: bump ?v= in every web/*.html.");
}
if (hasArea("wasm-core") || hasPath((p) => p === "web/rotor_wasm.wasm")) {
  checklist.push(
    "Wasm changed: run sh scripts/build-wasm.sh, both JS tests, and commit web/rotor_wasm.wasm.",
  );
}
if (hasArea("coordinator")) {
  checklist.push(
    "Coordinator embeds web/** at compile time: run cargo build --release --bin rotor-coord and check served routes.",
  );
}
if (hasPath((p) => p === "build.rs" || p.startsWith("Rotor-Cuda/"))) {
  checklist.push("CUDA/build.rs changed: run cargo build --release --features gpu and the gpu-bsgs-compile job.");
}
if (hasPath((p) => p === "Cargo.toml" || p === "Cargo.lock")) {
  checklist.push("Cargo manifest/lock changed: run workspace cargo test --release on Linux and Windows.");
}
if (hasArea("ops")) {
  checklist.push(
    "Ops/docs changed: run node scripts/check-projects.mjs and keep projects.json, PROJECTS.md and CI path filters in sync.",
  );
}
checklist.push("If a contract or behavior changed, update openspec specs and declare Areas: in the change.");
if (unmapped.length > 0) checklist.push("Unmapped paths: add them to the owning area in projects.json.");

if (argv.json) {
  console.log(JSON.stringify({ changed: paths.length, areas: affected, unmapped, checklist }, null, 2));
  process.exit(0);
}

console.log(`Changed paths: ${paths.length}`);
console.log(`Affected areas: ${affected.length}`);
for (const area of affected) {
  console.log(`- ${area.id} [${area.owner}] ${area.title} (${area.paths.length} path(s))`);
  for (const command of area.test) console.log(`  test: ${command}`);
}

console.log("Cross-area checklist:");
for (const item of checklist) console.log(`- [ ] ${item}`);

if (unmapped.length > 0) {
  console.log(`Unmapped paths (${unmapped.length}):`);
  for (const filePath of unmapped) console.log(`- ${filePath}`);
}
