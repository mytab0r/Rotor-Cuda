#!/usr/bin/env node
// Guard `screenshots-in-repo`: no screenshot or test-evidence image is tracked
// under docs/, and no image under web/tests/ lives outside the Playwright
// baseline directory.
//
// UI evidence is produced by the PR's `ui-audit` CI run (see
// .github/workflows/ui.yml) and attached as the `ui-audit-report-<run id>`
// artifact. The PR description links to that artifact; the image never lands
// in git, so checkouts and history stay small.
//
// The one allowed image location is `web/tests/__screenshots__/`: those are
// Playwright `toHaveScreenshot` baselines, deterministic test fixtures that
// must be reviewed and versioned like any other expectation. Playwright's
// default `<spec>-snapshots/` directory is deliberately not allowed.
//
// Zero dependencies; Windows-safe. Exit: 0 = clean, 1 = offending image.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib/area-map.mjs";

export const DETECTOR_ID = "screenshots-in-repo";
const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif)$/i;
const PLAYWRIGHT_BASELINES = "web/tests/__screenshots__/";

// Genuine exceptions only, each with the reason in the commit that adds it.
// Empty today: docs/ deliberately carries no image assets.
export const ALLOWLIST = new Set();

export function findOffenders(trackedFiles) {
  return trackedFiles
    .filter((file) => IMAGE_EXTENSION.test(file))
    .filter((file) => !ALLOWLIST.has(file))
    .filter(
      (file) =>
        file.startsWith("docs/") ||
        (file.startsWith("web/tests/") && !file.startsWith(PLAYWRIGHT_BASELINES)),
    )
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
        `error: [${DETECTOR_ID}] ${file} is a tracked image outside the allowed ` +
          "locations; UI evidence belongs in the ui-audit CI artifact and the only " +
          `committed images under web/tests/ are Playwright baselines in ${PLAYWRIGHT_BASELINES}`,
      );
    }
    console.error(
      `screenshots-in-repo: FAILED (${offenders.length} tracked image(s) outside allowed locations)`,
    );
    return 1;
  }

  console.log(
    `${DETECTOR_ID}: OK (${files.length} tracked files, no images under docs/ or outside ${PLAYWRIGHT_BASELINES})`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
