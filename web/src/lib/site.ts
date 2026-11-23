/* Shared site identity, navigation and route metadata for the Astro frontend.
 *
 * No DOM and no framework: the header active state is decided at build time
 * from the route, so a prerendered page never needs JavaScript to highlight
 * its own section. */

export const SITE_ORIGIN = 'https://rotor.pxbt.app';
export const SITE_NAME = 'Crypto';
export const REPOSITORY_URL = 'https://github.com/mytab0r/Rotor-Cuda';
export const THEME_STORAGE_KEY = 'rotor-theme';

export type NavSection =
  | 'home'
  | 'directory'
  | 'seeds'
  | 'puzzle'
  | 'vanity'
  | 'milk-sad'
  | 'tools'
  | 'docs'
  | 'search'
  | 'cabinet';

export interface NavItem {
  section: NavSection;
  href: string;
  label: string;
  icon: string;
}

/* Same order, labels and glyphs as the live coordinator header
 * (`site_header` in src/coordinator/mod.rs). The header renders this list;
 * the search and cabinet controls are the two utility actions. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { section: 'home', href: '/', label: 'Home', icon: 'ui-grid' },
  { section: 'directory', href: '/private-keys', label: 'Directory', icon: 'ui-key' },
  { section: 'seeds', href: '/mnemonic-seeds', label: 'Seeds', icon: 'ui-seed' },
  { section: 'puzzle', href: '/bitcoin-puzzle', label: 'Puzzle', icon: 'ui-puzzle' },
  { section: 'vanity', href: '/vanity', label: 'Vanity', icon: 'ui-random' },
  { section: 'milk-sad', href: '/milk-sad', label: 'Milk Sad', icon: 'ui-shield' },
  { section: 'tools', href: '/tools', label: 'Tools', icon: 'ui-tools' },
  { section: 'docs', href: '/docs', label: 'Docs', icon: 'ui-book' },
] as const;

/* Map a pathname to the primary nav section. Kept byte-compatible with
 * `sectionForPath` in apps/site/site.js so a migrated page highlights the same
 * item the coordinator highlighted before the move. */
export function sectionForPath(pathname: string): NavSection {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return 'home';
  if (path === '/private-keys' || path.startsWith('/private-keys/') || path.startsWith('/keys/')) {
    return 'directory';
  }
  if (path === '/mnemonic-seeds' || path.startsWith('/mnemonic-seeds/')) return 'seeds';
  if (path.startsWith('/bitcoin-puzzle')) return 'puzzle';
  if (path.startsWith('/vanity')) return 'vanity';
  if (path.startsWith('/milk-sad')) return 'milk-sad';
  if (
    path.startsWith('/tools') ||
    path.startsWith('/brainwallet') ||
    path.startsWith('/keystore-parser') ||
    path.startsWith('/faq') ||
    path.startsWith('/disclaimer') ||
    path.startsWith('/donate') ||
    path === '/seed' ||
    path === '/mnemonic-converter'
  ) {
    return 'tools';
  }
  if (path.startsWith('/docs')) return 'docs';
  if (path === '/key' || path.startsWith('/key/')) return 'search';
  if (path.startsWith('/cabinet') || path.startsWith('/monitor') || path.startsWith('/me')) {
    return 'cabinet';
  }
  return 'home';
}

export function absoluteUrl(pathname: string): string {
  return new URL(pathname, SITE_ORIGIN).href;
}

/* Routes this Astro app owns today. The sitemap lists exactly these; later
 * phases add their routes here as pages move, so the sitemap can never claim a
 * page the static build does not contain. */
export const PRERENDERED_ROUTES: readonly string[] = [
  '/',
  '/docs',
  '/mnemonic-converter',
  '/tools',
];
