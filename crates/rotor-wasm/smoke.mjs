// Smoke test for the rotor-wasm pointer/length ABI.
//
// Usage: node crates/rotor-wasm/smoke.mjs [path/to/rotor_wasm.wasm]
//
// The wasm module has no imports. The test scans [1, 2) for the key-1 address
// fixture and prints the scanned/found values from the result blob.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const defaultPath = fileURLToPath(
  new URL(
    "../../target/wasm32-unknown-unknown/release/rotor_wasm.wasm",
    import.meta.url,
  ),
);
const wasmPath = process.argv[2] ?? defaultPath;

const KEY1 = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const KEY1_HEX = "0000000000000000000000000000000000000000000000000000000000000001";

const bytes = await readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const wasm = instance.exports;

if (!(wasm.memory instanceof WebAssembly.Memory)) {
  throw new Error("wasm does not export memory");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function memory() {
  return new Uint8Array(wasm.memory.buffer);
}

function upload(text) {
  const data = encoder.encode(text);
  const ptr = wasm.alloc(data.length);
  if (ptr === 0) {
    throw new Error("alloc returned 0");
  }
  memory().set(data, ptr);
  return { ptr, len: data.length };
}

function writeScalar(value) {
  const ptr = wasm.alloc(32);
  const data = new Uint8Array(32);
  let remaining = BigInt(value);
  for (let index = 31; index >= 0; index -= 1) {
    data[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  memory().set(data, ptr);
  return ptr;
}

function readResult() {
  const view = new DataView(wasm.memory.buffer);
  const ptr = wasm.result_ptr();
  const scanned = view.getBigUint64(ptr, true);
  const found = view.getUint32(ptr + 8, true);
  if (found === 0) {
    return { scanned, found, key: null, address: null };
  }
  let at = ptr + 12;
  const keyLength = view.getUint32(at, true);
  at += 4;
  const key = decoder.decode(new Uint8Array(wasm.memory.buffer, at, keyLength));
  at += keyLength;
  const addressLength = view.getUint32(at, true);
  at += 4;
  const address = decoder.decode(
    new Uint8Array(wasm.memory.buffer, at, addressLength),
  );
  return { scanned, found, key, address };
}

function fail(status, stage) {
  const error = decoder.decode(
    new Uint8Array(wasm.memory.buffer, wasm.error_ptr(), wasm.error_len()),
  );
  throw new Error(`${stage} failed (${status}): ${error}`);
}

const targets = upload(`${KEY1}\n`);
const setStatus = wasm.set_job(0, 0, targets.ptr, targets.len);
if (setStatus !== 0) {
  fail(setStatus, "set_job");
}

const start = writeScalar(1n);
const end = writeScalar(2n);
const scanStatus = wasm.scan(start, end);
if (scanStatus !== 0) {
  fail(scanStatus, "scan");
}

const result = readResult();
console.log(
  `scanned=${result.scanned} found=${result.found} ` +
    `key=${result.key ?? "-"} address=${result.address ?? "-"}`,
);

if (
  result.scanned !== 1n ||
  result.found !== 1 ||
  result.key !== KEY1_HEX ||
  result.address !== KEY1
) {
  throw new Error("unexpected scan result");
}
console.log("smoke ok");
