/* Shared loader for the Node tests. The compiled tests live in
 * web/.test-build/tests, so ../../ is the web/ package root. The vendored
 * scripts are the exact files the browser loads from /vendor/. */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import type { RotorSeedApi, RotorSeedCryptoApi, WasmExports } from '../src/lib/seed-core.js';

export const webRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface VendorApi {
  seed: RotorSeedApi;
  crypto: RotorSeedCryptoApi;
}

export function loadVendor(): VendorApi {
  const global = globalThis as unknown as { window?: unknown };
  global.window = globalThis;
  for (const name of ['seed.js', 'seed-crypto.js']) {
    const file = path.join(webRoot, 'public', 'vendor', name);
    vm.runInThisContext(readFileSync(file, 'utf8'), { filename: name });
  }
  const seed = (globalThis as typeof globalThis & { RotorSeed?: RotorSeedApi }).RotorSeed;
  const crypto = (globalThis as typeof globalThis & { RotorSeedCrypto?: RotorSeedCryptoApi })
    .RotorSeedCrypto;
  if (!seed || !crypto) throw new Error('the vendored seed scripts did not expose their API');
  return { seed, crypto };
}

export async function loadWasm(): Promise<WasmExports> {
  const bytes = await readFile(path.join(webRoot, 'public', 'rotor_wasm.wasm'));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as unknown as WasmExports;
}
