// Route-map gate: data/routes.json is the single routing map.
//
// The coordinator route table lives in Rust string literals across a handful of
// functions. This module extracts those literals (pages, SEO routes, redirects,
// admin routes and API families) and fails when the map does not cover one of
// them, when a mapped template file does not exist, or when a mapped row is
// malformed. Static assets are deliberately out of scope: they are embedded
// files, not route families.
//
// Detector id: site-route-map. Zero dependencies; Windows-safe.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const ROUTES_PATH = "data/routes.json";
export const COORDINATOR_PATH = "src/coordinator/mod.rs";

export const RENDERERS = new Set(["astro-static", "worker-inject", "coordinator", "client-only", "api"]);
export const STATUSES = new Set(["live", "planned", "legacy"]);
export const AUTH = new Set(["public", "admin"]);

const REQUIRED_FIELDS = ["pattern", "family", "template", "renderer", "auth", "status", "notes"];
const ASSET_EXTENSION = /\.(?:js|css|wasm|svg|woff2|png|ico|json|txt|xml|webmanifest)$/i;
// These two have an extension but are routes, not assets.
const ROUTE_EXTENSIONS = new Set(["/robots.txt", "/sitemap.xml"]);
// Prefix guards that are not routes by themselves; real families are enumerated.
const PREFIX_GUARDS = new Set(["/api/v1/", "/cabinet/admin/"]);
const DATA_SOURCE_FILE = /\.(?:html|css|js|mjs|json|rs|wasm|toml|ts)$/i;

function isAsset(value) {
  if (ROUTE_EXTENSIONS.has(value)) return false;
  return ASSET_EXTENSION.test(value);
}

// Slice a balanced `{...}` block starting at `open`, ignoring braces inside
// string literals and comments. The scanned functions contain no raw strings.
function sliceBraces(source, open) {
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      if (char === "\\") {
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

function functionBody(source, name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:pub(?:\\s*\\([^)]*\\))?\\s+)?fn\\s+${name}\\s*\\(`, "g");
  const match = re.exec(source);
  if (!match) return null;
  const open = source.indexOf("{", match.index);
  if (open === -1) return null;
  return sliceBraces(source, open);
}

function constArrayBody(source, name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:pub\\s+)?const\\s+${name}\\b`, "g");
  const match = re.exec(source);
  if (!match) return null;
  const open = source.indexOf("[", match.index);
  if (open === -1) return null;
  const close = source.indexOf("];", open);
  if (close === -1) return null;
  return source.slice(open, close + 1);
}

function stringLiterals(text) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = re.exec(text)) !== null) out.push(match[1]);
  return out;
}

// Route literals compared against `path` (or `value`), plus `strip_prefix` and
// `starts_with`. This deliberately ignores `strip_suffix` markers such as
// "/detail" and `format!` fragments such as "/private-keys/{slug}".
function comparedPathLiterals(body) {
  const out = [];
  const patterns = [
    /\b(?:path|value)\s*==\s*"([^"]*)"/g,
    /\bstrip_prefix\(\s*"([^"]*)"\s*\)/g,
    /\bstarts_with\(\s*"([^"]*)"\s*\)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(body)) !== null) out.push(match[1]);
  }
  return out;
}

function addRoutes(target, body, options = {}) {
  if (!body) return;
  const literals = options.compared ? comparedPathLiterals(body) : stringLiterals(body);
  for (const literal of literals) {
    if (literal === "/") {
      target.add("/");
      continue;
    }
    if (!literal.startsWith("/")) continue;
    if (/[<>{}]|\s/.test(literal)) continue;
    if (PREFIX_GUARDS.has(literal)) continue;
    if (options.onlyApi && !literal.startsWith("/api/v1/")) continue;
    if (options.onlyAdmin && !literal.startsWith("/cabinet/admin")) continue;
    if (isAsset(literal)) continue;
    target.add(literal);
  }
}

/**
 * Extract route literals the coordinator dispatches. Returns a Set plus a
 * per-region count so a parser regression fails loudly in the test.
 */
export function extractCoordinatorRoutes(source) {
  const routes = new Set();
  const counts = {};
  const regions = [
    ["static_asset", {}],
    ["seo_asset", { compared: true }],
    ["redirect_target", { compared: true }],
    ["handle", { onlyApi: true }],
    ["allowed", { onlyApi: true }],
    ["capacity_rejection_status", { onlyApi: true }],
    ["handle_admin", { onlyAdmin: true }],
  ];
  for (const [name, options] of regions) {
    const body = functionBody(source, name);
    counts[name] = body ? stringLiterals(body).filter((value) => value.startsWith("/")).length : 0;
    addRoutes(routes, body, options);
  }
  const panels = constArrayBody(source, "ADMIN_PANEL_ROUTES");
  counts.ADMIN_PANEL_ROUTES = panels ? stringLiterals(panels).length : 0;
  addRoutes(routes, panels, { onlyAdmin: true });
  routes.delete("/");
  routes.add("/");
  return { routes, counts };
}

/** Static prefix of a pattern, up to the first parameter or wildcard segment. */
export function patternPrefix(pattern) {
  if (pattern === "/") return "/";
  const segments = pattern.split("/").filter(Boolean);
  const kept = [];
  for (const segment of segments) {
    if (segment.startsWith(":") || segment === "*") break;
    kept.push(segment);
  }
  return kept.length === 0 ? "/" : `/${kept.join("/")}/`;
}

/** Compile a route pattern (`/a/:b/:c?/:*`) to an anchored RegExp. */
export function patternToRegExp(pattern) {
  if (pattern === "/") return /^\/$/;
  const segments = pattern.split("/").filter(Boolean);
  let source = "";
  for (const segment of segments) {
    if (segment === "*") {
      source += "/.*";
    } else if (segment.startsWith(":")) {
      const optional = segment.endsWith("?");
      source += optional ? "(?:/[^/]+)?" : "/[^/]+";
    } else {
      source += `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    }
  }
  return new RegExp(`^${source}$`);
}

/** True when a route family pattern covers a coordinator literal. */
export function patternCovers(pattern, literal) {
  if (pattern === literal) return true;
  if (pattern === "/" || literal === "/") return false;
  const prefix = patternPrefix(pattern);
  if (literal.endsWith("/")) {
    // A prefix marker (`strip_prefix`/`starts_with`) must sit between a
    // pattern's static prefix and its first parameter.
    return prefix.startsWith(literal) || literal.startsWith(prefix);
  }
  if (patternToRegExp(pattern).test(literal)) return true;
  // Ancestor literal: `/api/v1/wallets` (a starts_with guard without a slash)
  // is covered by `/api/v1/wallets/:slug`.
  return prefix === `${literal}/` || prefix.startsWith(`${literal}/`);
}

function readJson(root, relative) {
  const full = path.join(root, relative);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate data/routes.json against the coordinator source.
 *
 * `overrides.routes` replaces the parsed file and `overrides.coordinatorSource`
 * replaces the Rust source; the text test uses both to prove mutations fail.
 */
export function validateSiteRoutes(root = REPO_ROOT, overrides = {}) {
  const errors = [];
  let data;
  try {
    data = overrides.routes ?? readJson(root, ROUTES_PATH);
  } catch (error) {
    return { errors: [`site-route-map: cannot read ${ROUTES_PATH}: ${error.message}`], routeCount: 0, coordinatorCount: 0 };
  }
  const source = overrides.coordinatorSource
    ?? fs.readFileSync(path.join(root, COORDINATOR_PATH), "utf8");
  const { routes: coordinatorRoutes, counts } = extractCoordinatorRoutes(source);

  if (!isPlainObject(data) || !Array.isArray(data.routes)) {
    return { errors: ["site-route-map: data/routes.json must be an object with a routes array"], routeCount: 0, coordinatorCount: coordinatorRoutes.size };
  }

  const patterns = [];
  const seen = new Set();
  data.routes.forEach((route, index) => {
    const where = `site-route-map: routes[${index}]`;
    if (!isPlainObject(route)) {
      errors.push(`${where} must be an object`);
      return;
    }
    for (const field of REQUIRED_FIELDS) {
      if (typeof route[field] !== "string" || route[field].trim() === "") {
        errors.push(`${where}.${field} must be a non-empty string`);
      }
    }
    if (typeof route.pattern === "string") {
      if (!route.pattern.startsWith("/")) errors.push(`${where}.pattern must start with /`);
      if (/\s/.test(route.pattern)) errors.push(`${where}.pattern must not contain whitespace`);
      if (route.pattern !== "/" && route.pattern.endsWith("/")) {
        errors.push(`${where}.pattern must not end with / (use the concrete family)`);
      }
      if (seen.has(route.pattern)) errors.push(`${where}.pattern duplicates ${route.pattern}`);
      seen.add(route.pattern);
      patterns.push(route.pattern);
    }
    if (route.renderer && !RENDERERS.has(route.renderer)) {
      errors.push(`${where}.renderer must be one of: ${[...RENDERERS].join(", ")}`);
    }
    if (route.status && !STATUSES.has(route.status)) {
      errors.push(`${where}.status must be one of: ${[...STATUSES].join(", ")}`);
    }
    if (route.auth && !AUTH.has(route.auth)) {
      errors.push(`${where}.auth must be one of: ${[...AUTH].join(", ")}`);
    }
    if (!Array.isArray(route.data_sources) || !route.data_sources.every((value) => typeof value === "string" && value.trim() !== "")) {
      errors.push(`${where}.data_sources must be an array of non-empty strings`);
    }
    if (typeof route.template === "string") {
      const target = route.template.split("#")[0];
      if (path.isAbsolute(target) || target.startsWith("..")) {
        errors.push(`${where}.template must be a repo-relative path: ${route.template}`);
      } else if (!fs.existsSync(path.join(root, target))) {
        errors.push(`${where}.template does not exist: ${route.template}`);
      }
    }
    if (Array.isArray(route.data_sources)) {
      for (const value of route.data_sources) {
        if (
          value.startsWith("/") ||
          value.includes("*") ||
          value.includes("{") ||
          !DATA_SOURCE_FILE.test(value)
        ) {
          continue;
        }
        if (!fs.existsSync(path.join(root, value))) {
          errors.push(`${where}.data_sources names a missing file: ${value}`);
        }
      }
    }
  });

  for (const literal of coordinatorRoutes) {
    if (!patterns.some((pattern) => patternCovers(pattern, literal))) {
      errors.push(
        `site-route-map: the coordinator serves ${literal} but data/routes.json has no covering pattern; ` +
          "add the route family (or remove the route)",
      );
    }
  }

  // A live row must point at a route the coordinator actually dispatches. This
  // catches an invented "live" row; planned rows may name future routes.
  for (const route of data.routes) {
    if (!isPlainObject(route) || route.status !== "live" || typeof route.pattern !== "string") continue;
    const prefix = patternPrefix(route.pattern);
    const exact = patternToRegExp(route.pattern);
    const found = [...coordinatorRoutes].some((literal) => {
      if (exact.test(literal)) return true;
      if (literal.endsWith("/")) return literal.startsWith(prefix);
      return prefix === `${literal}/`;
    });
    if (!found) {
      errors.push(
        `site-route-map: ${route.pattern} is marked live but the coordinator does not dispatch it; ` +
          "fix the status or the pattern",
      );
    }
  }

  return {
    errors,
    routeCount: data.routes.length,
    coordinatorCount: coordinatorRoutes.size,
    coordinatorRoutes: [...coordinatorRoutes].sort(),
    counts,
  };
}

export function main(root = REPO_ROOT) {
  const result = validateSiteRoutes(root);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.error(`site-route-map FAILED (${result.errors.length} error(s))`);
    return 1;
  }
  console.log(
    `site-route-map OK: ${result.routeCount} route families cover ` +
      `${result.coordinatorCount} coordinator route literals`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
