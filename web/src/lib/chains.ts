/* Canonical chain metadata for the Astro pages.
 *
 * `data/chains.json` is the single source of truth (AGENTS.md); this module only
 * narrows its shape for TypeScript and exposes the 18 mainnet rows in canonical
 * order. Testnet rows stay in the data but are not part of the public directory. */
import chainsData from '../../../data/chains.json' with { type: 'json' };

export interface Chain {
  slug: string;
  name: string;
  symbol: string;
  family: string;
  decimals: number;
  order: number;
  explorer: string;
  testnet?: boolean;
}

export const ALL_CHAINS = (chainsData as { chains: Chain[] }).chains;

export const MAINNET_CHAINS: readonly Chain[] = ALL_CHAINS
  .filter((chain) => !chain.testnet)
  .sort((a, b) => a.order - b.order);

export function chainBySlug(slug: string): Chain | undefined {
  return MAINNET_CHAINS.find((chain) => chain.slug === slug);
}
