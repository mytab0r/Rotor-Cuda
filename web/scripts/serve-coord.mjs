/* Start the release coordinator for the `/key` DOM regression.
 *
 * `/key` is coordinator-served, so the browser test needs the real binary and
 * its static-asset injection. State lives in a per-run temp directory that is
 * removed on exit; the monitor pollers point at a closed port because this
 * suite never needs balances. Mirrors the args `scripts/ui-audit.mjs --serve`
 * uses, but on its own port so it can run beside the audit. */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '..');
const PORT = Number(process.env.COORD_PORT || 4392);
const HOST = '127.0.0.1';
const EXE =
  process.env.COORD_BIN ||
  path.join(
    REPO_ROOT,
    'target',
    'release',
    process.platform === 'win32' ? 'rotor-coord.exe' : 'rotor-coord',
  );

if (!existsSync(EXE)) {
  console.error(`missing ${EXE}; run: cargo build --release --bin rotor-coord`);
  process.exit(1);
}

const stateDir = path.join(os.tmpdir(), `rotor-key-e2e-${process.pid}`);
mkdirSync(stateDir, { recursive: true });

const cleanup = () => {
  rmSync(stateDir, { recursive: true, force: true });
};

const child = spawn(
  EXE,
  [
    '--bind',
    `${HOST}:${PORT}`,
    '--token',
    'key-e2e-token',
    '--state',
    path.join(stateDir, 'coordinator.json'),
    '--monitor-state',
    path.join(stateDir, 'monitor.json'),
    '--monitor-interval',
    '3600',
    '--monitor-rpc',
    'http://127.0.0.1:1',
    '--monitor-btc-rpc',
    'http://127.0.0.1:1',
  ],
  { cwd: REPO_ROOT, stdio: 'inherit' },
);

const stop = () => {
  if (!child.killed) child.kill();
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', () => {
  stop();
  cleanup();
});

child.on('exit', (code, signal) => {
  cleanup();
  process.exit(signal ? 1 : code ?? 1);
});
