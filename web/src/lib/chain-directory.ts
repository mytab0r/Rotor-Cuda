/* Build-time derivation for the `/private-keys/<chain>` directory pages.
 *
 * The rows are examples, not a wallet: keys 1..60 are the publicly known
 * small integers, so anyone can reproduce every address. The crypto stays in
 * the existing Rust/WASM core (`rotor_wasm.wasm`, `derive_report`); this module
 * only maps the report ids to the formats a chain page shows. Bitcoin Cash
 * CashAddr reuses the existing browser encoder in
 * `apps/site/address-codecs.js`; there is no second address implementation.
 *
 * This module runs in Node at Astro build time. It is not imported by the
 * page's browser script. */
import { loadAddressCodecs } from './address-codecs.js';
import {
  bytesToHex,
  deriveReport as wasmDeriveReport,
  loadWasm,
  type Curve,
  type DeriveReport,
} from './wasm-core.js';

export const KEYS_PER_PAGE = 60;

export type { Curve, DeriveReport };

export interface FormatSpec {
  /** Stable id used by the table and tests. */
  id: string;
  /** Human label rendered in the Format column. */
  label: string;
  /** Curve passed to the WASM report: 0 secp256k1, 1 ed25519. */
  curve: Curve;
  /** Report address id, or `cashaddr` for the derived BCH encoding. */
  addressId: string;
}

export interface DirectoryRow {
  keyHex: string;
  formatId: string;
  formatLabel: string;
  address: string;
}

const EVM: FormatSpec = {
  id: 'evm',
  label: 'EVM 0x (EIP-55)',
  curve: 0,
  addressId: 'evm',
};

const BITCOIN_FORMATS: FormatSpec[] = [
  { id: 'btc_p2pkh', label: 'P2PKH legacy (1…)', curve: 0, addressId: 'btc_p2pkh' },
  { id: 'btc_p2sh_p2wpkh', label: 'P2SH-P2WPKH nested (3…)', curve: 0, addressId: 'btc_p2sh_p2wpkh' },
  { id: 'btc_p2wpkh', label: 'P2WPKH native (bc1q…)', curve: 0, addressId: 'btc_p2wpkh' },
  { id: 'btc_p2tr', label: 'P2TR taproot (bc1p…)', curve: 0, addressId: 'btc_p2tr' },
];

const LITECOIN_FORMATS: FormatSpec[] = [
  { id: 'ltc_p2pkh', label: 'P2PKH legacy (L…)', curve: 0, addressId: 'ltc_p2pkh' },
  { id: 'ltc_p2sh_p2wpkh', label: 'P2SH-P2WPKH nested (M…)', curve: 0, addressId: 'ltc_p2sh_p2wpkh' },
  { id: 'ltc_p2wpkh', label: 'P2WPKH native (ltc1q…)', curve: 0, addressId: 'ltc_p2wpkh' },
  { id: 'ltc_p2tr', label: 'P2TR taproot (ltc1p…)', curve: 0, addressId: 'ltc_p2tr' },
];

const FORMATS: Record<string, FormatSpec[]> = {
  bitcoin: BITCOIN_FORMATS,
  ethereum: [EVM],
  bnb: [EVM],
  arbitrum: [EVM],
  optimism: [EVM],
  base: [EVM],
  polygon: [EVM],
  avalanche: [EVM],
  zksync: [EVM],
  solana: [{ id: 'solana', label: 'ed25519 base58', curve: 1, addressId: 'solana' }],
  tron: [{ id: 'tron', label: 'TRON Base58Check (T…)', curve: 0, addressId: 'tron' }],
  xrp: [{ id: 'xrp_classic', label: 'XRP classic (r…)', curve: 0, addressId: 'xrp_classic' }],
  litecoin: LITECOIN_FORMATS,
  'bitcoin-cash': [
    { id: 'bch_legacy', label: 'Legacy P2PKH (1…)', curve: 0, addressId: 'bch_legacy' },
    { id: 'bch_cashaddr', label: 'CashAddr (bitcoincash:q…)', curve: 0, addressId: 'cashaddr' },
  ],
  dogecoin: [{ id: 'doge_p2pkh', label: 'P2PKH legacy (D…)', curve: 0, addressId: 'doge_p2pkh' }],
  zcash: [{ id: 'zcash_p2pkh', label: 'Transparent P2PKH (t1…)', curve: 0, addressId: 'zcash_p2pkh' }],
  sui: [{ id: 'sui', label: 'Sui account (0x…)', curve: 1, addressId: 'sui' }],
  ton: [{ id: 'ton_w5', label: 'TON wallet W5 (base64url)', curve: 1, addressId: 'ton_w5' }],
};

export function formatsFor(slug: string): FormatSpec[] {
  const formats = FORMATS[slug];
  if (!formats) throw new Error(`no address formats configured for chain "${slug}"`);
  return formats;
}

function exampleKey(index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 1) throw new Error(`invalid example key index ${index}`);
  const key = new Uint8Array(32);
  let value = BigInt(index);
  for (let at = 31; at >= 0 && value > 0n; at -= 1) {
    key[at] = Number(value & 0xffn);
    value >>= 8n;
  }
  return key;
}

function addressFor(report: DeriveReport, format: FormatSpec): string {
  if (format.addressId === 'cashaddr') {
    const legacy = report.addresses.find((entry) => entry.id === 'bch_legacy');
    const hash160 = legacy?.steps?.hash160;
    if (!hash160) throw new Error('BCH report has no legacy hash160 step');
    return loadAddressCodecs().cashaddr(hash160, 0);
  }
  const entry = report.addresses.find((item) => item.id === format.addressId);
  if (!entry || !entry.address) {
    throw new Error(`wasm report has no address "${format.addressId}" for ${report.curve}`);
  }
  return entry.address;
}

/* Rows are emitted key-major so the first 60 rows of a multi-format chain still
 * cover 60 distinct keys; page 1 keeps every format for every key. */
export async function deriveDirectoryRows(slug: string, count = KEYS_PER_PAGE): Promise<DirectoryRow[]> {
  const formats = formatsFor(slug);
  const wasm = await loadWasm();
  const rows: DirectoryRow[] = [];
  for (let index = 1; index <= count; index += 1) {
    const key = exampleKey(index);
    const hex = bytesToHex(key);
    const reports = new Map<Curve, DeriveReport>();
    for (const format of formats) {
      let report = reports.get(format.curve);
      if (!report) {
        report = wasmDeriveReport(wasm, hex, format.curve);
        reports.set(format.curve, report);
      }
      rows.push({
        keyHex: hex,
        formatId: format.id,
        formatLabel: format.label,
        address: addressFor(report, format),
      });
    }
  }
  return rows;
}
