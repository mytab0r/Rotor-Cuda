#!/usr/bin/env node
// Component-contract gate for the Rotor design system.
//
// It is the machine half of design/components/<name>.json and
// docs/design-system/components/<name>.md:
//
//   manifest-shape       the manifest has the twelve contract fields, a semver
//                        version, known status, unique variant/size/state ids
//                        and an existing docs page.
//   unknown-variant      every class in a variant or size list has a rule in
//                        apps/site/site.css. A class nobody styles is an
//                        invented variant, not a contract.
//   gallery-variant      every declared variant, size and state has a rendered
//                        example in apps/site/design.html with the matching
//                        data-component/data-variant/data-size/data-state.
//   required-attribute   every example carries the declared required attributes
//                        on the root or on the named slot.
//   page-local-family    a page <style> block does not target a shared family.
//                        The shared-family matcher and class parser are imported
//                        from scripts/check-token-usage.mjs (the legacy-selector
//                        detector), so there is one definition of a shared
//                        family and one class matcher.
//
// A manifest variant or size that the gallery does not render is the same class
// of failure as a state that is missing from the gallery: the contract and the
// rendered evidence disagree. The committed gallery's freshness is checked by
// `node scripts/build-gallery.mjs --check`, which is the separate gate.
//
// Zero dependencies; Windows-safe. Exit: 0 = clean, 1 = violations.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadManifests, OUTPUT_PATH, REPO_ROOT, COMPONENTS_DIR } from "./build-gallery.mjs";
import { classes as matcherClasses, isSharedFamily } from "./check-token-usage.mjs";

const CSS_PATH = "apps/site/site.css";
const SITE_DIR = "apps/site";
const REQUIRED_FIELDS = [
  "name",
  "version",
  "status",
  "element",
  "variants",
  "sizes",
  "states",
  "requiredAttrs",
  "forbidden",
  "slots",
  "tokens",
  "detectors",
  "docs",
];
const STATUSES = new Set(["stable", "reserved", "deprecated"]);
const DOC_HEADINGS = [
  "## Purpose",
  "## Anatomy and slots",
  "## API",
  "## State matrix",
  "## Motion and reduced motion",
  "## Accessibility",
  "## Copy rules",
  "## Do / don't",
  "## Detectors",
  "## Owner and changelog",
];

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

// Parse opening tags on one line. The generated gallery puts one root element
// per line, so this is enough to inspect a specimen without an HTML parser.
function openTags(line) {
  const tags = [];
  for (const match of line.matchAll(/<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    const attrs = {};
    for (const attribute of match[2].matchAll(/([:\w-]+)(?:="([^"]*)")?/g)) {
      attrs[attribute[1]] = attribute[2] === undefined ? "" : attribute[2];
    }
    tags.push({ tag: match[1], attrs });
  }
  return tags;
}

function cssClasses(css) {
  const names = new Set();
  for (const match of stripComments(css).matchAll(/\.([A-Za-z_][\w-]*)/g)) names.add(match[1]);
  return names;
}

function hasAttribute(tag, required) {
  if (!(required.name in tag.attrs)) return false;
  if (required.value === undefined) return true;
  const raw = String(tag.attrs[required.name]);
  if (raw === required.value) return true;
  // Space-separated id references may be suffixed per specimen
  // (aria-describedby="hint-3 error-3").
  return raw
    .split(/\s+/)
    .some((value) => value === required.value || value.startsWith(`${required.value}-`));
}

export function collectViolations(root = REPO_ROOT) {
  const violations = [];
  const add = (id, file, line, detail) => violations.push({ id, file, line, detail });
  const galleryPath = path.join(root, OUTPUT_PATH);
  if (!fs.existsSync(galleryPath)) {
    add("gallery-missing", OUTPUT_PATH, 1, "the generated gallery is missing; run node scripts/build-gallery.mjs");
    return violations;
  }
  const gallery = read(root, OUTPUT_PATH);
  const galleryLines = gallery.split("\n");
  const galleryStarts = lineStarts(gallery);
  const css = cssClasses(read(root, CSS_PATH));
  const manifests = loadManifests(root);

  for (const manifest of manifests) {
    const file = `${COMPONENTS_DIR}/${manifest.name}.json`;
    for (const field of REQUIRED_FIELDS) {
      if (!(field in manifest)) add("manifest-shape", file, 1, `missing field "${field}"`);
    }
    if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
      add("manifest-shape", file, 1, `version "${manifest.version}" must be semver`);
    }
    if (!STATUSES.has(manifest.status)) {
      add("manifest-shape", file, 1, `status "${manifest.status}" must be one of ${[...STATUSES].join(", ")}`);
    }
    for (const field of ["variants", "sizes", "states"]) {
      const seen = new Set();
      for (const item of manifest[field] || []) {
        if (!item || typeof item.id !== "string" || !item.id) {
          add("manifest-shape", file, 1, `${field} entry without an id`);
          continue;
        }
        if (seen.has(item.id)) add("manifest-shape", file, 1, `duplicate ${field} id "${item.id}"`);
        seen.add(item.id);
      }
    }
    for (const field of ["variants", "sizes"]) {
      for (const item of manifest[field] || []) {
        for (const name of item.classes || []) {
          if (!css.has(name)) {
            add(
              "unknown-variant",
              file,
              1,
              `${field} "${item.id}" uses .${name}, which has no rule in ${CSS_PATH}`,
            );
          }
        }
      }
    }

    if (!manifest.docs || !fs.existsSync(path.join(root, manifest.docs))) {
      add("manifest-shape", file, 1, `docs page ${manifest.docs || "(missing)"} does not exist`);
    } else {
      const docs = read(root, manifest.docs);
      for (const heading of DOC_HEADINGS) {
        if (!docs.includes(heading)) add("manifest-shape", manifest.docs, 1, `missing template section "${heading}"`);
      }
    }

    // All root examples of this component. A nested tag with the same
    // data-component would also match; the generator never emits one.
    const examples = [];
    for (const [index, line] of galleryLines.entries()) {
      for (const tag of openTags(line)) {
        if (tag.attrs["data-component"] === manifest.name) {
          examples.push({ line: index + 1, tag, text: line });
        }
      }
    }
    if (examples.length === 0) {
      add("gallery-variant", OUTPUT_PATH, 1, `${manifest.name} has no rendered example`);
      continue;
    }

    const present = (field, id) =>
      examples.some((example) => example.tag.attrs[field] === id);
    for (const variant of manifest.variants) {
      if (!present("data-variant", variant.id)) {
        add("gallery-variant", OUTPUT_PATH, 1, `${manifest.name} variant "${variant.id}" is missing from the gallery`);
      }
    }
    for (const size of manifest.sizes) {
      if (!present("data-size", size.id)) {
        add("gallery-variant", OUTPUT_PATH, 1, `${manifest.name} size "${size.id}" is missing from the gallery`);
      }
    }
    for (const state of manifest.states) {
      if (!present("data-state", state.id)) {
        add("gallery-variant", OUTPUT_PATH, 1, `${manifest.name} state "${state.id}" is missing from the gallery`);
      }
    }

    const rootRequired = (manifest.requiredAttrs || []).filter(
      (required) => !required.target || required.target === "root",
    );
    const slotRequired = (manifest.requiredAttrs || []).filter(
      (required) => required.target && required.target !== "root",
    );
    for (const example of examples) {
      for (const required of rootRequired) {
        if (!hasAttribute(example.tag, required)) {
          add(
            "required-attribute",
            OUTPUT_PATH,
            example.line,
            `${manifest.name} example is missing ${required.name}="${required.value ?? ""}"`,
          );
        }
      }
      for (const required of slotRequired) {
        const slotTag = openTags(example.text).find(
          (tag) => tag.attrs["data-slot"] === required.target,
        );
        if (!slotTag) {
          add(
            "required-attribute",
            OUTPUT_PATH,
            example.line,
            `${manifest.name} example has no data-slot="${required.target}" for ${required.name}`,
          );
        } else if (!hasAttribute(slotTag, required)) {
          add(
            "required-attribute",
            OUTPUT_PATH,
            example.line,
            `${manifest.name} slot "${required.target}" is missing ${required.name}="${required.value ?? ""}"`,
          );
        }
      }
    }
  }

  // Page-local <style> blocks must not style a shared family. The matcher is
  // the same one the legacy-selector detector uses.
  const siteDir = path.join(root, SITE_DIR);
  for (const name of fs.readdirSync(siteDir).filter((entry) => entry.endsWith(".html")).sort()) {
    const relative = `${SITE_DIR}/${name}`;
    const text = read(root, relative);
    const starts = lineStarts(text);
    for (const block of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      const bodyStart = block.index + block[0].indexOf(">") + 1;
      const body = stripComments(block[1]);
      for (const rule of body.matchAll(/([^{}]+)\{/g)) {
        const selector = rule[1].trim();
        if (!selector || selector.startsWith("@")) continue;
        for (const part of selector.split(",")) {
          const names = matcherClasses(part);
          const shared = names.find(isSharedFamily);
          if (!shared) continue;
          const index = bodyStart + rule.index + rule[0].indexOf(rule[1]) + rule[1].indexOf(part);
          add(
            "page-local-family",
            relative,
            lineAt(starts, index),
            `page <style> rule "${part.trim()}" targets the shared .${shared} family`,
          );
        }
      }
    }
  }

  return violations;
}

export function run({ root = REPO_ROOT } = {}) {
  let violations;
  try {
    violations = collectViolations(root);
  } catch (error) {
    console.error(`component-check: ${error.message}`);
    return 1;
  }
  if (violations.length === 0) {
    const count = loadManifests(root).length;
    console.log(`component-check: OK (${count} manifests, gallery and docs agree)`);
    return 0;
  }
  console.error(`component-check: ${violations.length} violation(s)`);
  for (const violation of violations) {
    console.error(`  [${violation.id}] ${violation.file}:${violation.line} ${violation.detail}`);
  }
  return 1;
}

export function main() {
  return run();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
