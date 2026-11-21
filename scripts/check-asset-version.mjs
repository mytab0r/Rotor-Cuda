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

// Every token that can ship must match projects.json.asset_version: static
// pages, coordinator-generated pages (/private-keys, /brainwallet, /cabinet,
// seeded pages) and lazy-loaded scripts that fetch assets at runtime.
const versions = new Map();
function collect(where, text) {
  for (const match of text.matchAll(/\?v=([0-9a-z]+)/g)) {
    if (!versions.has(match[1])) versions.set(match[1], new Set());
    versions.get(match[1]).add(where);
  }
}

for (const file of fs.readdirSync("apps/site").filter((name) => name.endsWith(".html"))) {
  collect(`apps/site/${file}`, fs.readFileSync(`apps/site/${file}`, "utf8"));
}
collect("src/coordinator/mod.rs", fs.readFileSync("src/coordinator/mod.rs", "utf8"));
for (const file of fs.readdirSync("apps/site").filter((name) => name.endsWith(".js"))) {
  collect(`apps/site/${file}`, fs.readFileSync(`apps/site/${file}`, "utf8"));
}

if (versions.size !== 1 || !versions.has(head)) {
  const stale = [...versions]
    .filter(([version]) => version !== head)
    .flatMap(([version, files]) => [...files].map((file) => `${file} uses ?v=${version}`));
  fail(`expected a single ?v=${head} everywhere: ${stale.join(", ")}`);
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
