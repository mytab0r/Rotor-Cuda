/* Build-time bridge to the browser address codec that is not in the WASM
 * report (Bitcoin Cash CashAddr). `apps/site/address-codecs.js` is the one
 * implementation the key page uses; the build requires the same file. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DerivedAddressRow {
  id: string;
  label: string;
  address: string;
  steps?: Record<string, string>;
}

export interface AddressCodecs {
  cashaddr(hash160: string, type: number): string;
  /** BCH CashAddr and the uncompressed DOGE/ZEC views the WASM report omits. */
  derive(report: unknown): Record<string, DerivedAddressRow>;
}

let codecs: AddressCodecs | null = null;

export function loadAddressCodecs(): AddressCodecs {
  if (codecs) return codecs;
  const require = createRequire(import.meta.url);
  const candidates = [
    path.resolve(process.cwd(), '../apps/site/address-codecs.js'),
    path.resolve(process.cwd(), 'apps/site/address-codecs.js'),
    fileURLToPath(new URL('../../../apps/site/address-codecs.js', import.meta.url)),
  ];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      codecs = require(candidate) as AddressCodecs;
      return codecs;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`could not load apps/site/address-codecs.js:\n${failures.join('\n')}`);
}
