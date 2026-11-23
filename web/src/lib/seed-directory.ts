/* Build-time derivation for `/mnemonic-seeds/<chain>`.
 *
 * The example set is the first 60 128-bit values of the BIP39 entropy space:
 * index 0 is the all-zero entropy that yields "abandon … about", index 1 is
 * 0x…01, and so on. Each index becomes one 12-word phrase; the phrase is a
 * public example, never a wallet.
 *
 * No crypto is implemented here. The phrase, PBKDF2 seed and BIP32 keys come
 * from `apps/site/seed.js` and `apps/site/seed-crypto.js`; SLIP-0010 ed25519
 * keys come from `slip10PrivateKey` in the same crypto module; every address
 * comes from the vendored WASM `derive_report` core. Bitcoin Cash CashAddr and
 * TON v4R2 reuse the browser encoders the key page uses.
 *
 * This module runs in Node at Astro build time and is not imported by a page
 * script. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { loadAddressCodecs } from './address-codecs.js';
import {
  deriveReport as wasmDeriveReport,
  hexToBytes,
  loadWasm,
  type Curve,
  type DeriveReport,
} from './wasm-core.js';

export const SEEDS_PER_PAGE = 60;
export const WORDS_PER_SEED = 12;

export interface SeedFormatSpec {
  /** Stable id used by the table and tests. */
  id: string;
  /** Human label rendered in the address line. */
  label: string;
  /** Curve used for the key and the WASM report. */
  curve: Curve;
  /** BIP32 / SLIP-0010 path this project derives for the format. */
  path: string;
  /** Report address id, or `cashaddr` / `ton_v4` for the browser encoders. */
  addressId: string;
}

export interface SeedAddressCell {
  formatId: string;
  label: string;
  path: string;
  address: string;
}

export interface SeedRow {
  /** Position in the example entropy set, 0-based. */
  index: number;
  phrase: string;
  cells: SeedAddressCell[];
  /** First format's private key, for the `/key` calculator link. */
  keyHex: string;
  keyCurve: Curve;
}

const EVM: SeedFormatSpec = {
  id: 'evm',
  label: 'EVM 0x (EIP-55)',
  curve: 0,
  path: "m/44'/60'/0'/0/0",
  addressId: 'evm',
};

const FORMATS: Record<string, SeedFormatSpec[]> = {
  bitcoin: [
    { id: 'btc_p2pkh', label: 'P2PKH legacy (1…)', curve: 0, path: "m/44'/0'/0'/0/0", addressId: 'btc_p2pkh' },
    { id: 'btc_p2sh_p2wpkh', label: 'P2SH-P2WPKH nested (3…)', curve: 0, path: "m/49'/0'/0'/0/0", addressId: 'btc_p2sh_p2wpkh' },
    { id: 'btc_p2wpkh', label: 'P2WPKH native (bc1q…)', curve: 0, path: "m/84'/0'/0'/0/0", addressId: 'btc_p2wpkh' },
    { id: 'btc_p2tr', label: 'P2TR taproot (bc1p…)', curve: 0, path: "m/86'/0'/0'/0/0", addressId: 'btc_p2tr' },
  ],
  ethereum: [EVM],
  bnb: [EVM],
  arbitrum: [EVM],
  optimism: [EVM],
  base: [EVM],
  polygon: [EVM],
  avalanche: [EVM],
  zksync: [EVM],
  solana: [
    { id: 'solana', label: 'ed25519 base58', curve: 1, path: "m/44'/501'/0'/0'", addressId: 'solana' },
  ],
  tron: [
    { id: 'tron', label: 'TRON Base58Check (T…)', curve: 0, path: "m/44'/195'/0'/0/0", addressId: 'tron' },
  ],
  xrp: [
    { id: 'xrp_classic', label: 'XRP classic (r…)', curve: 0, path: "m/44'/144'/0'/0/0", addressId: 'xrp_classic' },
  ],
  litecoin: [
    { id: 'ltc_p2pkh', label: 'P2PKH legacy (L…)', curve: 0, path: "m/44'/2'/0'/0/0", addressId: 'ltc_p2pkh' },
    { id: 'ltc_p2sh_p2wpkh', label: 'P2SH-P2WPKH nested (M…)', curve: 0, path: "m/49'/2'/0'/0/0", addressId: 'ltc_p2sh_p2wpkh' },
    { id: 'ltc_p2wpkh', label: 'P2WPKH native (ltc1q…)', curve: 0, path: "m/84'/2'/0'/0/0", addressId: 'ltc_p2wpkh' },
  ],
  'bitcoin-cash': [
    { id: 'bch_legacy', label: 'Legacy P2PKH (1…)', curve: 0, path: "m/44'/145'/0'/0/0", addressId: 'bch_legacy' },
    { id: 'bch_cashaddr', label: 'CashAddr (bitcoincash:q…)', curve: 0, path: "m/44'/145'/0'/0/0", addressId: 'cashaddr' },
  ],
  dogecoin: [
    { id: 'doge_p2pkh', label: 'P2PKH legacy (D…)', curve: 0, path: "m/44'/3'/0'/0/0", addressId: 'doge_p2pkh' },
  ],
  zcash: [
    { id: 'zcash_p2pkh', label: 'Transparent P2PKH (t1…)', curve: 0, path: "m/44'/133'/0'/0/0", addressId: 'zcash_p2pkh' },
  ],
  sui: [
    { id: 'sui', label: 'Sui account (0x…)', curve: 1, path: "m/44'/784'/0'/0'/0'", addressId: 'sui' },
  ],
  ton: [
    { id: 'ton', label: 'Wallet v4R2 (EQ…)', curve: 1, path: "m/44'/607'/0'", addressId: 'ton_v4' },
    { id: 'ton_w5', label: 'Wallet W5 (EQ…/UQ…)', curve: 1, path: "m/44'/607'/0'", addressId: 'ton_w5' },
  ],
};

export function seedFormatsFor(slug: string): SeedFormatSpec[] {
  const formats = FORMATS[slug];
  if (!formats) throw new Error(`no seed formats configured for chain "${slug}"`);
  return formats;
}

/* Unique derivation paths per chain, for the prose and the hub. */
export function seedPathsFor(slug: string): string[] {
  return [...new Set(seedFormatsFor(slug).map((format) => format.path))];
}

interface CryptoApi {
  bip39Seed(phrase: string, passphrase: string): Promise<Uint8Array>;
  bip32PrivateKey(
    seed: Uint8Array,
    path: string,
    pubkeyFor: (keyHex: string) => Promise<Uint8Array>,
  ): Promise<string>;
  slip10PrivateKey(seed: Uint8Array, path: string): Promise<string>;
}

interface SeedApi {
  entropyToMnemonic(entropyHex: string): string;
}

interface TonApi {
  address(publicKeyHex: string): Promise<string>;
}

function siteFileCandidates(name: string): string[] {
  return [
    path.resolve(process.cwd(), '../apps/site', name),
    path.resolve(process.cwd(), 'apps/site', name),
    fileURLToPath(new URL(`../../../apps/site/${name}`, import.meta.url)),
  ];
}

async function readSiteFile(name: string): Promise<{ source: string; file: string }> {
  const failures: string[] = [];
  for (const file of siteFileCandidates(name)) {
    try {
      return { source: await readFile(file, 'utf8'), file };
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`could not read apps/site/${name}:\n${failures.join('\n')}`);
}

function browserSandbox(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    console,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    navigator: {},
    btoa,
    atob,
    ...extra,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return sandbox;
}

let seedApiPromise: Promise<SeedApi> | null = null;

async function loadSeedApi(): Promise<SeedApi> {
  if (seedApiPromise) return seedApiPromise;
  seedApiPromise = (async () => {
    const { source, file } = await readSiteFile('seed.js');
    const sandbox = browserSandbox();
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: file });
    const seed = sandbox.RotorSeed as SeedApi | undefined;
    if (!seed || typeof seed.entropyToMnemonic !== 'function') {
      throw new Error('apps/site/seed.js did not expose RotorSeed.entropyToMnemonic');
    }
    return seed;
  })();
  return seedApiPromise;
}

let cryptoApi: CryptoApi | null = null;

function loadCryptoApi(): CryptoApi {
  if (cryptoApi) return cryptoApi;
  const require = createRequire(import.meta.url);
  const failures: string[] = [];
  for (const candidate of siteFileCandidates('seed-crypto.js')) {
    try {
      cryptoApi = require(candidate) as CryptoApi;
      return cryptoApi;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`could not load apps/site/seed-crypto.js:\n${failures.join('\n')}`);
}

let tonApiPromise: Promise<TonApi> | null = null;

async function loadTonApi(): Promise<TonApi> {
  if (tonApiPromise) return tonApiPromise;
  tonApiPromise = (async () => {
    const { source, file } = await readSiteFile('ton.js');
    const sandbox = browserSandbox();
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: file });
    const ton = sandbox.RotorTon as TonApi | undefined;
    if (!ton || typeof ton.address !== 'function') {
      throw new Error('apps/site/ton.js did not expose RotorTon.address');
    }
    return ton;
  })();
  return tonApiPromise;
}

/* All three caches are keyed by inputs, not by page, so 18 pages share one
 * phrase list, one PBKDF2 seed and one key per (curve, path) and index. */
const phraseCache = new Map<number, Promise<string>>();
const seedCache = new Map<number, Promise<Uint8Array>>();
const keyCache = new Map<string, Promise<string>>();
const reportCache = new Map<string, Promise<DeriveReport>>();

function exampleEntropyHex(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`invalid seed index ${index}`);
  const hex = index.toString(16);
  if (hex.length > 32) throw new Error(`seed index ${index} is outside the 128-bit example set`);
  return hex.padStart(32, '0');
}

function phraseFor(index: number): Promise<string> {
  let phrase = phraseCache.get(index);
  if (!phrase) {
    phrase = loadSeedApi().then((seed) => seed.entropyToMnemonic(exampleEntropyHex(index)));
    phraseCache.set(index, phrase);
  }
  return phrase;
}

function seedFor(index: number): Promise<Uint8Array> {
  let seed = seedCache.get(index);
  if (!seed) {
    seed = phraseFor(index).then((phrase) => loadCryptoApi().bip39Seed(phrase, ''));
    seedCache.set(index, seed);
  }
  return seed;
}

async function pubkeyFor(keyHex: string): Promise<Uint8Array> {
  const wasm = await loadWasm();
  const report = await reportOf(wasm, 0, keyHex);
  if (!report.pubkey_compressed) throw new Error(`WASM report has no pubkey for ${keyHex}`);
  return hexToBytes(report.pubkey_compressed);
}

function keyFor(index: number, curve: Curve, derivationPath: string): Promise<string> {
  const cacheKey = `${index}|${curve}|${derivationPath}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = seedFor(index).then(async (seedBytes) => {
      const crypto = loadCryptoApi();
      return curve === 1
        ? crypto.slip10PrivateKey(seedBytes, derivationPath)
        : crypto.bip32PrivateKey(seedBytes, derivationPath, pubkeyFor);
    });
    keyCache.set(cacheKey, key);
  }
  return key;
}

async function reportOf(
  wasm: Awaited<ReturnType<typeof loadWasm>>,
  curve: Curve,
  keyHex: string,
): Promise<DeriveReport> {
  const cacheKey = `${curve}|${keyHex}`;
  let report = reportCache.get(cacheKey);
  if (!report) {
    report = Promise.resolve(wasmDeriveReport(wasm, keyHex, curve));
    reportCache.set(cacheKey, report);
  }
  return report;
}

async function addressFor(
  report: DeriveReport,
  format: SeedFormatSpec,
  ton: TonApi | null,
): Promise<string> {
  if (format.addressId === 'cashaddr') {
    const legacy = report.addresses.find((entry) => entry.id === 'bch_legacy');
    const hash160 = legacy?.steps?.hash160;
    if (!hash160) throw new Error('BCH report has no legacy hash160 step');
    return loadAddressCodecs().cashaddr(hash160, 0);
  }
  if (format.addressId === 'ton_v4') {
    if (!ton) throw new Error('TON v4R2 needs the ton.js encoder');
    if (!report.ed_pubkey) throw new Error('TON report has no ed25519 public key');
    return ton.address(report.ed_pubkey);
  }
  const entry = report.addresses.find((item) => item.id === format.addressId);
  if (!entry || !entry.address) {
    throw new Error(`WASM report has no address "${format.addressId}" for ${report.curve}`);
  }
  return entry.address;
}

/* One chain's page: `count` phrases, each with the first derived address in
 * every format that chain supports. */
export async function deriveSeedRows(
  slug: string,
  count = SEEDS_PER_PAGE,
): Promise<SeedRow[]> {
  const formats = seedFormatsFor(slug);
  const wasm = await loadWasm();
  const ton = slug === 'ton' ? await loadTonApi() : null;
  const rows: SeedRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const phrase = await phraseFor(index);
    const cells: SeedAddressCell[] = [];
    let firstKey: string | null = null;
    for (const format of formats) {
      const keyHex = await keyFor(index, format.curve, format.path);
      if (firstKey === null) firstKey = keyHex;
      const report = await reportOf(wasm, format.curve, keyHex);
      cells.push({
        formatId: format.id,
        label: format.label,
        path: format.path,
        address: await addressFor(report, format, ton),
      });
    }
    if (!firstKey) throw new Error(`chain "${slug}" has no seed format`);
    rows.push({
      index,
      phrase,
      cells,
      keyHex: firstKey,
      keyCurve: formats[0]?.curve ?? 0,
    });
  }
  return rows;
}

let allRowsPromise: Promise<Map<string, SeedRow[]>> | null = null;

export async function seedRowsFor(slug: string): Promise<SeedRow[]> {
  if (!allRowsPromise) {
    allRowsPromise = (async () => {
      const map = new Map<string, SeedRow[]>();
      for (const chainSlug of Object.keys(FORMATS)) {
        map.set(chainSlug, await deriveSeedRows(chainSlug));
      }
      return map;
    })();
  }
  const rows = (await allRowsPromise).get(slug);
  if (!rows) throw new Error(`no seed rows configured for chain "${slug}"`);
  return rows;
}

export function isSeedChain(slug: string): boolean {
  return Object.hasOwn(FORMATS, slug);
}
