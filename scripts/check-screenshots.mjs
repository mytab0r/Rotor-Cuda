#!/usr/bin/env node
// Guard `screenshots-in-repo`: no screenshot or test-evidence image is tracked
// under docs/.
//
// UI evidence is produced by the PR's `ui-audit` CI run (see
// .github/workflows/ui.yml) and attached as the `ui-audit-report-<run id>`
// artifact. The PR description links to that artifact; the image never lands
// in git, so checkouts and history stay small.
//
// Zero dependencies; Windows-safe. Exit: 0 = clean, 1 = tracked image under
// docs/.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib/area-map.mjs";

export const DETECTOR_ID = "screenshots-in-repo";
const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif)$/i;

// Genuine exceptions only, each with the reason in the commit that adds it.
// Empty today: docs/ deliberately carries no image assets.
export const ALLOWLIST = new Set();

export function findOffenders(trackedFiles) {
  return trackedFiles
    .filter((file) => file.startsWith("docs/"))
    .filter((file) => IMAGE_EXTENSION.test(file))
    .filter((file) => !ALLOWLIST.has(file))
    .sort();
}

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

export function main() {
  let files;
  try {
    files = trackedFiles();
  } catch (error) {
    console.error(`error: [${DETECTOR_ID}] cannot run git ls-files: ${error.message}`);
    return 2;
  }

  const offenders = findOffenders(files);
  if (offenders.length > 0) {
    for (const file of offenders) {
      console.error(
        `error: [${DETECTOR_ID}] ${file} is a tracked image under docs/; ` +
          "UI evidence belongs in the ui-audit CI artifact, never in git",
      );
    }
    console.error(`screenshots-in-repo: FAILED (${offenders.length} tracked image(s) under docs/)`);
    return 1;
  }

  console.log(
    `${DETECTOR_ID}: OK (${files.length} tracked files, no images under docs/)`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
