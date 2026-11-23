// Tests for the universal revert mutation tier (scripts/revert-fix.mjs).
//
// The integration cases build a throwaway git repository: a "feature" commit
// that a test covers must go red when the non-test hunk is reverted, and an
// untested change must stay green. The script restores the tree in both cases.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TEST_GLOBS,
  globToRegExp,
  isTestPath,
  matchesGlob,
  selectRevertableFiles,
} from "./revert-fix.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "revert-fix.mjs");

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revert-fix-test-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "revert-fix test");
  fs.writeFileSync(path.join(dir, "lib.mjs"), "export const add = (a, b) => a + b;\n");
  fs.writeFileSync(
    path.join(dir, "lib.test.mjs"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { add } from "./lib.mjs";',
      'test("add", () => assert.equal(add(2, 3), 5));',
      "",
    ].join("\n"),
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

function run(dir, args) {
  // The outer test runner exports NODE_TEST_CONTEXT; without removing it the
  // child `node --test` refuses to run its files ("called recursively").
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
}

function assertClean(dir) {
  assert.equal(git(dir, "status", "--porcelain", "--untracked-files=no"), "");
}

test("glob matcher: ** crosses directories, * stays in a segment", () => {
  assert.ok(matchesGlob("tests/coordinator_api.rs", "tests/**"));
  assert.ok(matchesGlob("web/tests/a.test.ts", "**/tests/**"));
  assert.ok(matchesGlob("scripts/check-process.test.mjs", "**/*.test.*"));
  assert.ok(matchesGlob("apps/site/amount-test.mjs", "**/*-test.mjs"));
  assert.ok(matchesGlob("crates/rotor-wasm/tests/it.rs", "crates/**/tests/**"));
  assert.ok(!matchesGlob("src/lib.rs", "tests/**"));
  assert.ok(!matchesGlob("scripts/foo.mjs", "**/*.test.*"));
  assert.equal(globToRegExp("a/*/c").test("a/b/c"), true);
  assert.equal(globToRegExp("a/*/c").test("a/b/d/c"), false);
});

test("test paths cover the project conventions", () => {
  assert.ok(isTestPath("tests/coordinator_api.rs"));
  assert.ok(isTestPath("web/tests/analytics-beacon.test.mjs"));
  assert.ok(isTestPath("scripts/check-process.test.mjs"));
  assert.ok(isTestPath("scripts/check-process.test.mjs"));
  assert.ok(isTestPath("apps/site/amount-test.mjs"));
  assert.ok(isTestPath("crates/rotor-wasm/tests/smoke.rs"));
  assert.ok(isTestPath("pkg/handler_test.go"));
  assert.ok(isTestPath("pkg/test_handler.py"));
  assert.ok(!isTestPath("apps/site/amount.js"));
  assert.ok(!isTestPath("src/lib.rs"));
  assert.ok(DEFAULT_TEST_GLOBS.length > 0);
});

test("selection excludes test paths and honours include globs", () => {
  const files = [
    "apps/site/amount.js",
    "apps/site/amount-test.mjs",
    "web/src/lib/chains.ts",
    "web/tests/chains.test.ts",
    "docs/process/gates.md",
  ];
  assert.deepEqual(selectRevertableFiles(files), [
    "apps/site/amount.js",
    "web/src/lib/chains.ts",
    "docs/process/gates.md",
  ]);
  assert.deepEqual(selectRevertableFiles(files, { includeGlobs: ["web/**"] }), [
    "web/src/lib/chains.ts",
  ]);
});

test("integration: reverting a covered change makes the test fail", () => {
  const { dir, base } = makeRepo();
  fs.appendFileSync(path.join(dir, "lib.mjs"), "export const sub = (a, b) => a - b;\n");
  fs.appendFileSync(
    path.join(dir, "lib.test.mjs"),
    [
      'import { sub } from "./lib.mjs";',
      'test("sub", () => assert.equal(sub(5, 3), 2));',
      "",
    ].join("\n"),
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "feat: sub");

  const result = run(dir, ["--repo-root", dir, "--base", base, "--cmd", "node --test lib.test.mjs"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /result: test proven/);
  assert.match(result.stdout, /restore: the tracked tree is clean/);
  assertClean(dir);
});

test("integration: an untested change reports 'did not catch'", () => {
  const { dir, base } = makeRepo();
  fs.appendFileSync(path.join(dir, "lib.mjs"), "export const unused = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "feat: unused export");

  const result = run(dir, ["--repo-root", dir, "--base", base, "--cmd", "node --test lib.test.mjs"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /result: test did not catch the change/);
  assertClean(dir);
});

test("integration: a dirty tracked tree is refused before anything runs", () => {
  const { dir, base } = makeRepo();
  fs.appendFileSync(path.join(dir, "lib.mjs"), "// uncommitted\n");

  const result = run(dir, ["--repo-root", dir, "--base", base, "--cmd", "node --test lib.test.mjs"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /tracked tree is dirty/);
  assert.equal(git(dir, "status", "--porcelain", "--untracked-files=no"), "M lib.mjs");
});
