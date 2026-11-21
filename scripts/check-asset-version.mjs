import fs from "node:fs";
import { execFileSync } from "node:child_process";

function fail(message) {
  console.error(`asset-version: ${message}`);
  process.exit(1);
}

function readVersion(text, where) {
  try {
    return JSON.parse(text).asset_version;
  } catch (error) {
    fail(`${where} is not valid JSON: ${error.message}`);
  }
}

const head = readVersion(fs.readFileSync("projects.json", "utf8"), "projects.json");

const htmlVersions = new Set();
for (const file of fs.readdirSync("apps/site").filter((name) => name.endsWith(".html"))) {
  const source = fs.readFileSync(`apps/site/${file}`, "utf8");
  for (const match of source.matchAll(/\?v=([0-9a-z]+)/g)) htmlVersions.add(match[1]);
}

// Coordinator-generated pages (/private-keys, /brainwallet, /cabinet, seeded
// pages) hardcode their own tokens; a stale one ships without touching the
// HTML files, so fold it into the same single-version requirement.
const coordinatorFile = "src/coordinator/mod.rs";
const versions = new Set(htmlVersions);
for (const match of fs.readFileSync(coordinatorFile, "utf8").matchAll(/\?v=([0-9a-z]+)/g)) {
  versions.add(match[1]);
}

if (versions.size !== 1) {
  fail(
    `pages and ${coordinatorFile} use ${versions.size} different ?v= values: ${[...versions].join(", ")}`,
  );
}
const [pageVersion] = versions;
if (pageVersion !== head) {
  fail(`pages and ${coordinatorFile} use ?v=${pageVersion} but projects.json says ${head}`);
}

if (process.env.GITHUB_EVENT_NAME === "pull_request") {
  let base;
  try {
    base = readVersion(
      execFileSync("git", ["show", "origin/main:projects.json"], { encoding: "utf8" }),
      "origin/main:projects.json",
    );
  } catch (error) {
    fail(`cannot read origin/main projects.json (fetch-depth 0 is required): ${error.message}`);
  }
  if (head < base) {
    fail(`asset version regressed: head ${head} is older than main ${base}`);
  }
}

console.log(`asset-version: ${head} ok`);
