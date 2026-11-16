#!/usr/bin/env node
// Validate projects.json and prove every tracked path has exactly one owner.
// No dependencies, no network, no cargo.

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

let projects;
try {
  projects = loadProjects(REPO_ROOT);
} catch (error) {
  fail([`cannot read projects.json: ${error.message}`]);
  process.exit();
}

const errors = [];
if (typeof projects.asset_version !== "string" || projects.asset_version.length === 0) {
  errors.push("asset_version must be a non-empty string");
}
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

if (errors.length > 0) {
  fail(errors);
  process.exit();
}

console.log(
  `projects.json OK: ${projects.areas.length} areas, ${covered.length}/${tracked.length} tracked paths covered` +
    (ignored.length > 0 ? ` (${ignored.length} ignored: ${ignored.join(", ")})` : ""),
);
