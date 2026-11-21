#!/usr/bin/env node
/* Headless parity check for the /mnemonic-converter pilot.
 *
 * Loads the built page in Chrome/Edge over the DevTools protocol, converts two
 * fixed phrases at 375/768/1280 in dark and light, compares the addresses with
 * the vectors from apps/site/seed-test.mjs, and saves screenshots plus a JSON
 * report. Needs a running preview:
 *
 *   npm run preview -- --port 4321
 *   node scripts/cdp-parity.mjs --base http://127.0.0.1:4321
 *
 * Node 22+ for the built-in WebSocket. No dependencies. */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROUTE = '/mnemonic-converter';
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 900 },
];
const THEMES = ['dark', 'light'];

const PHRASES = [
  {
    name: 'bip39',
    scheme: 'bip39',
    chain: 'bitcoin',
    count: 1,
    phrase: 'abandon '.repeat(11) + 'about',
    expected: ['1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA'],
    expectRows: 1,
  },
  {
    name: 'electrum-old',
    scheme: 'electrum-old',
    chain: 'bitcoin',
    count: 3,
    phrase: 'hardly point goal hallway patience key stone difference ready caught listen fact',
    expected: ['18v3oDeH9LCmeKrbC2nYgLP5UKva1NpMG', '1BDoTF94QViEdnNuL4n6gQ8LgihBNCwXDT'],
    expectRows: 3,
  },
];

function parseArgs(argv) {
  const options = { base: 'http://127.0.0.1:4321', out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      console.log('usage: node scripts/cdp-parity.mjs [--base URL] [--out DIR]');
      process.exit(0);
    }
    if (arg === '--base') options.base = String(argv[++index] || '').replace(/\/+$/, '');
    else if (arg === '--out') options.out = argv[++index] || null;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.out) {
    options.out = path.join(tmpdir(), 'rotor-astro-pilot-' + Date.now());
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

function findBrowser() {
  const candidate = (value) => value && existsSync(value) && value;
  const env = candidate(process.env.CHROME_PATH) || candidate(process.env.EDGE_PATH);
  if (env) return env;
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      for (const relative of ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe']) {
        const found = candidate(path.join(root, relative));
        if (found) return found;
      }
    }
    return null;
  }
  if (process.platform === 'darwin') {
    return candidate('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') || null;
  }
  for (const name of ['google-chrome', 'chromium', 'microsoft-edge']) {
    const result = spawnSync('which', [name], { encoding: 'utf8' });
    const found = result.status === 0 ? result.stdout.trim() : '';
    if (candidate(found)) return found;
  }
  return null;
}

async function launchBrowser(browserPath, userDataDir) {
  const child = spawn(
    browserPath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--mute-audio',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8000);
  });
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`browser exited: ${stderr.trim()}`);
    if (existsSync(portFile)) {
      const [portText, wsPath] = (await readFile(portFile, 'utf8').catch(() => '')).split('\n');
      const port = Number.parseInt(portText, 10);
      if (port > 0 && wsPath) {
        const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
        if (!response.ok) throw new Error(`/json/new returned HTTP ${response.status}`);
        const target = await response.json();
        if (!target.webSocketDebuggerUrl) throw new Error('DevTools target has no webSocketDebuggerUrl');
        return { child, wsUrl: target.webSocketDebuggerUrl };
      }
    }
    await sleep(100);
  }
  killTree(child);
  throw new Error(`browser did not expose a DevTools port: ${stderr.trim()}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (message.id === undefined) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || 'CDP error'));
      else request.resolve(message.result || {});
    });
    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}, timeoutMs = 20000) {
          return new Promise((resolveCommand, rejectCommand) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCommand(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(timer);
                resolveCommand(value);
              },
              reject: (error) => {
                clearTimeout(timer);
                rejectCommand(error);
              },
            });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          try {
            socket.close();
          } catch {
            /* already closed */
          }
        },
      });
    });
    socket.addEventListener('error', () => reject(new Error('DevTools WebSocket error')));
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, expression);
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${expression} (last: ${JSON.stringify(last)})`);
}

async function convert(cdp, phrase) {
  await evaluate(
    cdp,
    `(() => {
      const scheme = document.getElementById('seed-scheme');
      scheme.value = ${JSON.stringify(phrase.scheme)};
      scheme.dispatchEvent(new Event('change', { bubbles: true }));
      const chain = document.getElementById('seed-chain');
      if (chain.value !== ${JSON.stringify(phrase.chain)}) {
        chain.value = ${JSON.stringify(phrase.chain)};
        chain.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const count = document.querySelector('.seed-count-btn[data-count="' + ${phrase.count} + '"]');
      if (count) count.click();
      const input = document.getElementById('seed-phrase');
      input.value = ${JSON.stringify(phrase.phrase)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('seed-derive').click();
      return true;
    })()`,
  );
  await waitFor(
    cdp,
    `document.querySelectorAll('#seed-rows .seed-row').length >= ${phrase.expectRows}`,
  );
  await sleep(400);
  return evaluate(
    cdp,
    `Array.from(document.querySelectorAll('#seed-rows .address-link')).map((a) => a.textContent)`,
  );
}

async function shot(cdp, file) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(file, Buffer.from(result.data, 'base64'));
}

async function main() {
  if (typeof WebSocket !== 'function') {
    throw new Error('this script needs Node 22+ for the built-in WebSocket');
  }
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.out, { recursive: true });
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('no Chrome/Edge found; set CHROME_PATH or EDGE_PATH');

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'rotor-astro-parity-chrome-'));
  const launched = await launchBrowser(browserPath, userDataDir);
  const cdp = await connect(launched.wsUrl);
  const failures = [];
  const runs = [];

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 1,
          mobile: viewport.width < 600,
          screenWidth: viewport.width,
          screenHeight: viewport.height,
        });
        await cdp.send('Emulation.setEmulatedMedia', {
          media: 'screen',
          features: [{ name: 'prefers-color-scheme', value: theme }],
        });

        for (const phrase of PHRASES) {
          await cdp.send('Page.navigate', { url: options.base + ROUTE });
          await waitFor(cdp, `Boolean(document.getElementById('seed-form'))`);
          await waitFor(cdp, `document.readyState === 'complete'`);
          await sleep(300);

          const prefix = `${phrase.name}-${viewport.width}-${theme}`;
          await shot(cdp, path.join(options.out, `${prefix}-page.png`));

          const addresses = await convert(cdp, phrase);
          await evaluate(cdp, `document.getElementById('seed-result').scrollIntoView({ block: 'start' })`);
          await sleep(300);
          await shot(cdp, path.join(options.out, `${prefix}-results.png`));

          const actual = addresses.slice(0, phrase.expected.length);
          const ok =
            addresses.length === phrase.expectRows &&
            phrase.expected.every((expected, index) => actual[index] === expected);
          const run = {
            phrase: phrase.name,
            viewport: viewport.width,
            theme,
            rows: addresses.length,
            expectedRows: phrase.expectRows,
            addresses,
            expected: phrase.expected,
            ok,
            screenshots: [
              path.join(options.out, `${prefix}-page.png`),
              path.join(options.out, `${prefix}-results.png`),
            ],
          };
          runs.push(run);
          if (!ok) failures.push(run);
          console.log(
            `${ok ? 'ok  ' : 'FAIL'} ${phrase.name} ${viewport.width}px ${theme} ` +
              `(${addresses.length} row(s), first: ${addresses[0] ?? '-'})`,
          );
        }
      }
    }
  } finally {
    cdp.close();
    killTree(launched.child);
  }

  const report = { base: options.base, route: ROUTE, generatedAt: new Date().toISOString(), runs };
  await writeFile(path.join(options.out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\nreport: ${path.join(options.out, 'report.json')}`);
  if (failures.length) {
    console.error(`${failures.length} of ${runs.length} parity run(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`all ${runs.length} parity runs passed`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
