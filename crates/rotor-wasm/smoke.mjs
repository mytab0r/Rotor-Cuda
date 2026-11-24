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
  ltc_p2pkh: "LVuDpNCSSj6pQ7t9Pv6d6sUkLKoqDEVUnJ",
  ltc_p2sh_p2wpkh: "MR8UQSBr5ULwWheBHznrHk2jxyxkHQu8vB",
  ltc_p2wpkh: "ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9",
  ltc_p2tr: "ltc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sszjagvq",
  doge_p2pkh: "DFpN6QqFfUm3gKNaxN6tNcab1FArL9cZLE",
  bch_legacy: KEY1,
  xrp_classic: "rBgGZ9tc4him9KBzD8fKFiQz3fSZpaSwMH",
  zcash_p2pkh: "t1UYsZVJkLPeMjxEtACvSxfWuNmddpWfxzs",
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
    `derive_report: got ${key1Report.addresses.length} addresses, want ${
      Object.keys(expectedAddresses).length
    }`,
  );
}
for (const [id, address] of Object.entries(expectedAddresses)) {
  if (byId[id]?.address !== address) {
    throw new Error(
      `derive_report ${id}: got ${byId[id]?.address ?? "missing"}, want ${address}`,
    );
  }
}
// New chain rows must carry the same step schema as their Bitcoin siblings.
const requiredSteps = {
  ltc_p2pkh: ["pubkey", "hash160", "payload", "checksum", "base58"],
  ltc_p2sh_p2wpkh: ["redeem", "script_hash", "payload", "checksum"],
  ltc_p2wpkh: ["hrp", "witness_version", "program", "checksum"],
  ltc_p2tr: ["internal_x", "tweak", "output_x", "parity", "program", "checksum"],
  doge_p2pkh: ["pubkey", "hash160", "payload", "checksum", "base58"],
  bch_legacy: ["pubkey", "hash160", "payload", "checksum", "base58"],
  xrp_classic: ["pubkey", "hash160", "payload", "checksum", "base58"],
};
for (const [id, steps] of Object.entries(requiredSteps)) {
  for (const step of steps) {
    if (typeof byId[id]?.steps?.[step] !== "string" || byId[id].steps[step] === "") {
      throw new Error(`derive_report ${id}: empty step ${step}`);
    }
  }
}
console.log(
  `derive_report secp256k1: ${key1Report.addresses.length} addresses, ` +
    `p2tr=${byId.btc_p2tr.address}, ltc=${byId.ltc_p2wpkh.address}, ` +
    `xrp=${byId.xrp_classic.address}`,
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
const expectedTonW5 = "EQCUp64SJJ505dIdcgHDG1oD8JKMLXpQzu5W6lLFdQGtA5Td";
if (
  edReport.curve !== "ed25519" ||
  edReport.ed_pubkey !== expectedEdPubkey ||
  edReport.addresses.length !== 3 ||
  edReport.addresses[0].id !== "solana" ||
  edReport.addresses[0].address !== expectedSolana ||
  edReport.addresses[1].id !== "sui" ||
  edReport.addresses[1].address !== "0x304af458e90e97c841685b8cbbc59b909f3e2cf150df590ada4c81452c29737d" ||
  edReport.addresses[2].id !== "ton_w5" ||
  edReport.addresses[2].address !== expectedTonW5
) {
  throw new Error("derive_report: unexpected ed25519 report");
}
console.log(`derive_report ed25519: solana=${edReport.addresses[0].address} sui=${edReport.addresses[1].address} ton_w5=${edReport.addresses[2].address}`);

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

// Public-key ABI: key 1 compressed in, the same addresses as derive_report
// out, and G + G must equal the key-2 public key.
const KEY1_PUB_COMPRESSED =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
if (typeof wasm.public_key_report !== "function" || typeof wasm.public_key_add !== "function") {
  throw new Error("wasm does not export the public key ABI");
}
const pubUpload = upload(KEY1_PUB_COMPRESSED);
const pubStatus = wasm.public_key_report(pubUpload.ptr, pubUpload.len);
if (pubStatus !== 0) {
  fail(pubStatus, "public_key_report");
}
const pubReport = readJson();
wasm.dealloc(pubUpload.ptr, pubUpload.len);
const pubByAddress = Object.fromEntries(
  pubReport.addresses.map((entry) => [entry.id, entry.address]),
);
if (
  pubReport.pubkey_uncompressed !==
    "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8" ||
  pubByAddress.btc_p2pkh !== KEY1 ||
  pubByAddress.evm !== "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
) {
  throw new Error(`public_key_report: unexpected result ${JSON.stringify(pubReport)}`);
}

const pubA = upload(KEY1_PUB_COMPRESSED);
const pubB = upload(KEY1_PUB_COMPRESSED);
const addStatus = wasm.public_key_add(pubA.ptr, pubA.len, pubB.ptr, pubB.len);
wasm.dealloc(pubA.ptr, pubA.len);
wasm.dealloc(pubB.ptr, pubB.len);
if (addStatus !== 0) {
  fail(addStatus, "public_key_add");
}
const doubled = readJson();
if (
  doubled.pubkey_compressed !==
  "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
) {
  throw new Error(`public_key_add: unexpected result ${JSON.stringify(doubled)}`);
}
console.log(
  `public_key_report: p2pkh=${pubByAddress.btc_p2pkh} evm=${pubByAddress.evm}; ` +
    `G + G = ${doubled.pubkey_compressed}`,
);

// EVM signing ABI: an EIP-1559 transfer signed with key 1. The expected raw
// transaction comes from ethers 6.17.0 (see the crate's pinned vector test).
if (typeof wasm.evm_sign_tx !== "function") {
  throw new Error("wasm does not export evm_sign_tx");
}
const signRequest = upload(
  JSON.stringify({
    chain_id: "11155111",
    nonce: "0",
    max_priority_fee: "1000000000",
    max_fee: "2000000000",
    gas_limit: "21000",
    to: "0x3535353535353535353535353535353535353535",
    value: "1000000000000000",
    data: "0x",
    private_key: `0x${KEY1_HEX}`,
  }),
);
const signStatus = wasm.evm_sign_tx(signRequest.ptr, signRequest.len);
wasm.dealloc(signRequest.ptr, signRequest.len);
if (signStatus !== 0) {
  fail(signStatus, "evm_sign_tx");
}
const signedTx = decoder.decode(
  new Uint8Array(wasm.memory.buffer, wasm.result_ptr(), wasm.result_len()),
);
const expectedSignedTx =
  "0x02f87483aa36a780843b9aca00847735940082520894353535353535353535353535353535353535353587038d7ea4c6800080c080a0d02b933531d628f5d2251fbf58903a4d720f9bd6c7c51f7578f7cf301f761263a012a7d571860bb8d7e71bcb6c63d265bc6fc57b250b9381cbc18c1543c282b147";
if (signedTx !== expectedSignedTx) {
  throw new Error(`evm_sign_tx: got ${signedTx}, want ${expectedSignedTx}`);
}

const badRequest = upload("{}");
const badStatus = wasm.evm_sign_tx(badRequest.ptr, badRequest.len);
wasm.dealloc(badRequest.ptr, badRequest.len);
if (badStatus === 0) {
  throw new Error("evm_sign_tx accepted an empty request");
}
const badError = decoder.decode(
  new Uint8Array(wasm.memory.buffer, wasm.error_ptr(), wasm.error_len()),
);
if (badError.length === 0) {
  throw new Error("evm_sign_tx rejection left the error buffer empty");
}
console.log(
  `evm_sign_tx: ${signedTx.length} hex chars; ` +
    `rejected empty request: ${badError}`,
);

// Unsigned review payload: the same transaction without the signature tail.
if (typeof wasm.evm_unsigned_tx !== "function") {
  throw new Error("wasm does not export evm_unsigned_tx");
}
const unsignedRequest = upload(
  JSON.stringify({
    chain_id: "11155111",
    nonce: "0",
    max_priority_fee: "1000000000",
    max_fee: "2000000000",
    gas_limit: "21000",
    to: "0x3535353535353535353535353535353535353535",
    value: "1000000000000000",
    data: "0x",
  }),
);
const unsignedStatus = wasm.evm_unsigned_tx(
  unsignedRequest.ptr,
  unsignedRequest.len,
);
wasm.dealloc(unsignedRequest.ptr, unsignedRequest.len);
if (unsignedStatus !== 0) {
  fail(unsignedStatus, "evm_unsigned_tx");
}
const unsignedTx = decoder.decode(
  new Uint8Array(wasm.memory.buffer, wasm.result_ptr(), wasm.result_len()),
);
const expectedUnsignedTx =
  "0x02f183aa36a780843b9aca00847735940082520894353535353535353535353535353535353535353587038d7ea4c6800080c0";
if (unsignedTx !== expectedUnsignedTx) {
  throw new Error(`evm_unsigned_tx: got ${unsignedTx}, want ${expectedUnsignedTx}`);
}
wasm.clear_result();
if (wasm.result_len() !== 0) {
  throw new Error("evm_unsigned_tx: clear_result left bytes behind");
}
console.log(`evm_unsigned_tx: ${unsignedTx.length} hex chars`);

// Network-aware derivation: mainnet keeps the existing addresses, testnet
// returns the Bitcoin testnet rows. Vectors cross-checked with bitcoinjs-lib 6.
if (typeof wasm.derive_report_network !== "function") {
  throw new Error("wasm does not export derive_report_network");
}
const netKeyPtr = writeScalar(1n);
const netMainnetStatus = wasm.derive_report_network(netKeyPtr, 32, 0, 0);
if (netMainnetStatus !== 0) {
  fail(netMainnetStatus, "derive_report_network(mainnet)");
}
const mainnetReport = readJson();
const netTestnetStatus = wasm.derive_report_network(netKeyPtr, 32, 0, 1);
wasm.dealloc(netKeyPtr, 32);
if (netTestnetStatus !== 0) {
  fail(netTestnetStatus, "derive_report_network(testnet)");
}
const testnetReport = readJson();
const testnetAddresses = Object.fromEntries(
  testnetReport.addresses.map((entry) => [entry.id, entry.address]),
);
const expectedTestnet = {
  btc_p2pkh: "mrCDrCybB6J1vRfbwM5hemdJz73FwDBC8r",
  btc_p2sh_p2wpkh: "2NAUYAHhujozruyzpsFRP63mbrdaU5wnEpN",
  btc_p2wpkh: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
  btc_p2tr: "tb1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5ssk79hv2",
};
if (mainnetReport.network !== "mainnet" || testnetReport.network !== "testnet") {
  throw new Error("derive_report_network: unexpected network field");
}
if (testnetReport.addresses.length !== 4) {
  throw new Error(
    `derive_report_network: got ${testnetReport.addresses.length} testnet addresses`,
  );
}
for (const [id, address] of Object.entries(expectedTestnet)) {
  if (testnetAddresses[id] !== address) {
    throw new Error(
      `derive_report_network ${id}: got ${testnetAddresses[id]}, want ${address}`,
    );
  }
}
if (
  testnetReport.wif_compressed !==
  "cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA"
) {
  throw new Error("derive_report_network: unexpected testnet WIF");
}
console.log(
  `derive_report_network: p2pkh=${testnetAddresses.btc_p2pkh} ` +
    `p2wpkh=${testnetAddresses.btc_p2wpkh} wif=${testnetReport.wif_compressed}`,
);

// BIP143 P2WPKH signing: a one-input, two-output testnet transaction. The
// expected unsigned and signed hex come from bitcoinjs-lib 6 (see the crate's
// pinned btc.rs tests).
if (
  typeof wasm.btc_unsigned_tx !== "function" ||
  typeof wasm.btc_sign_tx !== "function"
) {
  throw new Error("wasm does not export the Bitcoin signing ABI");
}
const btcBody = {
  network: "testnet",
  inputs: [
    {
      txid: "11".repeat(32),
      vout: 0,
      value: "100000",
      sequence: "4294967295",
    },
  ],
  outputs: [
    { address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", value: "99000" },
    { address: "tb1qq6hag67dl53wl99vzg42z8eyzfz2xlkvvlryfj", value: "500" },
  ],
};
const expectedUnsigned =
  "020000000111111111111111111111111111111111111111111111111111111111111111110000000000ffffffff02b882010000000000160014751e76e8199196d454941c45d1b3a323f1433bd6f40100000000000016001406afd46bcdfd22ef94ac122aa11f241244a37ecc00000000";
const expectedSigned =
  "0200000000010111111111111111111111111111111111111111111111111111111111111111110000000000ffffffff02b882010000000000160014751e76e8199196d454941c45d1b3a323f1433bd6f40100000000000016001406afd46bcdfd22ef94ac122aa11f241244a37ecc02473044022010cb6b408ebf2006dc378e84bd73d7ec7c2c870eea081c2933766f4acfc3047a022034ccc43523dc610366f16bfbd48e73ab4995134dde016b304b3b3aac351504e401210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179800000000";

const btcUnsignedRequest = upload(JSON.stringify(btcBody));
const btcUnsignedStatus = wasm.btc_unsigned_tx(
  btcUnsignedRequest.ptr,
  btcUnsignedRequest.len,
);
wasm.dealloc(btcUnsignedRequest.ptr, btcUnsignedRequest.len);
if (btcUnsignedStatus !== 0) {
  fail(btcUnsignedStatus, "btc_unsigned_tx");
}
const unsignedBtc = decoder.decode(
  new Uint8Array(wasm.memory.buffer, wasm.result_ptr(), wasm.result_len()),
);
if (unsignedBtc !== expectedUnsigned) {
  throw new Error(`btc_unsigned_tx: got ${unsignedBtc}, want ${expectedUnsigned}`);
}

const btcSignRequest = upload(
  JSON.stringify({ ...btcBody, private_key: `0x${KEY1_HEX}` }),
);
const btcSignStatus = wasm.btc_sign_tx(btcSignRequest.ptr, btcSignRequest.len);
const wiped = memory()
  .slice(btcSignRequest.ptr, btcSignRequest.ptr + btcSignRequest.len)
  .every((byte) => byte === 0);
wasm.dealloc(btcSignRequest.ptr, btcSignRequest.len);
if (btcSignStatus !== 0) {
  fail(btcSignStatus, "btc_sign_tx");
}
const signedBtc = decoder.decode(
  new Uint8Array(wasm.memory.buffer, wasm.result_ptr(), wasm.result_len()),
);
if (signedBtc !== expectedSigned) {
  throw new Error(`btc_sign_tx: got ${signedBtc}, want ${expectedSigned}`);
}
if (!wiped) {
  throw new Error("btc_sign_tx did not wipe the request buffer");
}

const btcBadRequest = upload(
  JSON.stringify({ ...btcBody, network: "mainnet", private_key: `0x${KEY1_HEX}` }),
);
const btcBadStatus = wasm.btc_sign_tx(btcBadRequest.ptr, btcBadRequest.len);
wasm.dealloc(btcBadRequest.ptr, btcBadRequest.len);
if (btcBadStatus === 0) {
  throw new Error("btc_sign_tx accepted a mainnet request");
}
const btcBadError = decoder.decode(
  new Uint8Array(wasm.memory.buffer, wasm.error_ptr(), wasm.error_len()),
);
console.log(
  `btc_sign_tx: ${signedBtc.length} hex chars; request wiped=${wiped}; ` +
    `rejected mainnet: ${btcBadError}`,
);

// TRON Nile testnet TRX transfer: the vector is pinned in tron.rs and was
// independently reproduced with a hand-written Python protobuf encoder.
if (
  typeof wasm.tron_unsigned_tx !== "function" ||
  typeof wasm.tron_sign_tx !== "function"
) {
  throw new Error("wasm does not export the TRON signing ABI");
}
const tronBody = {
  kind: "trx",
  owner_address: "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC",
  to_address: "TDvSsdrNM5eeXNL3czpa6AxLDHZA9nwe9K",
  amount: "1000000",
  ref_block_bytes: "12ab",
  ref_block_hash: "0011223344556677",
  expiration: "1700000060000",
  timestamp: "1700000000000",
};
const tronRawHex =
  "0a0212ab2208001122334455667740e0a499ffbc315a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a15417e5f4552091a69125d5dfcb7b8c2659029395bdf1215412b5ad5c4795c026514f8317c7a215e218dccd6cf18c0843d7080d095ffbc31900100";
const tronTxId =
  "ceff5238d3200e6ea4a23f8de6608e61aa6bb757a505e93f4fed422631a32c4e";

const tronUnsignedRequest = upload(JSON.stringify(tronBody));
const tronUnsignedStatus = wasm.tron_unsigned_tx(
  tronUnsignedRequest.ptr,
  tronUnsignedRequest.len,
);
wasm.dealloc(tronUnsignedRequest.ptr, tronUnsignedRequest.len);
if (tronUnsignedStatus !== 0) {
  fail(tronUnsignedStatus, "tron_unsigned_tx");
}
const tronUnsigned = readJson();
if (
  tronUnsigned.txID !== tronTxId ||
  tronUnsigned.raw_data_hex !== tronRawHex ||
  tronUnsigned.signature !== undefined
) {
  throw new Error(`tron_unsigned_tx: ${JSON.stringify(tronUnsigned)}`);
}

const tronSignRequest = upload(
  JSON.stringify({ ...tronBody, private_key: `0x${KEY1_HEX}` }),
);
const tronSignStatus = wasm.tron_sign_tx(tronSignRequest.ptr, tronSignRequest.len);
const tronWiped = memory()
  .slice(tronSignRequest.ptr, tronSignRequest.ptr + tronSignRequest.len)
  .every((byte) => byte === 0);
wasm.dealloc(tronSignRequest.ptr, tronSignRequest.len);
if (tronSignStatus !== 0) {
  fail(tronSignStatus, "tron_sign_tx");
}
const tronSigned = readJson();
const expectedTronSignature =
  "d990cf8db49841329b06d1c2c50e43d9481a7f762df4f603d321b8578454c0e62fe71d4d72db7bc8f95ac9d60cf5da983ba64ea13d6325e36fc99d9e46bb8a631c";
if (
  tronSigned.txID !== tronTxId ||
  tronSigned.raw_data_hex !== tronRawHex ||
  tronSigned.signature !== expectedTronSignature ||
  !tronWiped
) {
  throw new Error(`tron_sign_tx: ${JSON.stringify(tronSigned)} wiped=${tronWiped}`);
}
console.log(
  `tron_sign_tx: txID=${tronSigned.txID} signature=${tronSigned.signature.slice(0, 16)}... ` +
    `request wiped=${tronWiped}`,
);

const artifactSize = (await stat(wasmPath)).size;
console.log(`artifact=${artifactSize} bytes`);

console.log("smoke ok");
