#!/usr/bin/env node
// Security advisory gate: schema, checker registry, route references, review
// provenance and the committed generated page.
//
// Detector id: security-advisory-integrity (data/detectors.json).
//
// Checks:
//   schema            data/security-advisories.json matches the documented
//                     shape: closed severity/review/kind/checker sets, https
//                     primary sources, actions on every entry, ISO dates.
//   checker-routes    every referenced checker exists in the top-level checker
//                     registry, names an existing route in the coordinator's
//                     static_asset map and an implementation file that exists.
//   honest-claims     no entry promises protection or a guaranteed-safe key.
//   page-fresh        apps/site/security.html matches the renderer output.
//   page-shape        canonical, one main, one h1, one footer, JSON-LD parses,
//                     no noindex, and the sitemap lists /security.
//   route-wired       the coordinator serves /security and
//                     /security-advisories.json.
//
// Zero dependencies; Windows-safe. Exit: 0 = clean, 1 = violations.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_PATH,
  JSON_ROUTE,
  PAGE_PATH,
  PAGE_ROUTE,
  SITE_ORIGIN,
  coordinatorRoutes,
  loadChains,
  normalizeEol,
  readJson,
  renderSecurityPage,
  validateSecurityAdvisories,
} from "./lib/security-advisories.mjs";

export const DETECTOR_ID = "security-advisory-integrity";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

function read(relative) {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function checkPageShape(page, errors) {
  if (!page.includes(`<link rel="canonical" href="${SITE_ORIGIN}${PAGE_ROUTE}">`)) {
    errors.push(`${PAGE_PATH}: missing the canonical ${SITE_ORIGIN}${PAGE_ROUTE}`);
  }
  if (/noindex/i.test(page)) errors.push(`${PAGE_PATH}: content page must not be noindex`);
  if (count(page, "<main") !== 1) errors.push(`${PAGE_PATH}: expected exactly one <main>`);
  if (count(page, "<h1") !== 1) errors.push(`${PAGE_PATH}: expected exactly one <h1>`);
  if (count(page, "<footer") !== 0) {
    errors.push(`${PAGE_PATH}: must not ship its own footer; the coordinator injects the shared one`);
  }

  const jsonLd = page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!jsonLd) {
    errors.push(`${PAGE_PATH}: missing the JSON-LD block`);
  } else {
    try {
      const value = JSON.parse(jsonLd[1]);
      if (value["@type"] !== "CollectionPage") {
        errors.push(`${PAGE_PATH}: JSON-LD @type must be CollectionPage`);
      }
      if (value.url !== `${SITE_ORIGIN}${PAGE_ROUTE}`) {
        errors.push(`${PAGE_PATH}: JSON-LD url must be ${SITE_ORIGIN}${PAGE_ROUTE}`);
      }
    } catch (error) {
      errors.push(`${PAGE_PATH}: JSON-LD is not valid JSON (${error.message})`);
    }
  }
}

export function checkAdvisories(root = repoRoot) {
  const errors = [];
  let data;
  try {
    data = readJson(root, DATA_PATH);
  } catch (error) {
    return { ok: false, errors: [`${DATA_PATH}: cannot read (${error.message})`], data: null };
  }

  let routes;
  try {
    routes = coordinatorRoutes(root);
  } catch (error) {
    return { ok: false, errors: [error.message], data };
  }
  const chainSlugs = loadChains(root);
  const result = validateSecurityAdvisories(data, { repoRoot: root, routes, chainSlugs });
  errors.push(...result.errors);

  for (const route of [PAGE_ROUTE, JSON_ROUTE]) {
    if (!routes.has(route)) errors.push(`route-wired: ${route} is not in the coordinator static_asset map`);
  }
  const coordinator = fs.readFileSync(path.join(root, "src", "coordinator", "mod.rs"), "utf8");
  const sitemapStart = coordinator.indexOf("fn render_sitemap");
  const sitemapEnd = coordinator.indexOf("fn render_seo_not_found", sitemapStart);
  const sitemap = sitemapStart >= 0 && sitemapEnd > sitemapStart
    ? coordinator.slice(sitemapStart, sitemapEnd)
    : "";
  if (!sitemap.includes('"/security"')) {
    errors.push("sitemap: /security is missing from the page list in render_sitemap");
  }

  let page = "";
  try {
    page = fs.readFileSync(path.join(root, PAGE_PATH), "utf8");
  } catch (error) {
    errors.push(`${PAGE_PATH}: cannot read (${error.message})`);
  }
  if (page) {
    checkPageShape(page, errors);
    for (const group of ["advisories", "threats"]) {
      for (const entry of data[group] || []) {
        if (entry?.review?.status === "draft" && page.includes(`id="${entry.id}"`)) {
          errors.push(`${PAGE_PATH}: draft entry ${entry.id} reached the public page`);
        }
      }
    }
    const expected = renderSecurityPage(data);
    if (normalizeEol(page) !== expected) {
      errors.push(`${PAGE_PATH}: stale; run node scripts/gen-security-page.mjs`);
    }
  }

  return { ok: errors.length === 0, errors, data };
}

function main() {
  const { ok, errors, data } = checkAdvisories(repoRoot);
  if (!ok) {
    for (const error of errors) console.error(`error: ${error}`);
    console.error(`check-advisories: FAILED (${errors.length} error(s))`);
    process.exitCode = 1;
    return;
  }
  const checkers = data.checkers || [];
  console.log(
    `check-advisories: ${data.advisories.length} advisory(ies), ` +
      `${data.threats.length} threat class(es), ${checkers.length} checker(s); ` +
      `page fresh and wired`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
