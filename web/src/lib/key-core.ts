/* Build-time key derivation for `/key` and `/key/<hex>`.
 *
 * The crypto is the existing Rust/WASM core (`derive_report`) and the existing
 * browser helpers: `apps/site/address-codecs.js` supplies the BCH CashAddr and
 * the uncompressed DOGE/ZEC views, and `apps/site/key-tools.js` supplies the
 * donor fact set and the row order. Every TON wallet version (v3R2, v4R2, W5)
 * comes from the WASM report like the other rows. Nothing here recomputes a
 * hash, a curve point or an address.
 *
 * This module is imported only by the Astro pages at build time. The browser
 * island loads the same three helpers and drives the same WASM ABI; it never
 * imports this file (it uses Node built-ins). */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAddressCodecs } from './address-codecs.js';
import { EVM_NETWORKS, type KeyRowMeta, type KeyRowModel } from './key-model.js';
import {
  deriveReport,
  loadWasm,
  type DeriveReport,
  type WasmExports,
} from './wasm-core.js';

export interface KeyFact {
  id: string;
  label: string;
  value?: string;
  unavailable?: string;
  /** Link on the label (the calculator entry). */
  href?: string;
  /** Link on the value (the directory page). */
  valueHref?: string;
  /** Human-readable value while `value` stays the copy/URL payload. */
  displayValue?: string;
}

export interface AddressRow extends KeyRowMeta {
  address: string;
  curve: string;
}

export interface KeyPageData {
  hex: string;
  facts: KeyFact[];
  extras: KeyFact[];
  rows: AddressRow[];
  model: KeyRowModel;
  /** Non-empty when the value has no secp256k1 report (outside 1..n-1). */
  secpError: string;
}

interface ReportAddress {
  id: string;
  label: string;
  address: string;
  steps?: Record<string, string>;
}

interface MergedRow extends ReportAddress {
  curve?: string;
  sharedEvm?: boolean;
  sharedParent?: boolean;
}

interface KeyToolsApi {
  buildKeyFacts(
    report: DeriveReport & { priv_dec?: string; pubkey_uncompressed?: string; ed_pubkey?: string },
    doubleSha256: (bytes: Uint8Array) => Promise<Uint8Array>,
  ): Promise<KeyFact[]>;
  mergeCurveAddresses(
    secp: unknown,
    ed: unknown,
    extras: { secp: unknown[]; ed25519: unknown[] },
  ): MergedRow[];
  expandEvmAddresses(
    rows: MergedRow[],
    networks: ReadonlyArray<{ id: string; label: string }>,
    parentLabel: string,
  ): MergedRow[];
  orderAddressRows(rows: MergedRow[]): MergedRow[];
  addressTypeLabel(id: string): string;
  explorerFor(id: string): string;
  rowGroup(id: string): string;
  chainMeta(id: string): { ticker: string; icon: string; decimals: number };
}

const ROW_CHAIN_SLUGS: Record<string, string> = {
  btc: 'bitcoin',
  evm: 'ethereum',
  evm_parent: 'ethereum',
  evm_bnb: 'bnb',
  evm_arbitrum: 'arbitrum',
  evm_optimism: 'optimism',
  evm_base: 'base',
  evm_polygon: 'polygon',
  evm_avalanche: 'avalanche',
  evm_zksync: 'zksync',
  tron: 'tron',
  solana: 'solana',
  ltc: 'litecoin',
  doge: 'dogecoin',
  bch: 'bitcoin-cash',
  xrp: 'xrp',
  zcash: 'zcash',
  sui: 'sui',
  ton_v3r2: 'ton',
  ton_v4r2: 'ton',
  ton_w5: 'ton',
};

/* The shared balance provider each row id reads. This mirrors
 * `RotorBalanceProviders.metaFor` for the chain family; the island still asks
 * the provider module for the live meta, so the request itself cannot drift.
 * `data-balance-provider` is rendered at build time for the audit and the
 * row's own retry state.
 *
 * TRON is the one exception: the shared provider reaches it through the
 * coordinator's `/api/v1/chain/tron/address` proxy (TronScan sends no CORS
 * header), and the static Pages target does not serve that API. The row stays
 * honestly unavailable until the API cutover instead of issuing a 404. */
const ROW_PROVIDERS: Record<string, string> = {
  btc: 'blockchain.info',
  evm: 'evm',
  evm_bnb: 'evm',
  evm_arbitrum: 'evm',
  evm_optimism: 'evm',
  evm_base: 'evm',
  evm_polygon: 'evm',
  evm_avalanche: 'evm',
  evm_zksync: 'evm',
  tron: '',
  solana: 'solana',
  ltc: 'sochain',
  doge: 'sochain',
  bch: 'haskoin-bch',
  xrp: 'xrpscan',
  zcash: 'sochain',
  sui: 'sui',
  ton_v3r2: 'tonapi',
  ton_v4r2: 'tonapi',
  ton_w5: 'tonapi',
};

function rowSlug(id: string): string {
  return ROW_CHAIN_SLUGS[id] || ROW_CHAIN_SLUGS[id.split('_')[0]] || '';
}

function rowProvider(id: string): string {
  return ROW_PROVIDERS[id] || ROW_PROVIDERS[id.split('_')[0]] || '';
}

/* The eight donor fact ids, in order. `keypair` comes from the ed25519 report
 * because a Solana keypair is an ed25519 seed; every other id prefers the
 * secp256k1 report, which is the curve a 64-hex key is usually described on. */
const FACT_ORDER = ['hex', 'decimal', 'wif', 'wif_u', 'keypair', 'xrp', 'pubkey', 'page'] as const;
const ED_PREFERRED = new Set(['keypair']);

let toolsPromise: KeyToolsApi | null = null;

function siteRoot(): string {
  const candidates = [
    path.resolve(process.cwd(), '../apps/site'),
    path.resolve(process.cwd(), 'apps/site'),
    fileURLToPath(new URL('../../../apps/site/', import.meta.url)),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(path.join(candidate, 'key-tools.js'));
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error('could not locate apps/site for the key-page helpers');
}

function loadKeyTools(): KeyToolsApi {
  if (toolsPromise) return toolsPromise;
  const root = siteRoot();
  const require = createRequire(import.meta.url);
  const global = globalThis as unknown as { window?: unknown; RotorKeyTools?: KeyToolsApi };
  if (!global.window) global.window = globalThis;
  require(path.join(root, 'chains.generated.js'));
  const api = require(path.join(root, 'key-tools.js')) as KeyToolsApi;
  toolsPromise = api;
  return api;
}

function doubleSha256(bytes: Uint8Array): Promise<Uint8Array> {
  return Promise.resolve(createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest());
}

function pageFactDisplay(fact: KeyFact): KeyFact {
  if (fact.id !== 'page' || !fact.value) return fact;
  const match = String(fact.value).match(/\/(\d+)\/?$/);
  const number = (match ? match[1] : '1').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return {
    ...fact,
    valueHref: fact.valueHref || fact.value,
    displayValue: `Page ${number}`,
  };
}

function mergeFacts(primary: KeyFact[], secondary: KeyFact[]): KeyFact[] {
  const left = new Map(primary.map((fact) => [fact.id, fact]));
  const right = new Map(secondary.map((fact) => [fact.id, fact]));
  const ids = [...new Set([...left.keys(), ...right.keys()])];
  const ordered = [
    ...FACT_ORDER.filter((id) => ids.includes(id)),
    ...ids.filter((id) => !(FACT_ORDER as readonly string[]).includes(id)),
  ];
  return ordered.map((id) => {
    const a = left.get(id);
    const b = right.get(id);
    if (!a) return b as KeyFact;
    if (!b) return a;
    const preferRight = ED_PREFERRED.has(id);
    const first = preferRight ? b : a;
    const second = preferRight ? a : b;
    const chosen = first.value ? first : second.value ? second : first;
    return chosen;
  });
}

function pointFacts(report: DeriveReport | null): KeyFact[] {
  if (!report) return [];
  const rows: KeyFact[] = [
    { id: 'point-compressed', label: 'Compressed', value: report.pubkey_compressed },
    { id: 'point-uncompressed', label: 'Uncompressed', value: report.pubkey_uncompressed },
    { id: 'point-x', label: 'X', value: report.x },
    { id: 'point-y', label: 'Y', value: report.y },
  ];
  const present = rows.filter((fact) => Boolean(fact.value));
  if (present.length === 0 && report.ed_pubkey) {
    return [{ id: 'point-ed25519', label: 'ed25519', value: report.ed_pubkey }];
  }
  return present;
}

interface SsotChain {
  name: string;
  symbol: string;
  icon: string;
}

function chainFor(id: string): { chain: string; slug: string; provider: string; ticker: string; icon: string } {
  loadKeyTools();
  const ssot = (globalThis as unknown as {
    RotorChains?: { bySlug?: Record<string, SsotChain> };
  }).RotorChains;
  const slug = rowSlug(id);
  const meta = slug && ssot?.bySlug ? ssot.bySlug[slug] : null;
  if (!meta) {
    return {
      chain: id.replace(/_/g, ' '),
      slug,
      provider: rowProvider(id),
      ticker: id.toUpperCase(),
      icon: 'ui-blockchain',
    };
  }
  return {
    chain: meta.name,
    slug,
    provider: rowProvider(id),
    ticker: meta.symbol,
    icon: meta.icon || `chain-${slug}`,
  };
}

function decorate(rows: MergedRow[]): AddressRow[] {
  const tools = loadKeyTools();
  const out: AddressRow[] = [];
  for (const row of rows) {
    if (!row?.id || !row.address) continue;
    const identity = chainFor(row.id);
    const shared = row.sharedEvm ? 'same' : row.sharedParent ? 'parent' : null;
    out.push({
      id: row.id,
      type: shared === 'same' ? '↑ same' : shared === 'parent' ? '' : tools.addressTypeLabel(row.id),
      chain: shared === 'parent' ? 'EVM' : identity.chain,
      slug: identity.slug,
      provider: shared === 'parent' ? '' : identity.provider,
      ticker: identity.ticker,
      icon: identity.icon,
      group: tools.rowGroup(row.id),
      explorer: tools.explorerFor(row.id),
      shared,
      address: row.address,
      curve: row.curve || 'secp256k1',
    });
  }
  return out;
}

export function modelFor(rows: AddressRow[]): KeyRowModel {
  /* The model carries contiguous group spans so the server and the island
   * render one chain cell per group with the same rowspan. */
  const modelRows: KeyRowMeta[] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    chain: row.chain,
    slug: row.slug,
    provider: row.provider,
    ticker: row.ticker,
    icon: row.icon,
    group: row.group,
    explorer: row.explorer,
    shared: row.shared,
  }));
  return { rows: modelRows };
}

function rowsFor(
  secp: DeriveReport | null,
  ed: DeriveReport | null,
  edRows: unknown[],
): AddressRow[] {
  const tools = loadKeyTools();
  const codecs = loadAddressCodecs();
  const extras = secp ? Object.values(codecs.derive(secp)) : [];
  const merged = tools.mergeCurveAddresses(secp, ed, { secp: extras, ed25519: edRows });
  const expanded = tools.expandEvmAddresses(merged, EVM_NETWORKS, 'EVM (shared 0x address)');
  return decorate(tools.orderAddressRows(expanded));
}

const CACHE = new Map<string, Promise<KeyPageData>>();

export function deriveKeyPage(hex: string): Promise<KeyPageData> {
  const cached = CACHE.get(hex);
  if (cached) return cached;
  const run = (async (): Promise<KeyPageData> => {
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`invalid 64-hex key: ${hex}`);
    const wasm: WasmExports = await loadWasm();
    let secp: DeriveReport | null = null;
    let secpError = '';
    try {
      secp = deriveReport(wasm, hex, 0);
    } catch (error) {
      secpError = error instanceof Error ? error.message : String(error);
    }
    let ed: DeriveReport | null = null;
    try {
      ed = deriveReport(wasm, hex, 1);
    } catch (error) {
      if (!secp) throw error;
    }
    const tools = loadKeyTools();
    const edFacts = ed ? await tools.buildKeyFacts(ed, doubleSha256) : [];
    const secpFacts = secp ? await tools.buildKeyFacts(secp, doubleSha256) : [];
    const facts = mergeFacts(secpFacts, edFacts).map(pageFactDisplay);
    const extras = pointFacts(secp);
    /* `mergeCurveAddresses` filters the ed25519 report through its
     * ED25519_ONLY_IDS list, so the TON ids must stay listed there. */
    const rows = rowsFor(secp, ed, []);
    if (rows.length === 0) throw new Error(`no address rows for ${hex}`);
    return { hex, facts, extras, rows, model: modelFor(rows), secpError };
  })();
  CACHE.set(hex, run);
  return run;
}
