import { defineConfig } from 'astro/config';

// Static output only: the coordinator keeps serving every other route until
// later phases. No adapter, no server entry, no client runtime.
export default defineConfig({
  output: 'static',
  compressHTML: false,
  build: {
    format: 'directory',
  },
  vite: {
    build: {
      sourcemap: false,
    },
  },
});
