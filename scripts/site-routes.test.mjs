// Mutation tests for the site-route-map gate: the current tree must pass, and
// each class of drift must fail. Run with: node --test scripts/site-routes.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  COORDINATOR_PATH,
  REPO_ROOT,
  ROUTES_PATH,
  extractCoordinatorRoutes,
  patternCovers,
  patternToRegExp,
  validateSiteRoutes,
} from "./lib/site-routes.mjs";

const source = fs.readFileSync(path.join(REPO_ROOT, COORDINATOR_PATH), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ROUTES_PATH), "utf8"));

test("the current tree passes and the map is substantial", () => {
  const result = validateSiteRoutes(REPO_ROOT);
  assert.deepEqual(result.errors, []);
  assert.ok(result.routeCount >= 80, `only ${result.routeCount} route families`);
  assert.ok(result.coordinatorCount >= 60, `only ${result.coordinatorCount} coordinator literals`);
});

test("extraction covers every dispatcher region", () => {
  const { routes, counts } = extractCoordinatorRoutes(source);
  for (const region of [
    "static_asset",
    "seo_asset",
    "redirect_target",
    "handle",
    "allowed",
    "capacity_rejection_status",
    "handle_admin",
    "ADMIN_PANEL_ROUTES",
  ]) {
    assert.ok((counts[region] || 0) > 0, `${region} yielded no route literals`);
  }
  for (const literal of ["/docs", "/key/", "/private-keys/", "/api/v1/jobs", "/cabinet/admin/design", "/cabinet/admin/api/audit"]) {
    assert.ok(routes.has(literal), `missing extracted literal ${literal}`);
  }
});

test("mutation: a coordinator page route missing from the map fails", () => {
  const mutated = source.replace(
    '"/docs" => Some((DOCS_PAGE.as_bytes(), "text/html; charset=utf-8")),',
    '"/fake-route-family" => Some((DOCS_PAGE.as_bytes(), "text/html; charset=utf-8")),\n' +
      '        "/docs" => Some((DOCS_PAGE.as_bytes(), "text/html; charset=utf-8")),',
  );
  assert.notEqual(mutated, source, "mutation anchor not found");
  const result = validateSiteRoutes(REPO_ROOT, { coordinatorSource: mutated });
  assert.ok(
    result.errors.some((error) => error.includes("/fake-route-family")),
    `expected a missing-route error, got: ${result.errors.join("\n")}`,
  );
});

test("mutation: a coordinator SEO route missing from the map fails", () => {
  const mutated = source.replace(
    'if path == "/faq" {',
    'if path == "/faq" || path == "/fake-seo-route" {',
  );
  assert.notEqual(mutated, source, "mutation anchor not found");
  const result = validateSiteRoutes(REPO_ROOT, { coordinatorSource: mutated });
  assert.ok(
    result.errors.some((error) => error.includes("/fake-seo-route")),
    `expected a missing-route error, got: ${result.errors.join("\n")}`,
  );
});

test("mutation: a mapped template file that does not exist fails", () => {
  const routes = structuredClone(data);
  routes.routes[0].template = "apps/site/does-not-exist.html";
  const result = validateSiteRoutes(REPO_ROOT, { routes });
  assert.ok(
    result.errors.some((error) => error.includes("does not exist")),
    `expected a template error, got: ${result.errors.join("\n")}`,
  );
});

test("mutation: an invalid renderer or duplicate pattern fails", () => {
  const routes = structuredClone(data);
  routes.routes[0].renderer = "react";
  routes.routes[1].pattern = routes.routes[0].pattern;
  const result = validateSiteRoutes(REPO_ROOT, { routes });
  assert.ok(result.errors.some((error) => error.includes("renderer must be one of")));
  assert.ok(result.errors.some((error) => error.includes("duplicates")));
});

test("pattern matching handles params, optional segments and wildcards", () => {
  assert.ok(patternToRegExp("/send/:chain").test("/send/bitcoin"));
  assert.ok(!patternToRegExp("/send/:chain").test("/send"));
  assert.ok(patternToRegExp("/send/:chain?").test("/send"));
  assert.ok(patternToRegExp("/api/v1/monitor/*").test("/api/v1/monitor/feed"));
  assert.ok(patternCovers("/send/:chain", "/send/tron"));
  assert.ok(patternCovers("/key/:hex", "/key/"));
  assert.ok(patternCovers("/cabinet/admin/api/*", "/cabinet/admin/api/audit"));
  assert.ok(!patternCovers("/cabinet/admin/site-map", "/cabinet/admin/design"));
});
