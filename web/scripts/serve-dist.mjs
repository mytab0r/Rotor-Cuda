/* Zero-dependency static server for the built Astro output.
 *
 * The browser regression suite must run against the real artifacts in `dist/`
 * with no network. This server answers only same-origin file requests, folds
 * `/route/` to `/route/index.html`, refuses path traversal and never lists a
 * directory. It is test tooling, not part of the deployed site. */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4391);
const ROOT = path.resolve(process.env.DIST_DIR || 'dist');

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);

function resolveFile(requestPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestPath, 'http://localhost').pathname);
  } catch {
    return null;
  }
  const candidate = path.resolve(ROOT, `.${pathname}`);
  if (candidate !== ROOT && !candidate.startsWith(`${ROOT}${path.sep}`)) return null;
  const target = pathname.endsWith('/') || existsSync(candidate) && statSync(candidate).isDirectory()
    ? path.join(candidate, 'index.html')
    : candidate;
  return target;
}

const server = createServer((request, response) => {
  const method = request.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  const file = resolveFile(request.url || '/');
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found\n');
    return;
  }

  const type = MIME.get(path.extname(file).toLowerCase()) || 'application/octet-stream';
  response.writeHead(200, {
    'content-type': type,
    'content-length': statSync(file).size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(file).on('error', () => response.destroy()).pipe(response);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`dist server listening on http://${HOST}:${PORT} (${ROOT})\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
