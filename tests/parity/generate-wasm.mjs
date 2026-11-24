// Generate the wasm side of the P0 parity baseline.
//
// Usage: node tests/parity/generate-wasm.mjs [path/to/rotor_wasm.wasm]
//
// The default artifact is the committed `apps/site/rotor_wasm.wasm`; pass the
// fresh build target after `sh scripts/build-wasm.sh`:
//   node tests/parity/generate-wasm.mjs \
//     target/wasm32-unknown-unknown/release/rotor_wasm.wasm

import { writeFileSync } from "node:fs";

import { buildWasmVectors, loadWasm, repoPath } from "./lib.mjs";

const wasmPath = process.argv[2] ?? "apps/site/rotor_wasm.wasm";
const started = performance.now();
const context = await loadWasm(wasmPath);
const baseline = buildWasmVectors(context);
const output = repoPath("tests/parity/wasm-vectors.json");
writeFileSync(output, `${JSON.stringify(baseline, null, 2)}\n`);

const supported = baseline.vectors.filter((vector) => vector.supported).length;
const elapsed = (performance.now() - started).toFixed(0);
console.log(
  `wrote ${output}: ${supported}/${baseline.vectors.length} supported vectors, ` +
    `${baseline.chains.length} chains, wasm ${context.size} bytes, ${elapsed} ms`,
);
