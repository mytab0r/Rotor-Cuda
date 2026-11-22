#!/usr/bin/env node
// Validate projects.json and prove every tracked path has exactly one owner.
// No dependencies, no network, no cargo.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  IGNORED_PATHS,
  REPO_ROOT,
  globToRegExp,
  loadProjects,
  resolvePath,
} from "./lib/area-map.mjs";

const ALLOWED_OWNERS = new Set([
  "site-ui",
  "coordinator",
  "wasm-core",
  "desktop-tools",
  "ops/docs",
]);

function fail(errors) {
  for (const error of errors) console.error(`error: ${error}`);
  console.error(`projects.json check FAILED (${errors.length} error(s))`);
  process.exitCode = 1;
}

function isStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.length > 0);
}

// Cache tokens were hand-bumped across every page; assets now revalidate by
// ETag, so a `?v=` in a served source means the old mechanism crept back.
const CACHE_TOKEN = /\?v=/;

function servedSourceFiles() {
  const site = fs
    .readdirSync(path.join(REPO_ROOT, "apps/site"))
    .filter((name) => name.endsWith(".html") || name.endsWith(".js"))
    .map((name) => `apps/site/${name}`);
  const tests = fs
    .readdirSync(path.join(REPO_ROOT, "tests"))
    .filter((name) => name.endsWith(".rs"))
    .map((name) => `tests/${name}`);
  return [...site, "src/coordinator/mod.rs", ...tests];
}

function cacheTokenViolations() {
  return servedSourceFiles()
    .filter((relative) => CACHE_TOKEN.test(fs.readFileSync(path.join(REPO_ROOT, relative), "utf8")))
    .map((relative) => `cache-token: ${relative} adds a ?v= query; assets revalidate by ETag`);
}

// The Docker image builds from a context that only contains what the Dockerfile
// COPYs, while a checkout contains every source directory. A Rust include that
// points outside the copied set therefore passes `cargo build` locally and
// fails only inside the image. Resolve every include literal against its Rust
// file and require its top-level path to be copied into the build stage.
const RUST_INCLUDE = /\binclude_(?:str|bytes)!\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;

function rustFilesUnder(relativeDir) {
  const files = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(child);
    }
  };
  walk(relativeDir);
  return files;
}

function dockerBuildCopiedPaths() {
  const dockerfile = path.join(REPO_ROOT, "Dockerfile");
  if (!fs.existsSync(dockerfile)) return null;
  const lines = fs
    .readFileSync(dockerfile, "utf8")
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/);
  const stages = [];
  let stage = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^FROM\s/i.test(line)) {
      stage = { instructions: [] };
      stages.push(stage);
    } else if (stage) {
      stage.instructions.push(line);
    }
  }
  // The build stage is the one that compiles; the runtime stage only copies
  // the binary out of it.
  const build = stages.find((candidate) =>
    candidate.instructions.some((instruction) => /\bcargo build\b/.test(instruction)),
  );
  if (!build) return null;
  const copied = new Set();
  for (const instruction of build.instructions) {
    const match = /^(?:COPY|ADD)\s+(.*)$/i.exec(instruction);
    if (!match) continue;
    const rest = match[1].trim();
    let tokens;
    if (rest.startsWith("[")) {
      try {
        tokens = JSON.parse(rest);
      } catch {
        continue;
      }
    } else {
      tokens = rest.split(/\s+/).filter((token) => !token.startsWith("--"));
    }
    if (!Array.isArray(tokens) || tokens.length < 2) continue;
    for (const source of tokens.slice(0, -1)) {
      if (typeof source !== "string" || path.isAbsolute(source) || /^(?:[a-z]+:)?\/\//i.test(source)) continue;
      const normalized = source.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
      if (!normalized || normalized === "." || normalized === "..") continue;
      copied.add(normalized.split("/")[0]);
    }
  }
  return copied;
}

function dockerIncludeViolations() {
  const copied = dockerBuildCopiedPaths();
  if (copied === null) return [];
  const violations = [];
  for (const file of rustFilesUnder("src")) {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    for (const match of source.matchAll(RUST_INCLUDE)) {
      const literal = match[1].replace(/\\(.)/g, "$1");
      const resolved = path.resolve(REPO_ROOT, path.dirname(file), literal);
      const relative = path.relative(REPO_ROOT, resolved).replaceAll("\\", "/");
      if (relative === "" || relative.startsWith("../") || path.isAbsolute(relative)) {
        violations.push(`docker-copy: ${file} includes ${literal}, which escapes the repository root`);
        continue;
      }
      const top = relative.split("/")[0];
      if (!copied.has(top)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(
          `docker-copy: ${file}:${line} includes ${literal}, but the Dockerfile build stage does not COPY ${top} (add \`COPY ${top} ./${top}\`)`,
        );
      }
    }
  }
  return violations;
}

let projects;
try {
  projects = loadProjects(REPO_ROOT);
} catch (error) {
  fail([`cannot read projects.json: ${error.message}`]);
  process.exit();
}

const errors = [];
if (!Array.isArray(projects.areas) || projects.areas.length === 0) {
  fail(["areas must be a non-empty array"]);
  process.exit();
}

const ids = new Set();
const globs = new Map();
for (const [index, area] of projects.areas.entries()) {
  const where = `areas[${index}]${area && area.id ? ` (${area.id})` : ""}`;
  if (!area || typeof area !== "object") {
    errors.push(`${where} must be an object`);
    continue;
  }
  if (typeof area.id !== "string" || area.id.length === 0) {
    errors.push(`${where}.id must be a non-empty string`);
  } else if (ids.has(area.id)) {
    errors.push(`duplicate area id: ${area.id}`);
  } else {
    ids.add(area.id);
  }
  if (typeof area.title !== "string" || area.title.length === 0) {
    errors.push(`${where}.title must be a non-empty string`);
  }
  if (!ALLOWED_OWNERS.has(area.owner)) {
    errors.push(`${where}.owner must be one of: ${[...ALLOWED_OWNERS].join(", ")}`);
  }
  for (const field of ["build", "test"]) {
    if (!isStringArray(area[field])) {
      errors.push(`${where}.${field} must be a non-empty array of non-empty strings`);
    }
  }
  if (!Array.isArray(area.contracts) || !area.contracts.every((c) => typeof c === "string" && c.length > 0)) {
    errors.push(`${where}.contracts must be an array of non-empty strings`);
  }
  if (!Array.isArray(area.paths) || area.paths.length === 0) {
    errors.push(`${where}.paths must be a non-empty array`);
    continue;
  }
  for (const glob of area.paths) {
    try {
      globToRegExp(glob);
    } catch (error) {
      errors.push(`${where}: ${error.message}`);
      continue;
    }
    if (globs.has(glob)) {
      errors.push(`duplicate path glob "${glob}" in ${globs.get(glob)} and ${area.id}`);
    } else {
      globs.set(glob, area.id);
    }
  }
}

if (errors.length > 0) {
  fail(errors);
  process.exit();
}

let tracked;
try {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  tracked = output.split("\0").filter(Boolean);
} catch (error) {
  fail([`cannot run git ls-files: ${error.message}`]);
  process.exit();
}

const covered = [];
const ignored = [];
for (const filePath of tracked) {
  if (IGNORED_PATHS.has(filePath)) {
    ignored.push(filePath);
    continue;
  }
  const resolved = resolvePath(projects.areas, filePath);
  if (resolved === null) {
    errors.push(`unowned tracked path: ${filePath}`);
  } else if (resolved.ambiguous.length > 0) {
    errors.push(
      `ambiguous owner for ${filePath}: ${resolved.area.id} (${resolved.glob}) ties with ${resolved.ambiguous.join(", ")}`,
    );
  } else {
    covered.push(filePath);
  }
}

errors.push(...cacheTokenViolations());
errors.push(...dockerIncludeViolations());

if (errors.length > 0) {
  fail(errors);
  process.exit();
}

console.log(
  `projects.json OK: ${projects.areas.length} areas, ${covered.length}/${tracked.length} tracked paths covered` +
    (ignored.length > 0 ? ` (${ignored.length} ignored: ${ignored.join(", ")})` : ""),
);
