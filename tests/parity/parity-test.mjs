// P0 desktop/wasm behaviour-parity gate.
//
// Usage: node tests/parity/parity-test.mjs [path/to/rotor_wasm.wasm]
//
// Runs the wasm core against the fixed key/chain set, compares it with the
// committed wasm baseline, then compares the desktop and wasm baselines and
// fails on any mismatch that is not named in `parity-allowlist.json`. The
// desktop baseline itself is checked against live `src/` by
// `cargo test --release --test parity`; this script does not rebuild the
// desktop binary.
//
// Exit 0 only when the wasm baseline is current, every comparable field
// matches, and every allowlist entry still covers a real mismatch.

import { loadJson, buildWasmVectors, loadWasm, compareVectors, firstDifference } from "./lib.mjs";

const wasmPath = process.argv[2] ?? "apps/site/rotor_wasm.wasm";
const started = performance.now();

const context = await loadWasm(wasmPath);
const liveWasm = buildWasmVectors(context);
const goldenWasm = loadJson("tests/parity/wasm-vectors.json");
const desktop = loadJson("tests/parity/desktop-vectors.json");
const allowlist = loadJson("tests/parity/parity-allowlist.json");
const chainMap = loadJson("tests/parity/chain-map.json");
const dataChains = loadJson("data/chains.json").chains;
const keys = loadJson("tests/parity/keys.json").keys;

const errors = [];

// 1. The wasm implementation must reproduce its committed baseline.
const wasmDrift = firstDifference(liveWasm, goldenWasm);
if (wasmDrift) {
  errors.push(`wasm baseline drifted: ${wasmDrift}`);
}

// 2. Both baselines must cover every chain in data/chains.json and every key.
const expectedChains = dataChains
  .map((chain) => `${chain.slug}|${chain.family}|${Boolean(chain.testnet)}`)
  .sort()
  .join("\n");
for (const [label, baseline] of [
  ["desktop", desktop],
  ["wasm", goldenWasm],
]) {
  const actualChains = (baseline.chains ?? [])
    .map((chain) => `${chain.slug}|${chain.family}|${Boolean(chain.testnet)}`)
    .sort()
    .join("\n");
  if (actualChains !== expectedChains) {
    errors.push(
      `${label} baseline chain set does not match data/chains.json; regenerate the baseline`,
    );
  }
  const covered = new Set(
    (baseline.vectors ?? []).map((vector) => `${vector.key_id}/${vector.chain}`),
  );
  const missing = [];
  for (const key of keys) {
    for (const chain of dataChains) {
      if (!covered.has(`${key.id}/${chain.slug}`)) {
        missing.push(`${key.id}/${chain.slug}`);
      }
    }
  }
  if (missing.length > 0) {
    errors.push(
      `${label} baseline is missing ${missing.length} key/chain vectors: ` +
        `${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", ..." : ""}`,
    );
  }
}

// 3. Desktop/live-wasm comparison with the explicit allowlist. Comparing the
// live artifact (not only the golden) is what makes a derivation mutation fail
// on the mismatch itself, not just on the fixture-drift check above.
const result = compareVectors({
  desktop,
  wasm: liveWasm,
  allowlist,
  chainMap,
});
errors.push(...result.errors);

const elapsed = (performance.now() - started).toFixed(0);
console.log(
  `parity: ${result.compared} comparable vectors, ${result.fields} field checks, ` +
    `${result.matched} matched, ${result.allowed} allowlisted, ` +
    `${result.errors.length} mismatches; wasm ${context.size} bytes; ${elapsed} ms`,
);
for (const [label, count] of result.allowedDetails) {
  const entry = allowlist.entries.find(
    (candidate) => `${candidate.chain}/${candidate.field}` === label,
  );
  console.log(`  allowlisted ${label} x${count}: ${entry?.reason ?? ""} (${entry?.issue ?? ""})`);
}

if (errors.length > 0) {
  console.error("parity FAILED:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log("parity ok");
