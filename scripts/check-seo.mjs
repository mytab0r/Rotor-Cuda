#!/usr/bin/env node
// SEO gate for the prerendered chain directory (`/private-keys/<chain>`) and
// its hub (`/private-keys`).
//
// Reads the built `web/dist` tree (no network, no dependencies) and fails when
// a page breaks the contract the SEO audit measured:
//   - title outside 50-60 characters (hub: at most 60, intent first);
//   - description outside 120-160 characters with no concrete number;
//   - missing/incorrect canonical or robots;
//   - duplicate title or description between chain pages or the hub;
//   - a hidden H1 or fewer than two visible content H2s;
//   - fewer than 40 rendered key/address rows;
//   - fewer than 120 unique prose words;
//   - 5-gram Jaccard similarity >= 0.50 between two chain pages' prose;
//   - a missing CollectionPage/BreadcrumbList JSON-LD or chain-named og:image:alt;
//   - hub links missing for a chain page, or a hub internal link with no
//     built target in `web/dist`.
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
const TITLE_MIN = 50;
const TITLE_MAX = 60;
const HUB_TITLE_MAX = 60;
const DESCRIPTION_MIN = 120;
const DESCRIPTION_MAX = 160;
const MIN_UNIQUE_WORDS = 120;
const MIN_ROWS = 40;
const HUB_MIN_CONTENT_H2 = 2;
const MAX_JACCARD = 0.5;

const HELP = `check-seo - SEO gate for web/dist/private-keys and its chain pages

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
  return match ? decodeEntities(match[1].trim()) : null;
}

function sectionByMarker(html, marker) {
  const match = html.match(new RegExp(`<section\\b[^>]*\\b${marker}\\b[^>]*>([\\s\\S]*?)</section>`, 'i'));
  return match ? match[1] : '';
}

function headings(fragment) {
  const out = [];
  const re = /<h([12])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = re.exec(fragment)) !== null) {
    const attrs = match[2] ?? '';
    const hidden = /\bhidden\b/i.test(attrs) ||
      /\baria-hidden\s*=\s*["']true["']/i.test(attrs) ||
      /\bclass\s*=\s*["'][^"']*visually-hidden/i.test(attrs) ||
      /\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs);
    out.push({ level: Number(match[1]), hidden, text: visibleText(match[3]) });
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
  const description = attr(html, /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
  const canonical = attr(html, /<link\s+rel=["']canonical["']\s+href=["']([^"']*)["']/i);
  const robots = attr(html, /<meta\s+name=["']robots["']\s+content=["']([^"']*)["']/i);
  const ogImage = attr(html, /<meta\s+property=["']og:image["']\s+content=["']([^"']*)["']/i);
  const ogImageAlt = attr(html, /<meta\s+property=["']og:image:alt["']\s+content=["']([^"']*)["']/i);
  const twitterImage = attr(html, /<meta\s+name=["']twitter:image["']\s+content=["']([^"']*)["']/i);
  const twitterImageAlt = attr(html, /<meta\s+name=["']twitter:image:alt["']\s+content=["']([^"']*)["']/i);

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
  const description = attr(html, /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
  const canonical = attr(html, /<link\s+rel=["']canonical["']\s+href=["']([^"']*)["']/i);
  const robots = attr(html, /<meta\s+name=["']robots["']\s+content=["']([^"']*)["']/i);
  const ogImage = attr(html, /<meta\s+property=["']og:image["']\s+content=["']([^"']*)["']/i);
  const ogImageAlt = attr(html, /<meta\s+property=["']og:image:alt["']\s+content=["']([^"']*)["']/i);
  const twitterImageAlt = attr(html, /<meta\s+name=["']twitter:image:alt["']\s+content=["']([^"']*)["']/i);

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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const slugs = await chainSlugs();
  const expected = new Map();
  const data = JSON.parse(await readFile(path.join(REPO_ROOT, 'data', 'chains.json'), 'utf8'));
  for (const chain of data.chains) {
    if (!chain.testnet) expected.set(chain.slug, chain);
  }

  const pages = await loadPages(options.dist);
  const failures = [];
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

  const hubPage = await loadHub(options.dist);
  let hub = null;
  if (!hubPage) {
    failures.push(`[seo-hub-links] missing built hub page ${HUB_ROUTE}/index.html`);
  } else {
    hub = checkHub(hubPage, slugs, results, options.dist);
    for (const failure of hub.failures) failures.push(`hub: ${failure}`);
  }

  const seenTitles = new Map();
  const seenDescriptions = new Map();
  for (const result of results) {
    if (result.title) {
      if (seenTitles.has(result.title)) {
        failures.push(`[seo-duplicate-metadata] ${result.slug}: duplicate title with ${seenTitles.get(result.title)}`);
      } else {
        seenTitles.set(result.title, result.slug);
      }
    }
    if (result.description) {
      if (seenDescriptions.has(result.description)) {
        failures.push(`[seo-duplicate-metadata] ${result.slug}: duplicate description with ${seenDescriptions.get(result.description)}`);
      } else {
        seenDescriptions.set(result.description, result.slug);
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
  if (hub) {
    console.log(
      `\nhub ${hub.route}: title ${hub.titleLength}, desc ${hub.descriptionLength}, ` +
        `H2 ${hub.contentH2s}, chain links ${hub.chainLinks}/${slugs.length}, ` +
        `internal targets ${hub.internalLinks}`,
    );
  }
  if (maxPair) {
    console.log(`\nmax prose similarity: ${maxPair.left} vs ${maxPair.right} = ${maxPair.score.toFixed(3)}`);
  }

  const report = {
    dist: options.dist,
    pages: results.map(({ proseTokens, grams, ...rest }) => rest),
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
  console.log(`\nSEO gate passed: ${results.length} chain pages and the ${HUB_ROUTE} hub.`);
}

main().catch((error) => {
  console.error(`check-seo: ${error.message}`);
  process.exit(2);
});
