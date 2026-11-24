import { defineConfig } from '@playwright/test';

/* Coordinator-backed DOM regression for `/key`.
 *
 * The static-site suite in `playwright.config.ts` runs over the Astro `dist/`,
 * which does not own `/key` yet. This config starts the release coordinator
 * that the `ui` workflow already builds and drives the real page against it.
 * DOM-only: no screenshots, so no per-platform baselines are needed. */

const HOST = '127.0.0.1';
const PORT = Number(process.env.COORD_PORT || 4392);
const BASE_URL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /key-format\.spec\.ts/,
  outputDir: 'test-results-coord',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [['list'], ['json', { outputFile: 'test-results-coord/results.json' }]],
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'node scripts/serve-coord.mjs',
    url: `${BASE_URL}/key`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      COORD_PORT: String(PORT),
      COORD_BIN: process.env.COORD_BIN || '',
    },
  },
});
