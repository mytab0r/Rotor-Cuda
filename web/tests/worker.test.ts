/* Cloudflare Pages advanced-mode worker contract.
 *
 * The deploy is only correct if the worker leaves every static request
 * untouched and synthesizes nothing except a missing 64-hex `/key/<hex>`
 * page. The mock ASSETS layer reads a temp directory, so the passthrough test
 * compares the response body with the file on disk byte for byte. */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// @ts-ignore — plain browser-targeted ESM module under web/public, no types.
import worker from '../../public/_worker.js';

const CURATED = '0'.repeat(63) + '1';
const OTHER = 'a'.repeat(64);

interface WorkerModule {
  fetch(request: Request, env: { ASSETS: { fetch(input: Request | URL | string): Promise<Response> } }): Promise<Response>;
}

const site: WorkerModule = worker as WorkerModule;

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Private key explorer: 30 addresses on 18 chains | Crypto</title>
<meta name="description" content="Derive 30 addresses on 18 chains from any 64-character private key in your browser: Bitcoin, EVM, TRON, Solana, TON, XRP and more. Nothing is uploaded.">
<meta name="robots" content="index,follow">
<link rel="canonical" href="https://rotor.pxbt.app/key">
<meta property="og:title" content="Private key explorer: 30 addresses on 18 chains | Crypto">
<meta property="og:description" content="Derive 30 addresses on 18 chains from any 64-character private key in your browser: Bitcoin, EVM, TRON, Solana, TON, XRP and more. Nothing is uploaded.">
<meta property="og:url" content="https://rotor.pxbt.app/key">
<meta name="twitter:title" content="Private key explorer: 30 addresses on 18 chains | Crypto">
<meta name="twitter:description" content="Derive 30 addresses on 18 chains from any 64-character private key in your browser: Bitcoin, EVM, TRON, Solana, TON, XRP and more. Nothing is uploaded.">
<script type="application/ld+json">{"@type":"WebPage","url":"https://rotor.pxbt.app/key"}</script>
</head>
<body><main><h1>Private-key explorer</h1><div id="addr-rows"></div></main></body>
</html>
`;

function assetsFrom(root: string) {
  return {
    async fetch(input: Request | URL | string): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (relative === '' || relative.endsWith('/')) relative += 'index.html';
      else if (!path.extname(relative)) relative += '/index.html';
      try {
        const bytes = await readFile(path.join(root, relative));
        return new Response(bytes, {
          status: 200,
          headers: { 'content-type': relative.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' },
        });
      } catch {
        const notFound = await readFile(path.join(root, '404.html'));
        return new Response(notFound, {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
    },
  };
}

async function withSite(fn: (env: { ASSETS: ReturnType<typeof assetsFrom> }, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'rotor-worker-'));
  try {
    await mkdir(path.join(root, 'key', CURATED), { recursive: true });
    await mkdir(path.join(root, 'private-keys'), { recursive: true });
    await writeFile(path.join(root, 'key', 'index.html'), TEMPLATE);
    await writeFile(path.join(root, 'key', CURATED, 'index.html'), '<!doctype html><html><head><title>curated</title></head><body>curated key</body></html>');
    await writeFile(path.join(root, 'private-keys', 'index.html'), '<!doctype html><html><body>private keys</body></html>');
    await writeFile(path.join(root, 'site.css'), ':root { --known: 1; }\n');
    await writeFile(path.join(root, '404.html'), '<!doctype html><html><body>not found</body></html>');
    await fn({ ASSETS: assetsFrom(root) }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a static asset passes through byte-identically', async () => {
  await withSite(async (env, root) => {
    const response = await site.fetch(new Request('https://rotor.pxbt.app/site.css'), env);
    assert.equal(response.status, 200);
    const expected = await readFile(path.join(root, 'site.css'));
    const actual = Buffer.from(await response.arrayBuffer());
    assert.equal(Buffer.compare(actual, expected), 0, 'the response must be the static file, byte for byte');
  });
});

test('a static directory page passes through byte-identically', async () => {
  await withSite(async (env, root) => {
    const response = await site.fetch(new Request('https://rotor.pxbt.app/private-keys/'), env);
    assert.equal(response.status, 200);
    const expected = await readFile(path.join(root, 'private-keys', 'index.html'));
    assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), expected), 0);
  });
});

test('a curated key page is the static file, not an injection', async () => {
  await withSite(async (env, root) => {
    for (const suffix of ['', '/']) {
      const response = await site.fetch(new Request(`https://rotor.pxbt.app/key/${CURATED}${suffix}`), env);
      assert.equal(response.status, 200);
      const expected = await readFile(path.join(root, 'key', CURATED, 'index.html'));
      assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), expected), 0);
    }
  });
});

test('a missing 64-hex key is synthesized with per-key metadata and noindex', async () => {
  await withSite(async (env) => {
    for (const suffix of ['', '/']) {
      const response = await site.fetch(new Request(`https://rotor.pxbt.app/key/${OTHER}${suffix}`), env);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /text\/html/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-robots-tag'), 'noindex');
      const html = await response.text();
      assert.ok(html.includes(`<meta name="robots" content="noindex,follow">`));
      assert.ok(html.includes(`<link rel="canonical" href="https://rotor.pxbt.app/key/${OTHER}">`));
      assert.ok(html.includes(`<script type="application/json" id="key-request">{"hex":"${OTHER}"}</script>`));
      assert.ok(!html.includes('application/ld+json'), 'the hub JSON-LD is removed from a noindex key page');
      const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
      const description = html.match(/<meta name="description" content="([^"]*)">/)?.[1] ?? '';
      assert.ok(title.length >= 50 && title.length <= 60, `title length ${title.length}`);
      assert.ok(description.length >= 120 && description.length <= 160, `description length ${description.length}`);
      assert.ok(html.includes('data-key-source="worker"'));
    }
  });
});

test('invalid key paths stay a real 404 and never reach the injector', async () => {
  await withSite(async (env, root) => {
    const notFound = await readFile(path.join(root, '404.html'));
    for (const pathname of [
      `/key/${'b'.repeat(63)}`,
      `/key/${'z'.repeat(64)}`,
      '/key/wif',
      `/key/${'c'.repeat(64)}/extra`,
    ]) {
      const response = await site.fetch(new Request(`https://rotor.pxbt.app${pathname}`), env);
      assert.equal(response.status, 404, pathname);
      assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), notFound), 0, pathname);
    }
  });
});

test('non-GET requests always pass through', async () => {
  await withSite(async (env, root) => {
    const response = await site.fetch(
      new Request(`https://rotor.pxbt.app/key/${OTHER}/`, { method: 'POST', body: 'x' }),
      env,
    );
    assert.equal(response.status, 404);
    assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), await readFile(path.join(root, '404.html'))), 0);
  });
});
