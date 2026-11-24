#!/usr/bin/env node
// Universal revert mutation tier: revert every changed hunk outside test paths,
// run the project test command, and require the suite to go red. A green run
// means the tests do not cover the change ("test did not catch the change").
//
//   node scripts/revert-fix.mjs --base origin/main --cmd "npm --prefix web test"
//   node scripts/revert-fix.mjs --base origin/main --projects-area web
//   node scripts/revert-fix.mjs --base origin/main --cmd "node --test" \
//       --test-glob "**/*.spec.mjs" --include "apps/site/**" --dry-run
//
// Contract:
//   - The tracked tree must be clean before the run; the script refuses a dirty
//     tree (untracked files are ignored, output artifacts are expected).
//   - The test command runs once on the clean branch first. If the baseline is
//     already red, a later failure cannot be attributed to the revert, so the
//     run aborts instead of claiming proof.
//   - Only files outside the test globs are reverted. Test changes stay in
//     place: the mutation must be caught by the test, not by the test change.
//   - The tree is restored in a `finally` block and verified clean. A failed
//     restore is a hard error (exit 3), never a silent modification.
//
// Exit codes: 0 proven, 1 test did not catch the change, 2 usage/baseline/apply
// error, 3 the tree could not be restored.
//
// No dependencies beyond Node builtins and `git`.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Test paths are never reverted. The list covers the repository's conventions
// plus the generic names from the verification contract; `--test-glob` adds
// to it. A path is a test when any glob matches.
export const DEFAULT_TEST_GLOBS = [
  "tests/**",
  "**/tests/**",
  "**/*_test.go",
  "**/*.test.*",
  "**/*-test.mjs",
  "**/*-test.js",
  "**/test_*.py",
  "crates/**/tests/**",
];

function normalizePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

// Small glob matcher for repository paths: `**` crosses directories, `*` and
// `?` stay inside one segment. No dependency, and identical on Windows/Linux.
export function globToRegExp(glob) {
  const source = normalizePath(glob);
  let pattern = "^";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "*") {
      if (source[index + 1] === "*") {
        index += 1;
        if (source[index + 1] === "/") {
          index += 1;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`);
}

export function matchesGlob(filePath, glob) {
  return globToRegExp(glob).test(normalizePath(filePath));
}

export function isTestPath(filePath, testGlobs = DEFAULT_TEST_GLOBS) {
  const normalized = normalizePath(filePath);
  return testGlobs.some((glob) => matchesGlob(normalized, glob));
}

// Files that may be reverted: changed, outside the test globs, inside one of
// the include globs when any are given, and inside one of the source globs
// when any are given. Source globs let CI ignore documentation, workflow and
// data-only changes: there is no executable behaviour for a test to catch.
export function selectRevertableFiles(
  files,
  { testGlobs = DEFAULT_TEST_GLOBS, includeGlobs = [], sourceGlobs = [] } = {},
) {
  return files
    .map(normalizePath)
    .filter(Boolean)
    .filter((filePath) => !isTestPath(filePath, testGlobs))
    .filter(
      (filePath) =>
        includeGlobs.length === 0 ||
        includeGlobs.some((glob) => matchesGlob(filePath, glob)),
    )
    .filter(
      (filePath) =>
        sourceGlobs.length === 0 ||
        sourceGlobs.some((glob) => matchesGlob(filePath, glob)),
    );
}

function git(repoRoot, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function gitStatus(repoRoot) {
  return git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]).trim();
}

function trackedTreeIsClean(repoRoot) {
  return gitStatus(repoRoot) === "";
}

// The tree was clean at start. A test command is allowed to write tracked
// generated files; put HEAD content back before leaving, including on the
// baseline-failure path that exits before the patch exists.
function discardTrackedChanges(repoRoot) {
  if (!trackedTreeIsClean(repoRoot)) git(repoRoot, ["reset", "--hard", "HEAD"]);
}

export function changedFiles(repoRoot, base) {
  const output = git(repoRoot, [
    "diff",
    "--name-only",
    "--diff-filter=ACMRD",
    `${base}...HEAD`,
  ]);
  return output
    .split(/\r?\n/)
    .map(normalizePath)
    .filter(Boolean);
}

function gitRange(base) {
  return `${base}...HEAD`;
}

function runCommand(repoRoot, command, timeout) {
  const result = spawnSync(command, {
    cwd: repoRoot,
    shell: true,
    stdio: "inherit",
    timeout,
    env: process.env,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT" || result.signal) {
      return { status: null, timedOut: true };
    }
    throw result.error;
  }
  return { status: result.status, timedOut: false };
}

function restore(repoRoot, patchPath, files) {
  try {
    if (patchPath && fs.existsSync(patchPath)) {
      execFileSync("git", ["apply", patchPath], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  } catch {
    // Forward apply can fail if the reverse apply was partial; reset the
    // tracked tree to HEAD. The script refused a dirty tree, so HEAD is the
    // exact pre-run state.
    try {
      git(repoRoot, ["reset", "--hard", "HEAD"]);
    } catch {
      /* reported by the verification below */
    }
  }
  // Added files removed by the reverse patch and renames are covered by the
  // forward apply; a plain checkout is the last safety net for tracked paths.
  try {
    if (files.length > 0) git(repoRoot, ["checkout", "--", ...files]);
  } catch {
    /* reported by the verification below */
  }
  return trackedTreeIsClean(repoRoot);
}

function usage() {
  console.log(`Usage:
  node scripts/revert-fix.mjs --base <ref> --cmd <shell command> [options]
  node scripts/revert-fix.mjs --base <ref> --projects-area <id> [options]

Options:
  --base <ref>          Base ref or commit to diff against (default: origin/main).
  --cmd <command>       Test command to run; required unless --projects-area
                        supplies one (it overrides the area's test list).
  --projects-area <id>  Use the area's paths and test commands from projects.json.
  --test-glob <glob>    Add a test-path glob (repeatable).
  --include <glob>      Only revert files matching this glob (repeatable).
  --source-glob <glob>  Only revert executable-source files matching this glob
                        (repeatable); ignored when empty.
  --timeout <ms>        Test command timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}).
  --repo-root <path>    Repository root (default: the script's parent directory).
  --dry-run             Print the plan without running or modifying anything.
  --help                Print this help.

Exit codes: 0 test proven, 1 test did not catch the change, 2 error,
3 the tree could not be restored.`);
}

function parseArgs(argv) {
  const options = {
    base: "origin/main",
    cmd: null,
    projectsArea: null,
    testGlobs: [...DEFAULT_TEST_GLOBS],
    includeGlobs: [],
    sourceGlobs: [],
    timeout: DEFAULT_TIMEOUT_MS,
    repoRoot: DEFAULT_REPO_ROOT,
    dryRun: false,
    help: false,
  };  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[index];
    };
    if (arg === "--base") options.base = take();
    else if (arg === "--cmd") options.cmd = take();
    else if (arg === "--projects-area") options.projectsArea = take();
    else if (arg === "--test-glob") options.testGlobs.push(take());
    else if (arg === "--include") options.includeGlobs.push(take());
    else if (arg === "--source-glob") options.sourceGlobs.push(take());
    else if (arg === "--timeout") options.timeout = Number(take());
    else if (arg === "--repo-root") options.repoRoot = path.resolve(take());
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
    throw new Error("--timeout must be a positive number of milliseconds");
  }
  return options;
}

function loadArea(repoRoot, id) {
  const manifestPath = path.join(repoRoot, "projects.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const area = (manifest.areas ?? []).find((candidate) => candidate.id === id);
  if (!area) {
    const ids = (manifest.areas ?? []).map((candidate) => candidate.id).join(", ");
    throw new Error(`unknown projects.json area: ${id} (known: ${ids})`);
  }
  if (!Array.isArray(area.test) || area.test.length === 0) {
    throw new Error(`projects.json area ${id} has no test commands`);
  }
  return area;
}

function writePatch(repoRoot, base, files) {
  const patch = git(repoRoot, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "-U3",
    gitRange(base),
    "--",
    ...files,
  ]);
  if (!patch.trim()) return null;
  const patchPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "revert-fix-")),
    "change.patch",
  );
  fs.writeFileSync(patchPath, patch, "utf8");
  return patchPath;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    usage();
    process.exit(2);
  }
  if (options.help) {
    usage();
    process.exit(0);
  }

  const repoRoot = options.repoRoot;
  let command = options.cmd;
  let includeGlobs = options.includeGlobs;
  try {
    if (options.projectsArea) {
      const area = loadArea(repoRoot, options.projectsArea);
      // --projects-area supplies the area's path globs; --cmd may override the
      // area's test list when one command is not runnable on the CI runner
      // (for example the GPU-feature desktop test or a wasm artifact test).
      if (!command) command = area.test.join(" && ");
      includeGlobs = area.paths;
      console.log(`area: ${area.id} (${area.title})`);
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }
  if (!command) {
    console.error("error: --cmd or --projects-area is required");
    usage();
    process.exit(2);
  }

  try {
    git(repoRoot, ["rev-parse", "--verify", "--quiet", `${options.base}^{commit}`]);
  } catch {
    console.error(`error: base ref not found: ${options.base}`);
    process.exit(2);
  }

  if (!trackedTreeIsClean(repoRoot)) {
    console.error("error: the tracked tree is dirty; commit or discard the changes first");
    console.error(gitStatus(repoRoot));
    process.exit(2);
  }

  const changed = changedFiles(repoRoot, options.base);
  const revertable = selectRevertableFiles(changed, {
    testGlobs: options.testGlobs,
    includeGlobs,
    sourceGlobs: options.sourceGlobs,
  });

  console.log(`base: ${options.base}`);
  console.log(`changed files: ${changed.length}`);
  console.log(`revertable files (outside test paths): ${revertable.length}`);
  for (const filePath of revertable) console.log(`  ${filePath}`);

  if (revertable.length === 0) {
    console.log("result: nothing to revert");
    process.exit(0);
  }

  if (options.dryRun) {
    console.log("dry-run: no command was run and the tree was not modified");
    process.exit(0);
  }

  console.log(`command: ${command}`);

  let patchPath = null;
  let finished = false;
  try {
    console.log("baseline: running the test command before the revert");
    const baseline = runCommand(repoRoot, command, options.timeout);
    if (baseline.timedOut) {
      discardTrackedChanges(repoRoot);
      console.error("error: the baseline test command timed out");
      process.exit(2);
    }
    if (baseline.status !== 0) {
      discardTrackedChanges(repoRoot);
      console.error(
        `error: the baseline test command failed (exit ${baseline.status}); a later failure cannot prove the revert`,
      );
      process.exit(2);
    }
    console.log("baseline: passed");

    // The test command may write tracked generated files; reset them so the
    // reverse patch applies to the exact HEAD content.
    discardTrackedChanges(repoRoot);

    patchPath = writePatch(repoRoot, options.base, revertable);
    if (!patchPath) {
      console.log("result: nothing to revert");
      process.exit(0);
    }

    try {
      execFileSync("git", ["apply", "-R", "--whitespace=nowarn", patchPath], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // Throw instead of exiting: the finally block must restore a partial apply.
      throw new Error(`could not revert the change: ${error.message}`);
    }
    console.log("reverted: the non-test hunks are out of the tree");

    const after = runCommand(repoRoot, command, options.timeout);
    if (after.timedOut) {
      console.log("result: test did not catch the change (the command timed out)");
      process.exitCode = 1;
      finished = true;
    } else if (after.status !== 0) {
      console.log("result: test proven");
      console.log(`failing exit code: ${after.status}`);
      process.exitCode = 0;
      finished = true;
    } else {
      console.log("result: test did not catch the change");
      process.exitCode = 1;
      finished = true;
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 2;
  } finally {
    const clean = restore(repoRoot, patchPath, revertable);
    if (!clean) {
      console.error(
        "error: the working tree is still modified after the restore; inspect `git status` (the script refused a dirty tree, so `git reset --hard HEAD` is safe)",
      );
      process.exitCode = 3;
    } else {
      console.log("restore: the tracked tree is clean");
    }
    if (patchPath) {
      try {
        fs.rmSync(path.dirname(patchPath), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    if (!finished && process.exitCode === undefined) process.exitCode = 2;
  }
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main();
}
