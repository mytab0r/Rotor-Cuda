/* The twelve pages the browser regression suite owns and their contract.
 *
 * Titles and H1s are asserted exactly: they are the SEO surface the build
 * controls, and a silent change here is a regression, not a refactor. Row
 * counts come from the rendered tables; a hidden or dropped column still
 * passes a count check, which is why the visual spec exists beside this one. */

export interface RouteCase {
  /** URL path, with the trailing slash the static build serves. */
  path: string;
  /** Stable snapshot file stem. */
  name: string;
  title: string;
  h1: string;
  /** Rendered `<table class="data-table">` body rows. */
  rows: number;
  /** Extra assertion marker handled by the route spec. */
  kind: 'landing' | 'hub' | 'key-table' | 'seed-table' | 'puzzle-hub' | 'puzzle-detail' | 'prose';
}

export const ROUTES: RouteCase[] = [
  {
    path: '/',
    name: 'home',
    title: 'Private key explorer and Bitcoin puzzle search | Crypto',
    h1: 'Private key explorer and Bitcoin puzzle search',
    rows: 0,
    kind: 'landing',
  },
  {
    path: '/private-keys/',
    name: 'private-keys',
    title: 'Private keys by chain: 18 directories to browse | Crypto',
    h1: 'Private keys by chain',
    rows: 18,
    kind: 'hub',
  },
  {
    path: '/private-keys/bitcoin/',
    name: 'private-keys-bitcoin',
    title: 'Bitcoin private keys: P2PKH, SegWit and Taproot | Crypto',
    h1: 'Bitcoin private keys',
    rows: 60,
    kind: 'key-table',
  },
  {
    path: '/mnemonic-seeds/',
    name: 'mnemonic-seeds',
    title: 'Mnemonic seeds by chain: 18 directories to browse | Crypto',
    h1: 'Mnemonic seeds by chain',
    rows: 18,
    kind: 'hub',
  },
  {
    path: '/mnemonic-seeds/ethereum/',
    name: 'mnemonic-seeds-ethereum',
    title: 'Ethereum seed phrases: BIP44 and 0x accounts | Crypto',
    h1: 'Ethereum seed phrases',
    rows: 60,
    kind: 'seed-table',
  },
  {
    path: '/bitcoin-puzzle/',
    name: 'bitcoin-puzzle',
    title: 'Bitcoin puzzle browser: 160 targets, 83 solved | Crypto',
    h1: 'Bitcoin puzzle',
    rows: 160,
    kind: 'puzzle-hub',
  },
  {
    path: '/bitcoin-puzzle/1/',
    name: 'bitcoin-puzzle-1',
    title: 'Bitcoin puzzle #1 — P2PKH target and key range | Crypto',
    h1: 'Bitcoin puzzle #1',
    rows: 0,
    kind: 'puzzle-detail',
  },
  {
    path: '/docs/',
    name: 'docs',
    title: 'Docs: run a client, key tools and site limits | Crypto',
    h1: 'Documentation',
    rows: 0,
    kind: 'prose',
  },
  {
    path: '/tools/',
    name: 'tools',
    title: 'Crypto calculators: keys, WIF, seeds, vanity | Crypto',
    h1: 'Crypto calculators',
    rows: 0,
    kind: 'prose',
  },
  {
    path: '/faq/',
    name: 'faq',
    title: 'FAQ — how Crypto key tools and alerts work | Crypto',
    h1: 'Frequently asked questions',
    rows: 0,
    kind: 'prose',
  },
  {
    path: '/disclaimer/',
    name: 'disclaimer',
    title: 'Disclaimer — educational and authorized use | Crypto',
    h1: 'Disclaimer',
    rows: 0,
    kind: 'prose',
  },
  {
    path: '/donate/',
    name: 'donate',
    title: 'Donate — support Crypto development: BTC, USDT, EVM | Crypto',
    h1: 'Donate',
    rows: 0,
    kind: 'prose',
  },
];

export function schemeOf(projectName: string): 'light' | 'dark' {
  return projectName.endsWith('-light') ? 'light' : 'dark';
}
