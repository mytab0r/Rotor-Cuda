// Shared area-map loader and glob matcher for scripts/*.mjs.
// No dependencies; globs use **, * and ? with most-specific-owner-wins.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Tracked paths with no area on purpose. Keep the list explicit.
export const IGNORED_PATHS = new Set(["Cargo.lock"]);

export function loadProjects(root = REPO_ROOT) {
  return JSON.parse(readFileSync(path.join(root, "projects.json"), "utf8"));
}

export function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function globToRegExp(glob) {
  if (typeof glob !== "string" || glob.length === 0) {
    throw new Error(`invalid glob: ${JSON.stringify(glob)}`);
  }
  if (glob.startsWith("/") || glob.includes("\\") || glob.split("/").includes("..")) {
    throw new Error(`invalid glob (absolute, backslash or ..): ${glob}`);
  }
  let source = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`${source}$`);
}

// Longer literal path wins; globs with equal literal length are compared by
// segment count so an exact file path always beats a wildcard.
export function specificity(glob) {
  let literals = 0;
  for (const ch of glob) {
    if (ch !== "*" && ch !== "?") literals += 1;
  }
  return [literals, glob.split("/").length];
}

// Returns { area, glob, ambiguous: [areaId...] } or null. `ambiguous` lists
// other areas whose best glob is exactly as specific as the winner.
export function resolvePath(areas, filePath) {
  const matches = [];
  for (const area of areas) {
    for (const glob of area.paths) {
      if (!globToRegExp(glob).test(filePath)) continue;
      const [literals, segments] = specificity(glob);
      matches.push({ area, glob, literals, segments });
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.literals - a.literals || b.segments - a.segments);
  const top = matches[0];
  const ambiguous = [
    ...new Set(
      matches
        .filter(
          (m) =>
            m.area.id !== top.area.id &&
            m.literals === top.literals &&
            m.segments === top.segments,
        )
        .map((m) => m.area.id),
    ),
  ];
  return { area: top.area, glob: top.glob, ambiguous };
}
