/* Pure derivation and validation core for /mnemonic-converter.
 *
 * This is the TypeScript port of the DOM-free half of apps/site/seed-page.js.
 * The crypto itself is not reimplemented: the page loads the vendored
 * /vendor/seed.js and /vendor/seed-crypto.js byte copies and the wasm core
 * from /rotor_wasm.wasm. Everything here can run under Node in the tests. */

export type SeedScheme = 'bip39' | 'electrum-bip39' | 'electrum-old';

export interface ChainPreset {
  id: string;
  label: string;
  path: string;
}

export interface ChainConfig {
  label: string;
  explorer: string;
  presets: ChainPreset[];
}

export interface DeriveReport {
  addresses?: Array<{ id: string; address?: string }>;
  pubkey_compressed: string;
  pubkey_uncompressed?: string;
  wif_compressed?: string;
  wif_uncompressed?: string;
}

export interface WasmExports {
  memory: WebAssembly.Memory;
  alloc(length: number): number;
  dealloc(pointer: number, length: number): void;
  derive_report(pointer: number, flags: number): number;
  error_ptr(): number;
  error_len(): number;
  result_ptr(): number;
  result_len(): number;
}

export interface RotorSeedApi {
  wordlist: string[];
  validate(phrase: string): boolean;
  generate(): string;
  seedHex(phrase: string, passphrase?: string): string;
  entropyToMnemonic(entropyHex: string): string;
  derive(phrase: string, passphrase: string, path: string): string;
}

export interface RotorSeedCryptoApi {
  bip39Words(): string[];
  validateOld(phrase: string): { words: string[]; seedHex: string };
  validateElectrumBip39(
    phrase: string,
  ): Promise<{ words: string[]; phrase: string; seedType: string }>;
  bip39Seed(phrase: string, passphrase: string): Promise<Uint8Array>;
  electrumSeed(phrase: string, passphrase: string): Promise<Uint8Array>;
  electrumSeedType(phrase: string): Promise<string>;
  bip32PrivateKey(
    seed: Uint8Array,
    path: string,
    pubkeyFor: (keyHex: string) => Promise<Uint8Array>,
  ): Promise<string>;
  oldPrivateKeys(
    seedHex: string,
    count: number,
    report: (keyHex: string) => DeriveReport,
  ): Promise<{ stretched: string; masterPublicKey: string; keys: string[] }>;
  generateOld(count: number): string;
  generateBip39(count: number): string;
  generateElectrumBip39(count: number): Promise<string>;
}

declare global {
  interface Window {
    RotorSeed?: RotorSeedApi;
    RotorSeedCrypto?: RotorSeedCryptoApi;
  }
}

export const CHAINS: Record<string, ChainConfig> = {
  bitcoin: {
    label: 'Bitcoin',
    explorer: 'https://mempool.space/address/',
    presets: [
      { id: 'btc_p2pkh', label: 'BIP44 · Legacy', path: "m/44'/0'/0'/0/0" },
      { id: 'btc_p2sh_p2wpkh', label: 'BIP49 · Nested SegWit', path: "m/49'/0'/0'/0/0" },
      { id: 'btc_p2wpkh', label: 'BIP84 · Native SegWit', path: "m/84'/0'/0'/0/0" },
      { id: 'btc_p2tr', label: 'BIP86 · Taproot', path: "m/86'/0'/0'/0/0" },
    ],
  },
  ethereum: {
    label: 'Ethereum / EVM',
    explorer: 'https://etherscan.io/address/',
    presets: [{ id: 'evm', label: 'BIP44 · Ethereum', path: "m/44'/60'/0'/0/0" }],
  },
  tron: {
    label: 'TRON',
    explorer: 'https://tronscan.org/#/address/',
    presets: [{ id: 'tron', label: 'BIP44 · TRON', path: "m/44'/195'/0'/0/0" }],
  },
  litecoin: {
    label: 'Litecoin',
    explorer: 'https://blockchair.com/litecoin/address/',
    presets: [
      { id: 'ltc_p2pkh', label: 'BIP44 · Legacy', path: "m/44'/2'/0'/0/0" },
      { id: 'ltc_p2sh_p2wpkh', label: 'BIP49 · Nested SegWit', path: "m/49'/2'/0'/0/0" },
      { id: 'ltc_p2wpkh', label: 'BIP84 · Native SegWit', path: "m/84'/2'/0'/0/0" },
    ],
  },
  dogecoin: {
    label: 'Dogecoin',
    explorer: 'https://blockchair.com/dogecoin/address/',
    presets: [{ id: 'doge_p2pkh', label: 'BIP44 · Dogecoin', path: "m/44'/3'/0'/0/0" }],
  },
  'bitcoin-cash': {
    label: 'Bitcoin Cash',
    explorer: 'https://blockchair.com/bitcoin-cash/address/',
    presets: [{ id: 'bch_legacy', label: 'BIP44 · Bitcoin Cash', path: "m/44'/145'/0'/0/0" }],
  },
  xrp: {
    label: 'XRP',
    explorer: 'https://xrpscan.com/account/',
    presets: [{ id: 'xrp_classic', label: 'BIP44 · XRP', path: "m/44'/144'/0'/0/0" }],
  },
};

export const CHAIN_ORDER: string[] = [
  'bitcoin',
  'ethereum',
  'tron',
  'litecoin',
  'dogecoin',
  'bitcoin-cash',
  'xrp',
];

export const EVM_RPC = 'https://ethereum-rpc.publicnode.com';
export const BTC_BALANCE_URL = 'https://blockchain.info/balance?cors=true&active=';
export const WORDS: number[] = [12, 15, 18, 21, 24];
export const LOAD_BATCH: number = 5;
export const ADDRESS_COUNTS: number[] = [1, 3, 5, 10, 20];

export function normalizePhrase(text: unknown): string {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function countWords(text: unknown): number {
  const phrase = normalizePhrase(text);
  return phrase ? phrase.split(' ').length : 0;
}

export function batchIndices(start: number, size: number): number[] {
  const from = Math.max(0, Math.floor(Number(start) || 0));
  const length = Math.max(0, Math.floor(Number(size) || 0));
  const out: number[] = [];
  for (let index = 0; index < length; index += 1) out.push(from + index);
  return out;
}

export function withIndex(path: string, index: number): string {
  const parts = path.split('/');
  const last = parts[parts.length - 1] ?? '';
  const hardened = /['hH]$/.test(last);
  parts[parts.length - 1] = hardened ? index + "'" : String(index);
  return parts.join('/');
}

/* Restores the scheme for a phrase handed over from the search dialog: a valid
 * BIP39 checksum wins, then a legacy Electrum decode, otherwise Electrum
 * BIP39. Mirrors the boot block of the current page. */
export function schemeForPhrase(phrase: string): SeedScheme {
  const normalized = normalizePhrase(phrase);
  const seed = window.RotorSeed;
  if (seed && seed.validate(normalized)) return 'bip39';
  const crypto = requireCrypto();
  try {
    crypto.validateOld(normalized);
    return 'electrum-old';
  } catch {
    return 'electrum-bip39';
  }
}

function requireSeed(): RotorSeedApi {
  const seed = window.RotorSeed;
  if (!seed) throw new Error('The seed library did not load. Reload the page.');
  return seed;
}

function requireCrypto(): RotorSeedCryptoApi {
  const crypto = window.RotorSeedCrypto;
  if (!crypto) throw new Error('The seed library did not load. Reload the page.');
  return crypto;
}

let bip39Set: Record<string, true> | null = null;
function bip39WordSet(): Record<string, true> {
  if (bip39Set) return bip39Set;
  const set: Record<string, true> = Object.create(null) as Record<string, true>;
  for (const word of requireCrypto().bip39Words()) set[word] = true;
  bip39Set = set;
  return set;
}

/* Live hint that mirrors inspectPhrase(); messages never repeat phrase words. */
export async function phraseHint(text: unknown, scheme: SeedScheme): Promise<string> {
  const phrase = normalizePhrase(text);
  const words = phrase ? phrase.split(' ') : [];
  const count = words.length;
  if (!count) return 'Enter a mnemonic to check its words and checksum.';

  if (scheme === 'electrum-old') {
    if (!window.RotorSeedCrypto) return 'The seed libraries did not load.';
    if (count !== 12 && count !== 24) return 'Electrum old phrases use 12 or 24 words.';
    try {
      window.RotorSeedCrypto.validateOld(phrase);
      return 'Valid Electrum old phrase.';
    } catch {
      return 'Not a valid Electrum old phrase: check the words.';
    }
  }

  if (scheme === 'electrum-bip39') {
    if (!window.RotorSeedCrypto) return 'The seed libraries did not load.';
    try {
      const info = await window.RotorSeedCrypto.validateElectrumBip39(phrase);
      return 'Valid Electrum BIP39 phrase (' + info.seedType + ').';
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/at least two words/.test(message)) return 'An Electrum seed needs at least two words.';
      if (/2FA/.test(message)) return 'Electrum 2FA seeds are not supported here.';
      if (/Unknown BIP39 word/.test(message)) return 'Some words are not in the BIP39 wordlist.';
      return 'Not an Electrum BIP39 seed-version phrase.';
    }
  }

  if (WORDS.indexOf(count) < 0) return 'BIP39 uses 12, 15, 18, 21 or 24 words.';
  if (!window.RotorSeed || !window.RotorSeedCrypto) return 'The seed libraries did not load.';
  const known = bip39WordSet();
  for (const word of words) {
    if (!known[word]) return 'Some words are not in the BIP39 wordlist.';
  }
  if (!window.RotorSeed.validate(phrase)) return 'BIP39 checksum does not match.';
  return 'Valid BIP39 phrase.';
}

export interface Inspection {
  scheme: SeedScheme;
  phrase: string;
  passphrase?: string;
  seedHex?: string;
  seedType: string;
}

export async function inspectPhrase(
  phrase: string,
  scheme: SeedScheme,
  passphrase: string,
): Promise<Inspection> {
  if (scheme === 'electrum-old') {
    if (passphrase) throw new Error('Electrum old seeds do not support a passphrase.');
    const old = requireCrypto().validateOld(phrase);
    return { scheme, phrase: old.words.join(' '), seedHex: old.seedHex, seedType: 'old' };
  }

  if (scheme === 'electrum-bip39') {
    const electrum = await requireCrypto().validateElectrumBip39(phrase);
    return {
      scheme,
      phrase: electrum.phrase,
      passphrase,
      seedType: electrum.seedType,
    };
  }

  const words = phrase.split(' ');
  if (WORDS.indexOf(words.length) < 0) {
    throw new Error(
      'A BIP39 mnemonic has 12, 15, 18, 21 or 24 words; this one has ' + words.length + '.',
    );
  }
  const known = bip39WordSet();
  for (const word of words) {
    if (!known[word]) throw new Error('Unknown BIP39 word: "' + word + '".');
  }
  if (!requireSeed().validate(words.join(' '))) {
    throw new Error('BIP39 checksum does not match. Check the words and their order.');
  }
  return { scheme: 'bip39', phrase: words.join(' '), passphrase, seedType: 'bip39' };
}

export interface Target {
  chain: string;
  chainLabel: string;
  explorer: string;
  preset: ChainPreset;
}

function presetTargets(chain: string, selectedChain: string, pathValue: string, allPaths: boolean): Target[] {
  const config = CHAINS[chain];
  if (!config) return [];
  if (allPaths) {
    return config.presets.map((preset) => ({
      chain,
      chainLabel: config.label,
      explorer: config.explorer,
      preset,
    }));
  }
  if (selectedChain === chain) {
    const chosen = pathValue ? pathValue.split('|') : [];
    let match: ChainPreset | null = null;
    for (const preset of config.presets) {
      if (preset.path === chosen[0] && preset.id === chosen[1]) match = preset;
    }
    if (match) {
      return [{ chain, chainLabel: config.label, explorer: config.explorer, preset: match }];
    }
  }
  const first = config.presets[0];
  if (!first) return [];
  return [{ chain, chainLabel: config.label, explorer: config.explorer, preset: first }];
}

export function selectedTargets(
  scheme: SeedScheme,
  chain: string,
  pathValue: string,
  allPaths: boolean,
): Target[] {
  if (scheme === 'electrum-old') {
    const bitcoin = CHAINS.bitcoin;
    return [
      {
        chain: 'bitcoin',
        chainLabel: 'Bitcoin (Electrum old)',
        explorer: bitcoin ? bitcoin.explorer : 'https://mempool.space/address/',
        preset: { id: 'btc_p2pkh_uncompressed', label: 'Electrum old address', path: 'old' },
      },
    ];
  }
  if (chain === 'all') {
    let targets: Target[] = [];
    for (const id of CHAIN_ORDER) {
      targets = targets.concat(presetTargets(id, chain, pathValue, allPaths));
    }
    return targets;
  }
  return presetTargets(chain, chain, pathValue, allPaths);
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function readString(wasm: WasmExports, pointer: number, length: number): string {
  if (!pointer || !length) return '';
  return new TextDecoder('utf-8').decode(new Uint8Array(wasm.memory.buffer, pointer, length));
}

export function reportFor(wasm: WasmExports, keyHex: string): DeriveReport {
  const bytes = hexToBytes(keyHex);
  const pointer = wasm.alloc(bytes.length) >>> 0;
  if (!pointer) throw new Error('WASM memory exhausted.');
  try {
    new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
    const status = wasm.derive_report(pointer, 0) >>> 0;
    if (status !== 0) {
      throw new Error(
        readString(wasm, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0) ||
          'derivation status ' + status,
      );
    }
    return JSON.parse(readString(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0)) as DeriveReport;
  } finally {
    wasm.dealloc(pointer, bytes.length);
  }
}

export function addressOf(report: DeriveReport | null, id: string): string {
  if (!report || !Array.isArray(report.addresses)) return '';
  for (const entry of report.addresses) {
    if (entry.id === id) return entry.address || '';
  }
  return '';
}

export function makePubkeyFor(wasm: WasmExports): (keyHex: string) => Promise<Uint8Array> {
  return async (keyHex: string) => hexToBytes(reportFor(wasm, keyHex).pubkey_compressed);
}

export interface DerivationResult {
  chain: string;
  chainLabel: string;
  explorer: string;
  presetLabel: string;
  path: string;
  address: string;
  privHex: string;
  wifCompressed: string;
  wifUncompressed: string;
}

function makeResult(target: Target, path: string, keyHex: string, report: DeriveReport): DerivationResult {
  return {
    chain: target.chain,
    chainLabel: target.chainLabel,
    explorer: target.explorer,
    presetLabel: target.preset.label,
    path,
    address: addressOf(report, target.preset.id),
    privHex: keyHex,
    wifCompressed: report.wif_compressed || '',
    wifUncompressed: report.wif_uncompressed || '',
  };
}

export class DerivationCancelled extends Error {
  constructor() {
    super('Derivation cancelled.');
    this.name = 'DerivationCancelled';
  }
}

export interface DeriveDeps {
  wasm: WasmExports;
  /** Return false when a newer run replaced this one; the loop stops. */
  isCurrent?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface DeriveRequest extends DeriveDeps {
  phrase: string;
  passphrase: string;
  scheme: SeedScheme;
  chain: string;
  pathValue: string;
  allPaths: boolean;
  count: number;
}

export interface DerivationSnapshot {
  info: Inspection;
  targets: Target[];
  seed: Uint8Array | null;
  oldKeys: string[] | null;
  nextIndex: number;
}

export interface DeriveOutcome {
  info: Inspection;
  rows: DerivationResult[];
  snapshot: DerivationSnapshot;
}

function checkCurrent(deps: DeriveDeps): void {
  if (deps.isCurrent && !deps.isCurrent()) throw new DerivationCancelled();
}

export async function deriveEntries(request: DeriveRequest): Promise<DeriveOutcome> {
  const crypto = requireCrypto();
  const info = await inspectPhrase(request.phrase, request.scheme, request.passphrase);
  checkCurrent(request);

  const { wasm } = request;
  const report = (keyHex: string): DeriveReport => reportFor(wasm, keyHex);
  const pubkeyFor = makePubkeyFor(wasm);
  const targets = selectedTargets(
    info.scheme,
    request.chain,
    request.pathValue,
    request.allPaths,
  );
  const total = targets.length * request.count;
  let done = 0;
  const rows: DerivationResult[] = [];
  let seed: Uint8Array | null = null;
  let oldKeys: string[] | null = null;

  if (info.scheme === 'electrum-old') {
    const old = await crypto.oldPrivateKeys(info.seedHex ?? '', request.count, report);
    oldKeys = old.keys;
    const target = targets[0];
    if (!target) return { info, rows, snapshot: { info, targets, seed, oldKeys, nextIndex: request.count } };
    for (let index = 0; index < old.keys.length; index += 1) {
      checkCurrent(request);
      const key = old.keys[index];
      if (!key) continue;
      rows.push(makeResult(target, 'old/0/' + index, key, report(key)));
      done += 1;
      request.onProgress?.(done, total);
    }
  } else {
    seed =
      info.scheme === 'bip39'
        ? await crypto.bip39Seed(info.phrase, info.passphrase ?? '')
        : await crypto.electrumSeed(info.phrase, info.passphrase ?? '');
    for (const target of targets) {
      for (let index = 0; index < request.count; index += 1) {
        checkCurrent(request);
        const path = withIndex(target.preset.path, index);
        const keyHex = await crypto.bip32PrivateKey(seed, path, pubkeyFor);
        rows.push(makeResult(target, path, keyHex, report(keyHex)));
        done += 1;
        request.onProgress?.(done, total);
        if (done % 5 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  checkCurrent(request);
  return {
    info,
    rows,
    snapshot: { info, targets, seed, oldKeys, nextIndex: request.count },
  };
}

export interface DeriveMoreOutcome {
  rows: DerivationResult[];
  oldKeys: string[] | null;
}

/* Append LOAD_BATCH indices after the rendered count for every target path. */
export async function deriveMore(
  snapshot: DerivationSnapshot,
  size: number,
  deps: DeriveDeps,
): Promise<DeriveMoreOutcome> {
  const crypto = requireCrypto();
  const report = (keyHex: string): DeriveReport => reportFor(deps.wasm, keyHex);
  const pubkeyFor = makePubkeyFor(deps.wasm);
  const indices = batchIndices(snapshot.nextIndex, size);
  const rows: DerivationResult[] = [];
  let oldKeys = snapshot.oldKeys;

  if (snapshot.info.scheme === 'electrum-old') {
    const need = snapshot.nextIndex + size;
    const old = await crypto.oldPrivateKeys(snapshot.info.seedHex ?? '', need, report);
    const target = snapshot.targets[0];
    if (!target) return { rows, oldKeys };
    for (let index = 0; index < indices.length; index += 1) {
      checkCurrent(deps);
      const oldKey = old.keys[snapshot.nextIndex + index];
      if (!oldKey) break;
      const batchIndex = indices[index] ?? 0;
      rows.push(makeResult(target, 'old/0/' + batchIndex, oldKey, report(oldKey)));
    }
    oldKeys = old.keys;
  } else {
    for (const target of snapshot.targets) {
      for (const index of indices) {
        checkCurrent(deps);
        const path = withIndex(target.preset.path, index);
        const keyHex = await crypto.bip32PrivateKey(snapshot.seed ?? new Uint8Array(), path, pubkeyFor);
        rows.push(makeResult(target, path, keyHex, report(keyHex)));
        if (rows.length % LOAD_BATCH === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }
  }

  checkCurrent(deps);
  return { rows, oldKeys };
}

export function coin(value: number | bigint, decimals: number): string {
  const number = Number(value) / Math.pow(10, decimals);
  if (!isFinite(number)) return '0';
  if (number === 0) return '0';
  if (number < 0.00000001) return '<0.00000001';
  return number.toLocaleString('en-US', { maximumFractionDigits: decimals > 8 ? 6 : 8 });
}

export function csvCell(value: unknown): string {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function csvText(rows: Array<Pick<DerivationResult, 'chainLabel' | 'path' | 'address'>>): string {
  const lines = ['chain,path,address'];
  for (const row of rows) {
    lines.push([csvCell(row.chainLabel), csvCell(row.path), csvCell(row.address)].join(','));
  }
  return lines.join('\n') + '\n';
}

/* Exposed for the in-browser console and for parity checks; the page itself
 * imports the functions directly. */
export const RotorSeedPage = {
  countWords,
  phraseHint,
  batchIndices,
  schemeForPhrase,
  inspectPhrase,
  selectedTargets,
  deriveEntries,
  deriveMore,
  reportFor,
  addressOf,
};
