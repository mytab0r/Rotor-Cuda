// Shared loader for data/detectors.json, the single detector registry.
//
// Consumers:
//   - scripts/check-ssot.mjs        validates the registry, the audit coverage
//                                   and the defect-ledger coverage.
//   - scripts/check-defect-ledger.mjs
//   - scripts/gen-detector-docs.mjs renders the three markdown tables.
//
// The registry is the machine source. scripts/ui-audit.mjs stays the source of
// truth for which audit detectors exist; every id it emits must have a registry
// entry, and a defect-ledger detector must name one implemented entry.

import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./area-map.mjs";

export const REGISTRY_PATH = "data/detectors.json";
export const DEFECTS_PATH = "docs/process/defects.json";
export const AUDIT_PATH = "scripts/ui-audit.mjs";
export const REGISTRY_VERSION = 1;
export const STATUSES = new Set(["implemented", "planned", "diagnostic"]);
export const TABLES = ["skill", "plan", "design-system"];

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

function exists(root, relative) {
  if (typeof relative !== "string" || relative.trim() === "") return false;
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) return false;
  return fs.existsSync(path.join(root, relative));
}

export function loadRegistry(root = REPO_ROOT) {
  const json = readJson(root, REGISTRY_PATH);
  if (!json || json.version !== REGISTRY_VERSION || !Array.isArray(json.detectors)) {
    throw new Error(`${REGISTRY_PATH} must be { version: ${REGISTRY_VERSION}, detectors: [...] }`);
  }
  return json;
}

// Which generated markdown tables carry an entry. Diagnostic harness ids are
// not rules, so they stay registry-only.
export function tableScopes(entry) {
  if (entry.status === "diagnostic") return [];
  if (entry.status === "planned") return ["plan", "design-system"];
  return entry.implemented_in.startsWith("scripts/")
    ? ["skill", "plan", "design-system"]
    : ["plan", "design-system"];
}

export function validateRegistry(root = REPO_ROOT) {
  const errors = [];
  let json;
  try {
    json = loadRegistry(root);
  } catch (error) {
    return { ok: false, errors: [`[detector-registry] ${error.message}`], entries: [], byId: new Map() };
  }

  const byId = new Map();
  for (const [index, entry] of json.detectors.entries()) {
    const where = `${REGISTRY_PATH}.detectors[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`[detector-registry] ${where} must be an object`);
      continue;
    }
    const id = entry.id;
    if (typeof id !== "string" || !ID_RE.test(id)) {
      errors.push(`[detector-registry] ${where}.id must match ${ID_RE}`);
    } else if (byId.has(id)) {
      errors.push(`[detector-registry] ${REGISTRY_PATH} repeats detector id ${id}`);
    }
    if (typeof entry.rule !== "string" || entry.rule.trim() === "" || /[\r\n]/.test(entry.rule)) {
      errors.push(`[detector-registry] ${where}.rule must be one non-empty line`);
    }
    if (typeof entry.batch !== "string" || entry.batch.trim() === "") {
      errors.push(`[detector-registry] ${where}.batch must be a non-empty string`);
    }
    if (!STATUSES.has(entry.status)) {
      errors.push(`[detector-registry] ${where}.status must be one of: ${[...STATUSES].join(", ")}`);
    }
    if (typeof entry.doc_anchor !== "string" || entry.doc_anchor.trim() === "") {
      errors.push(`[detector-registry] ${where}.doc_anchor must name a docs file (optionally with #anchor)`);
    } else {
      const file = entry.doc_anchor.split("#")[0];
      if (!exists(root, file)) {
        errors.push(`[detector-registry] ${where}.doc_anchor file does not exist: ${file}`);
      }
    }

    if (entry.status === "planned") {
      if (entry.implemented_in !== null) {
        errors.push(`[detector-registry] ${where}.implemented_in must be null while status is planned`);
      }
    } else if (typeof entry.implemented_in !== "string" || entry.implemented_in.trim() === "") {
      errors.push(`[detector-registry] ${where}.implemented_in must name the implementing file`);
    } else if (!exists(root, entry.implemented_in)) {
      errors.push(`[detector-registry] ${where}.implemented_in does not exist: ${entry.implemented_in}`);
    } else {
      const text = fs.readFileSync(path.join(root, entry.implemented_in), "utf8");
      if (typeof id === "string" && !text.includes(id)) {
        errors.push(
          `[detector-registry] ${where}.implemented_in ${entry.implemented_in} does not contain the id ${id}`,
        );
      }
    }

    if (typeof id === "string" && !byId.has(id)) byId.set(id, entry);
  }

  return { ok: errors.length === 0, errors, entries: json.detectors, byId };
}

// Every id the audit can emit: `add("id", ...)` and `{ id: "id" }` literals,
// plus the `throw new Error(\`[id] ...\`)` convention used by the harness gates
// (for example route-coverage). This is intentionally a literal scan so the
// registry cannot silently lose a detector that the audit still reports.
export function auditDetectorIds(root = REPO_ROOT) {
  const text = fs.readFileSync(path.join(root, AUDIT_PATH), "utf8");
  const ids = new Set();
  for (const match of text.matchAll(/\badd\(\s*[\r\n]*\s*["']([A-Za-z][A-Za-z0-9_-]*)["']/g)) {
    ids.add(match[1]);
  }
  for (const match of text.matchAll(/\bid:\s*["']([A-Za-z][A-Za-z0-9_-]*)["']/g)) {
    ids.add(match[1]);
  }
  for (const match of text.matchAll(/throw new Error\(\s*`\[([A-Za-z][A-Za-z0-9_-]*)\]/g)) {
    ids.add(match[1]);
  }
  return [...ids].sort();
}

export function validateAuditCoverage(root, registry) {
  const errors = [];
  for (const id of auditDetectorIds(root)) {
    if (!registry.byId.has(id)) {
      errors.push(`[detector-registry] ${AUDIT_PATH} emits ${id}, which is missing from ${REGISTRY_PATH}`);
    }
  }
  return errors;
}

export function validateDefectCoverage(root, registry) {
  const errors = [];
  const ledger = readJson(root, DEFECTS_PATH);
  for (const entry of ledger.defects || []) {
    const detector = entry.detector;
    if (!detector || detector === "*") continue;
    const registered = registry.byId.get(detector);
    if (!registered) {
      errors.push(
        `[detector-registry] defect ${entry.id}: detector ${detector} has no entry in ${REGISTRY_PATH}`,
      );
      continue;
    }
    if (registered.status !== "implemented") {
      errors.push(
        `[detector-registry] defect ${entry.id}: detector ${detector} has no implementation (status ${registered.status})`,
      );
      continue;
    }
    if (registered.implemented_in !== entry.where) {
      errors.push(
        `[detector-registry] defect ${entry.id}: detector ${detector} is implemented in ` +
          `${registered.implemented_in}, but the ledger says ${entry.where}`,
      );
    }
  }
  return errors;
}
