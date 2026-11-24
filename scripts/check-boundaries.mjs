#!/usr/bin/env node
// Architecture boundary skeleton for the product split.
//
// Rules from openspec/changes/product-split/design.md:
//   1. No product depends on another product. Today the products are `rotor`
//      (desktop) and `rotor-wasm` (browser adapter); they share nothing
//      directly.
//   2. Once `rotor-core` exists it must have no network, GPU or server
//      dependency and no `gpu`/`network`/`server` feature.
//   3. `crates/rotor-wasm` must not reach into the root crate with `#[path]`.
//      P0 froze the six pre-P1 includes; P1 replaced them with a `rotor-core`
//      dependency, so the exception set is empty and stays that way.
//
// Input is `cargo metadata --format-version 1 --no-deps`; stdlib only.
// Exit: 0 = pass, 1 = boundary violation, 2 = cannot inspect the workspace.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib/area-map.mjs";

export const PRODUCTS = new Set(["rotor", "rotor-wasm"]);
export const CORE_PACKAGE = "rotor-core";
export const CORE_FORBIDDEN_DEPENDENCIES = [
  "tiny_http",
  "ureq",
  "reqwest",
  "hyper",
  "ctrlc",
  "xorf",
  "getrandom",
  "wgpu",
  "cudarc",
  "cust",
];
export const CORE_FORBIDDEN_FEATURES = ["gpu", "network", "server"];
export const WASM_LIB = "crates/rotor-wasm/src/lib.rs";

// Exact exception set. Shrink-only: P1 removed all six includes, so any
// `#[path]` include into the root crate is now a boundary break.
export const EXPECTED_PATH_INCLUDES = [];

/** Cross-product and core-dependency rules over parsed cargo metadata. */
export function evaluateMetadata(metadata) {
  const errors = [];
  const packages = new Map(metadata.packages.map((pkg) => [pkg.name, pkg]));

  for (const [product, pkg] of packages) {
    if (!PRODUCTS.has(product)) continue;
    for (const dependency of pkg.dependencies) {
      if (PRODUCTS.has(dependency.name) && dependency.name !== product) {
        errors.push(
          `cross-product dependency: ${product} depends on ${dependency.name}; ` +
            "products share rotor-core/rotor-search/contracts, never each other",
        );
      }
    }
  }

  const core = packages.get(CORE_PACKAGE);
  if (core) {
    for (const dependency of core.dependencies) {
      if (CORE_FORBIDDEN_DEPENDENCIES.includes(dependency.name)) {
        errors.push(
          `${CORE_PACKAGE} depends on ${dependency.name}; core has no network, GPU or server crate`,
        );
      }
    }
    for (const feature of Object.keys(core.features ?? {})) {
      if (CORE_FORBIDDEN_FEATURES.includes(feature)) {
        errors.push(
          `${CORE_PACKAGE} defines the ${feature} feature; a feature that changes output is a boundary break`,
        );
      }
    }
  }

  return errors;
}

/** Compare the `#[path]` includes in the wasm adapter with the frozen set. */
export function evaluatePathIncludes(source) {
  const found = [...source.matchAll(/#\[path\s*=\s*"([^"]+)"\s*\]/g)].map((match) => match[1]);
  const errors = [];

  for (const expected of EXPECTED_PATH_INCLUDES) {
    if (!found.includes(expected)) {
      errors.push(
        `missing expected #[path] include ${expected}; every frozen exception must stay in place`,
      );
    }
  }
  for (const actual of found) {
    if (!EXPECTED_PATH_INCLUDES.includes(actual)) {
      errors.push(
        `unexpected #[path] include ${actual} in ${WASM_LIB}; a new cross-product include ` +
          "is a boundary break, not an exception",
      );
    }
  }
  if (found.length !== new Set(found).size) {
    errors.push(`${WASM_LIB} repeats a #[path] include`);
  }

  return errors;
}

const USAGE = `Usage: node scripts/check-boundaries.mjs

Checks the workspace layout with cargo metadata:
  - no product depends on another product;
  - ${CORE_PACKAGE} (once present) has no network/GPU/server dependency or feature;
  - ${WASM_LIB} has no #[path] include into the root crate.
Exit: 0 pass, 1 violation, 2 cannot inspect the workspace.`;

export function main() {
  if (process.argv.slice(2).includes("--help") || process.argv.slice(2).includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  let metadata;
  let wasmLib;
  try {
    const output = execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", path.join(REPO_ROOT, "Cargo.toml")],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    metadata = JSON.parse(output);
    wasmLib = fs.readFileSync(path.join(REPO_ROOT, WASM_LIB), "utf8");
  } catch (error) {
    console.error(`error: [boundaries] cannot inspect the workspace: ${error.message}`);
    return 2;
  }

  const errors = [...evaluateMetadata(metadata), ...evaluatePathIncludes(wasmLib)];
  if (errors.length > 0) {
    for (const error of errors) console.error(`error: [boundaries] ${error}`);
    console.error(`boundaries: FAILED (${errors.length} violation(s))`);
    return 1;
  }

  const core = metadata.packages.some((pkg) => pkg.name === CORE_PACKAGE);
  console.log(
    `boundaries: OK (${metadata.packages.length} workspace package(s); no cross-product dependency; ` +
      `no #[path] includes; ` +
      `${CORE_PACKAGE} ${core ? "present and clean" : "not created yet"})`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
