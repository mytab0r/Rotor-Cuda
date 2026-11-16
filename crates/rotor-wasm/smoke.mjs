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

function writeOffsets(offsets) {
  const ptr = wasm.alloc(offsets.length * 4);
  if (ptr === 0) {
    throw new Error("alloc returned 0");
  }
  const view = new DataView(wasm.memory.buffer);
  offsets.forEach((offset, index) => {
    view.setUint32(ptr + index * 4, offset, true);
  });
  return ptr;
}

function readSamples() {
  const view = new DataView(wasm.memory.buffer);
  const ptr = wasm.result_ptr();
  const length = wasm.result_len();
  const count = view.getUint32(ptr, true);
  let at = ptr + 4;
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const sampleLength = view.getUint32(at, true);
    at += 4;
    samples.push(
      new Uint8Array(wasm.memory.buffer, at, sampleLength).slice(),
    );
    at += sampleLength;
  }
  if (at - ptr !== length) {
    throw new Error("samples blob length mismatch");
  }
  return samples;
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

// Samples ABI: one sample per offset, started at a fixed scalar. Address jobs
// produce 20-byte hash160 samples.
const sampleOffsets = [0, 1];
const offsetsPtr = writeOffsets(sampleOffsets);
const samplesStart = writeScalar(1n);
const samplesStatus = wasm.samples(
  samplesStart,
  offsetsPtr,
  sampleOffsets.length,
);
if (samplesStatus !== 0) {
  fail(samplesStatus, "samples");
}
const samples = readSamples();
if (samples.length !== sampleOffsets.length) {
  throw new Error(`samples: got ${samples.length}, want ${sampleOffsets.length}`);
}
for (const sample of samples) {
  if (sample.length !== 20) {
    throw new Error(`samples: unexpected sample length ${sample.length}`);
  }
  if (sample.every((byte) => byte === 0)) {
    throw new Error("samples: sample is all zeroes");
  }
}
console.log(
  `samples=${samples.length} ` +
    `lengths=${samples.map((sample) => sample.length).join(",")}`,
);
wasm.dealloc(offsetsPtr, sampleOffsets.length * 4);
wasm.dealloc(samplesStart, 32);

// Rate probe: ~50k keys starting at key 2 (key 1 is the fixture target, so it
// must stay out of the range). No absolute assertion, just print the measured
// rate so a human can compare it with the documented expectations.
const rateStartValue = 2n;
const rateKeyCount = 50000n;
const rateStart = writeScalar(rateStartValue);
const rateEnd = writeScalar(rateStartValue + rateKeyCount);
const rateStarted = performance.now();
const rateStatus = wasm.scan(rateStart, rateEnd);
const rateElapsedMs = performance.now() - rateStarted;
if (rateStatus !== 0) {
  fail(rateStatus, "scan");
}
const rateResult = readResult();
if (rateResult.scanned !== rateKeyCount || rateResult.found !== 0) {
  throw new Error(
    `rate scan: scanned=${rateResult.scanned} found=${rateResult.found}`,
  );
}
const rate = rateElapsedMs > 0 ? Number(rateKeyCount) / (rateElapsedMs / 1000) : 0;
console.log(
  `rate=${Math.round(rate)} keys/s over ${rateElapsedMs.toFixed(0)} ms ` +
    `(${rateKeyCount} keys)`,
);
wasm.dealloc(rateStart, 32);
wasm.dealloc(rateEnd, 32);

console.log("smoke ok");
