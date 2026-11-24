/* The curated key set: the only `/key/<hex>` routes the Astro build renders
 * and lists in the sitemap. `data/key-curated.json` is the one source; the
 * dynamic page, the sitemap, the SEO gate and the worker test all read it, so
 * the static set cannot drift from the indexable set.
 *
 * Every other 64-hex key is served by `web/public/_worker.js` (Cloudflare
 * Pages advanced mode), which injects per-key metadata and returns noindex.
 * That path never runs at build time, so it cannot import this module. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CuratedKey {
  /** Lowercase 64-character hex, the route segment and the input value. */
  hex: string;
  /** Decimal value of the key, for titles and copy. */
  value: string;
  /** Short display form, e.g. `0x0000…0001`. */
  display: string;
  /** Root-relative route, without a trailing slash. */
  path: string;
}

const CANDIDATES = [
  path.resolve(process.cwd(), 'data/key-curated.json'),
  path.resolve(process.cwd(), '../data/key-curated.json'),
  fileURLToPath(new URL('../../../data/key-curated.json', import.meta.url)),
];

function readData(): { keys?: unknown } {
  const failures: string[] = [];
  for (const candidate of CANDIDATES) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf8')) as { keys?: unknown };
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`could not read data/key-curated.json:\n${failures.join('\n')}`);
}

function displayFor(hex: string): string {
  return `0x${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

function load(): CuratedKey[] {
  const data = readData();
  if (!Array.isArray(data.keys) || data.keys.length < 3) {
    throw new Error('data/key-curated.json needs at least 3 curated keys');
  }
  const seen = new Set<string>();
  return data.keys.map((entry) => {
    if (typeof entry !== 'string' || !/^[0-9a-f]{64}$/.test(entry)) {
      throw new Error(`data/key-curated.json key must be 64 lowercase hex: ${String(entry)}`);
    }
    if (seen.has(entry)) throw new Error(`data/key-curated.json repeats ${entry}`);
    seen.add(entry);
    const value = BigInt(`0x${entry}`).toString();
    if (value === '0') throw new Error('data/key-curated.json contains the zero key');
    return {
      hex: entry,
      value,
      display: displayFor(entry),
      path: `/key/${entry}`,
    };
  });
}

export const CURATED_KEYS: readonly CuratedKey[] = load();
export const CURATED_BY_HEX = new Map(CURATED_KEYS.map((key) => [key.hex, key]));
export const DEFAULT_KEY: CuratedKey = CURATED_KEYS[0];
