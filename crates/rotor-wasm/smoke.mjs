// Smoke test for the rotor-wasm pointer/length ABI.
//
// Usage: node crates/rotor-wasm/smoke.mjs [path/to/rotor_wasm.wasm]
//
// The wasm module has no imports. The test scans [1, 2) for the key-1 address
// fixture and prints the scanned/found values from the result blob.

import { readFile, stat } from "node:fs/promises";
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

if (typeof wasm.derive_report !== "function") {
  throw new Error("wasm does not export derive_report");
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

// Derivation report ABI: a private key plus a curve in, UTF-8 JSON out.
function readJson() {
  const ptr = wasm.result_ptr();
  const length = wasm.result_len();
  const text = decoder.decode(
    new Uint8Array(wasm.memory.buffer, ptr, length),
  );
  return JSON.parse(text);
}

const key1Ptr = writeScalar(1n);
const key1Status = wasm.derive_report(key1Ptr, 0);
if (key1Status !== 0) {
  fail(key1Status, "derive_report(secp256k1)");
}
const key1Report = readJson();
wasm.dealloc(key1Ptr, 32);

const byId = Object.fromEntries(
  key1Report.addresses.map((entry) => [entry.id, entry]),
);
const expectedAddresses = {
  btc_p2pkh: KEY1,
  btc_p2pkh_uncompressed: "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm",
  btc_p2sh_p2wpkh: "3JvL6Ymt8MVWiCNHC7oWU6nLeHNJKLZGLN",
  btc_p2wpkh: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  btc_p2tr: "bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9",
  evm: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  tron: "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC",
  solana: "",
};
if (key1Report.curve !== "secp256k1" || key1Report.priv_dec !== "1") {
  throw new Error(`derive_report: unexpected header ${JSON.stringify(key1Report.curve)}`);
}
if (
  key1Report.wif_compressed !==
  "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn"
) {
  throw new Error("derive_report: unexpected WIF");
}
if (key1Report.addresses.length !== Object.keys(expectedAddresses).length) {
  throw new Error(
    `derive_report: got ${key1Report.addresses.length} addresses, want 8`,
  );
}
for (const [id, address] of Object.entries(expectedAddresses)) {
  if (byId[id]?.address !== address) {
    throw new Error(
      `derive_report ${id}: got ${byId[id]?.address ?? "missing"}, want ${address}`,
    );
  }
}
console.log(
  `derive_report secp256k1: 8 addresses, p2tr=${byId.btc_p2tr.address}`,
);

// Odd-y public points: BIP341 lifts the internal key to even y before the
// tweak. Expected addresses cross-checked with bitcoinjs-lib 6.
for (const [key, expected] of [
  [
    6n,
    {
      address:
        "bc1p4rsld9ryjhte00drc0r23r8ngd63xrzh5s4fvmy6q5yt70xzlsdqcuvtzv",
      parity: "1",
    },
  ],
  [
    11n,
    {
      address:
        "bc1pxy2wupspts5wl3ctseak4g7j42h6mumaqlq6zzrn6qesraqlqz7qk730p9",
      parity: "0",
    },
  ],
]) {
  const ptr = writeScalar(key);
  const status = wasm.derive_report(ptr, 0);
  if (status !== 0) {
    fail(status, `derive_report(key ${key})`);
  }
  const report = readJson();
  wasm.dealloc(ptr, 32);
  const p2tr = report.addresses.find((entry) => entry.id === "btc_p2tr");
  if (p2tr?.address !== expected.address || p2tr?.steps?.parity !== expected.parity) {
    throw new Error(
      `derive_report key ${key} taproot: ${JSON.stringify(p2tr)}`,
    );
  }
  console.log(
    `derive_report key ${key} (odd y): p2tr=${p2tr.address} parity=${p2tr.steps.parity}`,
  );
}

// ed25519 RFC8032 test vector.
const edSeed = Uint8Array.from(
  Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  ),
);
const edPtr = wasm.alloc(32);
memory().set(edSeed, edPtr);
const edStatus = wasm.derive_report(edPtr, 1);
if (edStatus !== 0) {
  fail(edStatus, "derive_report(ed25519)");
}
const edReport = readJson();
wasm.dealloc(edPtr, 32);
const expectedEdPubkey =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const expectedSolana = "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";
if (
  edReport.curve !== "ed25519" ||
  edReport.ed_pubkey !== expectedEdPubkey ||
  edReport.addresses.length !== 1 ||
  edReport.addresses[0].id !== "solana" ||
  edReport.addresses[0].address !== expectedSolana
) {
  throw new Error("derive_report: unexpected ed25519 report");
}
console.log(`derive_report ed25519: solana=${edReport.addresses[0].address}`);

// Invalid keys are rejected with a nonzero status and an error message.
const zeroPtr = wasm.alloc(32);
memory().fill(0, zeroPtr, zeroPtr + 32);
const zeroStatus = wasm.derive_report(zeroPtr, 0);
if (zeroStatus === 0) {
  throw new Error("derive_report accepted a zero secp256k1 key");
}
const zeroError = decoder.decode(
  new Uint8Array(wasm.memory.buffer, wasm.error_ptr(), wasm.error_len()),
);
if (zeroError.length === 0) {
  throw new Error("derive_report rejection left the error buffer empty");
}
wasm.dealloc(zeroPtr, 32);
console.log(`derive_report rejected zero key: ${zeroError}`);

const artifactSize = (await stat(wasmPath)).size;
console.log(`artifact=${artifactSize} bytes`);

console.log("smoke ok");
