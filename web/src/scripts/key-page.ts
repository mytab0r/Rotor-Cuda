/* The /key island: derive a 64-hex private key into the donor fact set and the
 * 30-row address table.
 *
 * The page is server-rendered for a known key, so this script does nothing on
 * first paint. It runs when the input changes or when a worker-injected
 * `#key-request` JSON block asks for a key. Crypto stays in the existing WASM
 * core and the existing browser helpers:
 *   - /rotor_wasm.wasm          derive_report (secp256k1 + ed25519)
 *   - /address-codecs.js        BCH CashAddr, uncompressed DOGE/ZEC views
 *   - /key-tools.js             the donor fact set and the row order
 *   - /ton.js                   TON v4R2 (the WASM report carries W5 only)
 * The helpers are loaded only after the first derivation request, so the
 * prerendered page loads no derivation code. The key never enters storage,
 * logs or a network request. */

import './chain-copy.js';
import { EVM_NETWORKS, type KeyRowMeta } from '../lib/key-model.js';

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

interface ReportShape {
  curve?: string;
  priv_hex?: string;
  priv_dec?: string;
  pubkey_compressed?: string;
  pubkey_uncompressed?: string;
  x?: string;
  y?: string;
  ed_pubkey?: string;
  addresses?: ReportAddress[];
}

interface KeyFact {
  id: string;
  label: string;
  value?: string;
  unavailable?: string;
  href?: string;
  valueHref?: string;
  displayValue?: string;
}

interface KeyToolsApi {
  buildKeyFacts(report: unknown, doubleSha256: (bytes: Uint8Array) => Promise<Uint8Array>): Promise<KeyFact[]>;
  mergeCurveAddresses(secp: unknown, ed: unknown, extras: { secp: unknown[]; ed25519: unknown[] }): MergedRow[];
  expandEvmAddresses(
    rows: MergedRow[],
    networks: ReadonlyArray<{ id: string; label: string }>,
    parentLabel: string,
  ): MergedRow[];
  orderAddressRows(rows: MergedRow[]): MergedRow[];
}

interface AddressCodecs {
  derive(report: unknown): Record<string, ReportAddress>;
}

interface TonApi {
  address(edPubkeyHex: string): Promise<string>;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  alloc(length: number): number;
  dealloc(pointer: number, length: number): void;
  derive_report(pointer: number, curve: number): number;
  result_ptr(): number;
  result_len(): number;
  error_ptr(): number;
  error_len(): number;
}

interface RotorWindow extends Window {
  RotorKeyTools?: KeyToolsApi;
  RotorAddressCodecs?: AddressCodecs;
  RotorTon?: TonApi;
}

const BUILD_ID = document.documentElement.getAttribute('data-build');
const asset = (path: string): string => (BUILD_ID ? `/a/${BUILD_ID}${path}` : path);
const WASM_URL = asset('/rotor_wasm.wasm');
const DECODER = new TextDecoder('utf-8');
const AUTO_MS = 220;
const FACT_ORDER = ['hex', 'decimal', 'wif', 'wif_u', 'keypair', 'xrp', 'pubkey', 'page'] as const;
const ED_PREFERRED = new Set(['keypair']);

const root = window as RotorWindow;
const form = document.getElementById('key-form') as HTMLFormElement | null;
const input = document.getElementById('priv') as HTMLInputElement | null;
const statusEl = document.getElementById('key-status');
const statusText = document.getElementById('key-status-text');
const factsEl = document.getElementById('key-facts');
const extrasEl = document.querySelector<HTMLElement>('.key-facts--extra');
const rowsEl = document.getElementById('addr-rows');
const modelEl = document.getElementById('key-row-model');
const requestEl = document.getElementById('key-request');

let modelRows: KeyRowMeta[] = [];
try {
  const parsed = modelEl ? (JSON.parse(modelEl.textContent || '{}') as { rows?: KeyRowMeta[] }) : {};
  modelRows = Array.isArray(parsed.rows) ? parsed.rows : [];
} catch {
  modelRows = [];
}
const modelById = new Map(modelRows.map((row) => [row.id, row]));

let wasmPromise: Promise<WasmExports> | null = null;
let depsPromise: Promise<KeyToolsApi> | null = null;
let tonPromise: Promise<TonApi> | null = null;
let timer = 0;
let sequence = 0;

function setStatus(state: string, message: string): void {
  if (!statusEl || !statusText) return;
  statusEl.className = `key-input-status is-${state}`;
  statusText.textContent = message;
}

function fail(message: string): void {
  if (input) input.setAttribute('aria-invalid', 'true');
  setStatus('invalid', message);
}

function loadWasm(): Promise<WasmExports> {
  if (wasmPromise) return wasmPromise;
  wasmPromise = (async () => {
    const response = await fetch(WASM_URL);
    if (!response.ok) throw new Error(`Cannot load the derivation core: HTTP ${response.status}`);
    let module: { instance: WebAssembly.Instance };
    try {
      module = await WebAssembly.instantiateStreaming(response.clone(), {});
    } catch {
      module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    }
    return module.instance.exports as unknown as WasmExports;
  })();
  wasmPromise.catch(() => {
    wasmPromise = null;
  });
  return wasmPromise;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Cannot load ${src}`));
    document.head.appendChild(script);
  });
}

function loadDeps(): Promise<KeyToolsApi> {
  if (root.RotorKeyTools && root.RotorAddressCodecs) return Promise.resolve(root.RotorKeyTools);
  if (depsPromise) return depsPromise;
  depsPromise = (async () => {
    if (!root.RotorAddressCodecs) await loadScript(asset('/address-codecs.js'));
    if (!root.RotorKeyTools) await loadScript(asset('/key-tools.js'));
    if (!root.RotorKeyTools || !root.RotorAddressCodecs) {
      throw new Error('The derivation helpers did not initialise.');
    }
    return root.RotorKeyTools;
  })();
  depsPromise.catch(() => {
    depsPromise = null;
  });
  return depsPromise;
}

function loadTon(): Promise<TonApi> {
  if (root.RotorTon) return Promise.resolve(root.RotorTon);
  if (tonPromise) return tonPromise;
  tonPromise = loadScript(asset('/ton.js')).then(() => {
    if (!root.RotorTon) throw new Error('The TON helper did not initialise.');
    return root.RotorTon;
  });
  tonPromise.catch(() => {
    tonPromise = null;
  });
  return tonPromise;
}

function reportOf(wasm: WasmExports, key: Uint8Array, curve: number): unknown {
  const pointer = wasm.alloc(key.length) >>> 0;
  if (!pointer) throw new Error('wasm alloc returned 0');
  try {
    new Uint8Array(wasm.memory.buffer, pointer, key.length).set(key);
    const status = wasm.derive_report(pointer, curve) >>> 0;
    if (status !== 0) {
      const message = DECODER.decode(
        new Uint8Array(wasm.memory.buffer, wasm.error_ptr(), wasm.error_len()),
      );
      throw new Error(message || `derive_report failed (${status})`);
    }
    return JSON.parse(
      DECODER.decode(new Uint8Array(wasm.memory.buffer, wasm.result_ptr(), wasm.result_len())),
    );
  } finally {
    wasm.dealloc(pointer, key.length);
  }
}

function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return crypto.subtle.digest('SHA-256', bytes as BufferSource).then((digest) => new Uint8Array(digest));
}

function doubleSha256(bytes: Uint8Array): Promise<Uint8Array> {
  return sha256(bytes).then((first) => sha256(first));
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
    return first.value ? first : second.value ? second : first;
  });
}

function pageFact(fact: KeyFact): KeyFact {
  if (fact.id !== 'page' || !fact.value) return fact;
  const match = String(fact.value).match(/\/(\d+)\/?$/);
  return {
    ...fact,
    valueHref: fact.valueHref || fact.value,
    displayValue: `Page ${match ? match[1] : '1'}`,
  };
}

function setFact(fact: KeyFact): void {
  if (!factsEl) return;
  const row = factsEl.querySelector<HTMLElement>(`[data-fact="${fact.id}"]`);
  if (!row) return;
  const dd = row.querySelector('dd');
  if (!dd) return;
  dd.textContent = '';
  if (fact.unavailable) {
    const span = document.createElement('span');
    span.className = 'key-fact-unavailable';
    span.textContent = fact.unavailable;
    dd.appendChild(span);
  } else if (fact.valueHref) {
    const link = document.createElement('a');
    link.className = 'key-fact-value key-fact-link';
    link.href = fact.valueHref;
    link.textContent = fact.displayValue || fact.value || '';
    dd.appendChild(link);
  } else {
    const code = document.createElement('code');
    code.className = 'key-fact-value';
    code.tabIndex = 0;
    code.textContent = fact.value || '';
    dd.appendChild(code);
  }
  const copy = row.querySelector<HTMLButtonElement>('button[data-copy]');
  if (copy) {
    const copyable = Boolean(fact.value) && !fact.valueHref && !fact.unavailable;
    copy.hidden = !copyable;
    if (copyable) copy.dataset.copy = fact.value;
  }
}

function renderExtras(extras: KeyFact[]): void {
  if (!extrasEl) return;
  extrasEl.textContent = '';
  for (const fact of extras) {
    if (!fact.value) continue;
    const row = document.createElement('div');
    row.className = 'key-form-row key-fact-row';
    row.dataset.fact = fact.id;
    const dt = document.createElement('dt');
    const label = document.createElement('span');
    label.textContent = fact.label;
    dt.appendChild(label);
    const dd = document.createElement('dd');
    const code = document.createElement('code');
    code.className = 'key-fact-value';
    code.tabIndex = 0;
    code.textContent = fact.value;
    dd.appendChild(code);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'icon-button icon-button--quiet row-action';
    copy.dataset.copy = fact.value;
    copy.dataset.copyLabel = fact.label;
    copy.setAttribute('aria-label', `Copy ${fact.label} value`);
    copy.dataset.tooltip = `Copy ${fact.label}`;
    copy.appendChild(iconUse(asset('/icons.svg#ui-copy')));
    row.append(dt, dd, copy);
    extrasEl.appendChild(row);
  }
}

function iconUse(href: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', href);
  svg.appendChild(use);
  return svg;
}

function actionButton(row: MergedRow, meta: KeyRowMeta): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'icon-button icon-button--sm icon-button--quiet';
  copy.dataset.copy = row.address;
  copy.dataset.copyLabel = `${meta.chain} address`;
  copy.setAttribute('aria-label', `Copy ${meta.chain} address`);
  copy.dataset.tooltip = 'Copy address';
  copy.appendChild(iconUse(asset('/icons.svg#ui-copy')));
  wrap.appendChild(copy);
  if (meta.explorer) {
    const link = document.createElement('a');
    link.className = 'icon-button icon-button--sm icon-button--quiet';
    const address = encodeURIComponent(row.address);
    link.href = meta.explorer.includes('{address}')
      ? meta.explorer.replace('{address}', address)
      : `${meta.explorer}${address}`;
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Open the ${meta.chain} address in the explorer`);
    link.dataset.tooltip = 'Open in explorer';
    link.appendChild(iconUse(asset('/icons.svg#ui-external')));
    wrap.appendChild(link);
  }
  return wrap;
}

function renderRows(rows: MergedRow[]): void {
  if (!rowsEl) return;
  rowsEl.textContent = '';
  const present = rows
    .map((row) => ({ row, meta: modelById.get(row.id) }))
    .filter((entry): entry is { row: MergedRow; meta: KeyRowMeta } => Boolean(entry.meta && entry.row.address));
  const spans = new Map<number, number>();
  let runStart = -1;
  let runGroup = '';
  present.forEach((entry, index) => {
    if (entry.meta.group !== runGroup) {
      if (runStart >= 0) spans.set(runStart, index - runStart);
      runStart = index;
      runGroup = entry.meta.group;
    }
  });
  if (runStart >= 0) spans.set(runStart, present.length - runStart);

  present.forEach(({ row, meta }, index) => {
    const tr = document.createElement('tr');
    tr.className = 'key-row';
    tr.dataset.addressId = row.id;
    const span = spans.get(index);
    if (span) {
      const chainCell = document.createElement('td');
      chainCell.className = 'key-cell-chain';
      chainCell.rowSpan = span;
      const id = document.createElement('span');
      id.className = 'key-chain-id';
      id.appendChild(iconUse(asset(`/icons.svg#${meta.icon}`)));
      const name = document.createElement('span');
      name.textContent = meta.chain;
      id.appendChild(name);
      const ticker = document.createElement('span');
      ticker.className = 'key-chain-ticker';
      ticker.textContent = meta.ticker;
      chainCell.append(id, ticker);
      tr.appendChild(chainCell);
    }
    const type = document.createElement('td');
    type.className = 'key-cell-type';
    type.textContent = meta.type;
    const address = document.createElement('td');
    address.className = 'key-cell-addr';
    const code = document.createElement('code');
    code.className = 'key-addr';
    code.tabIndex = 0;
    code.textContent = row.address;
    address.appendChild(code);
    const status = document.createElement('td');
    status.className = 'key-cell-status';
    const dash = document.createElement('span');
    dash.className = 'muted';
    dash.textContent = '—';
    status.appendChild(dash);
    const actions = document.createElement('td');
    actions.className = 'key-cell-act';
    actions.appendChild(actionButton(row, meta));
    tr.append(type, address, status, actions);
    rowsEl.appendChild(tr);
  });
}

async function derive(hex: string, seq: number): Promise<void> {
  const tools = await loadDeps();
  if (seq !== sequence) return;
  const wasm = await loadWasm();
  if (seq !== sequence) return;
  const key = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    key[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  let secp: ReportShape | null = null;
  let secpError = '';
  try {
    secp = reportOf(wasm, key, 0) as ReportShape;
  } catch (error) {
    secpError = error instanceof Error ? error.message : String(error);
  }
  if (seq !== sequence) return;
  const ed = reportOf(wasm, key, 1) as ReportShape;
  if (seq !== sequence) return;

  const secpFacts = secp ? await tools.buildKeyFacts(secp, doubleSha256) : [];
  const edFacts = ed ? await tools.buildKeyFacts(ed, doubleSha256) : [];
  if (seq !== sequence) return;
  const facts = mergeFacts(secpFacts, edFacts).map(pageFact);
  for (const fact of facts) setFact(fact);

  const extras = secp ? (root.RotorAddressCodecs as AddressCodecs).derive(secp) : {};
  const pointFacts: KeyFact[] = secp
    ? [
        { id: 'point-compressed', label: 'Compressed', value: secp.pubkey_compressed },
        { id: 'point-uncompressed', label: 'Uncompressed', value: secp.pubkey_uncompressed },
        { id: 'point-x', label: 'X', value: secp.x },
        { id: 'point-y', label: 'Y', value: secp.y },
      ].filter((fact): fact is KeyFact & { value: string } => Boolean(fact.value))
    : ed?.ed_pubkey
      ? [{ id: 'point-ed25519', label: 'ed25519', value: ed.ed_pubkey }]
      : [];
  renderExtras(pointFacts);

  const merged = tools.mergeCurveAddresses(secp, ed, {
    secp: Object.values(extras),
    ed25519: [],
  });
  const expanded = tools.expandEvmAddresses(merged, EVM_NETWORKS, 'EVM (shared 0x address)');
  const ordered = tools.orderAddressRows(expanded);
  renderRows(ordered);
  setStatus(
    'derived',
    `${secpError ? 'Secp256k1 is out of range; showing ed25519 rows. ' : ''}Derived ${ordered.length} addresses from 0x${hex.slice(0, 8)}…${hex.slice(-4)}.`,
  );

  /* TON v4R2 is a large existing bundle; load it after the table is usable and
   * add the row when it answers. W5 already comes from the WASM report. */
  if (!secpError) {
    loadTon()
      .then((ton) => ton.address(ed.ed_pubkey || ''))
      .then((address) => {
        if (seq !== sequence || !address) return;
        const withTon = tools.mergeCurveAddresses(secp, ed, {
          secp: Object.values(extras),
          ed25519: [{ id: 'ton', label: 'TON wallet v4R2', address, steps: {}, curve: 'ed25519' }],
        });
        const finalRows = tools.orderAddressRows(tools.expandEvmAddresses(withTon, EVM_NETWORKS, 'EVM (shared 0x address)'));
        renderRows(finalRows);
        setStatus('derived', `Derived ${finalRows.length} addresses from 0x${hex.slice(0, 8)}…${hex.slice(-4)}.`);
      })
      .catch(() => {
        /* The rest of the table stays usable without the TON bundle. */
      });
  }
}

function normalize(raw: string): string | null {
  const value = raw.trim().replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function schedule(raw: string, immediate = false): void {
  window.clearTimeout(timer);
  const hex = normalize(raw);
  if (!hex) {
    if (!raw.trim()) {
      setStatus('idle', 'Enter a 64-hex private key to derive its addresses.');
    } else {
      fail('A private key is 64 hex characters (0–9, a–f); the 0x prefix is optional.');
    }
    return;
  }
  if (input) input.removeAttribute('aria-invalid');
  const run = (): void => {
    const seq = ++sequence;
    setStatus('deriving', `Deriving addresses from 0x${hex.slice(0, 8)}…${hex.slice(-4)}…`);
    derive(hex, seq).catch((error) => {
      if (seq !== sequence) return;
      fail(error instanceof Error ? error.message : String(error));
    });
  };
  if (immediate) run();
  else timer = window.setTimeout(run, AUTO_MS);
}

if (form) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (input) schedule(input.value, true);
  });
}
if (input) {
  input.addEventListener('input', () => schedule(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      schedule(input.value, true);
    }
  });
}

if (requestEl) {
  try {
    const request = JSON.parse(requestEl.textContent || '{}') as { hex?: string };
    const hex = normalize(String(request.hex || ''));
    if (hex && input) {
      input.value = hex;
      schedule(hex, true);
    }
  } catch {
    /* The worker only emits JSON; a malformed block leaves the static page. */
  }
}
