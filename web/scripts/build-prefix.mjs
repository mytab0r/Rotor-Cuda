#!/usr/bin/env node
/* Give the static build the same asset URL shape the coordinator serves:
 * every script/link reference points at /a/<build>/<path>.
 *
 * Astro/Vite already content-hashes its own output, but public assets keep
 * their stable paths. The project contract (AGENTS.md -> "Site assets carry
 * no cache-busting query") is a build-prefixed immutable URL with a no-store
 * HTML response, so the static app mirrors it instead of asking the audit to
 * special-case a second scheme.
 *
 * Runs after `astro build`. No dependencies, no network. */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WEB_ROOT, 'dist');
const ASSET = /\.(?:css|js|wasm|svg|woff2|png|ico)(?:[?#].*)?$/;

function buildId() {
  const fromEnv = process.env.ROTOR_BUILD_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'astro';
  }
}

function filesUnder(root, relative = '') {
  const out = [];
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      // Never copy a previous prefix into itself.
      if (!relative && entry.name === 'a') continue;
      out.push(...filesUnder(root, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

const id = buildId();
const prefix = `a/${id}`;
const files = filesUnder(DIST);
const assetFiles = files.filter((rel) => ASSET.test(rel));

for (const rel of assetFiles) {
  const target = path.join(DIST, prefix, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(DIST, rel), target);
}

// CSS loaded from the prefixed tree must fetch its fonts/images from the same
// immutable tree. The root copy stays untouched for coordinator compatibility.
for (const rel of assetFiles.filter((file) => file.endsWith('.css'))) {
  const target = path.join(DIST, prefix, rel);
  const css = readFileSync(target, 'utf8');
  const rewritten = css.replace(
    /url\((["']?)\/(?!a\/)([^)"']+)\1\)/g,
    (match, quote, asset) => (ASSET.test(asset) ? `url(${quote}/${prefix}/${asset}${quote})` : match),
  );
  if (rewritten !== css) writeFileSync(target, rewritten);
}

const htmlFiles = files.filter((rel) => rel.endsWith('.html'));
for (const rel of htmlFiles) {
  const file = path.join(DIST, rel);
  const html = readFileSync(file, 'utf8');
  let rewritten = html.replace(
    /(<(?:script|link|use)\b[^>]*?\b(?:src|href)=")(\/(?!a\/)[^"]+)(")/g,
    (match, before, ref, after) => (ASSET.test(ref) ? `${before}/${prefix}${ref}${after}` : match),
  );
  // Absolute first-party assets in metadata and JSON-LD (og:image, logo) use
  // the same immutable prefix as the served document. Page URLs, canonical and
  // og:url carry no asset extension and are left alone.
  rewritten = rewritten.replace(
    /https:\/\/rotor\.pxbt\.app\/(?!a\/)([^"'<>\s]+\.(?:css|js|wasm|svg|woff2|png|ico|jpe?g|webp))/g,
    (_match, asset) => `https://rotor.pxbt.app/${prefix}/${asset}`,
  );
  if (rewritten !== html) writeFileSync(file, rewritten);
}

const bytes = assetFiles.reduce((sum, rel) => sum + statSync(path.join(DIST, rel)).size, 0);
console.log(`build prefix: ${prefix} (${assetFiles.length} assets, ${bytes} bytes copied)`);
