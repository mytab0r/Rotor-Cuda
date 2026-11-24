// Regenerate both P0 parity baselines and re-run the gate.
//
// Usage:
//   node tests/parity/regenerate.mjs [--wasm path/to/rotor_wasm.wasm]
//
// Default wasm artifact: the committed `apps/site/rotor_wasm.wasm`. After a
// `crates/rotor-wasm` change, build first:
//   sh scripts/build-wasm.sh
//   node tests/parity/regenerate.mjs --wasm target/wasm32-unknown-unknown/release/rotor_wasm.wasm
//
// This writes `desktop-vectors.json` from live `src/` and `wasm-vectors.json`
// from the chosen artifact, then runs the comparison. Review the JSON diff
// before committing: an unexplained vector change is a behaviour change.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
let wasmPath = "apps/site/rotor_wasm.wasm";
const wasmIndex = args.indexOf("--wasm");
if (wasmIndex >= 0) {
  wasmPath = args[wasmIndex + 1];
  if (!wasmPath) {
    console.error("error: --wasm needs a path");
    process.exit(1);
  }
}

function run(command, commandArgs, extraEnv = {}) {
  console.log(`$ ${command} ${commandArgs.join(" ")}`);
  execFileSync(command, commandArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
}

run(
  "cargo",
  ["test", "--release", "--test", "parity", "--", "--nocapture"],
  { ROTOR_PARITY_WRITE: "1" },
);
run(process.execPath, [path.join(ROOT, "tests/parity/generate-wasm.mjs"), wasmPath]);
run(process.execPath, [path.join(ROOT, "tests/parity/parity-test.mjs"), wasmPath]);
console.log("parity baselines regenerated; review the JSON diff before committing.");
