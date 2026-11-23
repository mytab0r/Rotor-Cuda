#!/usr/bin/env node
// SEO gate for the prerendered chain directory (`/private-keys/<chain>`), its
// hub (`/private-keys`), the presentation pages (`/docs`, `/tools`), the
// pure-content pages (`/faq`, `/disclaimer`, `/donate`), the Bitcoin puzzle hub
// (`/bitcoin-puzzle`) and its detail pages (`/bitcoin-puzzle/<n>`), plus the
// root 404 document and the sitemap.
//
// Reads the built `web/dist` tree (no network, no dependencies) and fails when
// a page breaks the contract the SEO audit measured:
//   - title outside 50-60 characters (hubs: at most 60, intent first);
//   - description outside 120-160 characters with no concrete number;
//   - missing/incorrect canonical or robots;
//   - duplicate title or description between any two checked pages;
//   - a hidden H1 or too few visible content H2s (at least 2 for a chain page
//     or the hub, 3 for /docs);
//   - fewer than 40 rendered key/address rows;
//   - fewer than 120 unique prose words;
//   - 5-gram Jaccard similarity >= 0.50 between two chain pages' prose;
//   - a missing CollectionPage/BreadcrumbList JSON-LD or chain-named og:image:alt;
//   - on /docs and /tools: a TOC anchor that does not resolve to an existing
//     id, or a TOC that omits a content H2;
//   - on every presentation page: an internal link target that neither exists
//     in `dist` nor is listed in the explicit `pendingCutover` allowlist below
//     (with a reason);
//   - malformed JSON-LD, or missing the expected schema types;
//   - hub links missing for a chain page, or a hub internal link with no
//     built target in `web/dist`;
//   - a puzzle row or detail page whose number, target, solved flag or range
//     disagrees with `data/puzzles.json`, a missing/extra detail page, a
//     fabricated 64-hex private key, or a puzzle route in the sitemap that the
//     build renders noindex;
//   - a missing dist/404.html, a 404 without noindex, or a 404 without exactly
//     one H1 (Cloudflare Pages answers 200 with the landing page otherwise).
//
// Usage:
//   node scripts/check-seo.mjs [--dist web/dist] [--json report.json]
//
// Exit codes: 0 = pass, 1 = violations, 2 = harness error (missing build).

import { existsSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ORIGIN = 'https://rotor.pxbt.app';
const HUB_ROUTE = '/private-keys';
const PUZZLE_HUB_ROUTE = '/bitcoin-puzzle';
const TITLE_MIN = 50;
const TITLE_MAX = 60;
const HUB_TITLE_MAX = 60;
const DESCRIPTION_MIN = 120;
const DESCRIPTION_MAX = 160;
const MIN_UNIQUE_WORDS = 120;
const MIN_ROWS = 40;
const HUB_MIN_CONTENT_H2 = 2;
const PUZZLE_MIN_CONTENT_H2 = 2;
const MAX_JACCARD = 0.5;

/* Presentation pages added to the Astro build. They are checked in addition to
 * the chain set: one visible H1, content H2s, TOC coverage, resolving internal
 * links, unique metadata and parseable JSON-LD with the expected types. */
const PRESENTATION_PAGES = [
  {
    route: '/docs',
    file: path.join('docs', 'index.html'),
    label: 'docs',
    minContentH2: 3,
    requireToc: true,
    jsonLdTypes: ['TechArticle', 'BreadcrumbList'],
  },
  {
    route: '/tools',
    file: path.join('tools', 'index.html'),
    label: 'tools',
    minContentH2: 2,
    requireToc: false,
    jsonLdTypes: ['CollectionPage', 'BreadcrumbList'],
  },
  {
    route: '/faq',
    file: path.join('faq', 'index.html'),
    label: 'faq',
    minContentH2: 2,
    requireToc: false,
    jsonLdTypes: ['FAQPage', 'BreadcrumbList'],
  },
  {
    route: '/disclaimer',
    file: path.join('disclaimer', 'index.html'),
    label: 'disclaimer',
    minContentH2: 2,
    requireToc: false,
    jsonLdTypes: ['BreadcrumbList'],
  },
  {
    route: '/donate',
    file: path.join('donate', 'index.html'),
    label: 'donate',
    minContentH2: 2,
    requireToc: false,
    jsonLdTypes: ['BreadcrumbList'],
  },
];

/* Internal targets the new presentation pages link to that the static build
 * does not contain yet. The coordinator still serves each of these routes, so
 * the link is canonical today; the entry is removed when the route migrates. A
 * reason is mandatory and a target that already exists in `dist` fails as a
 * stale entry, so the list is shrink-only. */
const pendingCutover = new Map([
  ['/key', 'Key explorer and /key/<hex> calculators are still served by the coordinator (frontend-platform phase 3).'],
  ['/key/hex', 'Named calculator entry under the /key family; the coordinator serves it today (phase 3).'],
  ['/key/wif', 'Named calculator entry under the /key family; the coordinator serves it today (phase 3).'],
  ['/key/decimal', 'Named calculator entry under the /key family; the coordinator serves it today (phase 3).'],
  ['/mnemonic-seeds', 'Seed pages still served by the coordinator (phase 4).'],
  ['/seed', 'Seed studio still served by the coordinator (phase 4).'],
  ['/vanity', 'Vanity generator still served by the coordinator (phase 2).'],
  ['/milk-sad', 'Milk Sad audit still served by the coordinator (phase 2).'],
  ['/brainwallet', 'Brainwallet pages still served by the coordinator (phase 4).'],
  ['/brainwallet/bitcoin', 'Brainwallet pages still served by the coordinator (phase 4).'],
  ['/brainwallet/ethereum', 'Brainwallet pages still served by the coordinator (phase 4).'],
  ['/brainwallet-generator', 'Brainwallet generator still served by the coordinator (phase 4).'],
  ['/hex-dec-bin', 'Converter still served by the coordinator (phase 2).'],
  ['/public-key', 'Converter still served by the coordinator (phase 2).'],
  ['/pubkey-add', 'Converter still served by the coordinator (phase 2).'],
  ['/keystore-parser', 'Converter still served by the coordinator (phase 2).'],
  ['/reconstruction', 'Converter still served by the coordinator (phase 2).'],
  ['/tx', 'Transaction tools still served by the coordinator (phase 2).'],
  ['/tx/bitcoin', 'Transaction tools still served by the coordinator (phase 2).'],
  ['/tx/ethereum', 'Transaction tools still served by the coordinator (phase 2).'],
  ['/cabinet', 'Client-only cabinet still served by the coordinator (phase 5).'],
  ['/cabinet/wallet', 'Client-only wallet still served by the coordinator (phase 5).'],
  ['/me', 'Client account shell still served by the coordinator (phase 5).'],
  ['/run', 'Worker client shell still served by the coordinator (phase 5).'],
  ['/send', 'Testnet send page still served by the coordinator (phase 5).'],
  ['/wallets', 'Wallet database route is live on the coordinator; its cutover is not scheduled.'],
]);

const HELP = `check-seo - SEO gate for web/dist/private-keys, its chain pages, /docs, /tools, /faq, /disclaimer, /donate, /bitcoin-puzzle, its detail pages, sitemap.xml and 404.html

Options:
  --dist PATH   built Astro output (default: web/dist)
  --json PATH   write the measured report as JSON
  -h, --help    show this help

Exit: 0 = pass, 1 = violations, 2 = harness error.`;

function parseArgs(argv) {
  const options = {
    dist: path.join(REPO_ROOT, 'web', 'dist'),
    json: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      process.exit(0);
    } else if (arg === '--dist') {
      const value = argv[index + 1];
      if (!value) throw new Error('--dist needs a path');
      options.dist = path.resolve(value);
      index += 1;
    } else if (arg === '--json') {
      const value = argv[index + 1];
      if (!value) throw new Error('--json needs a path');
      options.json = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function decodeEntities(text) {
  const map = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    mdash: '—',
    ndash: '–',
    hellip: '…',
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    }
    return map[body.toLowerCase()] ?? ' ';
  });
}

function visibleText(fragment) {
  return decodeEntities(
    fragment
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensOf(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function gramsOf(tokens, size) {
  const grams = new Set();
  for (let index = 0; index + size <= tokens.length; index += 1) {
    grams.add(tokens.slice(index, index + size).join(' '));
  }
  return grams;
}

function jaccard(first, second) {
  if (first.size === 0 && second.size === 0) return 0;
  let shared = 0;
  for (const gram of first) {
    if (second.has(gram)) shared += 1;
  }
  return shared / (first.size + second.size - shared);
}

function attr(html, pattern) {
  const match = html.match(pattern);
  // A `(["'])([\s\S]*?)\1` pattern keeps a quote of the other kind inside the
  // value; older single-group patterns still return group 1.
  return match ? decodeEntities((match[2] ?? match[1]).trim()) : null;
}

function sectionByMarker(html, marker) {
  const match = html.match(new RegExp(`<section\\b[^>]*\\b${marker}\\b[^>]*>([\\s\\S]*?)</section>`, 'i'));
  return match ? match[1] : '';
}

function headings(fragment) {
  const out = [];
  const re = /<h([123])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = re.exec(fragment)) !== null) {
    const attrs = match[2] ?? '';
    const hidden = /\bhidden\b/i.test(attrs) ||
      /\baria-hidden\s*=\s*["']true["']/i.test(attrs) ||
      /\bclass\s*=\s*["'][^"']*visually-hidden/i.test(attrs) ||
      /\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs);
    out.push({
      level: Number(match[1]),
      hidden,
      text: visibleText(match[3]),
      id: attr(attrs, /\bid\s*=\s*["']([^"']*)["']/i),
    });
  }
  return out;
}

function sectionHtml(fragment) {
  const match = fragment.match(/<section\b[^>]*\bdata-seo-prose\b[^>]*>([\s\S]*?)<\/section>/i);
  return match ? match[1] : '';
}

function rowsOf(html) {
  const body = html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!body) return 0;
  return [...body[1].matchAll(/<tr\b[^>]*\bdata-key=/gi)].length;
}

/* Every relative target in the built tree, as POSIX paths, so a link check
 * never needs to guess an extension or a directory index. */
async function listDistFiles(root) {
  const files = new Set();
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) files.add(rel);
    }
  }
  await walk(root, '');
  return files;
}

/* A root-relative URL resolves when `dist` contains the directory index or a
 * matching file. Query strings and fragments are not part of the target. */
function resolvesInDist(files, pathname) {
  let target = pathname.split('#')[0].split('?')[0];
  if (!target.startsWith('/')) return false;
  target = target.replace(/^\/+/, '');
  if (target === '') return files.has('index.html');
  const trimmed = target.replace(/\/+$/, '');
  return files.has(`${trimmed}/index.html`) || files.has(`${trimmed}.html`) || files.has(trimmed);
}

function hrefsOf(html) {
  const out = [];
  const re = /<a\b[^>]*\bhref\s*=\s*(["'])([\s\S]*?)\1/gi;
  let match;
  while ((match = re.exec(html)) !== null) out.push(decodeEntities(match[2].trim()));
  return out;
}

function idCountsOf(html) {
  const counts = new Map();
  for (const match of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) {
    const id = decodeEntities(match[1]);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1]);
}

function typesOf(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) typesOf(item, out);
  } else if (value && typeof value === 'object') {
    const type = value['@type'];
    if (typeof type === 'string') out.add(type);
    if (Array.isArray(type)) type.forEach((item) => out.add(String(item)));
    for (const item of Object.values(value)) typesOf(item, out);
  }
  return out;
}

async function checkPresentationPage(spec, dist, distFiles) {
  const { route, file, label } = spec;
  const failures = [];
  const fail = (id, message) => failures.push(`[${id}] ${label}: ${message}`);
  const filePath = path.join(dist, file);
  let html;
  let bytes = 0;
  try {
    html = await readFile(filePath, 'utf8');
    bytes = (await stat(filePath)).size;
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail('seo-page-set', `missing built page ${file}; run the Astro build first`);
      return { label, route, bytes, failures };
    }
    throw error;
  }

  const title = attr(html, /<title>([\s\S]*?)<\/title>/i);
  const description = attr(html, /<meta\s+name=["']description["']\s+content=(["'])([\s\S]*?)\1/i);
  const canonical = attr(html, /<link\s+rel=["']canonical["']\s+href=(["'])([\s\S]*?)\1/i);
  const robots = attr(html, /<meta\s+name=["']robots["']\s+content=(["'])([\s\S]*?)\1/i);
  const ogImage = attr(html, /<meta\s+property=["']og:image["']\s+content=(["'])([\s\S]*?)\1/i);
  const ogImageAlt = attr(html, /<meta\s+property=["']og:image:alt["']\s+content=(["'])([\s\S]*?)\1/i);
  const twitterImageAlt = attr(html, /<meta\s+name=["']twitter:image:alt["']\s+content=(["'])([\s\S]*?)\1/i);

  if (!title) {
    fail('seo-metadata-bounds', 'missing <title>');
  } else if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    fail('seo-metadata-bounds', `title length ${title.length} outside ${TITLE_MIN}-${TITLE_MAX}: ${title}`);
  } else if (!title.endsWith('| Crypto')) {
    fail('seo-metadata-bounds', `title does not end with the brand: ${title}`);
  }

  if (!description) {
    fail('seo-metadata-bounds', 'missing meta description');
  } else if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    fail('seo-metadata-bounds', `description length ${description.length} outside ${DESCRIPTION_MIN}-${DESCRIPTION_MAX}`);
  }

  const expectedCanonical = `${SITE_ORIGIN}${route}`;
  if (!canonical) fail('seo-canonical-robots', 'missing canonical');
  else if (canonical !== expectedCanonical) fail('seo-canonical-robots', `canonical ${canonical} is not ${expectedCanonical}`);

  if (!robots) fail('seo-canonical-robots', 'missing robots meta');
  else if (!/index\s*,\s*follow/i.test(robots)) fail('seo-canonical-robots', `robots is not index,follow: ${robots}`);

  if (!ogImage) fail('seo-og-image-alt', 'missing og:image');
  if (!ogImageAlt) fail('seo-og-image-alt', 'missing og:image:alt');
  if (!twitterImageAlt) fail('seo-og-image-alt', 'missing twitter:image:alt');

  const allHeadings = headings(html);
  const h1s = allHeadings.filter((heading) => heading.level === 1);
  const visibleH1s = h1s.filter((heading) => !heading.hidden && heading.text);
  if (h1s.length === 0) fail('seo-hidden-heading', 'missing H1');
  else if (h1s.some((heading) => heading.hidden)) fail('seo-hidden-heading', 'H1 is visually hidden');
  if (visibleH1s.length !== 1) fail('seo-hidden-heading', `expected exactly one visible H1, found ${visibleH1s.length}`);

  const content = mainHtml(html);
  const contentH2s = headings(content).filter(
    (heading) => heading.level === 2 && !heading.hidden && heading.text,
  );
  if (contentH2s.length < spec.minContentH2) {
    fail('seo-hidden-heading', `only ${contentH2s.length} visible content H2(s), need at least ${spec.minContentH2}`);
  }

  const idCounts = idCountsOf(html);
  for (const [id, count] of idCounts) {
    if (count > 1) fail('seo-toc-anchor', `duplicate id "${id}" (${count} times)`);
  }

  let tocAnchors = 0;
  if (spec.requireToc) {
    const toc = html.match(/<nav\b[^>]*\bdata-docs-toc\b[^>]*>([\s\S]*?)<\/nav>/i);
    if (!toc) {
      fail('seo-toc-anchor', 'missing the TOC nav (data-docs-toc)');
    } else {
      const tocHrefs = [...toc[1].matchAll(/href\s*=\s*(["'])#([^"']+)\1/gi)]
        .map((match) => decodeEntities(match[2]));
      tocAnchors = tocHrefs.length;
      for (const anchor of tocHrefs) {
        if (!idCounts.has(anchor)) fail('seo-toc-anchor', `TOC anchor #${anchor} has no matching id`);
      }
      for (const heading of contentH2s) {
        if (!heading.id) {
          fail('seo-toc-anchor', `content H2 "${heading.text}" has no id`);
        } else if (!tocHrefs.includes(heading.id)) {
          fail('seo-toc-anchor', `content H2 "${heading.text}" (#${heading.id}) is missing from the TOC`);
        }
      }
      if (tocHrefs.length < spec.minContentH2) {
        fail('seo-toc-anchor', `TOC has only ${tocHrefs.length} anchor(s), need at least ${spec.minContentH2}`);
      }
    }
  }

  const internal = new Set();
  for (const href of hrefsOf(html)) {
    if (!href) continue;
    if (href.startsWith('#')) {
      const id = href.slice(1);
      if (!idCounts.has(id)) fail('seo-toc-anchor', `anchor ${href} has no matching id`);
      continue;
    }
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    const pathname = href.split('#')[0].split('?')[0];
    internal.add(pathname);
    if (resolvesInDist(distFiles, pathname)) continue;
    if (pendingCutover.has(pathname)) continue;
    fail('seo-internal-link', `${href} is not built and is not in the pendingCutover allowlist`);
  }

  const blocks = jsonLdBlocks(html);
  if (blocks.length === 0) {
    fail('seo-structured-data', 'no application/ld+json block');
  } else {
    const types = new Set();
    for (const block of blocks) {
      try {
        typesOf(JSON.parse(block), types);
      } catch (error) {
        fail('seo-structured-data', `JSON-LD does not parse: ${error.message}`);
      }
    }
    for (const type of spec.jsonLdTypes) {
      if (!types.has(type)) fail('seo-structured-data', `JSON-LD is missing ${type}`);
    }
  }

  return {
    label,
    route,
    bytes,
    title,
    titleLength: title?.length ?? 0,
    description,
    descriptionLength: description?.length ?? 0,
    canonical,
    robots,
    contentH2s: contentH2s.length,
    tocAnchors,
    internalLinks: internal.size,
    failures,
  };
}

async function chainSlugs() {
  const file = path.join(REPO_ROOT, 'data', 'chains.json');
  const data = JSON.parse(await readFile(file, 'utf8'));
  return data.chains
    .filter((chain) => !chain.testnet)
    .sort((a, b) => a.order - b.order)
    .map((chain) => chain.slug);
}

function mainHtml(html) {
  const match = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return match ? match[1] : '';
}

/* ------------------------------------------------------------ puzzle pages */
/* `data/puzzles.json` is the machine source for the puzzle hub and its 160
 * detail pages. The gate compares every rendered row and page against this
 * file, so a fabricated number, target or solved flag fails the build. */

async function loadPuzzleData() {
  const file = path.join(REPO_ROOT, 'data', 'puzzles.json');
  let data;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.code ?? error.message}`);
  }
  if (!Number.isInteger(data.count) || !Array.isArray(data.puzzles)) {
    throw new Error(`${file}: expected a count and a puzzles array`);
  }
  if (data.puzzles.length !== data.count) {
    throw new Error(`${file}: count ${data.count} does not match ${data.puzzles.length} rows`);
  }
  const numbers = new Set();
  for (const puzzle of data.puzzles) {
    if (!Number.isInteger(puzzle.number) || puzzle.number < 1 || puzzle.number > data.count) {
      throw new Error(`${file}: bad puzzle number ${puzzle.number}`);
    }
    if (numbers.has(puzzle.number)) throw new Error(`${file}: duplicate puzzle #${puzzle.number}`);
    numbers.add(puzzle.number);
    if (typeof puzzle.target !== 'string' || typeof puzzle.solved !== 'boolean') {
      throw new Error(`${file}: puzzle #${puzzle.number} needs a target string and a solved boolean`);
    }
  }
  return data;
}

function puzzleIndexable(puzzle, data) {
  return (
    /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(puzzle.target) &&
    puzzle.number >= 1 &&
    puzzle.number <= data.count
  );
}

function puzzleRangeHex(number) {
  const start = (1n << BigInt(number - 1)).toString(16).padStart(64, '0');
  const end = ((1n << BigInt(number)) - 1n).toString(16).padStart(64, '0');
  return { start, end };
}

/* One parsed `<tr>` from the hub table. The page writes the dataset values as
 * data attributes, which lets the gate compare them without re-parsing prose. */
function puzzleRowsOf(html) {
  const rows = [];
  const re = /<tr\b([^>]*\bdata-puzzle-number=["'](\d+)["'][^>]*)>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1];
    rows.push({
      number: Number(match[2]),
      target: attr(attrs, /\bdata-puzzle-target\s*=\s*["']([^"']+)["']/i),
      status: attr(attrs, /\bdata-puzzle-status\s*=\s*["']([^"']+)["']/i),
      text: visibleText(match[3]),
    });
  }
  return rows;
}

async function loadPuzzleDetailPages(dist) {
  const root = path.join(dist, 'bitcoin-puzzle');
  const pages = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return pages;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const file = path.join(root, entry.name, 'index.html');
    try {
      const info = await stat(file);
      pages.push({
        number: Number(entry.name),
        file,
        bytes: info.size,
        html: await readFile(file, 'utf8'),
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return pages.sort((left, right) => left.number - right.number);
}

function checkPuzzleHub(page, data, distFiles) {
  const failures = [];
  const fail = (id, message) => failures.push(`[${id}] ${message}`);
  const { html } = page;

  const title = attr(html, /<title>([\s\S]*?)<\/title>/i);
  const description = attr(html, /<meta\s+name=["']description["']\s+content=(["'])([\s\S]*?)\1/i);
  const canonical = attr(html, /<link\s+rel=["']canonical["']\s+href=(["'])([\s\S]*?)\1/i);
  const robots = attr(html, /<meta\s+name=["']robots["']\s+content=(["'])([\s\S]*?)\1/i);
  const ogImage = attr(html, /<meta\s+property=["']og:image["']\s+content=(["'])([\s\S]*?)\1/i);
  const ogImageAlt = attr(html, /<meta\s+property=["']og:image:alt["']\s+content=(["'])([\s\S]*?)\1/i);
  const twitterImageAlt = attr(html, /<meta\s+name=["']twitter:image:alt["']\s+content=(["'])([\s\S]*?)\1/i);

  if (!title) {
    fail('seo-metadata-bounds', 'missing <title>');
  } else if (title.length > HUB_TITLE_MAX) {
    fail('seo-metadata-bounds', `title length ${title.length} over ${HUB_TITLE_MAX}: ${title}`);
  } else if (!/^Bitcoin puzzle browser/i.test(title)) {
    fail('seo-metadata-bounds', `title does not start with the hub intent: ${title}`);
  } else if (!title.endsWith('| Crypto')) {
    fail('seo-metadata-bounds', `title does not end with the brand: ${title}`);
  }

  if (!description) {
    fail('seo-metadata-bounds', 'missing meta description');
  } else if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    fail('seo-metadata-bounds', `description length ${description.length} outside ${DESCRIPTION_MIN}-${DESCRIPTION_MAX}`);
  } else if (!new RegExp(`\\b${data.count}\\b`).test(description)) {
    fail('seo-metadata-bounds', `description does not name the ${data.count} puzzles`);
  }

  const expectedCanonical = `${SITE_ORIGIN}${PUZZLE_HUB_ROUTE}`;
  if (!canonical) fail('seo-canonical-robots', 'missing canonical');
  else if (canonical !== expectedCanonical) fail('seo-canonical-robots', `canonical ${canonical} is not ${expectedCanonical}`);
  if (!robots) fail('seo-canonical-robots', 'missing robots meta');
  else if (!/index\s*,\s*follow/i.test(robots)) fail('seo-canonical-robots', `robots is not index,follow: ${robots}`);

  if (!ogImage) fail('seo-og-image-alt', 'missing og:image');
  if (!ogImageAlt) fail('seo-og-image-alt', 'missing og:image:alt');
  else if (!/bitcoin puzzle/i.test(ogImageAlt) || !new RegExp(`\\b${data.count}\\b`).test(ogImageAlt)) {
    fail('seo-og-image-alt', `og:image:alt does not describe the hub: ${ogImageAlt}`);
  }
  if (!twitterImageAlt) fail('seo-og-image-alt', 'missing twitter:image:alt');
  else if (!/bitcoin puzzle/i.test(twitterImageAlt)) {
    fail('seo-og-image-alt', `twitter:image:alt does not describe the hub: ${twitterImageAlt}`);
  }

  const allHeadings = headings(html);
  const h1s = allHeadings.filter((heading) => heading.level === 1);
  const visibleH1s = h1s.filter((heading) => !heading.hidden && heading.text);
  if (h1s.length === 0) fail('seo-hidden-heading', 'missing H1');
  else if (h1s.some((heading) => heading.hidden)) fail('seo-hidden-heading', 'H1 is visually hidden');
  if (visibleH1s.length !== 1) fail('seo-hidden-heading', `expected exactly one visible H1, found ${visibleH1s.length}`);
  else if (visibleH1s[0].text !== 'Bitcoin puzzle') {
    fail('seo-hidden-heading', `H1 is "${visibleH1s[0].text}", expected "Bitcoin puzzle"`);
  }

  const main = mainHtml(html);
  const contentH2s = headings(main).filter(
    (heading) => heading.level === 2 && !heading.hidden && heading.text,
  );
  if (contentH2s.length < PUZZLE_MIN_CONTENT_H2) {
    fail('seo-hidden-heading', `only ${contentH2s.length} visible content H2(s), need at least ${PUZZLE_MIN_CONTENT_H2}`);
  }

  const tableCount = attr(html, /\bdata-puzzle-count=["'](\d+)["']/i);
  if (Number(tableCount) !== data.count) {
    fail('seo-puzzle-rows', `table data-puzzle-count is ${tableCount}, expected ${data.count}`);
  }
  const rows = puzzleRowsOf(main);
  if (rows.length !== data.count) {
    fail('seo-puzzle-rows', `rendered ${rows.length} puzzle rows, expected ${data.count}`);
  }
  for (let index = 0; index < Math.min(rows.length, data.puzzles.length); index += 1) {
    const row = rows[index];
    const expected = data.puzzles[index];
    if (row.number !== expected.number) {
      fail('seo-puzzle-rows', `row ${index + 1} is puzzle #${row.number}, expected #${expected.number}`);
    }
    if (row.target !== expected.target) {
      fail('seo-puzzle-data', `puzzle #${expected.number} target ${row.target} is not ${expected.target}`);
    }
    const status = expected.solved ? 'solved' : 'unsolved';
    if (row.status !== status) {
      fail('seo-puzzle-data', `puzzle #${expected.number} status ${row.status} is not ${status}`);
    }
    if (!row.text.includes(expected.target)) {
      fail('seo-puzzle-data', `puzzle #${expected.number} row does not show its target`);
    }
    const pill = expected.solved ? 'Solved' : 'Unsolved';
    if (!row.text.includes(pill)) {
      fail('seo-puzzle-data', `puzzle #${expected.number} row has no "${pill}" pill`);
    }
  }

  const seenTargets = new Set();
  let checkedTargets = 0;
  for (const href of hrefsOf(html)) {
    if (!href || !href.startsWith('/') || href.startsWith('//')) continue;
    const pathname = href.split('#')[0].split('?')[0];
    if (seenTargets.has(pathname)) continue;
    seenTargets.add(pathname);
    checkedTargets += 1;
    if (resolvesInDist(distFiles, pathname) || pendingCutover.has(pathname)) continue;
    fail('seo-internal-link', `${href} is not built`);
  }

  const blocks = jsonLdBlocks(html);
  if (blocks.length === 0) {
    fail('seo-structured-data', 'no application/ld+json block');
  } else {
    const types = new Set();
    for (const block of blocks) {
      try {
        typesOf(JSON.parse(block), types);
      } catch (error) {
        fail('seo-structured-data', `JSON-LD does not parse: ${error.message}`);
      }
    }
    for (const type of ['CollectionPage', 'BreadcrumbList', 'ItemList']) {
      if (!types.has(type)) fail('seo-structured-data', `JSON-LD is missing ${type}`);
    }
    const joined = blocks.join('\n');
    if (!new RegExp(`"numberOfItems"\\s*:\\s*${data.count}\\b`).test(joined)) {
      fail('seo-structured-data', `JSON-LD numberOfItems is not ${data.count}`);
    }
  }

  return {
    route: PUZZLE_HUB_ROUTE,
    bytes: page.bytes,
    title,
    titleLength: title?.length ?? 0,
    description,
    descriptionLength: description?.length ?? 0,
    canonical,
    robots,
    contentH2s: contentH2s.length,
    rows: rows.length,
    internalLinks: checkedTargets,
    failures,
  };
}

function checkPuzzleDetail(page, puzzle, data, distFiles) {
  const { number, target, solved } = puzzle;
  const failures = [];
  const fail = (id, message) => failures.push(`[${id}] #${number}: ${message}`);
  const { html } = page;
  const indexable = puzzleIndexable(puzzle, data);

  const title = attr(html, /<title>([\s\S]*?)<\/title>/i);
  const description = attr(html, /<meta\s+name=["']description["']\s+content=(["'])([\s\S]*?)\1/i);
  const canonical = attr(html, /<link\s+rel=["']canonical["']\s+href=(["'])([\s\S]*?)\1/i);
  const robots = attr(html, /<meta\s+name=["']robots["']\s+content=(["'])([\s\S]*?)\1/i);
  const ogImage = attr(html, /<meta\s+property=["']og:image["']\s+content=(["'])([\s\S]*?)\1/i);
  const ogImageAlt = attr(html, /<meta\s+property=["']og:image:alt["']\s+content=(["'])([\s\S]*?)\1/i);
  const twitterImageAlt = attr(html, /<meta\s+name=["']twitter:image:alt["']\s+content=(["'])([\s\S]*?)\1/i);

  if (!title) {
    fail('seo-metadata-bounds', 'missing <title>');
  } else if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    fail('seo-metadata-bounds', `title length ${title.length} outside ${TITLE_MIN}-${TITLE_MAX}: ${title}`);
  } else if (!title.includes(`#${number}`)) {
    fail('seo-metadata-bounds', `title does not name puzzle #${number}: ${title}`);
  } else if (!title.endsWith('| Crypto')) {
    fail('seo-metadata-bounds', `title does not end with the brand: ${title}`);
  }

  if (!description) {
    fail('seo-metadata-bounds', 'missing meta description');
  } else if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    fail('seo-metadata-bounds', `description length ${description.length} outside ${DESCRIPTION_MIN}-${DESCRIPTION_MAX}`);
  } else if (!description.includes(target)) {
    fail('seo-metadata-bounds', 'description does not carry the puzzle target');
  }

  const expectedCanonical = `${SITE_ORIGIN}${PUZZLE_HUB_ROUTE}/${number}`;
  if (!canonical) fail('seo-canonical-robots', 'missing canonical');
  else if (canonical !== expectedCanonical) fail('seo-canonical-robots', `canonical ${canonical} is not ${expectedCanonical}`);
  if (!robots) fail('seo-canonical-robots', 'missing robots meta');
  else if (indexable && !/index\s*,\s*follow/i.test(robots)) {
    fail('seo-canonical-robots', `robots is not index,follow: ${robots}`);
  } else if (!indexable && !/noindex/i.test(robots)) {
    fail('seo-canonical-robots', `thin page is not noindex: ${robots}`);
  }

  if (!ogImage) fail('seo-og-image-alt', 'missing og:image');
  if (!ogImageAlt) fail('seo-og-image-alt', 'missing og:image:alt');
  else if (!ogImageAlt.toLowerCase().includes(target.toLowerCase())) {
    fail('seo-og-image-alt', `og:image:alt does not name the target: ${ogImageAlt}`);
  }
  if (!twitterImageAlt) fail('seo-og-image-alt', 'missing twitter:image:alt');

  const allHeadings = headings(html);
  const h1s = allHeadings.filter((heading) => heading.level === 1);
  const visibleH1s = h1s.filter((heading) => !heading.hidden && heading.text);
  if (h1s.length === 0) fail('seo-hidden-heading', 'missing H1');
  else if (h1s.some((heading) => heading.hidden)) fail('seo-hidden-heading', 'H1 is visually hidden');
  if (visibleH1s.length !== 1) fail('seo-hidden-heading', `expected exactly one visible H1, found ${visibleH1s.length}`);
  else if (visibleH1s[0].text !== `Bitcoin puzzle #${number}`) {
    fail('seo-hidden-heading', `H1 is "${visibleH1s[0].text}"`);
  }

  const main = mainHtml(html);
  const contentH2s = headings(main).filter(
    (heading) => heading.level === 2 && !heading.hidden && heading.text,
  );
  if (contentH2s.length < PUZZLE_MIN_CONTENT_H2) {
    fail('seo-hidden-heading', `only ${contentH2s.length} visible content H2(s), need at least ${PUZZLE_MIN_CONTENT_H2}`);
  }

  const pageNumber = attr(html, /\bdata-puzzle-number=["'](\d+)["']/i);
  const pageTarget = attr(html, /\bdata-puzzle-target=["']([^"']+)["']/i);
  const pageStatus = attr(html, /\bdata-puzzle-status=["']([^"']+)["']/i);
  const expectedStatus = solved ? 'solved' : 'unsolved';
  if (Number(pageNumber) !== number) {
    fail('seo-puzzle-data', `page data-puzzle-number is ${pageNumber}, expected ${number}`);
  }
  if (pageTarget !== target) {
    fail('seo-puzzle-data', `page target ${pageTarget} is not ${target}`);
  }
  if (pageStatus !== expectedStatus) {
    fail('seo-puzzle-data', `page status ${pageStatus} is not ${expectedStatus}`);
  }
  const mainText = visibleText(main);
  if (!mainText.includes(target)) {
    fail('seo-puzzle-data', 'target address is not visible in the main content');
  }
  const pill = solved ? 'Solved' : 'Unsolved';
  if (!mainText.includes(pill)) {
    fail('seo-puzzle-data', `main content has no "${pill}" status pill`);
  }

  const range = puzzleRangeHex(number);
  if (!html.includes(range.start)) {
    fail('seo-puzzle-data', `range start ${range.start} is not rendered`);
  }
  if (!html.includes(range.end)) {
    fail('seo-puzzle-data', `range end ${range.end} is not rendered`);
  }
  const allowedCopyValues = new Set([target, range.start, range.end]);
  for (const match of html.matchAll(/\bdata-copy=["']([^"']+)["']/gi)) {
    const value = decodeEntities(match[1]);
    if (!allowedCopyValues.has(value)) {
      fail('seo-puzzle-data', `copy control carries an unexpected value: ${value}`);
    }
  }

  /* No fabricated key: a 64-hex value labelled as a private key, or an explicit
   * secret data attribute. The inclusive range hex is legitimate and appears
   * without a "private key" label. */
  if (/(?:private\s*key|priv(?:ate)?\s*key)[^<>]{0,48}\b[0-9a-f]{64}\b/i.test(mainText)) {
    fail('seo-puzzle-fabricated-key', 'a 64-hex value is presented as a private key');
  }
  if (/\bdata-(?:private|priv|secret)-key\b/i.test(html)) {
    fail('seo-puzzle-fabricated-key', 'page carries a private-key data attribute');
  }

  const proseTokens = tokensOf(mainText);
  const uniqueWords = new Set(proseTokens).size;
  if (uniqueWords < MIN_UNIQUE_WORDS) {
    fail('seo-prose-uniqueness', `only ${uniqueWords} unique prose words, need at least ${MIN_UNIQUE_WORDS}`);
  }

  const seenTargets = new Set();
  for (const href of hrefsOf(html)) {
    if (!href || !href.startsWith('/') || href.startsWith('//')) continue;
    const pathname = href.split('#')[0].split('?')[0];
    if (seenTargets.has(pathname)) continue;
    seenTargets.add(pathname);
    if (resolvesInDist(distFiles, pathname) || pendingCutover.has(pathname)) continue;
    fail('seo-internal-link', `${href} is not built`);
  }

  const blocks = jsonLdBlocks(html);
  if (blocks.length === 0) {
    fail('seo-structured-data', 'no application/ld+json block');
  } else {
    const types = new Set();
    for (const block of blocks) {
      try {
        typesOf(JSON.parse(block), types);
      } catch (error) {
        fail('seo-structured-data', `JSON-LD does not parse: ${error.message}`);
      }
    }
    for (const type of ['WebPage', 'BreadcrumbList']) {
      if (!types.has(type)) fail('seo-structured-data', `JSON-LD is missing ${type}`);
    }
  }

  return {
    label: `puzzle-${number}`,
    number,
    indexable,
    bytes: page.bytes,
    title,
    titleLength: title?.length ?? 0,
    description,
    descriptionLength: description?.length ?? 0,
    canonical,
    robots,
    contentH2s: contentH2s.length,
    uniqueWords,
    failures,
  };
}

async function checkPuzzleSitemap(dist, data) {
  const failures = [];
  const fail = (id, message) => failures.push(`[${id}] ${message}`);
  const file = path.join(dist, 'sitemap.xml');
  let xml;
  try {
    xml = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail('seo-puzzle-sitemap', 'missing sitemap.xml');
      return { locs: 0, failures };
    }
    throw error;
  }
  const locs = new Set(
    [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((match) => match[1].trim()),
  );
  const hub = `${SITE_ORIGIN}${PUZZLE_HUB_ROUTE}`;
  if (!locs.has(hub)) fail('seo-puzzle-sitemap', `sitemap is missing ${hub}`);
  const expected = new Set();
  for (const puzzle of data.puzzles) {
    if (!puzzleIndexable(puzzle, data)) continue;
    expected.add(`${SITE_ORIGIN}${PUZZLE_HUB_ROUTE}/${puzzle.number}`);
  }
  for (const loc of expected) {
    if (!locs.has(loc)) fail('seo-puzzle-sitemap', `sitemap is missing indexable ${loc}`);
  }
  for (const loc of locs) {
    if (!loc.startsWith(`${SITE_ORIGIN}${PUZZLE_HUB_ROUTE}/`)) continue;
    if (!expected.has(loc)) fail('seo-puzzle-sitemap', `sitemap lists a non-indexable page ${loc}`);
  }
  return { locs: locs.size, failures };
}

function proseSections(html) {
  return [...html.matchAll(/<section\b[^>]*\bdata-seo-prose\b[^>]*>([\s\S]*?)<\/section>/gi)]
    .map((match) => match[1]);
}

function anchorsIn(fragment) {
  return [...fragment.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => decodeEntities(match[1].trim()));
}

/* Resolve a first-party href to the spelling the gate can test. External URLs,
 * fragments and non-HTTP schemes are not part of the internal-target check. */
function internalPath(href) {
  if (!href || href.startsWith('#') || /^(?:mailto:|tel:|javascript:)/i.test(href)) return null;
  if (href.startsWith(`${SITE_ORIGIN}/`) || href === SITE_ORIGIN) {
    return new URL(href).pathname;
  }
  if (href.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  if (href.startsWith('/')) return href.split('#')[0].split('?')[0];
  return new URL(href, `${SITE_ORIGIN}/private-keys/`).pathname;
}

/* Astro builds `format: directory`, so a route lives at `<route>/index.html`;
 * assets keep their literal path. */
function targetExists(dist, pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidates = [];
  if (relative === '') candidates.push('index.html');
  else if (relative.endsWith('/')) candidates.push(path.join(relative, 'index.html'));
  else candidates.push(relative, `${relative}.html`, path.join(relative, 'index.html'));
  return candidates.some((candidate) => existsSync(path.join(dist, candidate)));
}

async function loadHub(dist) {
  const file = path.join(dist, 'private-keys', 'index.html');
  try {
    const info = await stat(file);
    return { file, bytes: info.size, html: await readFile(file, 'utf8') };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function checkHub(page, slugs, chainResults, dist) {
  const failures = [];
  const fail = (id, message) => failures.push(`[${id}] ${message}`);
  const { html } = page;

  const title = attr(html, /<title>([\s\S]*?)<\/title>/i);
  const description = attr(html, /<meta\s+name=["']description["']\s+content=(["'])([\s\S]*?)\1/i);
  const canonical = attr(html, /<link\s+rel=["']canonical["']\s+href=(["'])([\s\S]*?)\1/i);
  const robots = attr(html, /<meta\s+name=["']robots["']\s+content=(["'])([\s\S]*?)\1/i);
  const ogImage = attr(html, /<meta\s+property=["']og:image["']\s+content=(["'])([\s\S]*?)\1/i);
  const ogImageAlt = attr(html, /<meta\s+property=["']og:image:alt["']\s+content=(["'])([\s\S]*?)\1/i);
  const twitterImage = attr(html, /<meta\s+name=["']twitter:image["']\s+content=(["'])([\s\S]*?)\1/i);
  const twitterImageAlt = attr(html, /<meta\s+name=["']twitter:image:alt["']\s+content=(["'])([\s\S]*?)\1/i);

  if (!title) {
    fail('seo-metadata-bounds', 'missing <title>');
  } else if (title.length > HUB_TITLE_MAX) {
    fail('seo-metadata-bounds', `title length ${title.length} over ${HUB_TITLE_MAX}: ${title}`);
  } else if (!/^private keys by chain/i.test(title)) {
    fail('seo-metadata-bounds', `title does not start with the hub intent: ${title}`);
  }

  if (!description) {
    fail('seo-metadata-bounds', 'missing meta description');
  } else if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    fail('seo-metadata-bounds', `description length ${description.length} outside ${DESCRIPTION_MIN}-${DESCRIPTION_MAX}`);
  } else if (!new RegExp(`\\b${slugs.length}\\b`).test(description)) {
    fail('seo-metadata-bounds', `description does not name the ${slugs.length} chains: ${description}`);
  }

  const expectedCanonical = `${SITE_ORIGIN}${HUB_ROUTE}`;
  if (!canonical) fail('seo-canonical-robots', 'missing canonical');
  else if (canonical !== expectedCanonical) fail('seo-canonical-robots', `canonical ${canonical} is not ${expectedCanonical}`);

  if (!robots) fail('seo-canonical-robots', 'missing robots meta');
  else if (!/index\s*,\s*follow/i.test(robots)) fail('seo-canonical-robots', `robots is not index,follow: ${robots}`);

  if (!ogImage) fail('seo-og-image-alt', 'missing og:image');
  if (!twitterImage) fail('seo-og-image-alt', 'missing twitter:image');
  if (!ogImageAlt) fail('seo-og-image-alt', 'missing og:image:alt');
  else if (!/private keys/i.test(ogImageAlt) || !new RegExp(`\\b${slugs.length}\\b`).test(ogImageAlt)) {
    fail('seo-og-image-alt', `og:image:alt does not describe the hub: ${ogImageAlt}`);
  }
  if (!twitterImageAlt) fail('seo-og-image-alt', 'missing twitter:image:alt');
  else if (!/private keys/i.test(twitterImageAlt)) {
    fail('seo-og-image-alt', `twitter:image:alt does not describe the hub: ${twitterImageAlt}`);
  }

  const allHeadings = headings(html);
  const h1s = allHeadings.filter((heading) => heading.level === 1);
  const visibleH1s = h1s.filter((heading) => !heading.hidden && heading.text);
  if (h1s.length === 0) fail('seo-hidden-heading', 'missing H1');
  else if (h1s.some((heading) => heading.hidden)) fail('seo-hidden-heading', 'H1 is visually hidden');
  if (visibleH1s.length !== 1) fail('seo-hidden-heading', `expected exactly one visible H1, found ${visibleH1s.length}`);
  else if (visibleH1s[0].text !== 'Private keys by chain') {
    fail('seo-hidden-heading', `H1 is "${visibleH1s[0].text}", expected "Private keys by chain"`);
  }

  const contentH2s = proseSections(html)
    .flatMap((section) => headings(section))
    .filter((heading) => heading.level === 2 && !heading.hidden && heading.text);
  if (contentH2s.length < HUB_MIN_CONTENT_H2) {
    fail('seo-hidden-heading', `only ${contentH2s.length} visible content H2(s), need at least ${HUB_MIN_CONTENT_H2}`);
  }

  const main = mainHtml(html);
  const hrefs = anchorsIn(main);
  const linked = new Set();
  for (const href of hrefs) {
    const pathname = internalPath(href);
    if (!pathname) continue;
    const match = pathname.match(/^\/private-keys\/([a-z0-9-]+)\/?$/);
    if (match) linked.add(match[1]);
  }
  const missing = slugs.filter((slug) => !linked.has(slug));
  if (missing.length) {
    fail('seo-hub-links', `hub is missing links to: ${missing.join(', ')}`);
  }

  const seenTargets = new Set();
  let checkedTargets = 0;
  for (const href of hrefs) {
    const pathname = internalPath(href);
    if (!pathname || seenTargets.has(pathname)) continue;
    seenTargets.add(pathname);
    checkedTargets += 1;
    if (!targetExists(dist, pathname)) {
      fail('seo-hub-links', `internal link ${href} has no built target in dist`);
    }
  }

  const jsonLd = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .join('\n');
  if (!jsonLd.includes('"CollectionPage"')) fail('seo-structured-data', 'JSON-LD is missing CollectionPage');
  if (!jsonLd.includes('"BreadcrumbList"')) fail('seo-structured-data', 'JSON-LD is missing BreadcrumbList');
  if (!jsonLd.includes('"ItemList"')) fail('seo-structured-data', 'JSON-LD is missing the chain ItemList');
  else if (!new RegExp(`"numberOfItems"\\s*:\\s*${slugs.length}\\b`).test(jsonLd)) {
    fail('seo-structured-data', `JSON-LD numberOfItems is not ${slugs.length}`);
  }

  for (const result of chainResults) {
    if (title && result.title === title) {
      fail('seo-duplicate-metadata', `hub title duplicates ${result.slug}`);
    }
    if (description && result.description === description) {
      fail('seo-duplicate-metadata', `hub description duplicates ${result.slug}`);
    }
  }

  return {
    route: HUB_ROUTE,
    bytes: page.bytes,
    title,
    titleLength: title?.length ?? 0,
    description,
    descriptionLength: description?.length ?? 0,
    canonical,
    robots,
    contentH2s: contentH2s.length,
    chainLinks: slugs.length - missing.length,
    internalLinks: checkedTargets,
    failures,
  };
}

async function loadPages(dist) {
  const root = path.join(dist, 'private-keys');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`missing built directory ${root} (${error.code ?? error.message}); run the Astro build first`);
  }
  const pages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'index.html');
    try {
      const info = await stat(file);
      const html = await readFile(file, 'utf8');
      pages.push({ slug: entry.name, file, bytes: info.size, html });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return pages.sort((a, b) => a.slug.localeCompare(b.slug));
}

function checkPage(page, expectedSlugs) {
  const { slug, html } = page;
  const failures = [];
  const fail = (id, message) => failures.push(`[${id}] ${message}`);
  const chainData = expectedSlugs.get(slug);
  const name = chainData?.name ?? slug;

  const title = attr(html, /<title>([\s\S]*?)<\/title>/i);
  const description = attr(html, /<meta\s+name=["']description["']\s+content=(["'])([\s\S]*?)\1/i);
  const canonical = attr(html, /<link\s+rel=["']canonical["']\s+href=(["'])([\s\S]*?)\1/i);
  const robots = attr(html, /<meta\s+name=["']robots["']\s+content=(["'])([\s\S]*?)\1/i);
  const ogImage = attr(html, /<meta\s+property=["']og:image["']\s+content=(["'])([\s\S]*?)\1/i);
  const ogImageAlt = attr(html, /<meta\s+property=["']og:image:alt["']\s+content=(["'])([\s\S]*?)\1/i);
  const twitterImageAlt = attr(html, /<meta\s+name=["']twitter:image:alt["']\s+content=(["'])([\s\S]*?)\1/i);

  if (!title) {
    fail('seo-metadata-bounds', 'missing <title>');
  } else if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    fail('seo-metadata-bounds', `title length ${title.length} outside ${TITLE_MIN}-${TITLE_MAX}: ${title}`);
  } else if (!title.startsWith(name)) {
    fail('seo-metadata-bounds', `title does not start with the chain name "${name}": ${title}`);
  } else if (!title.endsWith('| Crypto')) {
    fail('seo-metadata-bounds', `title does not end with the brand: ${title}`);
  }

  if (!description) {
    fail('seo-metadata-bounds', 'missing meta description');
  } else if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    fail('seo-metadata-bounds', `description length ${description.length} outside ${DESCRIPTION_MIN}-${DESCRIPTION_MAX}`);
  } else if (!/\d/.test(description)) {
    fail('seo-metadata-bounds', 'description has no concrete number');
  }

  const expectedCanonical = `${SITE_ORIGIN}/private-keys/${slug}`;
  if (!canonical) fail('seo-canonical-robots', 'missing canonical');
  else if (canonical !== expectedCanonical) fail('seo-canonical-robots', `canonical ${canonical} is not ${expectedCanonical}`);

  if (!robots) fail('seo-canonical-robots', 'missing robots meta');
  else if (!/index\s*,\s*follow/i.test(robots)) fail('seo-canonical-robots', `robots is not index,follow: ${robots}`);

  if (!ogImage) fail('seo-og-image-alt', 'missing og:image');
  if (!ogImageAlt) fail('seo-og-image-alt', 'missing og:image:alt');
  else if (!ogImageAlt.toLowerCase().includes(name.toLowerCase())) {
    fail('seo-og-image-alt', `og:image:alt does not name ${name}: ${ogImageAlt}`);
  }
  if (!twitterImageAlt) fail('seo-og-image-alt', 'missing twitter:image:alt');
  else if (!twitterImageAlt.toLowerCase().includes(name.toLowerCase())) {
    fail('seo-og-image-alt', `twitter:image:alt does not name ${name}: ${twitterImageAlt}`);
  }

  const allHeadings = headings(html);
  const h1s = allHeadings.filter((heading) => heading.level === 1);
  const visibleH1s = h1s.filter((heading) => !heading.hidden && heading.text);
  if (h1s.length === 0) fail('seo-hidden-heading', 'missing H1');
  else if (h1s.some((heading) => heading.hidden)) fail('seo-hidden-heading', 'H1 is visually hidden');
  if (visibleH1s.length !== 1) fail('seo-hidden-heading', `expected exactly one visible H1, found ${visibleH1s.length}`);
  else if (visibleH1s[0].text !== `${name} private keys`) {
    fail('seo-hidden-heading', `H1 is "${visibleH1s[0].text}", expected "${name} private keys"`);
  }

  const contentSection = sectionHtml(html);
  const contentH2s = headings(contentSection).filter((heading) => heading.level === 2 && !heading.hidden && heading.text);
  if (contentH2s.length < 2) fail('seo-hidden-heading', `only ${contentH2s.length} visible content H2(s), need at least 2`);

  const rows = rowsOf(html);
  if (rows < MIN_ROWS) fail('seo-rendered-rows', `only ${rows} rendered data rows, need at least ${MIN_ROWS}`);

  const prose = visibleText(contentSection);
  const proseTokens = tokensOf(prose);
  const uniqueWords = new Set(proseTokens).size;
  if (uniqueWords < MIN_UNIQUE_WORDS) {
    fail('seo-prose-uniqueness', `only ${uniqueWords} unique prose words, need at least ${MIN_UNIQUE_WORDS}`);
  }

  const jsonLd = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .join('\n');
  if (!jsonLd.includes('"CollectionPage"')) fail('seo-structured-data', 'JSON-LD is missing CollectionPage');
  if (!jsonLd.includes('"BreadcrumbList"')) fail('seo-structured-data', 'JSON-LD is missing BreadcrumbList');

  return {
    slug,
    name,
    bytes: page.bytes,
    title,
    titleLength: title?.length ?? 0,
    description,
    descriptionLength: description?.length ?? 0,
    canonical,
    robots,
    rows,
    contentH2s: contentH2s.length,
    uniqueWords,
    proseTokens,
    grams: gramsOf(proseTokens, 5),
    failures,
  };
}

/* The root 404 document is what Cloudflare Pages serves, with a real 404
 * status, for an unknown path. Without it the platform answers 200 with the
 * landing page (a soft 404). Require the file at the deploy root, a noindex
 * robots value and exactly one H1. */
async function checkNotFound(dist) {
  const file = path.join(dist, '404.html');
  const failures = [];
  let html;
  try {
    html = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      failures.push('[seo-not-found] missing 404.html at the deploy root; Cloudflare Pages would answer 200 with the landing page');
      return { file, robots: null, h1s: 0, failures };
    }
    throw error;
  }

  const robots = attr(html, /<meta\s+name=["']robots["']\s+content=(["'])([\s\S]*?)\1/i);
  if (!robots) {
    failures.push('[seo-not-found] 404.html has no robots meta; it must be noindex');
  } else if (!/noindex/i.test(robots)) {
    failures.push(`[seo-not-found] 404.html robots is not noindex: ${robots}`);
  }

  const h1s = headings(html).filter((heading) => heading.level === 1);
  const visibleH1s = h1s.filter((heading) => !heading.hidden && heading.text);
  if (h1s.some((heading) => heading.hidden)) {
    failures.push('[seo-not-found] 404.html has a hidden H1');
  }
  if (visibleH1s.length !== 1) {
    failures.push(`[seo-not-found] 404.html must have exactly one H1, found ${visibleH1s.length}`);
  }

  return { file, robots, h1s: visibleH1s.length, failures };
}

function formatTable(rows) {
  const header = ['chain', 'title', 'desc', 'H2', 'rows', 'words', 'bytes'];
  const lines = [header.join('\t')];
  for (const row of rows) {
    lines.push([
      row.slug,
      row.titleLength,
      row.descriptionLength,
      row.contentH2s,
      row.rows,
      row.uniqueWords,
      row.bytes,
    ].join('\t'));
  }
  return lines.join('\n');
}

function formatPresentationTable(rows) {
  const header = ['page', 'title', 'desc', 'H2', 'toc', 'links', 'bytes'];
  const lines = [header.join('\t')];
  for (const row of rows) {
    lines.push([
      row.label,
      row.titleLength,
      row.descriptionLength,
      row.contentH2s ?? 0,
      row.tocAnchors ?? 0,
      row.internalLinks ?? 0,
      row.bytes ?? 0,
    ].join('\t'));
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const slugs = await chainSlugs();
  const expected = new Map();
  const data = JSON.parse(await readFile(path.join(REPO_ROOT, 'data', 'chains.json'), 'utf8'));
  for (const chain of data.chains) {
    if (!chain.testnet) expected.set(chain.slug, chain);
  }

  const pages = await loadPages(options.dist);
  const notFound = await checkNotFound(options.dist);
  const failures = [...notFound.failures];
  const missing = slugs.filter((slug) => !pages.some((page) => page.slug === slug));
  const extra = pages.filter((page) => !expected.has(page.slug)).map((page) => page.slug);
  if (missing.length) failures.push(`[seo-page-set] missing built pages: ${missing.join(', ')}`);
  if (extra.length) failures.push(`[seo-page-set] unexpected built chain pages: ${extra.join(', ')}`);
  if (pages.length !== slugs.length) {
    failures.push(`[seo-page-set] built ${pages.length} chain pages, expected ${slugs.length}`);
  }

  const results = pages.map((page) => checkPage(page, expected));
  for (const result of results) {
    for (const failure of result.failures) failures.push(`${result.slug}: ${failure}`);
  }

  const distFiles = await listDistFiles(options.dist);

  /* Puzzle hub and detail pages: one row in `data/puzzles.json` must produce
   * exactly one built detail page and one hub row, and a detail page is listed
   * in the sitemap only when its data row is indexable. */
  const puzzleData = await loadPuzzleData();
  const puzzlePages = await loadPuzzleDetailPages(options.dist);
  const builtPuzzleNumbers = new Set(puzzlePages.map((page) => page.number));
  const expectedPuzzleNumbers = new Set(puzzleData.puzzles.map((puzzle) => puzzle.number));
  for (const number of expectedPuzzleNumbers) {
    if (!builtPuzzleNumbers.has(number)) {
      failures.push(`[seo-page-set] missing built puzzle detail page /bitcoin-puzzle/${number}`);
    }
  }
  for (const number of builtPuzzleNumbers) {
    if (!expectedPuzzleNumbers.has(number)) {
      failures.push(`[seo-page-set] unexpected built puzzle detail page /bitcoin-puzzle/${number}`);
    }
  }
  if (puzzlePages.length !== puzzleData.count) {
    failures.push(`[seo-page-set] built ${puzzlePages.length} puzzle detail pages, expected ${puzzleData.count}`);
  }
  const puzzleResults = [];
  for (const page of puzzlePages) {
    const record = puzzleData.puzzles.find((puzzle) => puzzle.number === page.number);
    if (!record) continue;
    const result = checkPuzzleDetail(page, record, puzzleData, distFiles);
    puzzleResults.push(result);
    for (const failure of result.failures) failures.push(`puzzle: ${failure}`);
  }

  let puzzleHub = null;
  const puzzleHubFile = path.join(options.dist, 'bitcoin-puzzle', 'index.html');
  try {
    const info = await stat(puzzleHubFile);
    const html = await readFile(puzzleHubFile, 'utf8');
    puzzleHub = checkPuzzleHub({ file: puzzleHubFile, bytes: info.size, html }, puzzleData, distFiles);
    for (const failure of puzzleHub.failures) failures.push(`puzzle hub: ${failure}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      failures.push(`[seo-page-set] missing built puzzle hub ${PUZZLE_HUB_ROUTE}/index.html`);
    } else {
      throw error;
    }
  }

  const puzzleSitemap = await checkPuzzleSitemap(options.dist, puzzleData);
  for (const failure of puzzleSitemap.failures) failures.push(failure);

  for (const [target, reason] of pendingCutover) {
    if (!reason || !reason.trim()) {
      failures.push(`[seo-pending-cutover] ${target}: allowlist entry has no reason`);
    }
    if (resolvesInDist(distFiles, target)) {
      failures.push(`[seo-pending-cutover] ${target}: allowlist entry is stale, the target now exists in dist`);
    }
  }

  const presentationResults = [];
  for (const spec of PRESENTATION_PAGES) {
    const result = await checkPresentationPage(spec, options.dist, distFiles);
    presentationResults.push(result);
    for (const failure of result.failures) failures.push(failure);
  }

  const hubPage = await loadHub(options.dist);
  let hub = null;
  if (!hubPage) {
    failures.push(`[seo-hub-links] missing built hub page ${HUB_ROUTE}/index.html`);
  } else {
    hub = checkHub(hubPage, slugs, results, options.dist);
    for (const failure of hub.failures) failures.push(`hub: ${failure}`);
  }

  const metadataPages = [
    ...results.map((result) => ({
      label: result.slug,
      title: result.title,
      description: result.description,
    })),
    ...presentationResults.map((result) => ({
      label: result.label,
      title: result.title,
      description: result.description,
    })),
    ...puzzleResults.map((result) => ({
      label: result.label,
      title: result.title,
      description: result.description,
    })),
    ...(puzzleHub ? [{ label: 'puzzle-hub', title: puzzleHub.title, description: puzzleHub.description }] : []),
    ...(hub ? [{ label: 'hub', title: hub.title, description: hub.description }] : []),
  ];
  const seenTitles = new Map();
  const seenDescriptions = new Map();
  for (const result of metadataPages) {
    if (result.title) {
      if (seenTitles.has(result.title)) {
        failures.push(`[seo-duplicate-metadata] ${result.label}: duplicate title with ${seenTitles.get(result.title)}`);
      } else {
        seenTitles.set(result.title, result.label);
      }
    }
    if (result.description) {
      if (seenDescriptions.has(result.description)) {
        failures.push(`[seo-duplicate-metadata] ${result.label}: duplicate description with ${seenDescriptions.get(result.description)}`);
      } else {
        seenDescriptions.set(result.description, result.label);
      }
    }
  }

  let maxPair = null;
  for (let left = 0; left < results.length; left += 1) {
    for (let right = left + 1; right < results.length; right += 1) {
      const score = jaccard(results[left].grams, results[right].grams);
      if (!maxPair || score > maxPair.score) {
        maxPair = { left: results[left].slug, right: results[right].slug, score };
      }
      if (score >= MAX_JACCARD) {
        failures.push(
          `[seo-prose-uniqueness] ${results[left].slug} vs ${results[right].slug}: ` +
            `5-gram Jaccard ${score.toFixed(3)} >= ${MAX_JACCARD}`,
        );
      }
    }
  }

  console.log(formatTable(results));
  console.log(`\n${formatPresentationTable(presentationResults)}`);
  if (hub) {
    console.log(
      `\nhub ${hub.route}: title ${hub.titleLength}, desc ${hub.descriptionLength}, ` +
        `H2 ${hub.contentH2s}, chain links ${hub.chainLinks}/${slugs.length}, ` +
        `internal targets ${hub.internalLinks}`,
    );
  }
  if (puzzleHub) {
    console.log(
      `\npuzzle hub ${puzzleHub.route}: title ${puzzleHub.titleLength}, desc ${puzzleHub.descriptionLength}, ` +
        `H2 ${puzzleHub.contentH2s}, rows ${puzzleHub.rows}/${puzzleData.count}, internal targets ${puzzleHub.internalLinks}`,
    );
  }
  if (puzzleResults.length) {
    const titleLengths = puzzleResults.map((result) => result.titleLength);
    const descriptionLengths = puzzleResults.map((result) => result.descriptionLength);
    console.log(
      `puzzle details: ${puzzleResults.length} pages, ` +
        `${puzzleResults.filter((result) => result.indexable).length} indexable, ` +
        `titles ${Math.min(...titleLengths)}-${Math.max(...titleLengths)}, ` +
        `descriptions ${Math.min(...descriptionLengths)}-${Math.max(...descriptionLengths)}, ` +
        `min unique words ${Math.min(...puzzleResults.map((result) => result.uniqueWords))}`,
    );
  }
  console.log(`\nsitemap: ${puzzleSitemap.locs} loc(s)`);
  console.log(`\n404: robots=${notFound.robots ?? 'missing'} h1=${notFound.h1s}`);
  if (maxPair) {
    console.log(`\nmax prose similarity: ${maxPair.left} vs ${maxPair.right} = ${maxPair.score.toFixed(3)}`);
  }

  const report = {
    dist: options.dist,
    notFound,
    pages: results.map(({ proseTokens, grams, ...rest }) => rest),
    presentation: presentationResults,
    puzzleHub,
    puzzles: puzzleResults,
    puzzleSitemap,
    pendingCutover: [...pendingCutover].map(([target, reason]) => ({ target, reason })),
    hub,
    maxPair,
    failures,
  };
  if (options.json) await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`);

  if (failures.length) {
    console.error(`\nSEO gate failed with ${failures.length} violation(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `\nSEO gate passed: ${results.length} chain pages, the ${HUB_ROUTE} hub, ` +
      `${presentationResults.length} presentation pages, the ${PUZZLE_HUB_ROUTE} hub, ` +
      `${puzzleResults.length} puzzle detail pages, the sitemap and the root 404 page.`,
  );
}

main().catch((error) => {
  console.error(`check-seo: ${error.message}`);
  process.exit(2);
});
