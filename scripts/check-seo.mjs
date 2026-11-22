#!/usr/bin/env node
// SEO gate for the prerendered chain directory (`/private-keys/<chain>`).
//
// Reads the built `web/dist` tree (no network, no dependencies) and fails when
// a page breaks the contract the SEO audit measured:
//   - title outside 50-60 characters;
//   - description outside 120-160 characters;
//   - missing/incorrect canonical or robots;
//   - duplicate title or description between chain pages;
//   - a hidden H1 or fewer than two visible content H2s;
//   - fewer than 40 rendered key/address rows;
//   - fewer than 120 unique prose words;
//   - 5-gram Jaccard similarity >= 0.50 between two chain pages' prose;
//   - a missing CollectionPage/BreadcrumbList JSON-LD or chain-named og:image:alt.
//
// Usage:
//   node scripts/check-seo.mjs [--dist web/dist] [--json report.json]
//
// Exit codes: 0 = pass, 1 = violations, 2 = harness error (missing build).

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ORIGIN = 'https://rotor.pxbt.app';
const TITLE_MIN = 50;
const TITLE_MAX = 60;
const DESCRIPTION_MIN = 120;
const DESCRIPTION_MAX = 160;
const MIN_UNIQUE_WORDS = 120;
const MIN_ROWS = 40;
const MAX_JACCARD = 0.5;

const HELP = `check-seo - SEO gate for web/dist/private-keys/<chain>

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
  if (maxPair) {
    console.log(`\nmax prose similarity: ${maxPair.left} vs ${maxPair.right} = ${maxPair.score.toFixed(3)}`);
  }

  const report = {
    dist: options.dist,
    pages: results.map(({ proseTokens, grams, ...rest }) => rest),
    maxPair,
    failures,
  };
  if (options.json) await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`);

  if (failures.length) {
    console.error(`\nSEO gate failed with ${failures.length} violation(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`\nSEO gate passed: ${results.length} chain pages.`);
}

main().catch((error) => {
  console.error(`check-seo: ${error.message}`);
  process.exit(2);
});
