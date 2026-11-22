/* DOM glue for /mnemonic-converter. TypeScript port of apps/site/seed-page.js;
 * the derivation itself lives in ../lib/seed-core.ts and the vendored crypto
 * scripts. The phrase, passphrase, seed and keys stay in this tab. Only public
 * addresses are sent, automatically after a derivation. */

import {
  ADDRESS_COUNTS,
  BTC_BALANCE_URL,
  CHAIN_ORDER,
  CHAINS,
  DerivationCancelled,
  LOAD_BATCH,
  coin,
  countWords,
  csvText,
  deriveEntries,
  deriveMore,
  normalizePhrase,
  phraseHint,
  schemeForPhrase,
  type ChainConfig,
  type DerivationResult,
  type DerivationSnapshot,
  type SeedScheme,
  type WasmExports,
} from '../lib/seed-core.js';

/* The shared layout stamps the build id on <html>; the post-build step emits
 * the same file under /a/<build>/. Fall back to the bare path in dev. */
const BUILD_ID = document.documentElement.getAttribute('data-build');
const WASM_URL = BUILD_ID ? `/a/${BUILD_ID}/rotor_wasm.wasm` : '/rotor_wasm.wasm';
const BALANCE_TIMEOUT_MS = 12000;
const EVM_RPC = 'https://ethereum-rpc.publicnode.com';

interface RowResult extends DerivationResult {
  balanceEl: HTMLElement | null;
  rowEl: HTMLElement | null;
  balanceValue: bigint | null;
  balanceUnit: string;
}

interface Group {
  section: HTMLElement;
  list: HTMLElement;
  meta: HTMLElement;
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

const form = byId<HTMLFormElement>('seed-form');
if (form) {
  boot();
}

function boot(): void {
  if (!form) return;

  const schemeEl = byId<HTMLSelectElement>('seed-scheme');
  const wordsEl = byId<HTMLSelectElement>('seed-words');
  const chainEl = byId<HTMLSelectElement>('seed-chain');
  const pathEl = byId<HTMLSelectElement>('seed-path');
  const allPathsEl = byId<HTMLInputElement>('seed-all-paths');
  const phraseEl = byId<HTMLTextAreaElement>('seed-phrase');
  const passphraseEl = byId<HTMLInputElement>('seed-passphrase');
  const errorEl = byId<HTMLElement>('seed-error');
  const statusEl = byId<HTMLElement>('seed-status');
  const helpEl = byId<HTMLElement>('seed-scheme-help');
  const resultEl = byId<HTMLElement>('seed-result');
  const rowsEl = byId<HTMLElement>('seed-rows');
  const countEl = byId<HTMLElement>('seed-count');
  const csvBtn = byId<HTMLButtonElement>('seed-csv');
  const copyAllBtn = byId<HTMLButtonElement>('seed-copy-all');
  const loadMoreBtn = byId<HTMLButtonElement>('seed-load-more');
  const aggregateEl = byId<HTMLElement>('seed-aggregate');
  const wordCountEl = byId<HTMLElement>('seed-word-count');
  const deriveBtn = byId<HTMLButtonElement>('seed-derive');
  const generateBtn = byId<HTMLButtonElement>('seed-generate');
  const clearBtn = byId<HTMLButtonElement>('seed-clear');
  const countButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.seed-count-btn'));

  const state: {
    wasmPromise: Promise<WasmExports> | null;
    busy: boolean;
    count: number;
    results: RowResult[];
    run: number;
    balanceAbort: AbortController | null;
    snapshot: DerivationSnapshot | null;
    groupIndex: Record<string, Group> | null;
  } = {
    wasmPromise: null,
    busy: false,
    count: 1,
    results: [],
    run: 0,
    balanceAbort: null,
    snapshot: null,
    groupIndex: null,
  };
  let wordRun = 0;

  function fail(message: string): void {
    if (!errorEl) return;
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  function note(message: string, isError?: boolean): void {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('err', Boolean(isError));
  }

  async function loadWasm(): Promise<WasmExports> {
    if (state.wasmPromise) return state.wasmPromise;
    state.wasmPromise = (async () => {
      const response = await fetch(WASM_URL);
      if (!response.ok) throw new Error('Cannot load the derivation core: HTTP ' + response.status);
      let module: { instance: WebAssembly.Instance };
      try {
        module = await WebAssembly.instantiateStreaming(response.clone(), {});
      } catch {
        module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      }
      return module.instance.exports as unknown as WasmExports;
    })();
    state.wasmPromise.catch(() => {
      state.wasmPromise = null;
    });
    return state.wasmPromise;
  }

  /* ------------------------------------------------------------- controls */

  function schemeValue(): SeedScheme {
    const value = schemeEl ? schemeEl.value : 'bip39';
    return value === 'electrum-bip39' || value === 'electrum-old' ? value : 'bip39';
  }

  function currentChain(): string {
    return chainEl ? chainEl.value : 'bitcoin';
  }

  function populateChains(): void {
    if (!chainEl) return;
    const previous = chainEl.value;
    chainEl.textContent = '';
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = 'All supported chains';
    chainEl.appendChild(all);
    for (const id of CHAIN_ORDER) {
      const config: ChainConfig | undefined = CHAINS[id];
      if (!config) continue;
      const option = document.createElement('option');
      option.value = id;
      option.textContent = config.label;
      chainEl.appendChild(option);
    }
    chainEl.value = previous && (previous === 'all' || CHAINS[previous]) ? previous : 'all';
  }

  function populatePaths(): void {
    if (!pathEl) return;
    const previous = pathEl.value;
    pathEl.textContent = '';
    const scheme = schemeValue();
    const chain = currentChain();
    if (scheme === 'electrum-old') {
      const old = document.createElement('option');
      old.value = 'old';
      old.textContent = 'Old sequence';
      pathEl.appendChild(old);
      pathEl.disabled = true;
      return;
    }
    if (chain === 'all') {
      const defaults = document.createElement('option');
      defaults.value = '';
      defaults.textContent = 'Default per chain';
      pathEl.appendChild(defaults);
      pathEl.disabled = true;
      return;
    }
    pathEl.disabled = false;
    const presets = CHAINS[chain] ? CHAINS[chain]?.presets ?? [] : [];
    for (const preset of presets) {
      const option = document.createElement('option');
      option.value = preset.path + '|' + preset.id;
      option.textContent = preset.label + ' · ' + preset.path;
      pathEl.appendChild(option);
    }
    const found = Array.from(pathEl.options).some((option) => option.value === previous);
    if (!found && pathEl.options.length) pathEl.selectedIndex = 0;
  }

  function refreshControls(): void {
    const scheme = schemeValue();
    const old = scheme === 'electrum-old';

    if (wordsEl) {
      for (const option of Array.from(wordsEl.options)) {
        option.disabled = old && [15, 18, 21].indexOf(Number(option.value)) >= 0;
      }
      if (old && [12, 24].indexOf(Number(wordsEl.value)) < 0) wordsEl.value = '12';
    }
    if (passphraseEl) {
      passphraseEl.disabled = old;
      if (old) passphraseEl.value = '';
    }
    if (chainEl) chainEl.disabled = old;
    if (allPathsEl) allPathsEl.disabled = old;
    if (old && chainEl) chainEl.value = 'bitcoin';
    populatePaths();

    if (helpEl) {
      if (old) {
        helpEl.textContent =
          'Electrum old: the legacy 1626-word list. The words decode to a hex seed; the master key is 100,000 SHA-256 rounds, and each address uses Electrum\'s old sequence scheme. It has no BIP39 passphrase.';
      } else if (scheme === 'electrum-bip39') {
        helpEl.textContent =
          'Electrum BIP39: BIP39 words checked against Electrum\'s seed-version prefix (01 standard, 100 segwit). The master seed is PBKDF2-HMAC-SHA512 with the salt "electrum" and the optional passphrase, then BIP32 along the selected path.';
      } else {
        helpEl.textContent =
          'BIP39: the phrase checksum is validated, and the master seed is PBKDF2-HMAC-SHA512 with the salt "mnemonic" and the optional passphrase, then BIP32 along the selected path.';
      }
    }
    updateWordCount();
  }

  function setCount(value: number): void {
    state.count = value;
    for (const button of countButtons) {
      const active = Number(button.getAttribute('data-count')) === value;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function invalidate(): void {
    state.run += 1;
    state.busy = false;
    state.results = [];
    state.snapshot = null;
    state.groupIndex = null;
    if (state.balanceAbort) {
      try {
        state.balanceAbort.abort();
      } catch {
        /* already aborted */
      }
      state.balanceAbort = null;
    }
    if (rowsEl) rowsEl.textContent = '';
    if (resultEl) resultEl.hidden = true;
    if (csvBtn) csvBtn.hidden = true;
    if (copyAllBtn) copyAllBtn.hidden = true;
    if (loadMoreBtn) {
      loadMoreBtn.hidden = true;
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load next 5';
    }
    if (aggregateEl) {
      aggregateEl.hidden = true;
      aggregateEl.textContent = '';
    }
    if (countEl) countEl.textContent = '';
    if (deriveBtn) {
      deriveBtn.disabled = false;
      deriveBtn.textContent = 'Convert & derive';
    }
    if (generateBtn) generateBtn.disabled = false;
  }

  /* ----------------------------------------------------------- phrase UI */

  function updateWordCount(): void {
    if (!wordCountEl) return;
    const text = phraseEl ? phraseEl.value : '';
    const count = countWords(text);
    const prefix = count + ' word' + (count === 1 ? '' : 's');
    wordCountEl.textContent = prefix;
    wordRun += 1;
    const run = wordRun;
    phraseHint(text, schemeValue()).then(
      (hint) => {
        if (run !== wordRun) return;
        wordCountEl.textContent = prefix + ' · ' + hint;
      },
      () => {
        if (run !== wordRun) return;
        wordCountEl.textContent = prefix;
      },
    );
  }

  /* ------------------------------------------------------------- deriving */

  async function deriveAll(): Promise<void> {
    if (state.busy) return;
    fail('');
    if (!window.RotorSeed || !window.RotorSeedCrypto) {
      fail('The seed libraries did not load. Reload the page.');
      return;
    }
    const phrase = normalizePhrase(phraseEl ? phraseEl.value : '');
    if (!phrase) {
      fail('Paste a mnemonic first.');
      if (phraseEl) phraseEl.focus();
      return;
    }

    invalidate();
    state.busy = true;
    state.run += 1;
    const run = state.run;
    if (deriveBtn) deriveBtn.disabled = true;
    if (generateBtn) generateBtn.disabled = true;
    if (loadMoreBtn) loadMoreBtn.disabled = true;
    if (deriveBtn) deriveBtn.textContent = 'Deriving…';
    note('Validating the phrase locally…');

    try {
      const wasm = await loadWasm();
      const outcome = await deriveEntries({
        phrase,
        passphrase: passphraseEl ? passphraseEl.value : '',
        scheme: schemeValue(),
        chain: currentChain(),
        pathValue: pathEl ? pathEl.value : '',
        allPaths: Boolean(allPathsEl && allPathsEl.checked),
        count: state.count,
        wasm,
        isCurrent: () => run === state.run,
        onProgress: (done, total) => {
          if (done === total || done % 5 === 0) note('Deriving ' + done + ' of ' + total + '…');
        },
      });
      if (run !== state.run) return;

      state.results = outcome.rows.map(toRowResult);
      state.snapshot = outcome.snapshot;
      renderGroups(state.results);
      const versions: Record<string, string> = {
        bip39: 'BIP39',
        standard: 'Electrum standard (seed version 01)',
        segwit: 'Electrum segwit (seed version 100)',
        old: 'Electrum old (1626-word legacy scheme)',
      };

      note(
        'Derived ' +
          outcome.rows.length +
          ' address' +
          (outcome.rows.length === 1 ? '' : 'es') +
          '. Seed type: ' +
          versions[outcome.info.seedType] +
          '. Checking public balances…',
      );
      await checkBalances();
    } catch (error) {
      if (error instanceof DerivationCancelled) return;
      if (run === state.run) {
        state.results = [];
        state.snapshot = null;
        state.groupIndex = null;
        if (rowsEl) rowsEl.textContent = '';
        if (copyAllBtn) copyAllBtn.hidden = true;
        if (loadMoreBtn) loadMoreBtn.hidden = true;
        if (aggregateEl) aggregateEl.hidden = true;
        fail(error instanceof Error ? error.message : 'Derivation failed.');
        note('Nothing was derived. The phrase stays in this tab.', true);
      }
    } finally {
      if (run === state.run) {
        state.busy = false;
        if (deriveBtn) deriveBtn.disabled = false;
        if (generateBtn) generateBtn.disabled = false;
        if (deriveBtn) deriveBtn.textContent = 'Convert & derive';
        if (loadMoreBtn) {
          loadMoreBtn.disabled = false;
          loadMoreBtn.textContent = 'Load next 5';
          loadMoreBtn.hidden = !state.snapshot || state.results.length === 0;
        }
      }
    }
  }

  async function loadNextBatch(): Promise<void> {
    const snapshot = state.snapshot;
    if (!snapshot || state.busy || !state.results.length) return;
    if (!window.RotorSeedCrypto) {
      fail('The seed libraries did not load. Reload the page.');
      return;
    }
    fail('');
    state.busy = true;
    const run = state.run;
    if (loadMoreBtn) {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = 'Loading…';
    }
    if (deriveBtn) deriveBtn.disabled = true;
    if (generateBtn) generateBtn.disabled = true;
    note('Deriving ' + LOAD_BATCH + ' more address' + (LOAD_BATCH === 1 ? '' : 'es') + ' per path…');

    try {
      const wasm = await loadWasm();
      const outcome = await deriveMore(snapshot, LOAD_BATCH, {
        wasm,
        isCurrent: () => run === state.run,
      });
      if (run !== state.run) return;
      snapshot.nextIndex += LOAD_BATCH;
      snapshot.oldKeys = outcome.oldKeys;
      const added = outcome.rows.map(toRowResult);
      state.results = state.results.concat(added);
      appendResults(added);
      updateResultSummary();
      note(
        'Added ' +
          added.length +
          ' address' +
          (added.length === 1 ? '' : 'es') +
          '. Checking public balances…',
      );
      await checkBalances(added);
    } catch (error) {
      if (error instanceof DerivationCancelled) return;
      if (run === state.run) {
        fail(error instanceof Error ? error.message : 'Could not load more addresses.');
        note('The extra addresses were not added. The phrase stays in this tab.', true);
      }
    } finally {
      if (run === state.run) {
        state.busy = false;
        if (deriveBtn) deriveBtn.disabled = false;
        if (generateBtn) generateBtn.disabled = false;
        if (loadMoreBtn) {
          loadMoreBtn.disabled = false;
          loadMoreBtn.textContent = 'Load next 5';
          loadMoreBtn.hidden = !state.snapshot || state.results.length === 0;
        }
      }
    }
  }

  function toRowResult(row: DerivationResult): RowResult {
    return { ...row, balanceEl: null, rowEl: null, balanceValue: null, balanceUnit: '' };
  }

  /* ------------------------------------------------------------ rendering */

  function makeGroupSection(label: string): Group {
    const section = document.createElement('section');
    section.className = 'seed-group';
    const head = document.createElement('div');
    head.className = 'seed-group-head';
    const title = document.createElement('h3');
    title.textContent = label;
    const meta = document.createElement('span');
    head.appendChild(title);
    head.appendChild(meta);
    section.appendChild(head);
    const list = document.createElement('div');
    list.className = 'seed-rows';
    section.appendChild(list);
    return { section, list, meta };
  }

  function updateGroupMeta(group: Group): void {
    const entries = group.list.children.length;
    group.meta.textContent = entries + ' address' + (entries === 1 ? '' : 'es');
  }

  function updateResultSummary(): void {
    const total = state.results.length;
    const groups = state.groupIndex ? Object.keys(state.groupIndex).length : 0;
    if (countEl) {
      countEl.textContent =
        total +
        ' address' +
        (total === 1 ? '' : 'es') +
        ' · ' +
        groups +
        ' group' +
        (groups === 1 ? '' : 's');
    }
    if (resultEl) resultEl.hidden = total === 0;
    if (csvBtn) csvBtn.hidden = total === 0;
    if (copyAllBtn) copyAllBtn.hidden = total === 0;
    if (loadMoreBtn) loadMoreBtn.hidden = total === 0 || !state.snapshot;
  }

  function renderGroups(results: RowResult[]): void {
    if (!rowsEl) return;
    rowsEl.textContent = '';
    state.groupIndex = Object.create(null) as Record<string, Group>;
    const order: Group[] = [];
    for (const entry of results) {
      const index = state.groupIndex;
      let group = index[entry.chainLabel];
      if (!group) {
        group = makeGroupSection(entry.chainLabel);
        index[entry.chainLabel] = group;
        order.push(group);
      }
      group.list.appendChild(rowFor(entry));
    }
    for (const group of order) {
      updateGroupMeta(group);
      rowsEl.appendChild(group.section);
    }
    updateResultSummary();
    if (resultEl && resultEl.scrollIntoView) {
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function appendResults(entries: RowResult[]): void {
    if (!rowsEl || !entries.length) return;
    if (!state.groupIndex) state.groupIndex = Object.create(null) as Record<string, Group>;
    const index = state.groupIndex;
    for (const entry of entries) {
      let group = index[entry.chainLabel];
      if (!group) {
        group = makeGroupSection(entry.chainLabel);
        index[entry.chainLabel] = group;
        rowsEl.appendChild(group.section);
      }
      group.list.appendChild(rowFor(entry));
      updateGroupMeta(group);
    }
    updateResultSummary();
  }

  function rowFor(entry: RowResult): HTMLElement {
    const row = document.createElement('div');
    row.className = 'seed-row';

    const head = document.createElement('div');
    head.className = 'seed-row-head seed-row-title';
    const title = document.createElement('h4');
    title.textContent = entry.presetLabel;
    const path = document.createElement('span');
    path.className = 'seed-path mono';
    path.textContent = entry.path;
    head.appendChild(title);
    head.appendChild(path);
    row.appendChild(head);

    const addressLine = document.createElement('div');
    addressLine.className = 'key-addr-line';
    if (entry.address) {
      const link = document.createElement('a');
      link.className = 'mono key-addr address-link';
      link.href = entry.explorer + encodeURIComponent(entry.address);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = entry.address;
      link.title = entry.address;
      addressLine.appendChild(link);
    } else {
      const missing = document.createElement('code');
      missing.className = 'mono key-addr';
      missing.textContent = 'Not available for this address type.';
      addressLine.appendChild(missing);
    }
    const copyAddress = document.createElement('button');
    copyAddress.type = 'button';
    copyAddress.className = 'key-copy';
    copyAddress.textContent = 'Copy';
    copyAddress.addEventListener('click', () => copyText(entry.address, copyAddress));
    addressLine.appendChild(copyAddress);
    row.appendChild(addressLine);

    if (entry.chain === 'bitcoin') {
      const wifPairs: Array<[string, string]> = [
        ['WIF (compressed)', entry.wifCompressed],
        ['WIF (uncompressed)', entry.wifUncompressed],
      ];
      for (const [label, value] of wifPairs) {
        if (!value) continue;
        const wif = document.createElement('a');
        wif.className = 'wif-line';
        wif.href = '/key/' + encodeURIComponent(value);
        wif.textContent = value;
        wif.title = label + ': ' + value;
        row.appendChild(wif);
      }
    }

    const details = document.createElement('details');
    details.className = 'key-steps';
    const summary = document.createElement('summary');
    summary.textContent = 'Private key and WIF';
    details.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'seed-key-body';
    const detailPairs: Array<[string, string]> = [
      ['Hex', entry.privHex],
      ['WIF (compressed)', entry.wifCompressed],
      ['WIF (uncompressed)', entry.wifUncompressed],
    ];
    for (const [label, value] of detailPairs) {
      if (!value) continue;
      const line = document.createElement('div');
      line.className = 'detail-line';
      const labelEl = document.createElement('span');
      labelEl.className = 'detail-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('code');
      valueEl.className = 'mono detail-value';
      valueEl.textContent = value;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-btn';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => copyText(value, copy));
      line.appendChild(labelEl);
      line.appendChild(valueEl);
      line.appendChild(copy);
      body.appendChild(line);
    }
    details.appendChild(body);
    row.appendChild(details);

    const balance = document.createElement('p');
    balance.className = 'seed-balance';
    balance.textContent = 'Waiting for the public balance…';
    row.appendChild(balance);
    entry.balanceEl = balance;
    entry.rowEl = row;
    return row;
  }

  function copyText(text: string, button: HTMLButtonElement, label?: string): void {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      fail('Clipboard access is unavailable in this browser. Select the value and copy it manually.');
      return;
    }
    const restore = label || button.textContent || '';
    navigator.clipboard.writeText(text).then(
      () => {
        button.textContent = 'Copied';
        window.setTimeout(() => {
          button.textContent = restore;
        }, 1200);
      },
      () => {
        fail('Clipboard access was denied. Select the value and copy it manually.');
      },
    );
  }

  /* -------------------------------------------------------------- balances */

  function iconUse(name: string): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/icons.svg#' + name);
    svg.appendChild(use);
    return svg;
  }

  function ensureBalance(entry: RowResult): HTMLElement | null {
    if (entry.balanceEl) return entry.balanceEl;
    if (!entry.rowEl) return null;
    const balance = document.createElement('p');
    balance.className = 'seed-balance';
    balance.textContent = 'Checking the public balance…';
    entry.rowEl.appendChild(balance);
    entry.balanceEl = balance;
    return balance;
  }

  function setBalance(entry: RowResult, text: string, isError?: boolean): void {
    const element = ensureBalance(entry);
    if (!element) return;
    element.className = 'seed-balance' + (isError ? ' err' : '');
    element.textContent = text;
  }

  function showBalanceError(entry: RowResult, message: string): void {
    const element = ensureBalance(entry);
    if (!element) return;
    element.className = 'seed-balance err';
    element.textContent = message + ' ';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'seed-balance-retry';
    button.title = 'Retry this balance';
    button.setAttribute('aria-label', 'Retry balance check for this address');
    button.appendChild(iconUse('ui-retry'));
    button.addEventListener('click', () => {
      setBalance(entry, 'Checking the public balance…');
      retryEntry(entry);
    });
    element.appendChild(button);
  }

  async function balanceFetch(
    url: string,
    options: RequestInit | null,
    signal: AbortSignal | null,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      controller.abort();
    }, BALANCE_TIMEOUT_MS);
    let onAbort: (() => void) | null = null;
    if (signal) {
      if (signal.aborted) {
        window.clearTimeout(timer);
        controller.abort();
      } else {
        onAbort = () => controller.abort();
        signal.addEventListener('abort', onAbort);
      }
    }
    const settings: RequestInit = { ...(options || {}) };
    settings.signal = controller.signal;
    try {
      return await fetch(url, settings);
    } finally {
      window.clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async function withAutoRetry<T>(task: () => Promise<T>, signal: AbortSignal | null): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (signal && signal.aborted) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      if (signal && signal.aborted) throw error;
      return task();
    }
  }

  async function checkBtcRows(entries: RowResult[], run: number, signal: AbortSignal | null): Promise<void> {
    const addresses = Array.from(new Set(entries.map((entry) => entry.address)));
    try {
      const response = await withAutoRetry(
        () => balanceFetch(BTC_BALANCE_URL + addresses.map(encodeURIComponent).join('|'), null, signal),
        signal,
      );
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = (await response.json()) as Record<string, { final_balance?: number; n_tx?: number }>;
      if (run !== state.run) return;
      for (const entry of entries) {
        const info = data[entry.address];
        if (!info) {
          entry.balanceValue = null;
          showBalanceError(entry, 'Balance row missing from the provider.');
          continue;
        }
        entry.balanceValue = BigInt(info.final_balance || 0);
        entry.balanceUnit = 'BTC';
        setBalance(
          entry,
          coin(info.final_balance ?? 0, 8) + ' BTC · ' + Number(info.n_tx || 0) + ' tx',
        );
      }
    } catch {
      if (run !== state.run || (signal && signal.aborted)) return;
      for (const entry of entries) {
        entry.balanceValue = null;
        showBalanceError(entry, 'Balance lookup failed.');
      }
    }
  }

  async function checkEvmRows(entries: RowResult[], run: number, signal: AbortSignal | null): Promise<void> {
    const addresses = Array.from(new Set(entries.map((entry) => entry.address)));
    const payload = addresses.map((address, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: 'eth_getBalance',
      params: [address, 'latest'],
    }));
    try {
      const response = await withAutoRetry(
        () =>
          balanceFetch(
            EVM_RPC,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            },
            signal,
          ),
        signal,
      );
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const list = (await response.json()) as Array<{ id: number; result?: string }>;
      if (run !== state.run) return;
      const byAddress: Record<string, bigint> = Object.create(null) as Record<string, bigint>;
      for (const item of Array.isArray(list) ? list : []) {
        const address = addresses[item.id - 1];
        if (address) byAddress[address] = BigInt(item.result || '0x0');
      }
      for (const entry of entries) {
        const value = byAddress[entry.address];
        if (value === undefined) {
          entry.balanceValue = null;
          showBalanceError(entry, 'Balance row missing from the provider.');
          continue;
        }
        entry.balanceValue = value;
        entry.balanceUnit = 'ETH';
        setBalance(entry, coin(value, 18) + ' ETH');
      }
    } catch {
      if (run !== state.run || (signal && signal.aborted)) return;
      for (const entry of entries) {
        entry.balanceValue = null;
        showBalanceError(entry, 'Balance lookup failed.');
      }
    }
  }

  function balanceRows(chain: string, entries?: RowResult[]): RowResult[] {
    return (entries || state.results).filter(
      (entry) => entry.chain === chain && entry.address && entry.balanceEl,
    );
  }

  /* Honest aggregates only: rows with a known balance, plus a summed current
   * balance when every rendered row shares one chain/asset. */
  function updateAggregates(): void {
    if (!aggregateEl) return;
    if (!state.results.length) {
      aggregateEl.hidden = true;
      aggregateEl.textContent = '';
      return;
    }
    const known = state.results.filter((entry) => entry.balanceValue !== null);
    if (!known.length) {
      aggregateEl.hidden = true;
      aggregateEl.textContent = '';
      return;
    }
    const active = known.filter((entry) => (entry.balanceValue ?? 0n) > 0n).length;
    let text = 'Active: ' + active;
    const unchecked = state.results.length - known.length;
    if (unchecked) text += ' · ' + unchecked + ' address' + (unchecked === 1 ? '' : 'es') + ' not checked';
    const unit = state.results[0]?.balanceUnit ?? '';
    const sameAsset =
      (unit === 'BTC' || unit === 'ETH') &&
      known.length === state.results.length &&
      state.results.every((entry) => entry.balanceUnit === unit);
    if (sameAsset) {
      const sum = known.reduce((acc, entry) => acc + (entry.balanceValue ?? 0n), 0n);
      text += ' · Sum: ' + coin(sum, unit === 'BTC' ? 8 : 18) + ' ' + unit;
    }
    aggregateEl.textContent = text;
    aggregateEl.hidden = false;
  }

  function retryEntry(entry: RowResult): void {
    if (!entry.address) return;
    const run = state.run;
    const done = () => {
      if (run === state.run) updateAggregates();
    };
    if (entry.chain === 'bitcoin') void checkBtcRows([entry], run, null).then(done);
    else if (entry.chain === 'ethereum') void checkEvmRows([entry], run, null).then(done);
    else {
      entry.balanceValue = null;
      setBalance(entry, 'Explorer only — no public balance adapter here.');
      updateAggregates();
    }
  }

  async function checkBalances(entries?: RowResult[]): Promise<void> {
    const rows = entries || state.results;
    if (!rows.length) return;
    if (state.balanceAbort) {
      try {
        state.balanceAbort.abort();
      } catch {
        /* already aborted */
      }
    }
    const controller = new AbortController();
    state.balanceAbort = controller;
    const run = state.run;

    const btc = balanceRows('bitcoin', rows);
    const evm = balanceRows('ethereum', rows);
    for (const entry of rows) {
      entry.balanceValue = null;
      if (entry.chain !== 'bitcoin' && entry.chain !== 'ethereum') {
        setBalance(entry, 'Explorer only — no public balance adapter here.');
      } else if (!entry.address) {
        setBalance(entry, 'No public address for this derivation type.');
      } else {
        setBalance(entry, 'Checking the public balance…');
      }
    }

    if (!btc.length && !evm.length) {
      note('No public address to check for this selection. Only derived addresses are ever sent.');
      state.balanceAbort = null;
      updateAggregates();
      return;
    }

    note(
      'Checking public balances. Only the derived public addresses are sent: blockchain.info for BTC and a public Ethereum JSON-RPC endpoint for EVM.',
    );
    await Promise.all([
      btc.length ? checkBtcRows(btc, run, controller.signal) : Promise.resolve(),
      evm.length ? checkEvmRows(evm, run, controller.signal) : Promise.resolve(),
    ]);
    if (run !== state.run) return;
    if (state.balanceAbort === controller) state.balanceAbort = null;
    updateAggregates();
    note('Balances loaded from public providers. They can lag the chain; only public addresses were sent.');
  }

  /* ------------------------------------------------------------------- csv */

  function exportCsv(): void {
    if (!state.results.length) return;
    const blob = new Blob([csvText(state.results)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'rotor-seed-addresses.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* Copy only the public rows: chain, path and address. Never keys. */
  function copyAll(): void {
    if (!state.results.length || !copyAllBtn) return;
    const lines = state.results.map((entry) => [entry.chainLabel, entry.path, entry.address].join('\t'));
    copyText(lines.join('\n'), copyAllBtn, 'Copy All');
  }

  /* -------------------------------------------------------------- generate */

  async function generate(): Promise<void> {
    if (state.busy) return;
    fail('');
    const scheme = schemeValue();
    let count = wordsEl ? Number(wordsEl.value) : 12;
    if (scheme === 'electrum-old' && count !== 12 && count !== 24) count = 12;
    state.busy = true;
    if (generateBtn) generateBtn.disabled = true;
    if (deriveBtn) deriveBtn.disabled = true;
    if (loadMoreBtn) loadMoreBtn.disabled = true;
    note('Generating a phrase locally…');
    try {
      const crypto = window.RotorSeedCrypto;
      if (!crypto) throw new Error('The seed library did not load. Reload the page.');
      let phrase: string;
      if (scheme === 'electrum-old') {
        phrase = crypto.generateOld(count);
      } else if (scheme === 'electrum-bip39') {
        phrase = await crypto.generateElectrumBip39(count);
      } else {
        phrase = crypto.generateBip39(count);
      }
      if (phraseEl) phraseEl.value = phrase;
      if (passphraseEl) passphraseEl.value = '';
      updateWordCount();
      note('New phrase generated in this tab. Write it down offline; it is not stored.');
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Could not generate a phrase.');
    } finally {
      state.busy = false;
      if (generateBtn) generateBtn.disabled = false;
      if (deriveBtn) deriveBtn.disabled = false;
      if (loadMoreBtn) loadMoreBtn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ boot */

  function clearAll(): void {
    state.run += 1;
    state.results = [];
    state.snapshot = null;
    state.groupIndex = null;
    if (state.balanceAbort) {
      try {
        state.balanceAbort.abort();
      } catch {
        /* already aborted */
      }
      state.balanceAbort = null;
    }
    if (phraseEl) phraseEl.value = '';
    if (passphraseEl) passphraseEl.value = '';
    if (rowsEl) rowsEl.textContent = '';
    if (resultEl) resultEl.hidden = true;
    if (csvBtn) csvBtn.hidden = true;
    if (copyAllBtn) copyAllBtn.hidden = true;
    if (loadMoreBtn) {
      loadMoreBtn.hidden = true;
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load next 5';
    }
    if (aggregateEl) {
      aggregateEl.hidden = true;
      aggregateEl.textContent = '';
    }
    if (countEl) countEl.textContent = '';
    updateWordCount();
    fail('');
    note('Cleared. The phrase, passphrase and results were removed from this tab.');
    if (phraseEl) phraseEl.focus();
  }

  schemeEl?.addEventListener('change', () => {
    invalidate();
    refreshControls();
  });
  wordsEl?.addEventListener('change', () => {
    invalidate();
    refreshControls();
  });
  chainEl?.addEventListener('change', () => {
    invalidate();
    populatePaths();
  });
  pathEl?.addEventListener('change', () => invalidate());
  allPathsEl?.addEventListener('change', () => invalidate());
  for (const button of countButtons) {
    button.addEventListener('click', () => {
      setCount(Number(button.getAttribute('data-count')) || 1);
      invalidate();
    });
  }

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void deriveAll();
  });
  phraseEl?.addEventListener('input', updateWordCount);
  generateBtn?.addEventListener('click', () => void generate());
  clearBtn?.addEventListener('click', clearAll);
  csvBtn?.addEventListener('click', exportCsv);
  copyAllBtn?.addEventListener('click', copyAll);
  loadMoreBtn?.addEventListener('click', () => void loadNextBatch());

  populateChains();
  refreshControls();
  setCount(1);

  void (async function restoreSearchPhrase(): Promise<void> {
    let phrase = '';
    let passphrase = '';
    let count = '';
    try {
      phrase = sessionStorage.getItem('rotor-seed-phrase') || '';
      passphrase = sessionStorage.getItem('rotor-seed-passphrase') || '';
      count = sessionStorage.getItem('rotor-seed-count') || '';
      sessionStorage.removeItem('rotor-seed-phrase');
      sessionStorage.removeItem('rotor-seed-passphrase');
      sessionStorage.removeItem('rotor-seed-count');
    } catch {
      phrase = '';
    }
    if (!phrase) return;
    if (phraseEl) phraseEl.value = phrase;
    const normalized = normalizePhrase(phrase);
    if (schemeEl) schemeEl.value = schemeForPhrase(normalized);
    refreshControls();
    updateWordCount();
    if (passphraseEl && passphrase) passphraseEl.value = passphrase;
    const countValue = Number(count);
    if (ADDRESS_COUNTS.indexOf(countValue) >= 0) setCount(countValue);
    void deriveAll();
  })();

  window.addEventListener('pagehide', () => {
    state.run += 1;
    state.results = [];
    state.snapshot = null;
    state.groupIndex = null;
    if (state.balanceAbort) {
      try {
        state.balanceAbort.abort();
      } catch {
        /* already aborted */
      }
      state.balanceAbort = null;
    }
    if (phraseEl) phraseEl.value = '';
    if (passphraseEl) passphraseEl.value = '';
    if (rowsEl) rowsEl.textContent = '';
    try {
      sessionStorage.removeItem('rotor-seed-phrase');
    } catch {
      /* private mode */
    }
  });
}
