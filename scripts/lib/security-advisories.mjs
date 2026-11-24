// Shared loader, validator and page renderer for data/security-advisories.json.
//
// Consumers:
//   - scripts/check-advisories.mjs   validates the SSOT, the checker registry
//                                    and the committed generated page.
//   - scripts/gen-security-page.mjs  writes apps/site/security.html.
//
// Zero dependencies; Windows-safe. The renderer escapes every data string, so
// the SSOT stays plain text and cannot inject markup into the page.

import fs from "node:fs";
import path from "node:path";

export const DATA_PATH = "data/security-advisories.json";
export const PAGE_PATH = "apps/site/security.html";
export const JSON_ROUTE = "/security-advisories.json";
export const PAGE_ROUTE = "/security";
export const SITE_ORIGIN = "https://rotor.pxbt.app";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"];
export const REVIEW_STATUSES = ["draft", "reviewed", "superseded"];
export const KINDS = ["vulnerability", "threat"];
export const CHECKER_KINDS = ["local-seed-range"];

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BANNED_CLAIMS = [
  "we protect you",
  "protects you",
  "guaranteed",
  "100% secure",
  "cannot be hacked",
  "can't be hacked",
];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validIsoDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validHttps(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function fileExists(repoRoot, relative) {
  if (!nonEmptyString(relative)) return false;
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) return false;
  return fs.existsSync(path.join(repoRoot, relative));
}

export function readJson(repoRoot, relative) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relative), "utf8"));
}

/* Generated files keep the checkout's EOL so a Windows CRLF checkout does not
 * report a false stale page. Comparisons normalize both sides to LF. */
export function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function withEol(text, eol) {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, eol);
}

export function normalizeEol(text) {
  return text.replace(/\r\n/g, "\n");
}

/** Public text/html routes embedded by the coordinator's static_asset map. */
export function coordinatorRoutes(repoRoot) {
  const source = fs.readFileSync(path.join(repoRoot, "src", "coordinator", "mod.rs"), "utf8");
  const start = source.indexOf("fn static_asset(");
  const end = source.indexOf("_ => None", start);
  if (start < 0 || end < 0) throw new Error("cannot locate fn static_asset in src/coordinator/mod.rs");
  const routes = new Set();
  let pending = [];
  for (const line of source.slice(start, end).split("\n")) {
    if (/^\s{8}"/.test(line)) pending = [];
    for (const match of line.matchAll(/"(\/[^"]*)"/g)) pending.push(match[1]);
    if (!line.includes('"text/html') && !line.includes("application/json")) continue;
    for (const route of pending) routes.add(route);
    pending = [];
  }
  return routes;
}

export function loadChains(repoRoot) {
  return readJson(repoRoot, "data/chains.json").chains.map((chain) => chain.slug);
}

function checkBannedClaims(where, values, errors) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const lower = value.toLowerCase();
    for (const claim of BANNED_CLAIMS) {
      if (lower.includes(claim)) errors.push(`${where}: banned protection claim "${claim}"`);
    }
  }
}

function validateSources(where, sources, errors) {
  if (!Array.isArray(sources) || sources.length === 0) {
    errors.push(`${where}.sources must be a non-empty array`);
    return;
  }
  let primary = 0;
  for (const [index, source] of sources.entries()) {
    const at = `${where}.sources[${index}]`;
    if (!isObject(source)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    if (!nonEmptyString(source.label)) errors.push(`${at}.label is required`);
    if (!validHttps(source.url)) errors.push(`${at}.url must be an https URL`);
    if (source.primary !== true && source.primary !== false) {
      errors.push(`${at}.primary must be a boolean`);
    } else if (source.primary === true) {
      primary += 1;
    }
  }
  if (primary === 0) errors.push(`${where}.sources must name at least one primary source`);
}

function validateReview(where, review, today, errors) {
  if (!isObject(review)) {
    errors.push(`${where}.review is required`);
    return;
  }
  if (!REVIEW_STATUSES.includes(review.status)) {
    errors.push(`${where}.review.status must be one of: ${REVIEW_STATUSES.join(", ")}`);
    return;
  }
  if (review.status === "draft") {
    if (review.reviewed_at || review.reviewed_by) {
      errors.push(`${where}.review: a draft must not carry reviewed_at or reviewed_by`);
    }
    return;
  }
  if (!nonEmptyString(review.reviewed_by)) errors.push(`${where}.review.reviewed_by is required`);
  if (!validIsoDate(review.reviewed_at)) {
    errors.push(`${where}.review.reviewed_at must be an ISO date (YYYY-MM-DD)`);
  } else if (review.reviewed_at > today) {
    errors.push(`${where}.review.reviewed_at is in the future`);
  }
  if (review.notes !== undefined && typeof review.notes !== "string") {
    errors.push(`${where}.review.notes must be a string when present`);
  }
}

function validateChecker(checker, routes, chainSlugs, repoRoot, errors) {
  const where = `checkers[${checker.id || "?"}]`;
  if (!nonEmptyString(checker.id) || !ID_RE.test(checker.id)) {
    errors.push(`${where}: id must match ${ID_RE}`);
    return;
  }
  if (!CHECKER_KINDS.includes(checker.kind)) {
    errors.push(`${where}.kind must be one of: ${CHECKER_KINDS.join(", ")}`);
  }
  for (const field of ["title", "description", "honesty"]) {
    if (!nonEmptyString(checker[field])) errors.push(`${where}.${field} is required`);
  }
  if (!Array.isArray(checker.chains) || checker.chains.length === 0) {
    errors.push(`${where}.chains must be a non-empty array`);
  } else {
    for (const chain of checker.chains) {
      if (!chainSlugs.includes(chain)) errors.push(`${where}.chains names unknown chain ${chain}`);
    }
  }
  if (!nonEmptyString(checker.route) || !checker.route.startsWith("/")) {
    errors.push(`${where}.route must be an absolute site path`);
  } else {
    const routePath = checker.route.split("#")[0].split("?")[0];
    if (!routes.has(routePath)) {
      errors.push(`${where}.route ${routePath} is not a route in src/coordinator/mod.rs`);
    }
  }
  if (!fileExists(repoRoot, checker.implementation)) {
    errors.push(`${where}.implementation does not exist: ${checker.implementation}`);
  }
  if (typeof checker.network !== "boolean") {
    errors.push(`${where}.network must be a boolean`);
  }
  if (!isObject(checker.limits)) {
    errors.push(`${where}.limits is required`);
  } else if (!Number.isInteger(checker.limits.max_seeds_per_run) || checker.limits.max_seeds_per_run < 1) {
    errors.push(`${where}.limits.max_seeds_per_run must be a positive integer`);
  } else if (checker.limits.max_seeds_per_run > 2000) {
    errors.push(`${where}.limits.max_seeds_per_run must not exceed the UI bound of 2000`);
  }
  checkBannedClaims(where, [checker.title, checker.description, checker.honesty], errors);
}

export function validateSecurityAdvisories(data, options = {}) {
  const errors = [];
  const repoRoot = options.repoRoot;
  const routes = options.routes || new Set();
  const chainSlugs = options.chainSlugs || [];
  const today = options.today || new Date().toISOString().slice(0, 10);

  if (!isObject(data)) return { ok: false, errors: ["data must be an object"] };
  if (data.version !== 1) errors.push("version must be 1");
  if (!validIsoDate(data.updated_at)) errors.push("updated_at must be an ISO date");
  if (!Array.isArray(data.severity_levels) || data.severity_levels.join(",") !== SEVERITIES.join(",")) {
    errors.push(`severity_levels must be exactly: ${SEVERITIES.join(", ")}`);
  }
  if (!Array.isArray(data.review_statuses) || data.review_statuses.join(",") !== REVIEW_STATUSES.join(",")) {
    errors.push(`review_statuses must be exactly: ${REVIEW_STATUSES.join(", ")}`);
  }
  if (!Array.isArray(data.rules) || data.rules.length === 0) errors.push("rules must be a non-empty array");

  const checkers = Array.isArray(data.checkers) ? data.checkers : [];
  const checkerIds = new Set();
  if (!Array.isArray(data.checkers)) errors.push("checkers must be an array");
  for (const [index, checker] of checkers.entries()) {
    if (!isObject(checker)) {
      errors.push(`checkers[${index}] must be an object`);
      continue;
    }
    if (checkerIds.has(checker.id)) errors.push(`checkers repeats id ${checker.id}`);
    else if (nonEmptyString(checker.id)) checkerIds.add(checker.id);
    validateChecker(checker, routes, chainSlugs, repoRoot, errors);
  }

  const allIds = new Set();
  for (const groupName of ["advisories", "threats"]) {
    const entries = Array.isArray(data[groupName]) ? data[groupName] : null;
    if (entries === null) {
      errors.push(`${groupName} must be an array`);
      continue;
    }
    for (const [index, entry] of entries.entries()) {
      const where = `${groupName}[${index}]`;
      if (!isObject(entry)) {
        errors.push(`${where} must be an object`);
        continue;
      }
      const id = entry.id;
      if (!nonEmptyString(id) || !ID_RE.test(id)) {
        errors.push(`${where}.id must match ${ID_RE}`);
      } else if (allIds.has(id)) {
        errors.push(`${where}.id repeats ${id}`);
      } else {
        allIds.add(id);
      }
      if (entry.kind !== "vulnerability" && entry.kind !== "threat") {
        errors.push(`${where}.kind must be vulnerability or threat`);
      }
      if (!nonEmptyString(entry.title)) errors.push(`${where}.title is required`);
      if (!SEVERITIES.includes(entry.severity)) {
        errors.push(`${where}.severity must be one of: ${SEVERITIES.join(", ")}`);
      }
      for (const field of ["summary", "user_impact"]) {
        if (!nonEmptyString(entry[field])) errors.push(`${where}.${field} is required`);
      }
      if (!Array.isArray(entry.actions) || entry.actions.length === 0 || !entry.actions.every(nonEmptyString)) {
        errors.push(`${where}.actions must be a non-empty array of strings`);
      }
      validateSources(where, entry.sources, errors);
      validateReview(where, entry.review, today, errors);
      checkBannedClaims(where, [entry.title, entry.summary, entry.user_impact, ...(entry.actions || [])], errors);

      if (groupName === "advisories") {
        if (entry.kind !== "vulnerability") errors.push(`${where}.kind must be vulnerability`);
        if (!validIsoDate(entry.disclosed)) errors.push(`${where}.disclosed must be an ISO date`);
        if (!Array.isArray(entry.cve) || entry.cve.length === 0 || !entry.cve.every(nonEmptyString)) {
          errors.push(`${where}.cve must be a non-empty array`);
        }
        if (!isObject(entry.affected)) {
          errors.push(`${where}.affected is required`);
        } else {
          if (!Array.isArray(entry.affected.tools) || entry.affected.tools.length === 0 || !entry.affected.tools.every(nonEmptyString)) {
            errors.push(`${where}.affected.tools must be a non-empty array`);
          }
          if (!Array.isArray(entry.affected.versions) || !entry.affected.versions.every(nonEmptyString)) {
            errors.push(`${where}.affected.versions must be an array of strings`);
          }
          if (!Array.isArray(entry.affected.chains) || entry.affected.chains.length === 0) {
            errors.push(`${where}.affected.chains must be a non-empty array`);
          } else {
            for (const chain of entry.affected.chains) {
              if (!chainSlugs.includes(chain)) {
                errors.push(`${where}.affected.chains names unknown chain ${chain}`);
              }
            }
          }
        }
        if (entry.checker !== null && typeof entry.checker !== "string") {
          errors.push(`${where}.checker must be null or a checker id`);
        } else if (typeof entry.checker === "string" && !checkerIds.has(entry.checker)) {
          errors.push(`${where}.checker references unknown checker ${entry.checker}`);
        }
      } else {
        if (entry.kind !== "threat") errors.push(`${where}.kind must be threat`);
        if (!nonEmptyString(entry.threat_class)) errors.push(`${where}.threat_class is required`);
        if (!nonEmptyString(entry.first_documented)) errors.push(`${where}.first_documented is required`);
        if (entry.checker !== undefined) errors.push(`${where}.checker is not allowed on a threat`);
        if ("cve" in entry) errors.push(`${where}.cve is not allowed on a threat`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ render */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* Only reviewed and superseded entries are public. A superseded entry stays
 * visible with its history; a draft never reaches the page. */
export function isPublishedReview(review) {
  return isObject(review) && (review.status === "reviewed" || review.status === "superseded");
}

/* JSON-LD sits inside a <script> element, so a data string must not be able to
 * close it. The gate already requires an ISO date; the renderer validates it
 * again and escapes the serialized JSON. */
function jsonLdSafeDate(value) {
  if (!validIsoDate(value)) throw new Error("updated_at must be an ISO date for JSON-LD");
  return value;
}

function serializeJsonLd(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function chip(text, className) {
  const extra = className ? ` class="${className}"` : "";
  return `<span${extra}>${escapeHtml(text)}</span>`;
}

function badgeText(entry) {
  const badges = [chip(entry.severity.toUpperCase(), `status--${entry.severity}`)];
  if (entry.kind === "vulnerability") {
    for (const cve of entry.cve || []) badges.push(chip(cve));
    badges.push(chip("Vulnerability"));
  } else {
    badges.push(chip("Threat class"));
  }
  const review = entry.review || {};
  badges.push(chip(review.status === "reviewed" ? `Reviewed ${review.reviewed_at}` : review.status));
  return `<div class="key-badges">${badges.join("")}</div>`;
}

function renderActions(actions) {
  return `<ol>${(actions || []).map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ol>`;
}

function renderSources(sources) {
  const items = (sources || []).map((source) => {
    const label = escapeHtml(source.label);
    const rel = source.url.startsWith(SITE_ORIGIN) ? "" : ' target="_blank" rel="noopener noreferrer"';
    const primary = source.primary ? ' <span class="muted">(primary)</span>' : "";
    return `<li><a href="${escapeHtml(source.url)}"${rel}>${label}</a>${primary}</li>`;
  });
  return `<ul class="security-sources">${items.join("")}</ul>`;
}

function renderAdvisory(entry, checkersById) {
  const checker = entry.checker ? checkersById.get(entry.checker) : null;
  const checkerBlock = checker
    ? `<div class="security-checker">
    <h3>Local check on this site</h3>
    <p>${escapeHtml(checker.description)}</p>
    <p><a class="chip chip--primary" href="${escapeHtml(checker.route)}">Open the local checker</a></p>
    <p class="muted">${escapeHtml(checker.honesty)}</p>
  </div>`
    : `<div class="security-checker">
    <h3>No local check</h3>
    <p class="muted">This site does not ship a local check for this entry. An address alone cannot show which random-number generator or device produced its key, so a check here would be a guess. Use the primary sources and the wallet's own creation history.</p>
  </div>`;
  return `<section class="card security-entry" id="${escapeHtml(entry.id)}">
    <h2>${escapeHtml(entry.title)}</h2>
    ${badgeText(entry)}
    <p>${escapeHtml(entry.summary)}</p>
    <h3>What it means for you</h3>
    <p>${escapeHtml(entry.user_impact)}</p>
    <h3>Affected</h3>
    <ul>${(entry.affected?.tools || []).map((tool) => `<li>${escapeHtml(tool)}</li>`).join("")}</ul>
    <h3>What to do</h3>
    ${renderActions(entry.actions)}
    ${checkerBlock}
    <h3>Primary sources</h3>
    ${renderSources(entry.sources)}
  </section>`;
}

function renderThreat(entry) {
  return `<section class="card security-entry" id="${escapeHtml(entry.id)}">
    <h2>${escapeHtml(entry.title)}</h2>
    ${badgeText(entry)}
    <p>${escapeHtml(entry.summary)}</p>
    <h3>What it means for you</h3>
    <p>${escapeHtml(entry.user_impact)}</p>
    <h3>What to do</h3>
    ${renderActions(entry.actions)}
    <h3>Primary sources</h3>
    ${renderSources(entry.sources)}
  </section>`;
}

function renderJsonLd(data) {
  const value = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Security advisories",
    url: `${SITE_ORIGIN}${PAGE_ROUTE}`,
    description:
      "Published vulnerabilities and threat classes that affect wallet keys and addresses, with plain-language impact, actions and primary sources.",
    dateModified: jsonLdSafeDate(data.updated_at),
    isPartOf: {
      "@type": "WebSite",
      name: "Crypto",
      url: `${SITE_ORIGIN}/`,
    },
  };
  return `<script type="application/ld+json">${serializeJsonLd(value)}</script>`;
}

const NAV = `<header class="site-nav">
  <a class="brand" href="/"><span class="brand-mark"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-rotor"></use></svg></span><span class="brand-name">Crypto<span>.</span></span></a>
  <nav aria-label="Main">
    <a href="/" data-nav="home"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-grid"></use></svg><span>Home</span></a>
    <a href="/private-keys" data-nav="directory"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-key"></use></svg><span>Directory</span></a>
    <a href="/mnemonic-seeds" data-nav="seeds"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-seed"></use></svg><span>Seeds</span></a>
    <a href="/bitcoin-puzzle" data-nav="puzzle"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-puzzle"></use></svg><span>Puzzle</span></a>
    <a href="/vanity" data-nav="vanity"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-random"></use></svg><span>Vanity</span></a>
    <a href="/milk-sad" data-nav="milk-sad"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-shield"></use></svg><span>Milk Sad</span></a>
    <a href="/tools" data-nav="tools"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-tools"></use></svg><span>Tools</span></a>
    <a href="/docs" data-nav="docs"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-book"></use></svg><span>Docs</span></a>
  </nav>
  <div class="nav-tools">
    <a class="icon-button icon-button--quiet icon-button--lg" href="/key" data-nav="search" aria-label="Search wallet" data-tooltip="Search wallet"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-search"></use></svg></a>
    <a class="chip chip--primary" href="/cabinet" data-nav="cabinet" aria-label="Cabinet"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-vault"></use></svg><span>Cabinet</span></a>
  </div>
</header>`;

export function renderSecurityPage(data) {
  const checkersById = new Map((data.checkers || []).map((checker) => [checker.id, checker]));
  const advisories = (data.advisories || []).filter((entry) => isPublishedReview(entry.review));
  const threats = (data.threats || []).filter((entry) => isPublishedReview(entry.review));
  const advisorySections = advisories.map((entry) => renderAdvisory(entry, checkersById)).join("\n");
  const threatSections = threats.map(renderThreat).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Security advisories: published wallet vulnerabilities and what to do | Crypto</title>
<meta name="description" content="Published vulnerabilities and threat classes that affect wallet keys and addresses, with plain-language impact, actions, primary sources and local checks. Documentation, not a protection service.">
<link rel="canonical" href="${SITE_ORIGIN}${PAGE_ROUTE}">
${renderJsonLd(data)}
<link rel="stylesheet" href="/site.css">
<link rel="preload" href="/fonts/manrope-latin.woff2" as="font" type="font/woff2" crossorigin>
<script src="/theme.js"></script>
</head>
<body>
${NAV}

<main class="key-page">
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> <span class="breadcrumbs__sep" aria-hidden="true">/</span> <span aria-current="page">Security advisories</span></nav>
  <section class="hero key-hero">
    <div class="key-hero-head">
      <span class="key-hero-icon"><svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-shield"></use></svg></span>
      <div>
        <h1>Security advisories</h1>
        <p class="key-tagline">Published vulnerabilities and threat classes that affect wallet keys and addresses. Each entry explains the impact in plain language, names primary sources and says whether a local check exists.</p>
        <div class="key-badges">${chip(`${advisories.length} ${advisories.length === 1 ? "advisory" : "advisories"}`)}${chip(`${threats.length} ${threats.length === 1 ? "threat class" : "threat classes"}`)}${chip(`Updated ${data.updated_at}`)}</div>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>How to read this page</h2>
    <p>This page is documentation, not a protection service. It cannot stop a theft, recover funds or prove that a key is safe. It lists only publicly documented issues, and every entry cites a primary source. An entry ships only after a reviewer checks its facts and records the review date.</p>
    <p class="muted">A local check reads only the address you enter in this browser. It never sends an address to this site or to a third party. A bounded local scan covers only the range you choose, so a no-match result is not a safety guarantee.</p>
  </section>

  <h2 class="security-section-title">Advisories</h2>
${advisorySections}

  <h2 class="security-section-title">Threat classes</h2>
  <p class="muted">These are scam techniques, not software bugs: there is no affected version and no patch. They are kept separate so a version update is never presented as a fix for them.</p>
${threatSections}

  <section class="card">
    <h2>Why this page does not list vulnerable keys</h2>
    <p>A searchable directory of every weak key and its balance is a target list, not a safety tool. It helps someone take funds from wallets they do not own. The owner of an affected wallet already has the public research and the official checker; publishing the whole enumeration adds no protection for that owner.</p>
  </section>

  <section class="card">
    <h2>How entries are reviewed</h2>
    <p>An advisory stays in <strong>draft</strong> until a human or agent reviewer checks the summary, the affected tools and versions, and the actions against the primary sources. The reviewer records their identifier and the review date in the data file. A superseded entry stays visible with its history instead of disappearing.</p>
  </section>

  <section class="directory-links" aria-label="Related pages">
    <a href="/milk-sad">Milk Sad local checker</a>
    <a href="/cabinet/wallet">Cabinet wallet</a>
    <a href="/docs">Documentation</a>
    <a href="https://milksad.info/" target="_blank" rel="noopener noreferrer">Milk Sad research</a>
    <a href="https://nvd.nist.gov/" target="_blank" rel="noopener noreferrer">NVD</a>
  </section>
</main>

<script src="/site.js"></script>
</body>
</html>
`;
}
