// CI gate cases for scripts/check-screenshots.mjs. Pure verdict over a tracked
// file list; no git, no filesystem.

import test from "node:test";
import assert from "node:assert/strict";

import { findOffenders } from "./check-screenshots.mjs";

test("flags a tracked image under docs/", () => {
  assert.deepEqual(findOffenders(["docs/process/screenshots/dashboard.png"]), [
    "docs/process/screenshots/dashboard.png",
  ]);
});

test("allows Playwright baselines under web/tests/__screenshots__/", () => {
  assert.deepEqual(
    findOffenders([
      "web/tests/__screenshots__/linux/home.png",
      "web/tests/__screenshots__/win32/desktop-1280-light/home.jpg",
    ]),
    [],
  );
});

test("flags an image under web/tests/ outside the baseline directory", () => {
  assert.deepEqual(findOffenders(["web/tests/test-results/failed.png"]), [
    "web/tests/test-results/failed.png",
  ]);
});

test("ignores non-image files everywhere", () => {
  assert.deepEqual(
    findOffenders(["docs/process/notes.md", "web/tests/e2e/home.spec.ts", "apps/site/logo.svg"]),
    [],
  );
});
