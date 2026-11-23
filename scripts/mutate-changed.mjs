#!/usr/bin/env node
// Mutation smoke for changed JavaScript: flip one changed comparison or return
// in a source file, run its matching test, and report whether the test noticed.
//
//   node scripts/mutate-changed.mjs [--base origin/main] [--file apps/site/x.js]
//       [--test apps/site/x-test.mjs] [--max-targets 3] [--timeout 120000] [--dry-run]
//
// Exit 0 when every evaluated mutation was caught (or nothing was changed that
// has a test); exit 1 when a test stayed green on a mutation or the baseline
// test was already red. The file is restored in `finally`; a failure to restore
// is reported as a hard error.
//
// No dependencies beyond Node builtins and `git`/`node`.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TARGETS = 3;
const MAX_ATTEMPTS_PER_FILE = 10;
// Auto-discovery covers the product frontend (apps/site/*.js), whose tests are
// hand-written and can silently stop asserting. Use `--file` for any other
// source with a matching test.
const SOURCE_GLOBS = ["apps/site/*.js"];
const SKIP_SOURCE_RE = /(?:\.generated\.js|-test\.mjs|\.test\.mjs)$/;

// Order matters: longer operators first, otherwise `===` would become `!==`
// and then `==` would be mutated again.
const COMPARISONS = [
  ["===", "!==", /(?<![=!<>])===(?!=)/],
  ["!==", "===", /(?<![=!<>])!==(?!=)/],
  ["<=", ">", /(?<![<])<=/],
  [">=", "<", /(?<![>])>=/],
  ["==", "!=", /(?<![=!<>])==(?!=)/],
  ["!=", "==", /(?<![=!<>])!=(?!=)/],
  ["<", ">=", /(?<![<=>])<(?![<=])/],
  [">", "<=", /(?<![=<>])>(?![>=])/],
];

export function mutateComparison(text) {
  const source = String(text ?? "");
  if (/^\s*\/\//.test(source) || /^\s*\*/.test(source)) return null;
  for (const [from, to, pattern] of COMPARISONS) {
    if (pattern.test(source)) return source.replace(pattern, to);
  }
  return null;
}

export function mutateReturn(text) {
  const source = String(text ?? "");
  if (/^\s*\/\//.test(source) || /^\s*\*/.test(source)) return null;
  const match = /^(\s*return\s+)(.+?)(;?\s*)$/.exec(source);
  if (!match) return null;
  const expression = match[2];
  if (expression === "true" || expression === "false") {
    return `${match[1]}${expression === "true" ? "false" : "true"}${match[3]}`;
  }
  if (expression.startsWith("!") && !expression.startsWith("!(")) {
    return `${match[1]}${expression.slice(1)}${match[3]}`;
  }
  return `${match[1]}!(${expression})${match[3]}`;
}

export function mutateLine(text) {
  return mutateComparison(text) ?? mutateReturn(text);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function rangeFor(base) {
  return base ? `${base}...HEAD` : "HEAD";
}

export function changedSources(base) {
  const output = git(["diff", "--name-only", rangeFor(base), "--", ...SOURCE_GLOBS]);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => !SKIP_SOURCE_RE.test(file));
}

export function testFileFor(source) {
  if (source.endsWith(".js")) return source.replace(/\.js$/, "-test.mjs");
  if (source.endsWith(".mjs")) return source.replace(/\.mjs$/, ".test.mjs");
  return null;
}

// Added lines in the diff, with their new-file line numbers. Hunk headers are
// parsed so a duplicate line elsewhere in the file is not mutated by accident.
export function addedLines(base, file) {
  const diff = git(["diff", "-U0", rangeFor(base), "--", file]);
  const lines = [];
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      lines.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) {
      newLine += 1;
    }
  }
  return lines;
}

function passFileArg(testFile) {
  if (!testFile.endsWith(".mjs") || !fs.existsSync(testFile)) return [];
  const source = fs.readFileSync(testFile, "utf8");
  const wasm = path.join("apps/site", "rotor_wasm.wasm");
  if (/rotor_wasm/.test(source) && fs.existsSync(path.join(REPO_ROOT, wasm))) return [wasm];
  return [];
}

function runTest(testFile, timeoutMs) {
  const result = spawnSync("node", [testFile, ...passFileArg(testFile)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    timedOut: result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function syntaxOk(file) {
  const result = spawnSync("node", ["--check", file], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function short(output) {
  const lines = String(output ?? "").trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-4).join("\n");
}

function evaluate({ source, testFile, base, timeoutMs, dryRun }) {
  const labels = [];
  const candidates = addedLines(base, source).filter((entry) => mutateLine(entry.text) !== null);
  if (candidates.length === 0) {
    return { source, testFile, result: "no changed comparison or return in the diff", ok: true, notes: [] };
  }

  const absolute = path.join(REPO_ROOT, source);
  const original = fs.readFileSync(absolute, "utf8");
  const originalLines = original.split(/\r?\n/);

  if (dryRun) {
    const first = candidates[0];
    return {
      source,
      testFile,
      result: "dry run: candidate selected, nothing executed",
      ok: true,
      notes: [`line ${first.line}: ${first.text.trim()} -> ${mutateLine(first.text).trim()}`],
    };
  }

  const baseline = runTest(testFile, timeoutMs);
  if (baseline.status !== 0) {
    return {
      source,
      testFile,
      result: "baseline test already failing; mutation not evaluated",
      ok: false,
      notes: [short(baseline.output)],
    };
  }

  for (const candidate of candidates.slice(0, MAX_ATTEMPTS_PER_FILE)) {
    const mutated = mutateLine(candidate.text);
    const index =
      candidate.line > 0 &&
      originalLines[candidate.line - 1] !== undefined &&
      originalLines[candidate.line - 1] === candidate.text
        ? candidate.line - 1
        : originalLines.indexOf(candidate.text);
    if (index < 0) continue;

    const nextLines = [...originalLines];
    nextLines[index] = mutated;
    try {
      fs.writeFileSync(absolute, nextLines.join("\n"), "utf8");
      if (!syntaxOk(source)) {
        labels.push(`line ${index + 1}: mutated form does not parse, trying the next candidate`);
        continue;
      }
      const run = runTest(testFile, timeoutMs);
      if (run.status === 0) {
        return {
          source,
          testFile,
          result: "test did not catch the mutation",
          ok: false,
          notes: [
            `line ${index + 1}: ${candidate.text.trim()} -> ${mutated.trim()}`,
            short(run.output),
          ],
        };
      }
      return {
        source,
        testFile,
        result: run.timedOut ? "test proven (the test timed out on the mutation)" : "test proven",
        ok: true,
        notes: [
          `line ${index + 1}: ${candidate.text.trim()} -> ${mutated.trim()}`,
          short(run.output),
        ],
      };
    } finally {
      fs.writeFileSync(absolute, original, "utf8");
    }
  }

  return {
    source,
    testFile,
    result: "no candidate could be applied safely",
    ok: true,
    notes: labels,
  };
}

function parseArgs(argv) {
  const args = { timeoutMs: DEFAULT_TIMEOUT_MS, maxTargets: DEFAULT_MAX_TARGETS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    const take = () => {
      if (value === undefined) throw new Error(`${token} needs a value`);
      index += 1;
      return value;
    };
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--base") args.base = take();
    else if (token === "--file") args.file = take();
    else if (token === "--test") args.testFile = take();
    else if (token === "--max-targets") args.maxTargets = Number(take());
    else if (token === "--timeout") args.timeoutMs = Number(take());
    else throw new Error(`unexpected argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/mutate-changed.mjs [--base <git-ref>] [--file <source>] [--test <test>]",
    "      [--max-targets 3] [--timeout 120000] [--dry-run]",
    "",
    "Without --file, scans changed apps/site/*.js against --base (or HEAD for",
    "the working tree), keeps only files with a matching *-test.mjs, flips one",
    "changed comparison or return per file and runs the test. --file accepts",
    "any source with a matching test (scripts/foo.mjs -> scripts/foo.test.mjs).",
    "",
    "Exit 0: every mutation was caught (or there was nothing to mutate).",
    "Exit 1: a test did not catch the mutation, or its baseline was red.",
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  let targets;
  if (args.file) {
    const testFile = args.testFile ?? testFileFor(args.file);
    if (!testFile || !fs.existsSync(path.join(REPO_ROOT, testFile))) {
      console.log(`mutate-changed: ${args.file} has no matching test file; nothing to mutate`);
      return;
    }
    targets = [{ source: args.file, testFile }];
  } else {
    targets = changedSources(args.base)
      .map((source) => ({ source, testFile: testFileFor(source) }))
      .filter((target) => target.testFile && fs.existsSync(path.join(REPO_ROOT, target.testFile)))
      .slice(0, Math.max(1, args.maxTargets));
  }

  if (targets.length === 0) {
    console.log("mutate-changed: no changed JS file with a matching test; nothing to mutate");
    return;
  }

  let failed = false;
  for (const target of targets) {
    const outcome = evaluate({ ...target, base: args.base, timeoutMs: args.timeoutMs, dryRun: args.dryRun });
    console.log(`mutate-changed: ${outcome.source} (test: ${outcome.testFile})`);
    for (const note of outcome.notes) console.log(`  ${note.replace(/\n/g, "\n  ")}`);
    console.log(`  result: ${outcome.result}`);
    if (!outcome.ok) failed = true;
  }
  if (failed) process.exitCode = 1;
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
