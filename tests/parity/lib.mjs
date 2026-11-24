// Shared helpers for the P0 desktop/wasm behaviour-parity baseline.
//
// The wasm core has no imports; this module instantiates the committed or the
// freshly built artifact and drives `derive_report` / `derive_report_network`
// through the same pointer/length ABI the site uses. No dependencies outside
// Node's standard library.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function repoPath(relative) {
  return path.join(ROOT, relative);
}

export function loadJson(relative) {
  return JSON.parse(readFileSync(repoPath(relative), "utf8"));
}

export function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

export async function loadWasm(wasmPath) {
  const absolute = path.isAbsolute(wasmPath)
    ? wasmPath
    : path.join(ROOT, wasmPath);
  const bytes = readFileSync(absolute);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports;
  for (const name of ["memory", "alloc", "dealloc", "derive_report", "derive_report_network", "result_ptr", "result_len", "error_ptr", "error_len"]) {
    if (!(name in wasm)) {
      throw new Error(`wasm artifact ${absolute} does not export ${name}`);
    }
  }
  return { wasm, path: absolute, size: bytes.length };
}

function readError(wasm) {
  return decoder.decode(
    new Uint8Array(wasm.memory.buffer, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0),
  );
}

function readJsonResult(wasm) {
  const text = decoder.decode(
    new Uint8Array(wasm.memory.buffer, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0),
  );
  return JSON.parse(text);
}

function callWithBytes(wasm, bytes, call) {
  const pointer = wasm.alloc(bytes.length) >>> 0;
  if (!pointer) throw new Error(`wasm alloc returned 0 for ${bytes.length} bytes`);
  try {
    new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
    const status = call(pointer) >>> 0;
    if (status !== 0) {
      throw new Error(`wasm derivation failed (status ${status}): ${readError(wasm)}`);
    }
    return readJsonResult(wasm);
  } finally {
    wasm.dealloc(pointer, bytes.length);
  }
}

export function deriveReport(context, keyHex, curve) {
  const bytes = hexToBytes(keyHex);
  return callWithBytes(context.wasm, bytes, (pointer) =>
    context.wasm.derive_report(pointer, curve),
  );
}

export function deriveReportNetwork(context, keyHex, curve, network) {
  const bytes = hexToBytes(keyHex);
  return callWithBytes(context.wasm, bytes, (pointer) =>
    context.wasm.derive_report_network(pointer, bytes.length, curve, network),
  );
}

function chainMeta(chains) {
  return chains.map((chain) => ({
    slug: chain.slug,
    family: chain.family,
    testnet: Boolean(chain.testnet),
  }));
}

/**
 * Compute the wasm side of the baseline.
 *
 * Seed inputs do not have a wasm BIP32/SLIP-0010 implementation: the desktop
 * core derives the per-chain key (BIP32 for secp256k1, the raw 32-byte seed for
 * ed25519) and the same derived key is fed to `derive_report`. This compares
 * the two address/pubkey implementations on identical key material, which is
 * what P0 freezes. BIP32 parity with `apps/site/seed-crypto.js` is a separate
 * open item and is not claimed here.
 */
export function buildWasmVectors(context) {
  const keys = loadJson("tests/parity/keys.json");
  const chainMap = loadJson("tests/parity/chain-map.json");
  const chains = loadJson("data/chains.json").chains;
  const desktop = loadJson("tests/parity/desktop-vectors.json");
  const desktopByKey = new Map(
    desktop.vectors.map((vector) => [`${vector.key_id}/${vector.chain}`, vector]),
  );
  const cache = new Map();

  function reportFor(keyHex, curve, network) {
    const cacheKey = `${keyHex}:${curve}:${network}`;
    if (!cache.has(cacheKey)) {
      cache.set(
        cacheKey,
        network === 0
          ? deriveReport(context, keyHex, curve)
          : deriveReportNetwork(context, keyHex, curve, network),
      );
    }
    return cache.get(cacheKey);
  }

  const vectors = [];

  for (const key of keys.keys) {
    for (const chain of chains) {
      const mapping = chainMap.chains[chain.slug];
      if (!mapping) {
        vectors.push({
          key_id: key.id,
          chain: chain.slug,
          supported: false,
          reason: "no chain-map entry",
        });
        continue;
      }

      const sourceSlug = mapping.desktop ? chain.slug : mapping.key_source_chain;
      const source = desktopByKey.get(`${key.id}/${sourceSlug}`);
      if (!source || !source.supported) {
        vectors.push({
          key_id: key.id,
          chain: chain.slug,
          supported: false,
          reason: `no desktop key material for ${sourceSlug}`,
        });
        continue;
      }

      const curve = source.curve === "secp256k1" ? 0 : 1;
      const network = mapping.wasm_network ?? 0;
      const report = reportFor(source.private_key, curve, network);
      const row = (report.addresses ?? []).find((entry) => entry.id === mapping.wasm_row);
      if (!row) {
        vectors.push({
          key_id: key.id,
          chain: chain.slug,
          supported: false,
          reason: `wasm report has no ${mapping.wasm_row} row`,
        });
        continue;
      }

      const addresses = {};
      for (const id of mapping.wasm_rows ?? [mapping.wasm_row]) {
        const entry = (report.addresses ?? []).find((candidate) => candidate.id === id);
        if (entry) addresses[id] = entry.address;
      }

      vectors.push({
        key_id: key.id,
        chain: chain.slug,
        supported: true,
        desktop_supported: Boolean(mapping.desktop),
        curve: curve === 0 ? "secp256k1" : "ed25519",
        family: chain.family,
        key_kind: key.kind,
        key_source: mapping.desktop
          ? source.key_source
          : `same-key-as-${sourceSlug}`,
        path: source.path,
        path_applied: source.path_applied,
        input_material: key.material.toLowerCase(),
        private_key: report.priv_hex,
        public_key_compressed: report.pubkey_compressed || "",
        public_key_uncompressed: report.pubkey_uncompressed || "",
        ed_pubkey: report.ed_pubkey || "",
        address: row.address,
        addresses,
        format: mapping.format,
        wasm_row: mapping.wasm_row,
        wif: report.wif_compressed || null,
      });
    }
  }

  return {
    schema: 1,
    generated_by: "node tests/parity/generate-wasm.mjs",
    keys: keys.keys,
    chains: chainMeta(chains),
    vectors,
  };
}

function normalizedPublicKeys(desktopVector, wasmVector) {
  const desktop = (desktopVector.public_key ?? "").toLowerCase();
  if (desktop.length === 128) {
    // EVM/TRON report x || y without the 0x04 prefix. Only strip the prefix
    // when the artifact actually returned the full 65-byte encoding.
    const uncompressed = (wasmVector.public_key_uncompressed ?? "").toLowerCase();
    return [
      desktop,
      uncompressed.length === 130 && uncompressed.startsWith("04")
        ? uncompressed.slice(2)
        : uncompressed,
    ];
  }
  if (desktop.length === 64) {
    return [desktop, (wasmVector.ed_pubkey ?? "").toLowerCase()];
  }
  return [desktop, (wasmVector.public_key_compressed ?? "").toLowerCase()];
}

/**
 * Compare the committed desktop and wasm vectors.
 *
 * A field that differs is accepted only when an allowlist entry names the
 * chain, the field and (optionally) the key. The result also fails when an
 * allowlist entry no longer matches a real mismatch, so fixing a divergence
 * forces the entry to be removed.
 */
export function compareVectors({ desktop, wasm, allowlist, chainMap }) {
  const errors = [];
  const entries = allowlist.entries ?? [];
  const entryHits = new Map(entries.map((entry) => [entry, 0]));

  function allowlisted(chain, keyId, field) {
    for (const entry of entries) {
      if (entry.chain !== chain || entry.field !== field) continue;
      if (entry.key_id && entry.key_id !== "*" && entry.key_id !== keyId) continue;
      entryHits.set(entry, entryHits.get(entry) + 1);
      return entry;
    }
    return null;
  }

  const desktopByKey = new Map(
    desktop.vectors.map((vector) => [`${vector.key_id}/${vector.chain}`, vector]),
  );
  const wasmByKey = new Map(
    wasm.vectors.map((vector) => [`${vector.key_id}/${vector.chain}`, vector]),
  );

  const desktopKeys = [...desktopByKey.keys()].sort();
  const wasmKeys = [...wasmByKey.keys()].sort();
  if (desktopKeys.length !== wasmKeys.length || desktopKeys.some((key, index) => key !== wasmKeys[index])) {
    errors.push(
      `coverage differs: desktop=${desktopKeys.length} wasm=${wasmKeys.length}`,
    );
  }

  let compared = 0;
  let fields = 0;
  let matched = 0;
  let allowed = 0;
  const allowedDetails = new Map();

  for (const [key, wasmVector] of wasmByKey) {
    const desktopVector = desktopByKey.get(key);
    if (!desktopVector) {
      errors.push(`${key}: present in wasm but missing from desktop`);
      continue;
    }
    if (!desktopVector.supported || !wasmVector.supported) {
      continue;
    }
    compared += 1;
    const [desktopPublicKey, wasmPublicKey] = normalizedPublicKeys(
      desktopVector,
      wasmVector,
    );
    const checks = [
      ["private_key", desktopVector.private_key, wasmVector.private_key],
      ["address", desktopVector.address, wasmVector.address],
      ["public_key", desktopPublicKey, wasmPublicKey],
    ];
    if (chainMap.chains[desktopVector.chain]?.wif_comparable) {
      checks.push(["wif", desktopVector.wif, wasmVector.wif]);
    }
    for (const [field, left, right] of checks) {
      fields += 1;
      if (left === right) {
        matched += 1;
        continue;
      }
      const entry = allowlisted(desktopVector.chain, desktopVector.key_id, field);
      if (entry) {
        allowed += 1;
        const label = `${desktopVector.chain}/${field}`;
        allowedDetails.set(label, (allowedDetails.get(label) ?? 0) + 1);
        continue;
      }
      errors.push(
        `${key} ${field}: desktop=${JSON.stringify(left)} wasm=${JSON.stringify(right)}`,
      );
    }
  }

  for (const [entry, hits] of entryHits) {
    if (hits === 0) {
      errors.push(
        `stale allowlist entry ${entry.chain}/${entry.field} (key ${entry.key_id ?? "*"}) ` +
          `no longer matches a mismatch; remove it (${entry.issue})`,
      );
    }
  }

  return {
    compared,
    fields,
    matched,
    allowed,
    mismatches: errors.length,
    allowedDetails,
    errors,
  };
}

/** First human-readable difference between two JSON values, or null. */
export function firstDifference(actual, expected, prefix = "") {
  if (actual === expected) return null;
  if (typeof actual !== typeof expected) {
    return `${prefix || "<root>"}: type ${typeof actual} != ${typeof expected}`;
  }
  if (actual === null || expected === null || typeof actual !== "object") {
    return `${prefix || "<root>"}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
      return `${prefix || "<root>"}: array/object mismatch`;
    }
    if (actual.length !== expected.length) {
      return `${prefix || "<root>"}: array length ${actual.length} != ${expected.length}`;
    }
    for (let index = 0; index < actual.length; index += 1) {
      const difference = firstDifference(
        actual[index],
        expected[index],
        `${prefix}[${index}]`,
      );
      if (difference) return difference;
    }
    return null;
  }
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    const difference = firstDifference(
      actual[key],
      expected[key],
      prefix ? `${prefix}.${key}` : key,
    );
    if (difference) return difference;
  }
  return null;
}
