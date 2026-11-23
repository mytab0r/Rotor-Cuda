/* Build-time bridge to the vendored Rust/WASM derivation core.
 *
 * `rotor_wasm.wasm` is the same file the browser loads. This module only
 * drives its pointer/length ABI: allocate, write 32 key bytes, call
 * `derive_report`, read the JSON blob, deallocate. No crypto is implemented
 * here, and every page that needs an address goes through one loader so the
 * build cannot drift from the browser. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Curve = 0 | 1;

export interface DeriveReport {
  curve: string;
  priv_hex: string;
  pubkey_compressed?: string;
  ed_pubkey?: string;
  addresses: Array<{
    id: string;
    label: string;
    address: string;
    steps?: Record<string, string>;
  }>;
}

export interface WasmExports {
  memory: WebAssembly.Memory;
  alloc(length: number): number;
  dealloc(pointer: number, length: number): void;
  derive_report(pointer: number, curve: number): number;
  result_ptr(): number;
  result_len(): number;
  error_ptr(): number;
  error_len(): number;
}

const DECODER = new TextDecoder('utf-8');

function wasmCandidates(): string[] {
  const candidates = [];
  if (process.env.ROTOR_WASM_PATH) candidates.push(process.env.ROTOR_WASM_PATH);
  candidates.push(
    path.resolve(process.cwd(), 'public/rotor_wasm.wasm'),
    path.resolve(process.cwd(), 'web/public/rotor_wasm.wasm'),
    fileURLToPath(new URL('../../public/rotor_wasm.wasm', import.meta.url)),
  );
  return [...new Set(candidates)];
}

let wasmPromise: Promise<WasmExports> | null = null;

export async function loadWasm(): Promise<WasmExports> {
  if (wasmPromise) return wasmPromise;
  wasmPromise = (async () => {
    const failures: string[] = [];
    for (const candidate of wasmCandidates()) {
      try {
        const bytes = await readFile(candidate);
        const { instance } = await WebAssembly.instantiate(bytes, {});
        const wasm = instance.exports as unknown as WasmExports;
        if (!(wasm.memory instanceof WebAssembly.Memory)) {
          throw new Error('module does not export memory');
        }
        for (const name of ['alloc', 'dealloc', 'derive_report', 'result_ptr', 'result_len', 'error_ptr', 'error_len']) {
          if (typeof (wasm as unknown as Record<string, unknown>)[name] !== 'function') {
            throw new Error(`module is missing ${name}`);
          }
        }
        return wasm;
      } catch (error) {
        failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`could not load rotor_wasm.wasm:\n${failures.join('\n')}`);
  })();
  return wasmPromise;
}

function bytesAt(wasm: WasmExports, pointer: number, length: number): Uint8Array {
  return new Uint8Array(wasm.memory.buffer, pointer, length);
}

function readText(wasm: WasmExports, pointer: number, length: number): string {
  return DECODER.decode(bytesAt(wasm, pointer, length));
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function deriveReport(wasm: WasmExports, keyHex: string, curve: Curve): DeriveReport {
  const key = hexToBytes(keyHex);
  const pointer = wasm.alloc(key.length) >>> 0;
  if (!pointer) throw new Error('wasm alloc returned 0');
  try {
    bytesAt(wasm, pointer, key.length).set(key);
    const status = wasm.derive_report(pointer, curve) >>> 0;
    if (status !== 0) {
      const message = readText(wasm, wasm.error_ptr(), wasm.error_len());
      throw new Error(`derive_report failed (${status}): ${message}`);
    }
    return JSON.parse(readText(wasm, wasm.result_ptr(), wasm.result_len())) as DeriveReport;
  } finally {
    wasm.dealloc(pointer, key.length);
  }
}
