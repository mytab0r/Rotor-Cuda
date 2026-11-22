import { defineConfig } from 'astro/config';

// Static output only: the coordinator keeps serving every other route until
// later phases. No adapter, no server entry, no client runtime.
export default defineConfig({
  site: 'https://rotor.pxbt.app',
  output: 'static',
  compressHTML: false,
  build: {
    format: 'directory',
  },
  vite: {
    build: {
      sourcemap: false,
      // Keep every script a same-origin file: the CSP plan allows
      // script-src 'self' only, so an inlined module or data: URL is a
      // violation even when it is smaller.
      assetsInlineLimit: 0,
    },
  },
});
