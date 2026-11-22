#!/usr/bin/env node
// Generate apps/site/design.html from the component manifests.
//
// The manifests in design/components/ are the machine contract
// (docs/design-system/DESIGN-SYSTEM.md §3.0). This generator renders one
// specimen per variant, size and state, using the production element names and
// production classes from apps/site/site.css. Nothing is restyled: the gallery
// loads /site.css and the shared page header is copied verbatim from a real
// page, so the gallery shows the components as production renders them.
//
// A variant marked `external` is rendered by the page shell instead of a
// specimen: `nav` uses the real <header class="site-nav"> and `breadcrumb` uses
// the page trail. Both carry data-component/data-variant/data-state so
// scripts/check-components.mjs can see that the declared variant is rendered.
//
// Usage:
//   node scripts/build-gallery.mjs           # write apps/site/design.html
//   node scripts/build-gallery.mjs --check   # fail when the committed page is stale
//
// Zero dependencies; Windows-safe. Exit: 0 = clean/written, 1 = stale/error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const COMPONENTS_DIR = "design/components";
export const OUTPUT_PATH = "apps/site/design.html";
const HEADER_SOURCE = "apps/site/docs.html";

const VOID_TAGS = new Set(["input", "br", "hr", "img", "meta", "link"]);
const STACK_STAGES = new Set(["card", "stat", "table", "empty", "error", "pager", "field", "skeleton"]);

function fail(message) {
  throw new Error(message);
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function readJson(root, relative) {
  try {
    return JSON.parse(read(root, relative));
  } catch (error) {
    fail(`cannot read ${relative}: ${error.message}`);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderAttrs(attrs) {
  let out = "";
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (value === "" || value === true) out += ` ${name}`;
    else out += ` ${name}="${escapeHtml(value)}"`;
  }
  return out;
}

export function loadManifests(root = REPO_ROOT) {
  const dir = path.join(root, COMPONENTS_DIR);
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (names.length === 0) fail(`${COMPONENTS_DIR} has no manifests`);
  return names.map((file) => {
    const manifest = readJson(root, `${COMPONENTS_DIR}/${file}`);
    const expected = file.slice(0, -".json".length);
    if (manifest.name !== expected) {
      fail(`${COMPONENTS_DIR}/${file}: name "${manifest.name}" must match the file name "${expected}"`);
    }
    for (const field of ["variants", "sizes", "states"]) {
      if (!Array.isArray(manifest[field]) || manifest[field].length === 0) {
        fail(`${manifest.name}.${field} must be a non-empty array`);
      }
    }
    return manifest;
  });
}

function baseVariant(manifest) {
  const variant = manifest.variants.find((candidate) => !candidate.external);
  if (!variant) fail(`${manifest.name} has no non-external variant to render states on`);
  return variant;
}

function mergeOverrides(...lists) {
  const merged = new Map();
  const apply = (list) => {
    for (const override of list || []) {
      if (!override || !override.slot) fail("override needs a slot name");
      const current = merged.get(override.slot) || { slot: override.slot, classes: [], attrs: {} };
      if (Array.isArray(override.classes)) current.classes.push(...override.classes);
      if (override.attrs) Object.assign(current.attrs, override.attrs);
      if (override.text !== undefined) current.text = override.text;
      merged.set(override.slot, current);
    }
  };
  for (const list of lists) apply(list);
  return merged;
}

function applyOverrides(node, overrides) {
  const override = node.name ? overrides.get(node.name) : null;
  const classes = [...(node.classes || []), ...((override && override.classes) || [])];
  const attrs = { ...(node.attrs || {}), ...((override && override.attrs) || {}) };
  const text = override && override.text !== undefined ? override.text : node.text;
  return { ...node, classes, attrs, text, children: node.children };
}

function renderSlot(node, overrides, requiredBySlot) {
  const merged = applyOverrides(node, overrides);
  const classes = merged.classes.length ? ` class="${escapeHtml(merged.classes.join(" "))}"` : "";
  const attrs = { ...merged.attrs };
  if (merged.name) attrs["data-slot"] = merged.name;
  if (merged.name && requiredBySlot[merged.name]) {
    for (const required of requiredBySlot[merged.name]) {
      if (required.value !== undefined) attrs[required.name] = required.value;
      else if (!(required.name in attrs)) attrs[required.name] = "";
    }
  }
  const text = merged.text === undefined || merged.text === null ? "" : escapeHtml(merged.text);
  if (VOID_TAGS.has(merged.tag)) {
    if (merged.children && merged.children.length) fail(`<${merged.tag}> cannot have children`);
    return `<${merged.tag}${classes}${renderAttrs(attrs)}>`;
  }
  const children = (merged.children || [])
    .map((child) => renderSlot(child, overrides, requiredBySlot))
    .join("");
  return `<${merged.tag}${classes}${renderAttrs(attrs)}>${text}${children}</${merged.tag}>`;
}

function requiredByTarget(manifest) {
  const bySlot = {};
  const root = [];
  for (const required of manifest.requiredAttrs || []) {
    if (!required || !required.name) fail(`${manifest.name}.requiredAttrs needs a name`);
    if (!required.target || required.target === "root") root.push(required);
    else (bySlot[required.target] ||= []).push(required);
  }
  return { root, bySlot };
}

// Duplicate ids are invalid HTML and would make aria-describedby/for resolve to
// the first example. Every specimen gets a suffix on its own ids and the
// references that point at them.
function uniquifyIds(html, suffix) {
  const ids = new Map();
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) ids.set(match[1], `${match[1]}-${suffix}`);
  let out = html.replace(/\sid="([^"]+)"/g, (_, id) => ` id="${ids.get(id)}"`);
  out = out.replace(
    /\s(for|aria-describedby|aria-labelledby|aria-controls|aria-owns|list)="([^"]*)"/g,
    (_, name, value) =>
      ` ${name}="${value
        .split(/\s+/)
        .map((token) => ids.get(token) || token)
        .join(" ")}"`,
  );
  out = out.replace(/\shref="#([^"]+)"/g, (_, id) => ` href="#${ids.get(id) || id}"`);
  return out;
}

export function renderSpecimen(manifest, variant, size, state, suffix) {
  const { root: rootRequired, bySlot } = requiredByTarget(manifest);
  const overrides = mergeOverrides(variant.overrides, state.overrides);
  const classes = [...(variant.classes || []), ...(size.classes || []), ...(state.classes || [])];
  const attrs = { ...(state.attrs || {}) };
  for (const required of rootRequired) {
    if (required.value !== undefined) attrs[required.name] = required.value;
    else if (!(required.name in attrs)) attrs[required.name] = "";
  }
  attrs["data-component"] = manifest.name;
  attrs["data-variant"] = variant.id;
  attrs["data-size"] = size.id;
  attrs["data-state"] = state.id;
  const root = {
    tag: variant.element || manifest.element,
    classes,
    attrs,
    children: variant.slots || manifest.slots || [],
  };
  const html = renderSlot(root, overrides, bySlot);
  return uniquifyIds(html, suffix);
}

function labelOf(item) {
  return item.label || item.id;
}

function figure(manifest, variant, size, state, suffix, stageClass) {
  const caption = `${labelOf(variant)} · ${labelOf(size)} · ${labelOf(state)}`;
  const markup = renderSpecimen(manifest, variant, size, state, suffix);
  return (
    `      <figure class="design-gallery__example">\n` +
    `        <figcaption class="design-gallery__label">${escapeHtml(manifest.name)} · ${escapeHtml(caption)}</figcaption>\n` +
    `        <div class="design-gallery__stage${stageClass}">\n` +
    `          ${markup}\n` +
    `        </div>\n` +
    `      </figure>\n`
  );
}

function extractPageHeader(root) {
  const source = read(root, HEADER_SOURCE);
  const start = source.indexOf('<header class="site-nav"');
  if (start === -1) fail(`${HEADER_SOURCE} has no <header class="site-nav">`);
  const end = source.indexOf("</header>", start);
  if (end === -1) fail(`${HEADER_SOURCE} has an unclosed site header`);
  // The source may be checked out with CRLF (core.autocrlf) or mixed EOL.
  // The renderer is LF-only; write time applies the working-tree EOL.
  return source.slice(start, end + "</header>".length).replace(/\r\n/g, "\n");
}

function markHeader(header, manifest) {
  const variant = manifest.variants.find((candidate) => candidate.external === "page-header");
  if (!variant) fail(`${manifest.name} needs a variant with external="page-header"`);
  return header.replace(
    "<header",
    `<header data-component="${escapeHtml(manifest.name)}" data-variant="${escapeHtml(
      variant.id,
    )}" data-size="${escapeHtml(manifest.sizes[0].id)}" data-state="default"`,
  );
}

function breadcrumbTrail(manifest, suffix) {
  return renderSpecimen(
    manifest,
    baseVariant(manifest),
    manifest.sizes[0],
    manifest.states[0],
    suffix,
  );
}

export function renderGallery(root = REPO_ROOT) {
  const manifests = loadManifests(root);
  const byName = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  const nav = byName.get("nav");
  const breadcrumb = byName.get("breadcrumb");
  if (!nav) fail("design/components/nav.json is required");
  if (!breadcrumb) fail("design/components/breadcrumb.json is required");

  let suffix = 0;
  let examples = "";
  const sections = [];
  for (const manifest of manifests) {
    const stack = STACK_STAGES.has(manifest.name);
    const stageClass = stack ? " design-gallery__stage--block" : "";
    const variantList = manifest.variants.filter((variant) => !variant.external);
    let body = "";

    if (manifest.name === "breadcrumb") {
      body =
        `      <p class="design-gallery__note">The trail above the title is the live ` +
        `<code>.breadcrumbs</code> example; its current marker is this page.</p>\n`;
    } else if (manifest.name === "nav") {
      body =
        `      <p class="design-gallery__note">The page header above is the live ` +
        `<code>.site-nav</code> example. Its links are the production markup.</p>\n`;
    } else {
      const base = baseVariant(manifest);
      const rows = [];
      for (const variant of variantList) {
        rows.push(figure(manifest, variant, manifest.sizes[0], manifest.states[0], ++suffix, stageClass));
      }
      for (const size of manifest.sizes) {
        if (size.id === manifest.sizes[0].id) continue;
        rows.push(figure(manifest, base, size, manifest.states[0], ++suffix, stageClass));
      }
      for (const state of manifest.states) {
        if (state.id === manifest.states[0].id) continue;
        rows.push(figure(manifest, base, manifest.sizes[0], state, ++suffix, stageClass));
      }
      const wrapper = stack ? " design-gallery__examples design-gallery__examples--stack" : " design-gallery__examples";
      body = `      <div class="${wrapper.trim()}">\n${rows.join("")}      </div>\n`;
    }

    sections.push(
      `    <section class="design-gallery__family" data-family="${escapeHtml(manifest.name)}">\n` +
        `      <h2>${escapeHtml(manifest.name)} <span class="design-gallery__label">v${escapeHtml(
          manifest.version,
        )} · ${escapeHtml(manifest.status)}</span></h2>\n` +
        `      <p class="design-gallery__note">Contract: <code>${escapeHtml(
          manifest.docs,
        )}</code> · ${manifest.detectors.length ? `detectors: <code>${escapeHtml(
          manifest.detectors.join(", "),
        )}</code>` : "not machine-checkable"}</p>\n` +
        body +
        `    </section>\n`,
    );
  }

  examples = sections.join("\n");
  const header = markHeader(extractPageHeader(root), nav);
  const trail = breadcrumbTrail(breadcrumb, ++suffix);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Crypto - design gallery</title>
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/admin.css">
<script src="/theme.js"></script>
</head>
<body>
${header}

<main>
  ${trail}
  <h1>Design gallery</h1>
  <p class="muted">
    Every normalized component family, rendered from
    <code>design/components/*.json</code> with the production classes from
    <code>apps/site/site.css</code>. The page is internal, noindex, requires the
    operator cookie and is not linked from the public navigation;
    <code>/cabinet/admin/design</code> is the only address.
  </p>

${examples}</main>

<script src="/site.js"></script>
</body>
</html>
`;
}

export function run(argv = process.argv.slice(2), root = REPO_ROOT) {
  const check = argv.includes("--check");
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length) fail(`unexpected argument(s): ${unknown.join(" ")}`);
  const full = path.join(root, OUTPUT_PATH);
  const existing = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
  // Preserve the working-tree EOL so --check passes with core.autocrlf=true and
  // in the LF CI checkout. The renderer always builds with LF.
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const output = renderGallery(root).replace(/\n/g, eol);
  if (check) {
    if (!existing) fail(`${OUTPUT_PATH} is missing; run node scripts/build-gallery.mjs`);
    if (existing !== output) {
      fail(`${OUTPUT_PATH} is stale; run node scripts/build-gallery.mjs and commit the result`);
    }
    console.log(`build-gallery: ${OUTPUT_PATH} is up to date (${loadManifests(root).length} manifests)`);
    return 0;
  }
  fs.writeFileSync(full, output);
  console.log(`build-gallery: wrote ${OUTPUT_PATH} from ${loadManifests(root).length} manifests`);
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  try {
    return run(argv);
  } catch (error) {
    console.error(`build-gallery: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
