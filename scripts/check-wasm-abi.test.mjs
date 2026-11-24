// CI gate cases for scripts/check-wasm-abi.mjs. The real snapshot must match
// the committed artifact; a mutated snapshot must fail with a named mismatch.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { diffAbi, parseWasmAbi, DEFAULT_ARTIFACT, DEFAULT_SNAPSHOT } from "./check-wasm-abi.mjs";
import { REPO_ROOT } from "./lib/area-map.mjs";

function realInputs() {
  const artifact = parseWasmAbi(fs.readFileSync(path.join(REPO_ROOT, DEFAULT_ARTIFACT)));
  const snapshot = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, DEFAULT_SNAPSHOT), "utf8"));
  return { artifact, snapshot };
}

test("the committed snapshot matches the committed artifact", () => {
  const { artifact, snapshot } = realInputs();
  assert.equal(artifact.functions.length, 24);
  assert.equal(artifact.hasMemory, true);
  assert.deepEqual(diffAbi(artifact, snapshot), []);
});

test("a mutated parameter count is rejected", () => {
  const { artifact, snapshot } = realInputs();
  const mutated = structuredClone(snapshot);
  const entry = mutated.exports.find((candidate) => candidate.name === "keystore_decrypt");
  entry.params += 1;
  const errors = diffAbi(artifact, mutated);
  assert.ok(
    errors.some((error) => error.includes("keystore_decrypt") && error.includes("parameter")),
    errors.join("\n"),
  );
});

test("a removed snapshot entry is rejected", () => {
  const { artifact, snapshot } = realInputs();
  const mutated = structuredClone(snapshot);
  mutated.exports = mutated.exports.filter((entry) => entry.name !== "scan");
  const errors = diffAbi(artifact, mutated);
  assert.ok(
    errors.some((error) => error.includes("unexpected export: scan")),
    errors.join("\n"),
  );
});

test("a snapshot entry missing from the artifact is rejected", () => {
  const { artifact, snapshot } = realInputs();
  const mutated = structuredClone(snapshot);
  mutated.exports.push({ name: "new_export", params: 0, results: 1, result: "test" });
  const errors = diffAbi(artifact, mutated);
  assert.ok(
    errors.some((error) => error.includes("missing export: new_export")),
    errors.join("\n"),
  );
});
