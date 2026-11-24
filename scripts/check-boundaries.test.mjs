// CI gate cases for scripts/check-boundaries.mjs. Pure verdict over
// synthesized cargo metadata and the frozen #[path] include set.

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateMetadata, evaluatePathIncludes, EXPECTED_PATH_INCLUDES } from "./check-boundaries.mjs";

function pkg(name, dependencies = [], features = {}) {
  return { name, dependencies: dependencies.map((dependency) => ({ name: dependency })), features };
}

function metadata(...packages) {
  return { packages };
}

test("the current clean layout passes", () => {
  assert.deepEqual(
    evaluateMetadata(metadata(pkg("rotor", ["serde_json"]), pkg("rotor-wasm", ["sha2"]))),
    [],
  );
});

test("a product depending on another product fails", () => {
  const errors = evaluateMetadata(
    metadata(pkg("rotor"), pkg("rotor-wasm", ["rotor"])),
  );
  assert.ok(
    errors.some((error) => error.includes("rotor-wasm depends on rotor")),
    errors.join("\n"),
  );
});

test("rotor-core with a network dependency fails", () => {
  const errors = evaluateMetadata(metadata(pkg("rotor-core", ["ureq"])));
  assert.ok(
    errors.some((error) => error.includes("rotor-core depends on ureq")),
    errors.join("\n"),
  );
});

test("rotor-core with a gpu feature fails", () => {
  const errors = evaluateMetadata(metadata(pkg("rotor-core", [], { gpu: [] })));
  assert.ok(
    errors.some((error) => error.includes("gpu feature")),
    errors.join("\n"),
  );
});

test("a wasm adapter without #[path] includes passes", () => {
  assert.deepEqual(evaluatePathIncludes(""), []);
});

test("a new cross-product #[path] include fails", () => {
  const source = [...EXPECTED_PATH_INCLUDES, "../../../src/engine.rs"]
    .map((include) => `#[path = "${include}"]\nmod module;`)
    .join("\n");
  const errors = evaluatePathIncludes(source);
  assert.ok(
    errors.some((error) => error.includes("unexpected #[path] include") && error.includes("engine.rs")),
    errors.join("\n"),
  );
});

test("a root-crate #[path] include fails now that P1 removed the exceptions", () => {
  const source = `#[path = "../../../src/base58.rs"]\nmod base58;`;
  const errors = evaluatePathIncludes(source);
  assert.ok(
    errors.some((error) => error.includes("unexpected #[path] include") && error.includes("base58.rs")),
    errors.join("\n"),
  );
});
