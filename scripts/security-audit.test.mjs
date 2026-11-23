import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "security-audit.mjs");

function run(reports) {
  const dir = mkdtempSync(join(tmpdir(), "security-audit-"));
  try {
    for (const [name, value] of Object.entries(reports)) {
      writeFileSync(join(dir, name), JSON.stringify(value));
    }
    return spawnSync(process.execPath, [script, dir, "--dry-run"], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("renders one report from cargo and npm reports", () => {
  const result = run({
    "cargo-audit.json": {
      vulnerabilities: {
        found: true,
        count: 1,
        list: [
          {
            advisory: {
              id: "RUSTSEC-2026-0001",
              package: "foo",
              title: "Example advisory",
              url: "https://example.invalid/adv",
              severity: "high",
            },
            versions: { patched: ["1.0.1"] },
            package: { name: "foo", version: "1.0.0" },
          },
        ],
      },
      warnings: { unmaintained: [], unsound: [], yanked: [] },
    },
    "npm-web.json": {
      vulnerabilities: {
        lodash: {
          name: "lodash",
          severity: "high",
          via: [{ title: "Prototype pollution", url: "https://example.invalid" }],
          fixAvailable: { name: "lodash", version: "4.17.21", isSemVerMajor: false },
        },
      },
      metadata: { vulnerabilities: { high: 1, critical: 0, moderate: 0, low: 0 } },
    },
    "npm-cloudflare.json": { note: "No package-lock.json: nothing to audit." },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RUSTSEC-2026-0001/);
  assert.match(result.stdout, /lodash 4\.17\.21/);
  assert.match(result.stdout, /No package-lock\.json: nothing to audit\./);
  assert.match(result.stdout, /dry run: the tracking issue was not changed/);
});

test("reports a missing report instead of crashing", () => {
  const result = run({});

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No cargo-audit report was uploaded/);
  assert.match(result.stdout, /No npm audit report for web was uploaded/);
});
