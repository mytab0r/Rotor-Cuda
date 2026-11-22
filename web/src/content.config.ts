import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/* One Markdown entry per mainnet chain directory page. The body carries the
 * chain-specific prose and its content H2s; the page renders it once inside the
 * shared shell. `chain` must match a slug in data/chains.json; the page fails
 * the build when it does not. */
const chains = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/chains' }),
  schema: z.object({
    chain: z.string(),
    title: z.string(),
    description: z.string(),
  }),
});

export const collections = { chains };
