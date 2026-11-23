import { defineConfig } from '@playwright/test';

/* Browser-level regression suite for the static Astro build.
 *
 * The suite runs against `dist/` (built by `npm run build`) served by the
 * zero-dependency `scripts/serve-dist.mjs`; it never reaches the internet.
 * Three widths times two colour schemes match the project's UI gate. Every
 * run has one retry so a transient browser hiccup cannot redden the gate. */

const HOST = '127.0.0.1';
/* A dedicated port: local sessions often leave an `astro preview` on 4321, and
 * reusing another checkout's server would test the wrong `dist/`. */
const PORT = Number(process.env.PORT || 4391);
const BASE_URL = `http://${HOST}:${PORT}`;

const viewports = [
  { name: 'mobile-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
];

const schemes = ['light', 'dark'] as const;

export default defineConfig({
  testDir: './tests/e2e',
  /* Baselines live in `tests/__screenshots__/<platform>/<project>/<name>.png`.
   * Text rasterisation differs between Windows and the Linux CI runner by
   * more than a few percent, so each platform keeps its own reviewed set
   * instead of masking real diffs behind a loose pixel tolerance. */
  snapshotPathTemplate: '{testDir}/../__screenshots__/{platform}/{projectName}/{arg}{ext}',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 1,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      /* Baselines are per platform; this ceiling only absorbs sub-pixel
       * antialiasing noise inside one OS. A structural regression (a hidden
       * column, a table spilling out of its scroll wrapper) changes far more. */
      maxDiffPixelRatio: 0.005,
      threshold: 0.2,
    },
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: viewports.flatMap((viewport) =>
    schemes.map((scheme) => ({
      name: `${viewport.name}-${scheme}`,
      use: {
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      },
    })),
  ),
  webServer: {
    command: 'node scripts/serve-dist.mjs',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
