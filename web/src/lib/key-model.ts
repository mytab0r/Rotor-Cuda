/* Shared key-page row vocabulary. Pure data, no Node and no DOM, so the Astro
 * build and the browser island import the same list. The eight EVM networks
 * are address-row ids, not chain slugs; `lib/key-core.ts` maps each id to the
 * chain identity in `data/chains.json`. */

export interface EvmNetwork {
  id: string;
  label: string;
}

/* Same order as `EVM_IDS` in apps/site/key.js: the generic 0x parent row and
 * the eight network rows that show the same address as "↑ same". */
export const EVM_NETWORKS: readonly EvmNetwork[] = [
  { id: 'evm', label: 'Ethereum' },
  { id: 'evm_bnb', label: 'BNB Chain' },
  { id: 'evm_arbitrum', label: 'Arbitrum' },
  { id: 'evm_optimism', label: 'Optimism' },
  { id: 'evm_base', label: 'Base' },
  { id: 'evm_polygon', label: 'Polygon' },
  { id: 'evm_avalanche', label: 'Avalanche' },
  { id: 'evm_zksync', label: 'zkSync Era' },
];

export interface KeyRowMeta {
  id: string;
  /** Short type cell: Legacy, SegWit, Base58, CashAddr, W5, ↑ same, … */
  type: string;
  /** Chain display name, e.g. Bitcoin or zkSync Era. */
  chain: string;
  ticker: string;
  /** `chain-<slug>` icon id from data/chains.json. */
  icon: string;
  /** Contiguous chain-group key; rows with the same group share one cell. */
  group: string;
  /** Explorer URL template with `{address}`, or an empty string. */
  explorer: string;
  shared: 'parent' | 'same' | null;
}

export interface KeyRowModel {
  rows: KeyRowMeta[];
}
