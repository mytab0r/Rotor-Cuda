#!/usr/bin/env node
// Guard the rotor-wasm pointer/length ABI: the committed artifact must export
// exactly the names, parameter counts and result arity recorded in
// crates/rotor-wasm/wasm-abi.json.
//
// The snapshot is the contract the site and wallet build against. A missing or
// renamed export is a breaking ABI change; a new export needs a new snapshot
// entry and a compatibility note. Neither passes silently.
//
// Stdlib only; no network, no cargo. Exit: 0 = match, 1 = drift, 2 = bad input.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib/area-map.mjs";

export const DEFAULT_ARTIFACT = "apps/site/rotor_wasm.wasm";
export const DEFAULT_SNAPSHOT = "crates/rotor-wasm/wasm-abi.json";

const WASM_MAGIC = Uint8Array.from([0x00, 0x61, 0x73, 0x6d]);
const SECTION_TYPE = 1;
const SECTION_IMPORT = 2;
const SECTION_FUNCTION = 3;
const SECTION_EXPORT = 7;
const KIND_FUNCTION = 0;
const KIND_MEMORY = 2;

class Reader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.offset = start;
    this.end = end;
  }

  byte() {
    if (this.offset >= this.end) throw new Error("unexpected end of wasm section");
    return this.bytes[this.offset++];
  }

  varUint() {
    let result = 0;
    let shift = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
    throw new Error("varuint32 is longer than 5 bytes");
  }

  name() {
    const length = this.varUint();
    if (this.offset + length > this.end) throw new Error("name exceeds section");
    const value = this.bytes.subarray(this.offset, this.offset + length).toString("utf8");
    this.offset += length;
    return value;
  }

  values() {
    const count = this.varUint();
    const values = [];
    for (let index = 0; index < count; index += 1) values.push(this.byte());
    return values;
  }

  limits() {
    const flags = this.byte();
    this.varUint();
    if (flags & 1) this.varUint();
  }
}

function parseTypes(reader) {
  const count = reader.varUint();
  const types = [];
  for (let index = 0; index < count; index += 1) {
    if (reader.byte() !== 0x60) throw new Error("unsupported type form (expected functype 0x60)");
    types.push({ params: reader.values().length, results: reader.values().length });
  }
  return types;
}

function parseImports(reader) {
  const count = reader.varUint();
  let functions = 0;
  for (let index = 0; index < count; index += 1) {
    reader.name();
    reader.name();
    const kind = reader.byte();
    if (kind === KIND_FUNCTION) {
      reader.varUint();
      functions += 1;
    } else if (kind === 1) {
      reader.byte();
      reader.limits();
    } else if (kind === KIND_MEMORY) {
      reader.limits();
    } else if (kind === 3) {
      reader.byte();
      reader.byte();
    } else if (kind === 4) {
      reader.byte();
      reader.varUint();
    } else {
      throw new Error(`unsupported import kind ${kind}`);
    }
  }
  return functions;
}

function parseFunctionTypes(reader) {
  const count = reader.varUint();
  const indices = [];
  for (let index = 0; index < count; index += 1) indices.push(reader.varUint());
  return indices;
}

function parseExports(reader) {
  const count = reader.varUint();
  const exports = [];
  for (let index = 0; index < count; index += 1) {
    const name = reader.name();
    const kind = reader.byte();
    const indexInKind = reader.varUint();
    exports.push({ name, kind, index: indexInKind });
  }
  return exports;
}

/**
 * Parse the type, import, function and export sections of a wasm module.
 * Returns the function exports with their parameter and result arity.
 */
export function parseWasmAbi(bytes) {
  if (bytes.length < 8) throw new Error("file is shorter than the wasm header");
  for (let index = 0; index < WASM_MAGIC.length; index += 1) {
    if (bytes[index] !== WASM_MAGIC[index]) throw new Error("missing wasm magic");
  }
  const version = new Reader(bytes, 4, 8).varUint();
  if (version !== 1) throw new Error(`unsupported wasm version ${version}`);

  let types = [];
  let functionTypes = [];
  let importedFunctions = 0;
  let exports = [];
  const seen = new Set();
  let offset = 8;

  while (offset < bytes.length) {
    const sectionId = bytes[offset++];
    if (offset >= bytes.length) throw new Error("truncated section header");
    const sizeReader = new Reader(bytes, offset, bytes.length);
    const size = sizeReader.varUint();
    offset = sizeReader.offset;
    const end = offset + size;
    if (end > bytes.length) throw new Error(`section ${sectionId} exceeds the file`);
    const reader = new Reader(bytes, offset, end);

    if (sectionId !== 0) {
      if (seen.has(sectionId)) throw new Error(`duplicate section ${sectionId}`);
      seen.add(sectionId);
    }
    if (sectionId === SECTION_TYPE) types = parseTypes(reader);
    else if (sectionId === SECTION_IMPORT) importedFunctions = parseImports(reader);
    else if (sectionId === SECTION_FUNCTION) functionTypes = parseFunctionTypes(reader);
    else if (sectionId === SECTION_EXPORT) exports = parseExports(reader);
    offset = end;
  }

  const functions = [];
  for (const entry of exports) {
    if (entry.kind !== KIND_FUNCTION) continue;
    const functionIndex = entry.index - importedFunctions;
    const typeIndex = functionTypes[functionIndex];
    if (typeIndex === undefined || types[typeIndex] === undefined) {
      throw new Error(`export ${entry.name} refers to unknown function ${entry.index}`);
    }
    functions.push({ name: entry.name, params: types[typeIndex].params, results: types[typeIndex].results });
  }

  return {
    functions,
    hasMemory: exports.some((entry) => entry.kind === KIND_MEMORY),
  };
}

/**
 * Compare a parsed artifact with a snapshot. Returns human-readable errors;
 * an empty array means the ABI matches.
 */
export function diffAbi(artifact, snapshot) {
  const errors = [];
  if (!snapshot || !Array.isArray(snapshot.exports)) {
    return ["snapshot has no exports array"];
  }

  const snapshotNames = new Set();
  for (const entry of snapshot.exports) {
    if (typeof entry.name !== "string" || entry.name.length === 0) {
      errors.push("snapshot entry without a name");
      continue;
    }
    if (snapshotNames.has(entry.name)) {
      errors.push(`snapshot lists ${entry.name} twice`);
      continue;
    }
    snapshotNames.add(entry.name);
    if (!Number.isInteger(entry.params) || !Number.isInteger(entry.results)) {
      errors.push(`snapshot entry ${entry.name} needs integer params and results`);
    }
  }

  const actual = new Map(artifact.functions.map((entry) => [entry.name, entry]));
  for (const entry of snapshot.exports) {
    const found = actual.get(entry.name);
    if (!found) {
      errors.push(
        `missing export: ${entry.name} is in wasm-abi.json but not in the artifact; ` +
          "restore it or treat the removal as a breaking ABI change",
      );
      continue;
    }
    if (found.params !== entry.params) {
      errors.push(
        `export ${entry.name}: artifact has ${found.params} parameter(s), ` +
          `wasm-abi.json has ${entry.params}`,
      );
    }
    if (found.results !== entry.results) {
      errors.push(
        `export ${entry.name}: artifact returns ${found.results} value(s), ` +
          `wasm-abi.json has ${entry.results}`,
      );
    }
  }

  for (const found of artifact.functions) {
    if (!snapshotNames.has(found.name)) {
      errors.push(
        `unexpected export: ${found.name} is in the artifact but not in wasm-abi.json; ` +
          "add a snapshot entry and a compatibility note",
      );
    }
  }

  if (!artifact.hasMemory) {
    errors.push("missing export: memory is required by the pointer/length ABI");
  }

  return errors;
}

const USAGE = `Usage: node scripts/check-wasm-abi.mjs [artifact.wasm] [wasm-abi.json]

Checks the committed wasm artifact against the frozen ABI snapshot.
Defaults: ${DEFAULT_ARTIFACT} ${DEFAULT_SNAPSHOT}
Exit: 0 match, 1 name/arity drift, 2 unreadable or malformed input.`;

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv.length > 2) {
    console.error(USAGE);
    return 2;
  }

  const artifactPath = argv[0] ? path.resolve(argv[0]) : path.join(REPO_ROOT, DEFAULT_ARTIFACT);
  const snapshotPath = argv[1] ? path.resolve(argv[1]) : path.join(REPO_ROOT, DEFAULT_SNAPSHOT);

  let artifact;
  let snapshot;
  try {
    artifact = parseWasmAbi(fs.readFileSync(artifactPath));
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  } catch (error) {
    console.error(`error: [wasm-abi] ${error.message}`);
    return 2;
  }

  const errors = diffAbi(artifact, snapshot);
  if (errors.length > 0) {
    for (const error of errors) console.error(`error: [wasm-abi] ${error}`);
    console.error(`wasm-abi: FAILED (${errors.length} mismatch(es))`);
    return 1;
  }

  console.log(
    `wasm-abi: OK (${artifact.functions.length} function exports match the snapshot; memory present)`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
