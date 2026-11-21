#!/usr/bin/env node
// UI self-review harness for the Rotor site.
//
// Zero dependencies: drives headless Chrome/Edge over the DevTools protocol with
// Node's built-in WebSocket and fetch. It looks for the inconsistencies that keep
// slipping through page-local reviews: overflow, tiny text/targets, unlabeled
// icon controls, duplicated or uneven address-type components, half-empty cards,
// manual balance controls, and route-specific parity checks.
//
// Usage:
//   node scripts/ui-audit.mjs                       # audit a running coordinator on :7879
//   node scripts/ui-audit.mjs --serve               # start target/release/rotor-coord on :7899 (fails if the binary predates the site/coordinator sources)
//   node scripts/ui-audit.mjs --routes /key,/seed --viewports 375,1280 --themes dark
//
// Exit codes: 0 = no violations, 1 = violations found, 2 = harness/environment error.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const DEFAULT_ROUTES = [
  "/",
  "/key",
  // Key 1 in the URL derives on load, so the address table, statuses and
  // counters are inspected too (the plain /key route only types the key).
  "/key/0000000000000000000000000000000000000000000000000000000000000001",
  "/private-keys",
  "/private-keys/bitcoin",
  // The account-chain variant renders two summary cards (Balance / Active)
  // instead of the UTXO three-card row.
  "/private-keys/ethereum",
  "/seed",
  "/mnemonic-seeds/bitcoin",
  "/brainwallet",
  "/brainwallet/bitcoin",
  "/bitcoin-puzzle",
  "/bitcoin-puzzle/71",
  "/bitcoin-puzzle/71/random",
  "/tools",
  "/vanity",
  "/send",
  "/send/bitcoin",
  "/send/ethereum",
  "/send/bnb",
  "/send/usdt",
  "/send/tron",
  "/cabinet/wallet",
  "/mnemonic-converter",
  "/mnemonic-seeds",
  "/milk-sad",
  "/hex-dec-bin",
  "/public-key",
  "/pubkey-add",
  "/keystore-parser",
  "/reconstruction",
  "/tx",
  "/tx/bitcoin",
  "/tx/ethereum",
  "/docs",
  // Internal design-system gallery: every component family, both themes.
  "/design",
];
const VIEWPORT_HEIGHTS = { 375: 812, 768: 1024, 1280: 900 };
const DEFAULT_SETTLE_MS = 700;
const NAV_TIMEOUT_MS = 20000;
const SELECTOR_TIMEOUT_MS = 12000;
const CDP_TIMEOUT_MS = 20000;

const HELP = `ui-audit - headless UI self-review for the Rotor site

Options:
  --base URL            site origin (default http://127.0.0.1:7879, or :7899 with --serve)
  --routes a,b,c        comma-separated routes (default: key public routes;
                        on Git Bash omit the leading slash: --routes key,seed)
  --viewports 375,768,1280   widths to test; heights are preset (default 375,768,1280)
  --themes dark,light   colour schemes to test (default dark,light)
  --serve               spawn target/release/rotor-coord on 127.0.0.1:7899 with temp state
  --json PATH           write the machine-readable summary
  -h, --help            show this help

Exit: 0 = pass, 1 = violations, 2 = harness error (no browser, server, etc.).`;

function parseArgs(argv) {
  const options = {
    base: null,
    routes: DEFAULT_ROUTES,
    viewports: [375, 768, 1280],
    themes: ["dark", "light"],
    serve: false,
    json: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [name, inline] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, null];
    const value = () => {
      if (inline !== null) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`${name} needs a value`);
      return argv[i];
    };
    switch (name) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--base":
        options.base = value().replace(/\/+$/, "");
        break;
      case "--routes":
        options.routes = value()
          .split(",")
          .map((route) => route.trim())
          .filter(Boolean)
          .map((route) => (route.startsWith("/") ? route : `/${route}`));
        break;
      case "--viewports":
        options.viewports = value()
          .split(",")
          .map((width) => Number.parseInt(width.trim(), 10))
          .filter((width) => Number.isFinite(width) && width > 0);
        break;
      case "--themes":
        options.themes = value()
          .split(",")
          .map((theme) => theme.trim())
          .filter((theme) => theme === "dark" || theme === "light");
        break;
      case "--serve":
        options.serve = true;
        break;
      case "--json":
        options.json = value();
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.help) return options;
  if (options.routes.length === 0) throw new Error("--routes must contain at least one route");
  if (options.viewports.length === 0) throw new Error("--viewports must contain at least one width");
  if (options.themes.length === 0) throw new Error("--themes must contain dark and/or light");
  if (!options.base) options.base = options.serve ? "http://127.0.0.1:7899" : "http://127.0.0.1:7879";
  return options;
}

// route-coverage: every public text/html route in the coordinator's static_asset
// map must be inspected by the default audit. Internal/auth pages are exempt.
function missingPublicRoutes(routes) {
  const file = path.join(REPO_ROOT, "src", "coordinator", "mod.rs");
  const source = readFileSync(file, "utf8");
  const start = source.indexOf("fn static_asset(");
  const end = source.indexOf("_ => None", start);
  const excluded = new Set(["/cabinet", "/cabinet/wallet", "/app", "/run", "/me"]);
  const publicPages = new Set();
  let pending = [];
  for (const line of source.slice(start, end).split("\n")) {
    if (/^\s{8}"/.test(line)) pending = [];
    for (const match of line.matchAll(/"(\/[^"]*)"/g)) pending.push(match[1]);
    if (!line.includes('"text/html')) continue;
    for (const route of pending) {
      if (!excluded.has(route) && !route.includes("/api/")) publicPages.add(route);
    }
    pending = [];
  }
  return [...publicPages].filter((route) => !routes.includes(route));
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

// legacy-token: token truth lives in exactly one `:root` block. A second block
// (the pre-batch-7 legacy palette) silently overrides the first and makes every
// later token edit ambiguous. Theme overrides must use `html[data-theme]`, not
// a second `:root`.
function legacyTokenViolations() {
  const cssDir = path.join(REPO_ROOT, "apps", "site");
  const owners = new Map();
  for (const name of readdirSync(cssDir).filter((file) => file.endsWith(".css"))) {
    const text = readFileSync(path.join(cssDir, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
    for (const match of text.matchAll(/(^|\})\s*:root\s*\{([^}]*)\}/g)) {
      const line = text.slice(0, match.index).split("\n").length;
      for (const declaration of match[2].matchAll(/(--[\w-]+)\s*:/g)) {
        const token = declaration[1];
        if (!owners.has(token)) owners.set(token, []);
        owners.get(token).push(`${name}:${line}`);
      }
    }
  }
  const duplicates = [...owners].filter(([, where]) => where.length > 1);
  if (!duplicates.length) return [];
  return [{
    id: "legacy-token",
    message: `${duplicates.length} custom property(ies) declared in more than one :root block`,
    detail: duplicates.slice(0, 12).map(([token, where]) => `${token} (${where.join(", ")})`),
  }];
}

// empty-state-grammar: one shared empty box and one shared error box.
// Page-local empty classes and page-local error margins are deleted; the
// shared box uses the documented tokens. Static half of the check.
function emptyStateViolations() {
  const siteDir = path.join(REPO_ROOT, "apps", "site");
  const issues = [];
  const legacySelector = /\.(key-empty|range-empty|monitor-empty)\b/;
  for (const name of readdirSync(siteDir)) {
    if (!/\.(css|html|js)$/.test(name)) continue;
    const text = readFileSync(path.join(siteDir, name), "utf8");
    text.split("\n").forEach((line, index) => {
      const match = legacySelector.exec(line);
      if (match) issues.push(`${name}:${index + 1} keeps ${match[0]}`);
    });
  }

  const css = readFileSync(path.join(siteDir, "site.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const rules = [];
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const line = css.slice(0, match.index).split("\n").length;
    rules.push({ selector: match[1].trim(), body: match[2], line });
  }
  const declarations = (body) => {
    const map = new Map();
    for (const part of body.split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      map.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
    }
    return map;
  };

  const emptyRules = rules.filter((rule) =>
    rule.selector.split(",").map((selector) => selector.trim()).includes(".empty-state"),
  );
  if (emptyRules.length !== 1) {
    issues.push(`.empty-state is declared ${emptyRules.length} time(s) in site.css`);
  }
  for (const rule of emptyRules) {
    const decl = declarations(rule.body);
    if (!/\bdashed\b/.test(decl.get("border") || "")) {
      issues.push(`site.css:${rule.line} .empty-state border is not dashed`);
    }
    if ((decl.get("border-radius") || "") !== "var(--radius-l)") {
      issues.push(`site.css:${rule.line} .empty-state radius is ${decl.get("border-radius") || "unset"}`);
    }
    if ((decl.get("padding") || "") !== "var(--space-5)") {
      issues.push(`site.css:${rule.line} .empty-state padding is ${decl.get("padding") || "unset"}`);
    }
  }

  const errorSelectors = new Set([".error", ".key-error", ".range-error", ".monitor-status", ".wallet-field-error"]);
  for (const rule of rules) {
    if (!rule.selector.split(",").map((selector) => selector.trim()).some((selector) => errorSelectors.has(selector))) {
      continue;
    }
    const decl = declarations(rule.body);
    for (const name of ["margin", "margin-top"]) {
      const value = decl.get(name);
      if (value === undefined) continue;
      const top = name === "margin" ? value.split(/\s+/)[0] : value;
      if (top !== "var(--space-2)" && top !== "var(--space-3)") {
        issues.push(`site.css:${rule.line} ${rule.selector} ${name}: ${value}`);
      }
    }
  }

  if (!issues.length) return [];
  return [{
    id: "empty-state-grammar",
    message: `${issues.length} empty/error state issue(s) outside the shared grammar`,
    detail: issues.slice(0, 12),
  }];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killTree(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
      if (response.status < 500) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(250);
  }
  throw new Error(`server did not answer ${url} within ${timeoutMs}ms (${lastError})`);
}

function findBrowser() {
  const candidate = (value) => value && existsSync(value) && value;
  const env = candidate(process.env.CHROME_PATH) || candidate(process.env.EDGE_PATH);
  if (env) return env;

  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    const relative = [
      "Google/Chrome/Application/chrome.exe",
      "Microsoft/Edge/Application/msedge.exe",
    ];
    for (const root of roots) {
      for (const rel of relative) {
        const found = candidate(path.join(root, rel));
        if (found) return found;
      }
    }
    return null;
  }

  if (process.platform === "darwin") {
    return (
      candidate("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ||
      candidate("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge") ||
      candidate("/Applications/Chromium.app/Contents/MacOS/Chromium") ||
      null
    );
  }

  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  for (const name of names) {
    const result = spawnSync("which", [name], { encoding: "utf8" });
    const found = result.status === 0 ? result.stdout.trim() : "";
    if (candidate(found)) return found;
  }
  return null;
}

async function launchBrowser(browserPath, userDataDir) {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--mute-audio",
    "--window-size=1280,900",
    "about:blank",
  ];
  const child = spawn(browserPath, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  const portFile = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`browser exited with code ${child.exitCode}: ${stderr.trim()}`);
    }
    if (existsSync(portFile)) {
      const text = await readFile(portFile, "utf8").catch(() => "");
      const [portText, wsPath] = text.split("\n");
      const port = Number.parseInt(portText, 10);
      if (port > 0 && wsPath) {
        const target = await createPageTarget(port, child, stderr).catch(async (error) => {
          throw new Error(`cannot open a DevTools page target: ${error.message}\n${stderr.trim()}`);
        });
        return { child, port, wsUrl: target.webSocketDebuggerUrl, stderr: () => stderr };
      }
    }
    await sleep(100);
  }
  killTree(child);
  throw new Error(`browser did not expose a DevTools port within 20s: ${stderr.trim()}`);
}

async function createPageTarget(port, child, stderr) {
  // Chrome 111+ requires PUT for /json/new.
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`/json/new returned HTTP ${response.status}: ${stderr.trim()}`);
  }
  const target = await response.json();
  if (!target.webSocketDebuggerUrl) throw new Error("DevTools target has no webSocketDebuggerUrl");
  if (child.exitCode !== null) throw new Error("browser exited while creating the target");
  return target;
}

function createCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 0;

    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(`${message.error.message || "CDP error"}`));
        else request.resolve(message.result || {});
        return;
      }
      const handlers = listeners.get(message.method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(message.params || {});
          } catch {
            /* a broken listener must not kill the session */
          }
        }
      }
    };

    const api = {
      send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
        return new Promise((resolveCommand, rejectCommand) => {
          const id = ++nextId;
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectCommand(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      on(method, handler) {
        if (!listeners.has(method)) listeners.set(method, []);
        listeners.get(method).push(handler);
        return () => {
          const handlers = listeners.get(method) || [];
          const index = handlers.indexOf(handler);
          if (index >= 0) handlers.splice(index, 1);
        };
      },
      waitEvent(method, timeoutMs = CDP_TIMEOUT_MS, predicate = () => true) {
        return new Promise((resolveEvent, rejectEvent) => {
          const timer = setTimeout(() => {
            off();
            rejectEvent(new Error(`event ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          const off = api.on(method, (params) => {
            if (!predicate(params)) return;
            clearTimeout(timer);
            off();
            resolveEvent(params);
          });
        });
      },
      close() {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      },
    };

    socket.addEventListener("open", () => resolve(api));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", () => reject(new Error("DevTools WebSocket error")));
    socket.addEventListener("close", () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("DevTools WebSocket closed"));
      }
      pending.clear();
      reject(new Error("DevTools WebSocket closed before opening"));
    });
  });
}

async function evaluate(cdp, expression, timeoutMs = CDP_TIMEOUT_MS) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    timeoutMs,
  );
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(`page evaluation failed: ${detail}`);
  }
  return result.result?.value;
}

async function waitForSelector(cdp, selector, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await evaluate(
      cdp,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.getBoundingClientRect().height >= 0 : false; })()`,
      5000,
    ).catch(() => false);
    if (found) return true;
    await sleep(120);
  }
  return false;
}

async function goto(cdp, url) {
  // A load event can belong to the previous navigation, and the shared footer
  // is the last node in <body>: measuring too early reports it missing. Mark
  // the old document, then wait until the new one has finished parsing.
  const navToken = `nav-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await evaluate(cdp, `window.__auditNavToken = ${JSON.stringify(navToken)}`).catch(() => {});
  const loaded = cdp.waitEvent("Page.loadEventFired", NAV_TIMEOUT_MS);
  const navigation = await cdp.send("Page.navigate", { url }, NAV_TIMEOUT_MS);
  if (navigation.errorText) throw new Error(`navigation failed: ${navigation.errorText}`);
  await loaded.catch(() => {
    /* the page can still be inspected after a load timeout */
  });
  const started = Date.now();
  let complete = false;
  while (Date.now() - started < NAV_TIMEOUT_MS) {
    const state = await evaluate(
      cdp,
      `({ token: window.__auditNavToken, ready: document.readyState })`,
      5000,
    ).catch(() => null);
    if (state && state.token !== navToken && state.ready !== "loading") {
      complete = true;
      break;
    }
    await sleep(50);
  }
  if (!complete) throw new Error(`navigation did not finish parsing: ${url}`);
  // Give inline scripts and deferred bundles a beat to run.
  await sleep(DEFAULT_SETTLE_MS);
  await evaluate(
    cdp,
    `Promise.race([
       (document.fonts && document.fonts.ready) || Promise.resolve(),
       new Promise((resolve) => setTimeout(resolve, 3000)),
     ]).then(() => document.readyState)`,
    6000,
  ).catch(() => {});
}

// A cold first navigation in CI can miss the parse deadline once (fresh
// profile, large wasm fetch). Retry the navigation layer once: a genuinely
// broken page fails both attempts and still reports the violation.
async function gotoWithRetry(cdp, url, attempts = 2) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await goto(cdp, url);
      return;
    } catch (error) {
      if (!/^navigation/.test(error.message) || attempt >= attempts) throw error;
      log(`retry ${attempt}/${attempts - 1}: ${error.message}`);
      await sleep(500);
    }
  }
}

function slugify(route) {
  const slug = route.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "-");
  return slug || "home";
}

// Runs inside the page. Keep every helper inside so the function can be
// serialized without closing over the Node scope.
function auditPage(args) {
  const { route, theme } = args;
  const violations = [];
  const metrics = {
    theme: document.documentElement.getAttribute("data-theme") || null,
    colorScheme: document.documentElement.style.colorScheme || null,
  };
  const add = (id, message, detail) => violations.push({ id, message, detail });

  if (theme && metrics.theme && metrics.theme !== theme) {
    add("theme-not-applied", `expected ${theme} theme, page rendered ${metrics.theme}`, metrics);
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest("[hidden]")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.classList.contains("visually-hidden") || el.classList.contains("sr-only")) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number.parseFloat(style.opacity || "1") < 0.05) return false;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    if (box.bottom < 0 || box.right < 0) return false;
    return true;
  }

  function boxOf(el) {
    const box = el.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
  }

  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return `#${el.id}`;
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth += 1) {
      let part = node.tagName.toLowerCase();
      if (node.classList.length) part += `.${[...node.classList].slice(0, 2).join(".")}`;
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function textOf(el) {
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function directText(el) {
    return [...el.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  }

  // 1. Horizontal overflow.
  const docEl = document.documentElement;
  const body = document.body;
  const scrollWidth = Math.max(docEl.scrollWidth, body ? body.scrollWidth : 0);
  const clientWidth = docEl.clientWidth;
  metrics.overflow = { scrollWidth, clientWidth, excess: Math.max(0, scrollWidth - clientWidth) };
  if (scrollWidth > clientWidth + 1) {
    const offenders = [...document.body.querySelectorAll("*")]
      .filter(visible)
      .map((el) => ({ el, box: boxOf(el) }))
      .filter(({ box }) => box.right > clientWidth + 1 && box.width > 1)
      .slice(0, 5)
      .map(({ el, box }) => `${selectorOf(el)} (${Math.round(box.left)}..${Math.round(box.right)}px)`);
    add(
      "horizontal-overflow",
      `page scrolls horizontally: ${scrollWidth}px content in ${clientWidth}px viewport`,
      offenders.length ? { offenders } : undefined,
    );
  }

  // 1b. Controls that spill outside their card's padding box.
  const clippedControls = [];
  const scrollableAncestor = (el) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (["auto", "scroll"].includes(style.overflowX) || ["auto", "scroll"].includes(style.overflowY)) return true;
    }
    return false;
  };
  for (const card of [...document.querySelectorAll(".card")].filter(visible)) {
    const cardBox = card.getBoundingClientRect();
    for (const control of card.querySelectorAll("a, button, select, input, textarea")) {
      if (!visible(control) || scrollableAncestor(control)) continue;
      const controlBox = control.getBoundingClientRect();
      let reason = "";
      if (controlBox.right > cardBox.right + 1 || controlBox.bottom > cardBox.bottom + 1) {
        reason = "outside the card border";
      } else {
        for (let node = control.parentElement; node && node !== card; node = node.parentElement) {
          const style = getComputedStyle(node);
          const clips = ["hidden", "clip"].includes(style.overflowX);
          if (!clips) continue;
          const nodeBox = node.getBoundingClientRect();
          if (controlBox.right > nodeBox.right + 1 || controlBox.left < nodeBox.left - 1) {
            reason = `cut by ${selectorOf(node)}`;
            break;
          }
        }
      }
      if (reason) clippedControls.push(`${selectorOf(control)} ${reason}`);
    }
  }
  if (clippedControls.length) {
    add(
      "clipped-control",
      `${clippedControls.length} control(s) extend past their card padding`,
      clippedControls.slice(0, 6),
    );
  }

  // 1c. Raw URL paths shown where a human label belongs (tables and fact rows).
  const rawPaths = [];
  for (const cell of document.querySelectorAll("td, dd, .key-form-row")) {
    if (!visible(cell)) continue;
    if (cell.closest("pre, code.docs, .docs")) continue;
    const text = textOf(cell);
    if (/^\/[a-z0-9][\w\-/]*$/i.test(text) && text.length > 14) rawPaths.push(`${selectorOf(cell)}: ${text.slice(0, 48)}`);
  }
  if (rawPaths.length) {
    add("raw-path-text", `${rawPaths.length} cell(s) show a raw path instead of a label`, rawPaths.slice(0, 6));
  }

  // 2. Body text below 12px.
  const smallText = [];
  const seenText = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "BR", "HR"].includes(el.tagName)) continue;
    if (el.closest("svg")) continue;
    if (!visible(el)) continue;
    const text = directText(el);
    if (!text) continue;
    const size = Number.parseFloat(getComputedStyle(el).fontSize);
    if (!Number.isFinite(size) || size <= 0 || size >= 12) continue;
    const selector = selectorOf(el);
    if (seenText.has(selector)) continue;
    seenText.add(selector);
    smallText.push({ selector, size, text: text.slice(0, 48) });
  }
  metrics.smallText = smallText;
  if (smallText.length) {
    add("small-text", `${smallText.length} visible text element(s) below 12px`, smallText.slice(0, 8));
  }

  // 3. Touch targets below 44x44. Inline prose links are exempt (WCAG 2.5.8
  //    inline-text exception); they are not standalone controls.
  function inlineTextLink(el) {
    if (el.tagName !== "A") return false;
    if (el.querySelector("svg, img")) return false;
    if (!textOf(el)) return false;
    const style = getComputedStyle(el);
    if (style.display !== "inline") return false;
    return Boolean(el.closest("p, li, dd, dt, figcaption"));
  }

  const smallTargets = [];
  const interactive = document.querySelectorAll(
    'button, a[href], [role="button"], input[type="checkbox"], input[type="radio"], select, summary',
  );
  for (const el of interactive) {
    if (!visible(el)) continue;
    if (el.type === "hidden") continue;
    if (el.closest("[aria-hidden='true']")) continue;
    if (inlineTextLink(el)) continue;
    // A checkbox/radio wrapped in a >=44px label is effectively a large target.
    if (el.matches("input[type='checkbox'], input[type='radio']") && el.labels) {
      const labels = [...el.labels].filter(visible);
      if (labels.some((label) => boxOf(label).width >= 44 && boxOf(label).height >= 44)) continue;
    }
    const box = boxOf(el);
    if (box.width >= 44 && box.height >= 44) continue;
    smallTargets.push({
      selector: selectorOf(el),
      text: textOf(el).slice(0, 40),
      width: Math.round(box.width),
      height: Math.round(box.height),
    });
  }
  metrics.smallTargets = smallTargets;
  if (smallTargets.length) {
    add("small-touch-target", `${smallTargets.length} visible control(s) below 44x44`, smallTargets.slice(0, 8));
  }

  // 4. Icon-only controls without an accessible name.
  const unlabeledIcons = [];
  for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
    if (!visible(el)) continue;
    if (textOf(el)) continue;
    if (!el.querySelector("svg, img")) continue;
    const label =
      el.getAttribute("aria-label") ||
      el.getAttribute("aria-labelledby") ||
      el.getAttribute("title");
    if (!label) {
      unlabeledIcons.push({ selector: selectorOf(el), html: el.outerHTML.slice(0, 160) });
    }
  }
  metrics.unlabeledIcons = unlabeledIcons;
  if (unlabeledIcons.length) {
    add("unlabeled-icon-control", `${unlabeledIcons.length} icon-only control(s) without aria-label/title`, unlabeledIcons.slice(0, 8));
  }

  // 4a. Icon-only actions use the shared .icon-button component. A control
  //     with no visible text and an icon must not invent a page-local size
  //     (AGENTS.md: "Every icon-only action uses the shared .icon-button
  //     component"). Text nodes under aria-hidden/visually-hidden or inside
  //     svg/img do not count as a visible label.
  const visibleLabel = (el) => {
    const copy = el.cloneNode(true);
    for (const node of copy.querySelectorAll("svg, img, [aria-hidden='true'], .visually-hidden, .sr-only")) {
      node.remove();
    }
    return (copy.textContent || "").replace(/\s+/g, " ").trim();
  };
  const iconOnlyUnshared = [];
  for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
    if (!visible(el)) continue;
    if (el.classList.contains("icon-button")) continue;
    if (!el.querySelector("svg, img")) continue;
    if (visibleLabel(el)) continue;
    iconOnlyUnshared.push({ selector: selectorOf(el), html: el.outerHTML.slice(0, 160) });
  }
  metrics.iconOnlyUnshared = iconOnlyUnshared;
  if (iconOnlyUnshared.length) {
    add(
      "icon-only-shared-component",
      `${iconOnlyUnshared.length} icon-only control(s) without the shared .icon-button class`,
      iconOnlyUnshared.slice(0, 8),
    );
  }

  // 4b. Icon buttons share one geometry and one name pair. Regression guard
  //     for docs/design-system/DESIGN-SYSTEM.md §3.2: box 28/36/44, icon
  //     14/16/18, aria-label plus the shared data-tooltip primitive (no
  //     native title next to it). Sm (28) is reserved for dense table rows.
  const iconButtonSizes = [28, 36, 44];
  const iconSizes = [14, 16, 18];
  const iconButtonIssues = [];
  for (const el of document.querySelectorAll(".icon-button")) {
    if (!visible(el)) continue;
    const box = boxOf(el);
    const svg = el.querySelector("svg");
    if (!svg) {
      iconButtonIssues.push({ selector: selectorOf(el), issues: ["no icon"] });
      continue;
    }
    const iconStyle = getComputedStyle(svg);
    const width = Math.round(box.width);
    const height = Math.round(box.height);
    const iconWidth = Math.round(Number.parseFloat(iconStyle.width));
    const iconHeight = Math.round(Number.parseFloat(iconStyle.height));
    const issues = [];
    if (!iconButtonSizes.includes(height)) issues.push(`height ${height}px`);
    if (!iconButtonSizes.includes(width)) issues.push(`width ${width}px`);
    if (!iconSizes.includes(iconWidth) || iconWidth !== iconHeight) {
      issues.push(`icon ${iconWidth}x${iconHeight}px`);
    }
    if (!(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || textOf(el))) {
      issues.push("no accessible name");
    }
    if (!el.getAttribute("data-tooltip") || !el.getAttribute("data-tooltip").trim()) {
      issues.push("no data-tooltip");
    }
    if (el.hasAttribute("title")) issues.push("native title alongside data-tooltip");
    if (el.classList.contains("icon-button--sm") && !el.closest("tr, .key-row")) {
      issues.push("sm outside a dense table row");
    }
    if (issues.length) iconButtonIssues.push({ selector: selectorOf(el), issues });
  }
  metrics.iconButtons = iconButtonIssues;
  if (iconButtonIssues.length) {
    add("icon-button-scale", `${iconButtonIssues.length} icon button(s) outside the shared scale`, iconButtonIssues.slice(0, 8));
  }

  // 4d. Form controls share the control scale. Inputs and selects are
  //     28/36/44/56 high; textareas keep the 44 floor but may grow. Chips and
  //     segmented items are 44-high controls too. Regression guard for
  //     docs/design-system/DESIGN-SYSTEM.md §3.3/§3.4/§3.7.
  const controlHeightScale = [28, 36, 44, 56];
  const fieldSelector = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), select, textarea';
  const controlScaleIssues = [];
  const scaleControl = (el, kind) => {
    if (!visible(el) || el.disabled) return;
    const box = boxOf(el);
    const height = Math.round(box.height);
    if (kind === "textarea" ? height < 43.5 : !controlHeightScale.includes(height)) {
      controlScaleIssues.push({ selector: selectorOf(el), kind, issue: `height ${height}px` });
    }
  };
  for (const el of document.querySelectorAll(fieldSelector)) scaleControl(el, el.tagName.toLowerCase());
  for (const el of document.querySelectorAll(".chip, .segmented__item")) scaleControl(el, "chip");
  metrics.controlHeights = controlScaleIssues;
  if (controlScaleIssues.length) {
    add("control-height-scale", `${controlScaleIssues.length} control(s) outside the 28/36/44/56 scale`, controlScaleIssues.slice(0, 8));
  }

  // 4e. Field geometry: radius 10 (16 for the named hero size), a visible
  //     label at >=12px, and a focus ring on focus. The label may be a real
  //     <label>, a visually-hidden one wired with `for`, or aria-label.
  const fieldIssues = [];
  for (const el of document.querySelectorAll(fieldSelector)) {
    if (!visible(el) || el.disabled) continue;
    const style = getComputedStyle(el);
    const radius = Number.parseFloat(style.borderTopLeftRadius);
    const issues = [];
    if (![10, 16].some((value) => Math.abs(value - radius) <= 0.5)) {
      issues.push(`radius ${radius}px`);
    }
    const labels = el.labels ? [...el.labels] : [];
    const label = labels.find((node) => textOf(node)) || null;
    if (!label && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")) {
      issues.push("no label");
    } else if (label && Number.parseFloat(getComputedStyle(label).fontSize) < 12) {
      issues.push(`label ${getComputedStyle(label).fontSize}`);
    }
    el.focus({ preventScroll: true });
    const focused = getComputedStyle(el);
    const ring = (focused.boxShadow && focused.boxShadow !== "none") ||
      (focused.outlineStyle !== "none" && Number.parseFloat(focused.outlineWidth) > 0);
    el.blur();
    if (!ring) issues.push("no focus ring");
    if (issues.length) fieldIssues.push({ selector: selectorOf(el), issues });
  }
  metrics.fieldGeometry = fieldIssues;
  if (fieldIssues.length) {
    add("field-geometry", `${fieldIssues.length} field(s) outside the shared geometry`, fieldIssues.slice(0, 8));
  }

  // 4f. Segmented controls: one track grammar and exactly one selected item.
  const segmentedIssues = [];
  for (const track of document.querySelectorAll(".segmented")) {
    if (!visible(track)) continue;
    const style = getComputedStyle(track);
    const pad = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
      .map((value) => Number.parseFloat(value));
    const radius = Number.parseFloat(style.borderTopLeftRadius);
    const items = [...track.querySelectorAll(".segmented__item")].filter(visible);
    const selected = items.filter((item) =>
      item.getAttribute("aria-pressed") === "true" ||
      item.classList.contains("is-selected") ||
      item.classList.contains("active"));
    const issues = [];
    if (pad.some((value) => !(Math.abs(value - 4) <= 0.5))) issues.push(`track padding ${pad.join("/")}px`);
    if (Math.abs(radius - 12) > 0.5) issues.push(`track radius ${radius}px`);
    if (items.length < 2) issues.push(`${items.length} item(s)`);
    if (selected.length !== 1) issues.push(`${selected.length} selected item(s)`);
    for (const item of items) {
      const itemBox = boxOf(item);
      const itemRadius = Number.parseFloat(getComputedStyle(item).borderTopLeftRadius);
      if (itemBox.height < 43.5) issues.push(`${selectorOf(item)} height ${Math.round(itemBox.height)}px`);
      if (!(itemRadius >= 7.5 && itemRadius <= 10.5)) {
        issues.push(`${selectorOf(item)} radius ${itemRadius}px`);
      }
    }
    if (issues.length) segmentedIssues.push({ selector: selectorOf(track), issues });
  }
  metrics.segmented = segmentedIssues;
  if (segmentedIssues.length) {
    add("segmented-geometry", `${segmentedIssues.length} segmented control(s) outside the shared grammar`, segmentedIssues.slice(0, 8));
  }

  // 4g. Card surfaces share one padding/radius scale. `.card--flat` and the
  //     boxless `.stat-card` strip cell are documented exceptions.
  const cardSelector = [
    ".card",
    ".chain-card",
    ".tool-card",
    ".tool-family",
    ".address-db-card",
    ".tool-index-card",
    ".pz-picker-card",
    ".stat",
    ".stat-card",
    ".key-stat",
    ".pz-stat",
  ].join(", ");
  const cardPadScale = [16, 20, 24];
  const cardRadiusScale = [12, 16];
  const cardIssues = [];
  for (const el of document.querySelectorAll(cardSelector)) {
    if (!visible(el)) continue;
    if (el.classList.contains("card--flat")) continue;
    const style = getComputedStyle(el);
    const pad = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
      .map((value) => Number.parseFloat(value));
    const radius = Number.parseFloat(style.borderTopLeftRadius);
    const boxless = el.classList.contains("stat-card") || el.classList.contains("card--stat");
    const issues = [];
    if (pad.some((value) => !cardPadScale.some((step) => Math.abs(step - value) <= 0.5))) {
      issues.push(`padding ${pad.join("/")}px`);
    }
    if (!cardRadiusScale.some((step) => Math.abs(step - radius) <= 0.5) &&
        !(boxless && radius <= 0.5)) {
      issues.push(`radius ${radius}px`);
    }
    if (issues.length) cardIssues.push({ selector: selectorOf(el), issues });
  }
  metrics.cards = cardIssues;
  if (cardIssues.length) {
    add("card-padding-scale", `${cardIssues.length} card(s) outside the shared padding/radius scale`, cardIssues.slice(0, 8));
  }

  // 4h. Stat blocks: 12px sentence-case label, 20/24/28 value with tabular
  //     digits. No fixed empty height (the mostly-empty-block check covers it).
  const statIssues = [];
  for (const el of document.querySelectorAll(".stat, .stat-card, .key-stat, .pz-stat")) {
    if (!visible(el)) continue;
    const label = el.querySelector(".stat-label, .stat__label, .key-stat-label, .pz-stat-label");
    const value = el.querySelector(".stat-value, .stat__value, .key-stat-value, .pz-stat-value");
    if (!label && !value) continue;
    const issues = [];
    if (label) {
      const labelStyle = getComputedStyle(label);
      if (Number.parseFloat(labelStyle.fontSize) < 12) issues.push(`label ${labelStyle.fontSize}`);
      if (labelStyle.textTransform !== "none") issues.push(`label text-transform ${labelStyle.textTransform}`);
      if (Number.parseFloat(labelStyle.letterSpacing) > 0.5) issues.push(`label tracking ${labelStyle.letterSpacing}`);
    }
    if (value) {
      const valueStyle = getComputedStyle(value);
      const size = Math.round(Number.parseFloat(valueStyle.fontSize));
      if (![20, 24, 28].includes(size)) issues.push(`value ${size}px`);
      if (!String(valueStyle.fontVariantNumeric).includes("tabular-nums")) {
        issues.push(`value font-variant-numeric ${valueStyle.fontVariantNumeric}`);
      }
    }
    if (issues.length) statIssues.push({ selector: selectorOf(el), issues });
  }
  metrics.stats = statIssues;
  if (statIssues.length) {
    add("stat-geometry", `${statIssues.length} stat block(s) outside the shared geometry`, statIssues.slice(0, 8));
  }

  // 4i. Tables share one grammar: every visible table uses `.data-table`
  //     inside `.table-scroll`, header cells are 12px/600 sentence case with
  //     no tracking, and every cell has 8/12 padding.
  const tableGrammarIssues = [];
  const tableHeaderIssues = [];
  const tableSummary = { tables: 0, cells: 0, headerHeights: [], paddings: [] };
  for (const table of document.querySelectorAll("table")) {
    if (!visible(table)) continue;
    tableSummary.tables += 1;
    const tableIssues = [];
    if (!table.classList.contains("data-table")) tableIssues.push("missing .data-table");
    if (!table.parentElement || !table.parentElement.classList.contains("table-scroll")) {
      tableIssues.push("not inside .table-scroll");
    }
    const headers = [...table.querySelectorAll("thead th")].filter(visible);
    const cells = [...table.querySelectorAll("tbody td")].filter(visible);
    const pad8 = (value) => Math.abs(Number.parseFloat(value) - 8) <= 0.5;
    const pad12 = (value) => Math.abs(Number.parseFloat(value) - 12) <= 0.5;
    for (const cell of [...headers, ...cells]) {
      const style = getComputedStyle(cell);
      tableSummary.cells += 1;
      tableSummary.paddings.push(`${style.paddingTop}/${style.paddingRight}/${style.paddingBottom}/${style.paddingLeft}`);
      if (!pad8(style.paddingTop) || !pad8(style.paddingBottom)) {
        tableIssues.push(`${selectorOf(cell)} vertical padding ${style.paddingTop}/${style.paddingBottom}`);
      }
      if (!pad12(style.paddingLeft) || !pad12(style.paddingRight)) {
        tableIssues.push(`${selectorOf(cell)} horizontal padding ${style.paddingLeft}/${style.paddingRight}`);
      }
    }
    const headerHeights = headers.map((cell) => Math.round(cell.getBoundingClientRect().height));
    tableSummary.headerHeights.push(...headerHeights);
    if (headerHeights.length && Math.max(...headerHeights) - Math.min(...headerHeights) > 1) {
      tableIssues.push(`header heights ${[...new Set(headerHeights)].join("/")}`);
    }
    if (tableIssues.length) {
      tableGrammarIssues.push({ selector: selectorOf(table), issues: tableIssues.slice(0, 6) });
    }
    for (const cell of headers) {
      const style = getComputedStyle(cell);
      const issues = [];
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10);
      if (!(Math.abs(size - 12) <= 0.5)) issues.push(`font ${size}px`);
      if (Number.isFinite(weight) && weight > 600) issues.push(`weight ${weight}`);
      if (style.textTransform !== "none") issues.push(`transform ${style.textTransform}`);
      if (Number.parseFloat(style.letterSpacing) > 0.5) issues.push(`tracking ${style.letterSpacing}`);
      if (issues.length) tableHeaderIssues.push({ selector: selectorOf(cell), issues });
    }
  }
  metrics.tableGrammar = tableGrammarIssues;
  metrics.tableHeaders = tableHeaderIssues;
  for (const header of document.querySelectorAll(".keys-header, .bw-rows-header")) {
    if (!visible(header)) continue;
    const style = getComputedStyle(header);
    const issues = [];
    if (Math.abs(Number.parseFloat(style.fontSize) - 12) > 0.5) issues.push(`font ${style.fontSize}`);
    const weight = Number.parseInt(style.fontWeight, 10);
    if (Number.isFinite(weight) && weight > 600) issues.push(`weight ${weight}`);
    if (style.textTransform !== "none") issues.push(`transform ${style.textTransform}`);
    if (Number.parseFloat(style.letterSpacing) > 0.5) issues.push(`tracking ${style.letterSpacing}`);
    if (issues.length) tableHeaderIssues.push({ selector: selectorOf(header), issues });
  }
  if (tableGrammarIssues.length) {
    add("table-grammar", `${tableGrammarIssues.length} table(s) outside the shared shell`, tableGrammarIssues.slice(0, 8));
  }
  if (tableHeaderIssues.length) {
    add("table-header-style", `${tableHeaderIssues.length} table header cell(s) outside the shared style`, tableHeaderIssues.slice(0, 8));
  }

  // 4j. Row height: a table row is >=44 high, or it contains a >=44 action.
  //     Div-based directory/seed rows follow the same floor.
  const rowHeightIssues = [];
  const rowHeights = [];
  const checkRow = (row, kind) => {
    const box = boxOf(row);
    rowHeights.push(Math.round(box.height));
    if (box.height >= 43.5) return;
    const action = [...row.querySelectorAll("a, button, [role='button']")]
      .filter(visible)
      .some((control) => boxOf(control).height >= 43.5);
    if (!action) rowHeightIssues.push({ selector: selectorOf(row), kind, height: Math.round(box.height) });
  };
  for (const row of document.querySelectorAll("table.data-table tbody tr")) {
    if (visible(row)) checkRow(row, "table");
  }
  for (const row of document.querySelectorAll(".key-row:not(tr), .bw-row, .seed-row")) {
    if (visible(row)) checkRow(row, "row");
  }
  // `.bw-row` may be matched twice via `.key-row`? It is not a key-row.
  metrics.tableRows = rowHeightIssues;
  metrics.tableSummary = {
    tables: tableSummary.tables,
    cells: tableSummary.cells,
    headerHeights: [...new Set(tableSummary.headerHeights)].sort((a, b) => a - b),
    paddings: [...new Set(tableSummary.paddings)],
    rowHeightMin: rowHeights.length ? Math.min(...rowHeights) : null,
    rowHeightMax: rowHeights.length ? Math.max(...rowHeights) : null,
  };
  if (rowHeightIssues.length) {
    add("table-row-height", `${rowHeightIssues.length} row(s) below 44px without a 44px action`, rowHeightIssues.slice(0, 8));
  }

  // 4k. Row actions use the icon-button grammar (44 box, radius 10, labelled).
  const rowActionIssues = [];
  for (const action of document.querySelectorAll(
    "table.data-table .icon-button, .key-row .icon-button, .bw-row .icon-button",
  )) {
    if (!visible(action)) continue;
    const box = boxOf(action);
    const style = getComputedStyle(action);
    const radius = Number.parseFloat(style.borderTopLeftRadius);
    const issues = [];
    if (box.width < 43.5 || box.height < 43.5) {
      issues.push(`box ${Math.round(box.width)}x${Math.round(box.height)}px`);
    }
    if (Math.abs(radius - 10) > 0.5) issues.push(`radius ${radius}px`);
    if (!(action.getAttribute("aria-label") || action.getAttribute("aria-labelledby") || textOf(action))) {
      issues.push("no accessible name");
    }
    if (issues.length) rowActionIssues.push({ selector: selectorOf(action), issues });
  }
  metrics.rowActions = rowActionIssues;
  if (rowActionIssues.length) {
    add("row-action-geometry", `${rowActionIssues.length} row action(s) outside the icon-button grammar`, rowActionIssues.slice(0, 8));
  }

  // 4b. Status pills share one geometry. Regression guard for
  //     docs/design-system/DESIGN-SYSTEM.md §3.5: >=12px text, pill radius,
  //     8px inline padding, 18-32px height.
  const statusPillSelectors = [
    ".badge",
    ".key-badges span",
    ".puzzle-badge",
    ".puzzle-status",
    ".pz-pill",
    ".ws-chain-status",
    ".monitor-chain",
    ".balance-refresh-count",
  ].join(", ");
  const statusPills = [];
  for (const el of document.querySelectorAll(statusPillSelectors)) {
    if (!visible(el)) continue;
    const style = getComputedStyle(el);
    const box = boxOf(el);
    const fontSize = Number.parseFloat(style.fontSize);
    const radius = Number.parseFloat(style.borderTopLeftRadius);
    const padInline = Number.parseFloat(style.paddingLeft);
    const issues = [];
    if (!Number.isFinite(fontSize) || fontSize < 12) issues.push(`font ${fontSize}px`);
    if (!(box.height >= 18 && box.height <= 32)) issues.push(`height ${Math.round(box.height)}px`);
    if (!(radius >= Math.min(box.width, box.height) / 2 - 1)) issues.push(`radius ${radius}px not pill`);
    if (![6, 8, 10, 12].includes(Math.round(padInline))) issues.push(`padding-inline ${padInline}px`);
    if (issues.length) statusPills.push({ selector: selectorOf(el), issues });
  }
  metrics.statusPills = statusPills;
  if (statusPills.length) {
    add("status-pill-geometry", `${statusPills.length} status pill(s) outside the shared geometry`, statusPills.slice(0, 8));
  }

  // 4b-2. Empty and error states share one grammar: a dashed, radius-12,
  //       20px-padded empty box, and an error box whose top margin is on the
  //       8/12px scale. Enforced together with the static half above.
  const emptyStateIssues = [];
  const emptyStateCount = { boxes: 0, errors: 0 };
  const emptyStateSamples = [];
  for (const el of document.querySelectorAll(".empty-state")) {
    if (!visible(el)) continue;
    emptyStateCount.boxes += 1;
    const style = getComputedStyle(el);
    const issues = [];
    if (style.borderTopStyle !== "dashed") issues.push(`border ${style.borderTopStyle || "none"}`);
    const radius = Number.parseFloat(style.borderTopLeftRadius);
    if (!(Math.abs(radius - 12) <= 0.5)) issues.push(`radius ${radius}px`);
    const pad = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
      .map((value) => Number.parseFloat(value));
    if (pad.some((value) => !(Math.abs(value - 20) <= 0.5))) issues.push(`padding ${pad.join("/")}px`);
    if (emptyStateSamples.length < 8) {
      emptyStateSamples.push({ selector: selectorOf(el), border: style.borderTopStyle, radius, padding: pad });
    }
    if (issues.length) emptyStateIssues.push({ selector: selectorOf(el), kind: "empty", issues });
  }
  for (const el of document.querySelectorAll(".error")) {
    if (!visible(el)) continue;
    emptyStateCount.errors += 1;
    const marginTop = Number.parseFloat(getComputedStyle(el).marginTop);
    if (emptyStateSamples.length < 8) {
      emptyStateSamples.push({ selector: selectorOf(el), kind: "error", marginTop });
    }
    if (![8, 12].some((step) => Math.abs(step - marginTop) <= 0.5)) {
      emptyStateIssues.push({ selector: selectorOf(el), kind: "error", issues: [`margin-top ${marginTop}px`] });
    }
  }
  metrics.emptyStates = emptyStateIssues;
  metrics.emptyStateCount = emptyStateCount;
  metrics.emptyStateSamples = emptyStateSamples;
  if (emptyStateIssues.length) {
    add("empty-state-grammar", `${emptyStateIssues.length} empty/error state(s) outside the shared grammar`, emptyStateIssues.slice(0, 8));
  }

  // 4c. Tooltip contract: data-tooltip targets carry short text, never a
  //     duplicate native title, and icon-only ones keep an aria-label.
  const tooltipTargets = [...document.querySelectorAll("[data-tooltip]")].filter(visible);
  const tooltipIssues = [];
  for (const el of tooltipTargets) {
    const text = (el.getAttribute("data-tooltip") || "").trim();
    if (!text) tooltipIssues.push(`${selectorOf(el)} has an empty data-tooltip`);
    else if (text.length > 40) tooltipIssues.push(`${selectorOf(el)} tooltip is ${text.length} chars: ${text.slice(0, 48)}`);
    if (el.hasAttribute("title")) tooltipIssues.push(`${selectorOf(el)} keeps a native title alongside data-tooltip`);
    if (!textOf(el) && el.querySelector("svg, img") &&
        !(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"))) {
      tooltipIssues.push(`${selectorOf(el)} is icon-only without an accessible name`);
    }
  }
  metrics.tooltips = { targets: tooltipTargets.length, issues: tooltipIssues };
  if (tooltipIssues.length) {
    add("tooltip-primitive", `${tooltipIssues.length} tooltip target(s) break the shared primitive`, tooltipIssues.slice(0, 8));
  }

  // 4c. /key info affordance: a quiet 18px glyph in the shared 44x44
  //     .icon-button hit area must not read as another bordered button beside
  //     random/clear.
  if (route === "/key" || route.startsWith("/key/")) {
    const info = document.getElementById("key-info-btn");
    const meta = document.querySelector(".key-input-meta");
    metrics.keyInfo = {};
    if (info && visible(info)) {
      const style = getComputedStyle(info);
      const box = boxOf(info);
      const borderWidths = ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"]
        .map((name) => Number.parseFloat(style[name] || "0"));
      const colorAlpha = (value) => {
        const match = String(value || "").match(/rgba?\(([^)]+)\)/);
        const parts = match ? match[1].split(",").map(Number) : [];
        return parts.length > 3 ? parts[3] : 1;
      };
      const bg = style.backgroundColor || "";
      const alpha = colorAlpha(bg);
      const borderColors = ["borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"]
        .map((name) => style[name]);
      const visibleBorder = borderWidths.some((width, i) => width > 0.05 && colorAlpha(borderColors[i]) > 0.05);
      const issues = [];
      if (box.width < 43.5 || box.height < 43.5) {
        issues.push(`hit box ${Math.round(box.width)}x${Math.round(box.height)}px (expected >=44x44)`);
      }
      if (visibleBorder) {
        issues.push(`visible border ${borderWidths.map((width) => `${width}px`).join("/")}`);
      }
      if (alpha > 0.05) issues.push(`visible background ${bg}`);
      if (style.backgroundImage && style.backgroundImage !== "none") issues.push(`background image ${style.backgroundImage}`);
      if (!info.classList.contains("icon-button")) issues.push("not the shared .icon-button component");
      metrics.keyInfo = {
        width: Math.round(box.width),
        height: Math.round(box.height),
        borderWidths,
        background: bg,
      };
      if (issues.length) {
        add("look-alike-icon-button", `#key-info-btn still looks like a full button: ${issues.join("; ")}`, issues);
      }
    }
    if (meta && visible(meta)) {
      const metaBox = boxOf(meta);
      metrics.metaRow = { height: Math.round(metaBox.height) };
      if (Math.abs(metaBox.height - 40) > 1) {
        add("key-meta-row", `.key-input-meta is ${Math.round(metaBox.height)}px high (expected one 40px line)`);
      }
      if (info && visible(info)) {
        const infoBox = boxOf(info);
        const offset = Math.abs((infoBox.top + infoBox.height / 2) - (metaBox.top + metaBox.height / 2));
        metrics.metaRow.infoCentreOffset = Number(offset.toFixed(1));
        if (offset > 2) {
          add("key-meta-row", `#key-info-btn is ${offset.toFixed(1)}px off the meta row centre`);
        }
      }
    }

    // The private-key field shows the key as ordinary text (no password mask).
    const priv = document.getElementById("priv");
    if (priv && priv.type === "password") {
      add("key-input-type", "#priv is type=password; the key field must show plain text");
    }

    // The row text and its title come from one formatter: same amount/decimals
    // and the same tx count. Only settled rows are checked.
    const balanceIssues = [];
    for (const badge of document.querySelectorAll(".key-balance")) {
      const row = badge.closest("tr, .key-row");
      if (!row || !visible(badge) || row.dataset.balanceState !== "ok") continue;
      const title = (badge.getAttribute("title") || "").trim();
      const text = textOf(badge);
      const amount = /^([\d,]+(?:\.\d+)?)\s+[A-Z]+/.exec(title);
      if (!amount) continue;
      const issues = [];
      if (!text.includes(amount[1])) {
        issues.push(`text "${text}" does not carry the title amount ${amount[1]}`);
      }
      const txs = /·\s*(\d+)\s+tx/.exec(title);
      if (txs && !text.includes(txs[1] + " tx")) {
        issues.push(`text "${text}" does not carry the title tx count ${txs[1]}`);
      }
      if (issues.length) balanceIssues.push({ selector: selectorOf(badge), title, issues });
    }
    metrics.balanceRows = balanceIssues;
    if (balanceIssues.length) {
      add("balance-consistency", `${balanceIssues.length} balance row(s) disagree with their title`, balanceIssues.slice(0, 8));
    }
  }

  // 5. Duplicate address-type implementations on one page.
  const keyFamily = document.querySelector(".key-types, .key-btc-panel");
  const panelFamily = document.querySelector(".address-type-panel");
  metrics.addressTypeFamilies = {
    keyTypes: Boolean(keyFamily),
    addressTypePanel: Boolean(panelFamily),
  };
  if (keyFamily && panelFamily) {
    add(
      "duplicate-address-type-implementation",
      "page mixes .key-types/.key-btc-panel with .address-type-panel",
      { keyTypes: selectorOf(keyFamily), addressTypePanel: selectorOf(panelFamily) },
    );
  }

  // 6. Address-type card widths must not diverge inside one row. 15% is the
  //    documented tolerance; above that one card looks like a different widget.
  function unionArea(rects) {
    if (!rects.length) return 0;
    const xs = [...new Set(rects.flatMap((rect) => [rect.left, rect.right]))].sort((a, b) => a - b);
    let area = 0;
    for (let index = 0; index < xs.length - 1; index += 1) {
      const left = xs[index];
      const right = xs[index + 1];
      if (right <= left) continue;
      const spans = rects
        .filter((rect) => rect.left < right && rect.right > left)
        .map((rect) => [rect.top, rect.bottom])
        .sort((a, b) => a[0] - b[0]);
      let covered = 0;
      let start = null;
      let end = null;
      for (const [spanStart, spanEnd] of spans) {
        if (start === null) {
          start = spanStart;
          end = spanEnd;
        } else if (spanStart <= end) {
          end = Math.max(end, spanEnd);
        } else {
          covered += end - start;
          start = spanStart;
          end = spanEnd;
        }
      }
      if (start !== null) covered += end - start;
      area += (right - left) * covered;
    }
    return area;
  }

  const spreadIssues = [];
  const containers = [];
  for (const container of document.querySelectorAll(".key-types, .address-type-cards")) {
    containers.push({ el: container, cards: [...container.children] });
  }
  for (const panel of document.querySelectorAll(".address-type-panel")) {
    const cards = [...panel.children].filter((child) => child.classList.contains("address-type-card"));
    if (cards.length) containers.push({ el: panel, cards });
  }
  for (const { el, cards } of containers) {
    if (!visible(el)) continue;
    const rows = new Map();
    for (const card of cards) {
      if (!visible(card)) continue;
      const box = boxOf(card);
      if (box.width <= 0) continue;
      const rowKey = Math.round(box.top / 4);
      if (!rows.has(rowKey)) rows.set(rowKey, []);
      rows.get(rowKey).push({ card, width: box.width });
    }
    for (const entries of rows.values()) {
      if (entries.length < 2) continue;
      const widths = entries.map((entry) => entry.width);
      const max = Math.max(...widths);
      const min = Math.min(...widths);
      const spread = max > 0 ? (max - min) / max : 0;
      if (spread > 0.15) {
        spreadIssues.push({
          container: selectorOf(el),
          widths: widths.map((width) => Math.round(width)),
          spread: Number(spread.toFixed(2)),
        });
      }
    }
  }
  metrics.addressTypeSpread = spreadIssues;
  if (spreadIssues.length) {
    add("address-type-width-spread", `address-type cards differ by more than 15% inside a row`, spreadIssues);
  }

  // 7. Large blocks that are mostly empty. Threshold: a card/section taller
  //    than 220px with less than 55% of its content box covered by visible
  //    direct children. This is intentionally conservative to avoid flagging
  //    normal spacing.
  const emptyBlocks = [];
  for (const el of document.querySelectorAll("section, .card")) {
    if (!visible(el)) continue;
    const outer = boxOf(el);
    if (outer.height <= 220) continue;
    const style = getComputedStyle(el);
    const inner = {
      left: outer.left + Number.parseFloat(style.paddingLeft || "0") + Number.parseFloat(style.borderLeftWidth || "0"),
      top: outer.top + Number.parseFloat(style.paddingTop || "0") + Number.parseFloat(style.borderTopWidth || "0"),
      right: outer.right - Number.parseFloat(style.paddingRight || "0") - Number.parseFloat(style.borderRightWidth || "0"),
      bottom: outer.bottom - Number.parseFloat(style.paddingBottom || "0") - Number.parseFloat(style.borderBottomWidth || "0"),
    };
    const innerWidth = inner.right - inner.left;
    const innerHeight = inner.bottom - inner.top;
    if (innerWidth <= 0 || innerHeight <= 0) continue;
    const children = [...el.children]
      .filter(visible)
      .map((child) => {
        const box = boxOf(child);
        return {
          left: Math.max(inner.left, box.left),
          top: Math.max(inner.top, box.top),
          right: Math.min(inner.right, box.right),
          bottom: Math.min(inner.bottom, box.bottom),
        };
      })
      .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
    const covered = unionArea(children);
    const ratio = 1 - covered / (innerWidth * innerHeight);
    if (ratio > 0.45) {
      emptyBlocks.push({
        selector: selectorOf(el),
        height: Math.round(outer.height),
        emptyRatio: Number(ratio.toFixed(2)),
      });
    }
  }
  metrics.emptyBlocks = emptyBlocks;
  if (emptyBlocks.length) {
    add("mostly-empty-block", `${emptyBlocks.length} large block(s) more than 45% empty`, emptyBlocks.slice(0, 8));
  }

  // 8. Visible manual balance controls. Balance must be automatic; these
  //    controls are the regression this harness exists to catch.
  const manualIds = new Set(["check-balances", "seed-balances", "online-toggle"]);
  const manualTexts = new Set(["check balances", "check public balances", "online balance lookups"]);
  const balanceControls = [];
  const seenControl = new Set();
  for (const el of document.querySelectorAll("button, a, label, input, p, span, div")) {
    if (!visible(el)) continue;
    const id = el.id || "";
    const text = textOf(el);
    const lower = text.toLowerCase();
    const idHit = manualIds.has(id);
    const textHit =
      manualTexts.has(lower) ||
      (el.matches("button, a[role='button'], input[type='submit']") && lower.startsWith("check balances"));
    if (!idHit && !textHit) continue;
    const key = id || lower.slice(0, 60);
    if (seenControl.has(key)) continue;
    seenControl.add(key);
    balanceControls.push({ selector: selectorOf(el), text: text.slice(0, 80) });
  }
  metrics.balanceControls = balanceControls;
  if (balanceControls.length) {
    add("manual-balance-control", `${balanceControls.length} visible manual balance control(s)`, balanceControls.slice(0, 8));
  }

  // 8b. Summary card grid: a chain-shaped summary (two cards on account
  //     chains) rendered on a three-column grid leaves an empty cell. Count
  //     rendered columns from the computed template; ".balance-refresh" and
  //     ".balance-note" span every column and are not cards.
  const summaryOrphans = [];
  for (const summary of document.querySelectorAll(".balance-summary")) {
    if (!visible(summary)) continue;
    const template = (getComputedStyle(summary).gridTemplateColumns || "none").trim();
    const columns = template === "none" ? 1 : template.split(/\s+/).filter(Boolean).length;
    const cards = summary.querySelectorAll(":scope > .stat-card").length;
    if (cards > 0 && columns > 0 && cards % columns !== 0) {
      summaryOrphans.push({ selector: selectorOf(summary), cards, columns });
    }
  }
  metrics.summaryGrid = summaryOrphans;
  if (summaryOrphans.length) {
    const first = summaryOrphans[0];
    add(
      "summary-grid-orphan",
      `${route}: ${first.selector} has ${first.cards} card(s) on a ${first.columns}-column grid`,
      summaryOrphans.slice(0, 8)
    );
  }

  // 9. Route-specific parity checks.
  metrics.routeChecks = {};
  if (route === "/key") {
    const calculate = [...document.querySelectorAll("button, input[type='submit'], a[role='button']")]
      .filter(visible)
      .filter((el) => /^calculate$/i.test(textOf(el)) || /calculate/i.test(el.id || ""));
    metrics.routeChecks.calculateButtons = calculate.map((el) => selectorOf(el));
    if (calculate.length) {
      add("key-calculate-button", "/key still exposes a Calculate button; derivation must follow the input", metrics.routeChecks.calculateButtons);
    }
    metrics.routeChecks.hasPrivateInput = Boolean(document.getElementById("priv"));

    const presetChips = document.querySelectorAll("[data-preset]").length;
    const presetSelect = document.getElementById("preset-select");
    metrics.routeChecks.presetChips = presetChips;
    metrics.routeChecks.presetSelect = Boolean(presetSelect && visible(presetSelect));
    if (presetChips > 0 && presetSelect && visible(presetSelect)) {
      add("duplicate-preset-control", "/key shows both preset chips and a preset select for the same filter");
    }

    const summary = document.getElementById("summary");
    if (summary) {
      let columns = [...summary.children].filter(visible);
      if (columns.length === 1) {
        const nested = [...columns[0].children].filter(visible);
        if (nested.length >= 2) columns = nested;
      }
      // Only boxes that share a grid row are columns; stacked groups in a
      // single-column layout are not comparable.
      const rows = [];
      for (const column of columns) {
        const box = boxOf(column);
        const row = rows.find((entry) => Math.abs(entry.top - box.top) <= 2);
        if (row) row.boxes.push(box);
        else rows.push({ top: box.top, boxes: [box] });
      }
      const row = rows.find((entry) => entry.boxes.length >= 2);
      if (row) {
        const bottoms = row.boxes.map((box) => Math.round(box.bottom));
        const spread = Math.round(Math.max(...bottoms) - Math.min(...bottoms));
        const tallest = Math.round(Math.max(...row.boxes.map((box) => box.height)));
        if (tallest > 150 && spread > 40) {
          metrics.routeChecks.summaryColumnSpread = spread;
          add("ragged-summary-columns", `/key Keys columns end ${spread}px apart`, { bottoms, spread });
        }
      }
    }
  }

  if (route === "/seed") {
    const checkbox = document.getElementById("seed-balances");
    metrics.routeChecks.seedBalanceCheckbox = Boolean(checkbox && visible(checkbox));
    const form = document.querySelector("#seed-form, .seed-studio-form");
    const card = form ? form.closest(".card, section") : null;
    if (form && card) {
      const style = getComputedStyle(card);
      const contentWidth =
        card.clientWidth -
        Number.parseFloat(style.paddingLeft || "0") -
        Number.parseFloat(style.paddingRight || "0");
      const formWidth = boxOf(form).width;
      const ratio = contentWidth > 0 ? formWidth / contentWidth : 0;
      metrics.routeChecks.seedFormWidthRatio = Number(ratio.toFixed(2));
      if (ratio <= 0.8) {
        add("seed-form-narrow", `/seed form uses ${Math.round(ratio * 100)}% of the card width (expected >80%)`, {
          formWidth: Math.round(formWidth),
          contentWidth: Math.round(contentWidth),
        });
      }
    }
  }

  if (route === "/cabinet/wallet") {
    // The seed block lives in the unlocked vault panel; auditWalletSeed()
    // creates/unlocks the vault before this runs. The page must say how strong
    // the phrase is, offer a hover/focus estimate through the shared tooltip
    // primitive and keep both actions on the 44px target scale.
    const strength = document.getElementById("wallet-seed-strength");
    const info = document.getElementById("wallet-seed-info");
    const generate = document.getElementById("wallet-seed-generate");
    const addButton = document.getElementById("wallet-seed-add");
    const issues = [];
    metrics.routeChecks.walletSeed = {};
    if (!strength || !visible(strength)) {
      issues.push("#wallet-seed-strength is missing or hidden");
    } else {
      const text = (textOf(strength) || "").trim();
      metrics.routeChecks.walletSeed.strength = text;
      if (!/\d+\s+words?/i.test(text)) issues.push(`strength text has no word count: "${text}"`);
      if (!/entropy/i.test(text)) issues.push(`strength text has no entropy figure: "${text}"`);
    }
    if (!info) {
      issues.push("#wallet-seed-info is missing");
    } else {
      const label = (info.getAttribute("aria-label") || "").trim();
      const tooltip = (info.getAttribute("data-tooltip") || "").trim();
      metrics.routeChecks.walletSeed.info = { classes: info.className, label, tooltip };
      if (!info.classList.contains("icon-button")) {
        issues.push("#wallet-seed-info is not the shared .icon-button");
      }
      if (!label) issues.push("#wallet-seed-info has no aria-label");
      if (!tooltip) issues.push("#wallet-seed-info has no data-tooltip");
    }
    for (const [name, button] of [["generate", generate], ["add", addButton]]) {
      if (!button) {
        issues.push(`#wallet-seed-${name} is missing`);
        continue;
      }
      const box = boxOf(button);
      metrics.routeChecks.walletSeed[name] = {
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
      if (box.width < 43.5 || box.height < 43.5) {
        issues.push(
          `#wallet-seed-${name} is ${Math.round(box.width)}x${Math.round(box.height)}px (expected >=44x44)`,
        );
      }
    }
    if (issues.length) {
      add("wallet-seed-strength", `wallet seed controls are incomplete: ${issues.join("; ")}`, issues);
    }
  }

  if (route.startsWith("/brainwallet/") && route !== "/brainwallet/") {
    const rows = document.querySelectorAll(".bw-row").length;
    metrics.routeChecks.brainwalletRows = rows;
    if (rows !== 60) {
      add("brainwallet-row-count", `/brainwallet page has ${rows} rows (expected 60)`, { rows });
    }
  }

  if (route === "/bitcoin-puzzle") {
    const rows = document.querySelectorAll("[data-puzzle-row]").length;
    metrics.routeChecks.puzzleRows = rows;
    if (rows !== 160) {
      add("puzzle-row-count", `/bitcoin-puzzle has ${rows} data-puzzle rows (expected 160)`, { rows });
    }
  }

  // 7. Navigation shell: one link grammar at 44px with 18px icons, and one
  //    utility cluster built from the shared icon-button and chip components.
  const navIssues = [];
  const navEvidence = { links: 0, tools: 0 };
  for (const link of document.querySelectorAll(".site-nav nav a[data-nav], .nav-drawer a")) {
    if (!visible(link)) continue;
    navEvidence.links += 1;
    const box = boxOf(link);
    const icon = link.querySelector(".icon");
    const issues = [];
    if (box.width < 43.5 || box.height < 43.5) {
      issues.push(`box ${Math.round(box.width)}x${Math.round(box.height)}px`);
    }
    if (icon) {
      const iconBox = boxOf(icon);
      if (Math.round(iconBox.width) !== 18 || Math.round(iconBox.height) !== 18) {
        issues.push(`icon ${Math.round(iconBox.width)}x${Math.round(iconBox.height)}px`);
      }
    }
    if (issues.length) navIssues.push({ selector: selectorOf(link), issues });
  }
  for (const control of document.querySelectorAll(".nav-tools .icon-button, .nav-tools .chip")) {
    if (!visible(control)) continue;
    navEvidence.tools += 1;
    const box = boxOf(control);
    if (box.width < 43.5 || box.height < 43.5) {
      navIssues.push({
        selector: selectorOf(control),
        issues: [`box ${Math.round(box.width)}x${Math.round(box.height)}px`],
      });
    }
  }
  metrics.nav = navEvidence;
  metrics.navLinks = navIssues;
  if (navIssues.length) {
    add("nav-link-height", `${navIssues.length} nav link(s) outside the 44px/18px grammar`, navIssues.slice(0, 8));
  }

  // 7b. The Seeds nav item is a destination, not a label: it must resolve to
  //     the browsable directory, never the /seed converter studio.
  const seedsNav = document.querySelector('.site-nav nav a[data-nav="seeds"]');
  if (seedsNav) {
    const rawHref = seedsNav.getAttribute("href") || "";
    let destination = rawHref;
    try {
      destination = new URL(rawHref, location.href).pathname;
    } catch {}
    if (destination !== "/mnemonic-seeds") {
      add("nav-destination", `Seeds nav points at ${destination || "(no href)"} instead of /mnemonic-seeds`, {
        href: rawHref,
      });
    }
    const onSeeds =
      location.pathname === "/mnemonic-seeds" || location.pathname.startsWith("/mnemonic-seeds/");
    if (onSeeds && seedsNav.getAttribute("aria-current") !== "page") {
      add("nav-destination", `Seeds nav is not marked active on ${location.pathname}`, {
        href: rawHref,
      });
    }
  }

  // 8. Breadcrumbs: one grammar (current marker + separators) and one trail
  //    on every public content page. The app and cabinet shells and the
  //    landing page intentionally have none.
  const shellRoutes = new Set(["/app", "/me", "/run", "/cabinet", "/cabinet/wallet"]);
  const shellPage = shellRoutes.has(route);
  const needsBreadcrumbs = route !== "/" && !shellPage;
  const crumbNavs = [...document.querySelectorAll("nav.breadcrumbs")].filter(visible);
  const crumbIssues = [];
  const currentIssues = [];
  for (const nav of crumbNavs) {
    const label = nav.getAttribute("aria-label") || "";
    const issues = [];
    if (label !== "Breadcrumb") issues.push(`aria-label "${label}"`);
    const current = [...nav.querySelectorAll('[aria-current="page"]')].filter(visible);
    if (current.length !== 1) {
      currentIssues.push({ selector: selectorOf(nav), issues: [`${current.length} current marker(s)`] });
    } else if (/^\/[a-z0-9]/i.test(textOf(current[0]))) {
      currentIssues.push({ selector: selectorOf(current[0]), issues: [`raw path label "${textOf(current[0]).slice(0, 40)}"`] });
    }
    for (const link of [...nav.querySelectorAll("a")].filter(visible)) {
      const box = boxOf(link);
      if (box.width < 43.5 || box.height < 43.5) {
        issues.push(`${selectorOf(link)} box ${Math.round(box.width)}x${Math.round(box.height)}px`);
      }
      if (/^\/[a-z0-9]/i.test(textOf(link))) {
        issues.push(`${selectorOf(link)} shows a raw path`);
      }
    }
    let separators = 0;
    for (const child of [...nav.children]) {
      if (child.tagName === "A" || child.hasAttribute("aria-current")) continue;
      if (!child.classList.contains("breadcrumbs__sep")) {
        issues.push(`${selectorOf(child)} is not a .breadcrumbs__sep`);
        continue;
      }
      separators += 1;
      if (textOf(child) !== "/") issues.push(`separator text "${textOf(child)}"`);
      if (child.getAttribute("aria-hidden") !== "true") issues.push("separator is not aria-hidden");
    }
    const linkCount = nav.querySelectorAll("a").length;
    if (linkCount > 0 && separators !== linkCount) {
      issues.push(`${separators} separator(s) for ${linkCount} link(s)`);
    }
    if (issues.length) crumbIssues.push({ selector: selectorOf(nav), issues });
  }
  if (needsBreadcrumbs && crumbNavs.length !== 1) {
    crumbIssues.push({ route, issues: [`${crumbNavs.length} breadcrumb nav(s), expected 1`] });
  }
  metrics.breadcrumbs = { navs: crumbNavs.length, required: needsBreadcrumbs };
  metrics.breadcrumbGrammar = crumbIssues;
  metrics.breadcrumbCurrent = currentIssues;
  if (crumbIssues.length) {
    add("breadcrumb-grammar", `${crumbIssues.length} breadcrumb trail(s) outside the shared grammar`, crumbIssues.slice(0, 8));
  }
  if (currentIssues.length) {
    add("breadcrumb-current", `${currentIssues.length} breadcrumb(s) without one human current marker`, currentIssues.slice(0, 8));
  }

  // 9. Pagination: one pager built from `.pager` + `.pager-btn`, 44px boxes,
  //    radius 10 and `aria-disabled` for unavailable directions.
  const pagerIssues = [];
  const pagerGeometry = [];
  const pagerBlocks = [...document.querySelectorAll(".pager")].filter(visible);
  metrics.pagers = {
    blocks: pagerBlocks.length,
    buttons: pagerBlocks.reduce((sum, pager) => sum + pager.querySelectorAll(".pager-btn").length, 0),
    jumps: [...document.querySelectorAll(".page-jump")].filter(visible).length,
  };
  for (const pager of pagerBlocks) {
    const issues = [];
    if (!pager.getAttribute("aria-label")) issues.push("no aria-label");
    for (const child of [...pager.children]) {
      if (!child.classList.contains("pager-btn")) issues.push(`${selectorOf(child)} is not .pager-btn`);
    }
    const buttons = [...pager.querySelectorAll(".pager-btn")].filter(visible);
    if (buttons.length < 4) issues.push(`${buttons.length} pager button(s)`);
    for (const button of buttons) {
      const geometry = [];
      const box = boxOf(button);
      const radius = Number.parseFloat(getComputedStyle(button).borderTopLeftRadius);
      if (box.width < 43.5 || box.height < 43.5) {
        geometry.push(`box ${Math.round(box.width)}x${Math.round(box.height)}px`);
      }
      if (Math.abs(radius - 10) > 0.5) geometry.push(`radius ${radius}px`);
      if (!button.hasAttribute("aria-disabled")) issues.push(`${selectorOf(button)} has no aria-disabled`);
      if (button.classList.contains("random")) issues.push(`${selectorOf(button)} uses the legacy .random modifier`);
      const icon = button.querySelector(".icon");
      if (icon) {
        const iconBox = boxOf(icon);
        if (Math.round(iconBox.width) !== 16 || Math.round(iconBox.height) !== 16) {
          geometry.push(`icon ${Math.round(iconBox.width)}x${Math.round(iconBox.height)}px`);
        }
      }
      if (geometry.length) pagerGeometry.push({ selector: selectorOf(button), issues: geometry });
    }
    if (issues.length) pagerIssues.push({ selector: selectorOf(pager), issues });
  }
  for (const jump of [...document.querySelectorAll(".page-jump")].filter(visible)) {
    const issues = [];
    if (!jump.querySelector("label")) issues.push("no label");
    for (const control of jump.querySelectorAll("input, button")) {
      if (!visible(control)) continue;
      const box = boxOf(control);
      if (box.height < 43.5) issues.push(`${selectorOf(control)} height ${Math.round(box.height)}px`);
    }
    if (issues.length) pagerIssues.push({ selector: selectorOf(jump), issues });
  }
  metrics.pagerGrammar = pagerIssues;
  metrics.pagerGeometry = pagerGeometry;
  if (pagerIssues.length) {
    add("pager-grammar", `${pagerIssues.length} pager block(s) outside the shared structure`, pagerIssues.slice(0, 8));
  }
  if (pagerGeometry.length) {
    add("pager-geometry", `${pagerGeometry.length} pager button(s) outside the 44px/radius-10 geometry`, pagerGeometry.slice(0, 8));
  }

  // 10. Footer: exactly one marketing footer on public content pages, none on
  //     the app/cabinet shells, with the required links and build version.
  const footerNodes = [...document.querySelectorAll("footer, .site-footer")].filter(visible);
  const footerIssues = [];
  metrics.footer = { count: footerNodes.length, shell: shellPage };
  if (shellPage) {
    if (footerNodes.length) footerIssues.push(`${footerNodes.length} footer(s) on an app shell`);
  } else if (footerNodes.length !== 1) {
    footerIssues.push(`${footerNodes.length} footer(s), expected 1`);
  }
  if (footerNodes.length === 1) {
    const footer = footerNodes[0];
    const hrefs = [...footer.querySelectorAll("a[href]")].map((link) => link.getAttribute("href") || "");
    for (const required of ["/faq", "/disclaimer", "/donate", "/docs"]) {
      if (!hrefs.includes(required)) footerIssues.push(`missing ${required} link`);
    }
    if (!hrefs.some((href) => href.startsWith("https://github.com/"))) footerIssues.push("missing GitHub link");
    const text = textOf(footer);
    if (!text.includes("©")) footerIssues.push("missing copyright");
    if (!/\bbuild (?:[0-9a-f]{7,12}|dev)\b/.test(text)) footerIssues.push("missing build id");
    for (const link of [...footer.querySelectorAll("a")].filter(visible)) {
      const box = boxOf(link);
      if (box.width < 43.5 || box.height < 43.5) {
        footerIssues.push(`${selectorOf(link)} box ${Math.round(box.width)}x${Math.round(box.height)}px`);
      }
    }
  }
  metrics.footerIssues = footerIssues;
  if (footerIssues.length) {
    add("footer-presence", `${footerIssues.length} footer problem(s)`, footerIssues.slice(0, 8));
  }

  // 11. Asset fingerprint: every first-party asset reference in the served
  //     HTML carries the /a/<build>/ prefix. A bare link is what lets an edge
  //     Browser Cache TTL keep a returning browser on stale CSS or JS.
  const assetLinks = [];
  for (const el of document.querySelectorAll("script[src], link[href]")) {
    const ref = el.getAttribute("src") || el.getAttribute("href") || "";
    if (!ref.startsWith("/")) continue;
    const path = ref.split(/[?#]/)[0];
    if (!/\.(?:css|js|wasm|svg|woff2|png|ico)$/.test(path)) continue;
    assetLinks.push({ ref, selector: selectorOf(el) });
  }
  const bareAssets = assetLinks.filter(({ ref }) => !ref.startsWith("/a/"));
  metrics.assetFingerprint = { assets: assetLinks.length, bare: bareAssets.length };
  if (bareAssets.length) {
    add(
      "asset-fingerprint",
      `${bareAssets.length} asset reference(s) lack the build prefix`,
      bareAssets.slice(0, 8).map(({ ref, selector }) => `${selector} -> ${ref}`),
    );
  }

  return { violations, metrics };
}

/* /cabinet/wallet ships its seed controls inside the unlocked vault panel.
 * Create or unlock the audit vault, then prove the strength line follows the
 * phrase: 12 words -> 128 bits, a bad checksum disables Add, 24 words -> 256.
 * Leaves a valid 24-word phrase so the resting auditPage check sees a filled
 * strength line. */
async function auditWalletSeed(cdp) {
  const passphrase = "ui-audit-passphrase";
  const unlocked = await evaluate(
    cdp,
    `(async () => {
      const shown = (el) => Boolean(el) && !el.hidden && el.getClientRects().length > 0;
      const setup = document.getElementById('wallet-setup');
      const unlock = document.getElementById('wallet-unlock');
      const panel = document.getElementById('wallet-panel');
      if (shown(setup)) {
        document.getElementById('wallet-create-pass').value = ${JSON.stringify(passphrase)};
        document.getElementById('wallet-create-pass2').value = ${JSON.stringify(passphrase)};
        document.getElementById('wallet-create-form').requestSubmit();
      } else if (shown(unlock)) {
        document.getElementById('wallet-unlock-pass').value = ${JSON.stringify(passphrase)};
        document.getElementById('wallet-unlock-form').requestSubmit();
      }
      const started = Date.now();
      while (Date.now() - started < 12000) {
        if (panel && !panel.hidden) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    })()`,
    20000,
  );
  if (!unlocked) return { ok: false, reason: "the audit vault did not unlock", problems: ["vault did not unlock"] };

  const result = await evaluate(
    cdp,
    `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (test, timeout) => {
        const started = Date.now();
        while (Date.now() - started < timeout) {
          if (test()) return true;
          await sleep(100);
        }
        return false;
      };
      const strength = document.getElementById('wallet-seed-strength');
      const info = document.getElementById('wallet-seed-info');
      const generate = document.getElementById('wallet-seed-generate');
      const add = document.getElementById('wallet-seed-add');
      const phrase = document.getElementById('wallet-seed-phrase');
      if (!strength || !info || !generate || !add || !phrase) {
        return { evidence: {}, problems: ['seed controls are missing'] };
      }
      const problems = [];
      const boxOf = (el) => {
        const box = el.getBoundingClientRect();
        return Math.round(box.width) + 'x' + Math.round(box.height);
      };
      const evidence = {
        initial: strength.textContent.trim(),
        boxes: { generate: boxOf(generate), add: boxOf(add), info: boxOf(info) },
      };
      if (!/12 words/.test(evidence.initial) || !/entropy/i.test(evidence.initial)) {
        problems.push('initial strength line: ' + evidence.initial);
      }

      // A 12-word phrase with a broken checksum must name the problem and
      // disable Add.
      phrase.value = 'abandon '.repeat(12).trim();
      phrase.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFor(() => /checksum does not match/i.test(strength.textContent), 5000);
      evidence.invalid = strength.textContent.trim();
      evidence.invalidAddDisabled = add.disabled;
      if (!/checksum does not match/i.test(evidence.invalid) || !add.disabled) {
        problems.push('invalid checksum did not disable Add: ' + evidence.invalid);
      }

      phrase.value = '';
      phrase.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-seed-words="12"]').click();
      generate.click();
      await waitFor(() => /12 words/.test(strength.textContent) && /BIP39 checksum ok/.test(strength.textContent), 8000);
      evidence.words12 = strength.textContent.trim();
      if (!/12 words/.test(evidence.words12) || !/128-bit/.test(evidence.words12)) {
        problems.push('12-word strength line: ' + evidence.words12);
      }

      document.querySelector('[data-seed-words="24"]').click();
      generate.click();
      await waitFor(() => /24 words/.test(strength.textContent) && /256-bit/.test(strength.textContent), 8000);
      evidence.words24 = strength.textContent.trim();
      if (!/24 words/.test(evidence.words24) || !/256-bit/.test(evidence.words24)) {
        problems.push('24-word strength line: ' + evidence.words24);
      }
      evidence.tooltip = info.getAttribute('data-tooltip');
      return { evidence, problems };
    })()`,
    40000,
  );
  return { ok: result.problems.length === 0, ...result };
}

async function auditKeyAutoDerive(cdp) {
  return evaluate(
    cdp,
    `(async () => {
      const input = document.getElementById('priv');
      if (!input) return { ok: false, reason: 'missing #priv' };
      // Keep the audit offline: balance lookups hit public providers and add
      // CORS noise that is unrelated to layout/parity.
      const toggle = document.getElementById('online-toggle');
      if (toggle && toggle.checked) {
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '${"0".repeat(63)}1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const started = Date.now();
      while (Date.now() - started < 6000) {
        const card = document.getElementById('summary-card');
        const rows = document.querySelectorAll('#addr-rows .key-row');
        if (card && !card.hidden && rows.length > 0) {
          return { ok: true, rows: rows.length, ms: Date.now() - started };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const card = document.getElementById('summary-card');
      return {
        ok: false,
        reason: 'no derived rows within 6s',
        summaryHidden: card ? card.hidden : null,
        rows: document.querySelectorAll('#addr-rows .key-row').length,
        status: (document.getElementById('key-status-text') || {}).textContent || '',
      };
    })()`,
    10000,
  );
}

async function auditKeyTooltips(cdp) {
  return evaluate(
    cdp,
    `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const info = document.getElementById('key-info-btn');
      const random = document.getElementById('random-btn');
      const popover = document.getElementById('key-info-popover');
      const meta = document.querySelector('.key-input-meta');
      const violations = [];
      const evidence = {};
      if (!info) return { ok: false, violations: [{ id: 'tooltip-behaviour', message: 'missing #key-info-btn' }], evidence };

      const tip = () => document.getElementById('ui-tooltip');
      const visibleTip = () => {
        const el = tip();
        if (!el || el.hidden) return null;
        const style = getComputedStyle(el);
        return style.display === 'none' || style.visibility === 'hidden' ? null : el;
      };
      const fire = (el, type, relatedTarget) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        relatedTarget: relatedTarget || null
      }));
      const box = (el) => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const fail = (message) => violations.push({ id: 'tooltip-behaviour', message });

      const scrollBefore = window.scrollY;
      const metaBefore = meta ? box(meta) : null;

      // Hover: ~150ms delay, but it must be visible within 300ms.
      const hoverStarted = performance.now();
      fire(info, 'pointerover');
      let el = null;
      while (performance.now() - hoverStarted < 300) {
        el = visibleTip();
        if (el) break;
        await sleep(20);
      }
      const hoverLatency = Math.round(performance.now() - hoverStarted);
      evidence.hover = { shown: Boolean(el), text: el ? el.textContent : '', latencyMs: hoverLatency };
      if (!el) {
        fail('tooltip did not appear within 300ms of hovering #key-info-btn');
      } else {
        const tipBox = box(el);
        const targetBox = box(info);
        const described = (info.getAttribute('aria-describedby') || '').split(/\\s+/);
        const inside = tipBox.left >= -0.5 && tipBox.right <= window.innerWidth + 0.5 &&
          tipBox.top >= -0.5 && tipBox.bottom <= window.innerHeight + 0.5;
        const clearOfTarget = tipBox.bottom <= targetBox.top + 1 || tipBox.top >= targetBox.bottom - 1;
        evidence.hover = {
          shown: true,
          text: el.textContent,
          latencyMs: hoverLatency,
          role: el.getAttribute('role'),
          describedBy: described.includes('ui-tooltip'),
          insideViewport: inside,
          clearOfTarget,
          box: tipBox
        };
        if (el.getAttribute('role') !== 'tooltip') fail('tooltip node has no role="tooltip"');
        if (!described.includes('ui-tooltip')) fail('#key-info-btn is not aria-describedby the tooltip');
        if (el.textContent !== (info.getAttribute('data-tooltip') || '')) fail('tooltip text does not match data-tooltip');
        if (!inside) fail('tooltip is clipped by the viewport');
        if (!clearOfTarget) fail('tooltip overlaps its trigger');
      }
      fire(info, 'pointerout', document.body);
      await sleep(80);
      if (visibleTip()) fail('tooltip stayed visible after the pointer left');
      if ((info.getAttribute('aria-describedby') || '').includes('ui-tooltip')) {
        fail('aria-describedby still names the tooltip after hiding');
      }

      // Keyboard focus: shown at once, Escape hides it.
      if (random && !random.disabled) {
        random.focus();
        await sleep(80);
        el = visibleTip();
        evidence.focus = { shown: Boolean(el), text: el ? el.textContent : '', active: document.activeElement === random };
        if (!el) fail('tooltip did not appear on keyboard focus');
        else if (el.textContent !== (random.getAttribute('data-tooltip') || '')) fail('focus tooltip text does not match data-tooltip');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(40);
        if (visibleTip()) fail('Escape did not hide the tooltip');
        random.blur();
      }

      // Popover: opens without a scroll shift or a row height change, and it
      // replaces the tooltip while open.
      if (popover) {
        info.focus();
        await sleep(60);
        info.click();
        await sleep(80);
        const metaAfter = meta ? box(meta) : null;
        evidence.popover = {
          open: !popover.hidden,
          expanded: info.getAttribute('aria-expanded'),
          tooltipHidden: !visibleTip(),
          scrollShift: window.scrollY - scrollBefore,
          heightBefore: metaBefore ? metaBefore.height : null,
          heightAfter: metaAfter ? metaAfter.height : null
        };
        if (popover.hidden) fail('info popover did not open on click');
        if (info.getAttribute('aria-expanded') !== 'true') fail('aria-expanded is not true while the popover is open');
        if (visibleTip()) fail('tooltip stayed over the open popover');
        if (Math.abs(evidence.popover.scrollShift) > 1) fail('page scrolled when the popover opened');
        if (metaBefore && metaAfter && Math.abs(metaAfter.height - metaBefore.height) > 1) {
          fail('meta row changed height when the popover opened');
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(80);
        evidence.popover.closed = popover.hidden;
        evidence.popover.focusReturned = document.activeElement === info;
        if (!popover.hidden) fail('Escape did not close the info popover');
        if (document.activeElement !== info) fail('focus did not return to the info control');
        info.blur();
      }

      return { ok: violations.length === 0, violations, evidence };
    })()`,
    20000,
  );
}

// DESIGN-SYSTEM §3.2: a quiet icon button is transparent with no border. The
// generic `button:not(.primary):hover` rule out-ranks the variant, so hover used
// to paint a 1px border. Synthetic PointerEvents never set CSS :hover, so force
// the pseudo-state through CDP and read the real computed style. Transitions are
// suppressed for the measurement so the hover value is read immediately instead
// of racing the --duration-fast animation.
async function auditQuietIconHover(cdp) {
  const buttons = await evaluate(
    cdp,
    `(() => Array.from(document.querySelectorAll('button.icon-button--quiet')).map((el, index) => {
      const rect = el.getBoundingClientRect();
      const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
      const visible = !disabled && el.checkVisibility({ visibilityProperty: true }) && rect.width > 0 && rect.height > 0;
      const label = el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || (el.textContent || '').trim().slice(0, 40);
      return { index, disabled, visible, label };
    }))()`,
    10000,
  );
  const evidence = { checked: 0, buttons };
  const violations = [];
  const targets = buttons.filter((button) => button.visible);
  if (!targets.length) return { ok: true, violations, evidence };

  const { root } = await cdp.send("DOM.getDocument", { depth: 0, pierce: false });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector: "button.icon-button--quiet",
  });
  const forced = [];
  await evaluate(
    cdp,
    `(() => {
      const style = document.createElement('style');
      style.setAttribute('data-quiet-hover-audit', '');
      style.textContent = '*, *::before, *::after { transition: none !important; }';
      document.head.appendChild(style);
    })()`,
    10000,
  );
  try {
    for (const target of targets) {
      const nodeId = nodeIds[target.index];
      if (nodeId === undefined) continue;
      await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
      forced.push({ target, nodeId });
    }
    const measured = await evaluate(
      cdp,
      `(() => {
        const alpha = (value) => {
          const match = /rgba?\\(([^)]+)\\)/.exec(value || '');
          if (!match) return 0;
          const parts = match[1].split(',').map((part) => parseFloat(part));
          return parts.length >= 4 ? parts[3] : 1;
        };
        const all = document.querySelectorAll('button.icon-button--quiet');
        return ${JSON.stringify(forced.map((entry) => entry.target.index))}.map((index) => {
          const el = all[index];
          if (!el) return { index, missing: true };
          const style = getComputedStyle(el);
          const sides = ['Top', 'Right', 'Bottom', 'Left'].map((side) => {
            const width = parseFloat(style['border' + side + 'Width']) || 0;
            const color = style['border' + side + 'Color'];
            return { side: side.toLowerCase(), width: Number(width.toFixed(2)), color, alpha: alpha(color) };
          });
          const visibleBorder = sides.filter((side) => side.width > 0.05 && side.alpha > 0.05);
          return { index, sides, visibleBorder };
        });
      })()`,
      10000,
    );
    for (const entry of measured) {
      const target = forced.find((item) => item.target.index === entry.index);
      const label = target ? target.target.label : `#${entry.index}`;
      evidence.checked += 1;
      evidence.buttons[entry.index] = { ...evidence.buttons[entry.index], hover: entry.sides, visibleBorder: entry.visibleBorder };
      const sides = entry.visibleBorder.map((side) => `${side.side} ${side.width}px ${side.color}`);
      if (sides.length) {
        violations.push({
          id: "quiet-icon-hover-border",
          message: `quiet icon button ${label ? `"${label}"` : `#${entry.index}`} gains a hover border (${sides.join(", ")}); DESIGN-SYSTEM §3.2 requires transparent with no border`,
          detail: { button: label, sides: entry.visibleBorder },
        });
      }
    }
  } finally {
    for (const entry of forced) {
      await cdp.send("CSS.forcePseudoState", { nodeId: entry.nodeId, forcedPseudoClasses: [] }).catch(() => {});
    }
    await evaluate(
      cdp,
      `(() => { const style = document.querySelector('style[data-quiet-hover-audit]'); if (style) style.remove(); })()`,
      10000,
    ).catch(() => {});
  }
  return { ok: violations.length === 0, violations, evidence };
}

function viewportFor(width) {
  const height = VIEWPORT_HEIGHTS[width] || 900;
  return { width, height };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const uncovered = missingPublicRoutes(DEFAULT_ROUTES);
  if (uncovered.length) {
    throw new Error(
      `[route-coverage] public page route(s) missing from DEFAULT_ROUTES: ${uncovered.join(", ")}`,
    );
  }
  if (options.help) {
    log(HELP);
    return 0;
  }

  let server = null;
  let browser = null;
  let cdp = null;
  let chromeProfile = null;
  const tempRoot = await mkdtemp(path.join(tmpdir(), "rotor-ui-audit-"));
  const screenshotsDir = path.join(tempRoot, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });

  const cleanup = () => {
    if (cdp) cdp.close();
    if (browser) killTree(browser);
    if (server) killTree(server);
  };

  try {
    if (options.serve) {
      const baseUrl = new URL(options.base);
      if (baseUrl.port !== "7899") {
        throw new Error(
          `--serve binds 127.0.0.1:7899; use --base http://127.0.0.1:7899 or drop --serve (got ${options.base})`,
        );
      }
      const alreadyUp = await fetch(`${options.base}/`, {
        signal: AbortSignal.timeout(1000),
      }).then((response) => response.status < 500).catch(() => false);
      if (alreadyUp) {
        throw new Error(
          `--serve cannot start: something is already listening on ${options.base}; stop it or run without --serve`,
        );
      }
      const exe = path.join(
        REPO_ROOT,
        "target",
        "release",
        process.platform === "win32" ? "rotor-coord.exe" : "rotor-coord",
      );
      if (!existsSync(exe)) {
        throw new Error(`--serve needs ${exe}; run: cargo build --release --bin rotor-coord`);
      }
      // A stale binary serves old embedded assets and reports violations that
      // are already fixed (and passes ones that are not). Fail loud instead.
      const newestSource = (dir) => readdirSync(dir, { recursive: true })
        .reduce((newest, entry) => {
          const full = path.join(dir, typeof entry === "string" ? entry : entry.name);
          try {
            return Math.max(newest, statSync(full).mtimeMs);
          } catch {
            return newest;
          }
        }, 0);
      const newestEmbedded = Math.max(
        newestSource(path.join(REPO_ROOT, "apps", "site")),
        newestSource(path.join(REPO_ROOT, "src", "coordinator")),
      );
      if (newestEmbedded > statSync(exe).mtimeMs) {
        throw new Error(
          `--serve uses a stale ${exe}: site/coordinator sources changed after the build; run: cargo build --release --bin rotor-coord`,
        );
      }
      const stateDir = path.join(tempRoot, "state");
      await mkdir(stateDir, { recursive: true });
      server = spawn(
        exe,
        [
          "--bind",
          "127.0.0.1:7899",
          "--token",
          "ui-audit-token",
          "--state",
          path.join(stateDir, "coordinator.json"),
          "--monitor-state",
          path.join(stateDir, "monitor.json"),
          "--monitor-interval",
          // The audit does not need the monitor; a short interval makes it poll
          // the unreachable test RPC mid-run and exit before the last routes.
          "3600",
          "--monitor-rpc",
          "http://127.0.0.1:1",
          "--monitor-btc-rpc",
          "http://127.0.0.1:1",
        ],
        { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
      let serverLog = "";
      server.stdout.on("data", (chunk) => {
        serverLog += chunk.toString();
      });
      server.stderr.on("data", (chunk) => {
        serverLog += chunk.toString();
      });
      server.on("exit", (code) => {
        if (code !== null && code !== 0) serverLog += `\ncoordinator exited with ${code}`;
      });
      await waitForHttp(`${options.base}/`, 25000).catch((error) => {
        throw new Error(`${error.message}\ncoordinator log:\n${serverLog.trim()}`);
      });
    } else {
      await waitForHttp(`${options.base}/`, 10000).catch((error) => {
        throw new Error(`${error.message}\nstart the coordinator or pass --serve`);
      });
    }

    const browserPath = findBrowser();
    if (!browserPath) {
      throw new Error(
        "no Chrome/Edge found; set CHROME_PATH or install Chrome/Chromium/Microsoft Edge",
      );
    }

    chromeProfile = await mkdtemp(path.join(tmpdir(), "rotor-ui-audit-chrome-"));
    const launched = await launchBrowser(browserPath, chromeProfile);
    browser = launched.child;
    cdp = await createCdp(launched.wsUrl);

    await cdp.send("Page.enable");
    // Headless pages may not own system focus, so element.focus() would not
    // dispatch focusin. Emulate focus so keyboard tooltip/focus checks are real.
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable").catch(() => {});
    await cdp.send("Network.enable").catch(() => {});
    // Forced pseudo-states for the quiet-icon hover check need the DOM/CSS
    // agents; enabling them once keeps the per-run measurement short.
    await cdp.send("DOM.enable").catch(() => {});
    await cdp.send("CSS.enable").catch(() => {});

    let consoleErrors = [];
    let networkErrors = [];
    const baseOrigin = new URL(options.base).origin;
    const requestUrls = new Map();
    cdp.on("Network.requestWillBeSent", (params) => {
      if (params?.request?.url) requestUrls.set(params.requestId, params.request.url);
    });
    cdp.on("Network.responseReceived", (params) => {
      const response = params?.response;
      if (!response?.url) return;
      let origin = null;
      try {
        origin = new URL(response.url).origin;
      } catch {
        return;
      }
      if (origin !== baseOrigin) return;
      const pathname = (() => {
        try {
          return new URL(response.url).pathname;
        } catch {
          return "";
        }
      })();
      const keylessProvider = response.status === 501 && pathname.startsWith("/api/v1/chain/");
      if (response.status >= 400 && !keylessProvider) {
        networkErrors.push(`${response.status} ${response.url.slice(0, 160)}`);
      }
    });
    cdp.on("Network.loadingFailed", (params) => {
      const url = requestUrls.get(params.requestId);
      if (!url) return;
      let origin = null;
      try {
        origin = new URL(url).origin;
      } catch {
        return;
      }
      if (origin !== baseOrigin) return;
      networkErrors.push(`failed ${params.errorText || "unknown"} ${url.slice(0, 160)}`);
    });
    cdp.on("Runtime.exceptionThrown", (params) => {
      const text =
        params.exceptionDetails?.exception?.description ||
        params.exceptionDetails?.text ||
        "uncaught exception";
      consoleErrors.push(text.split("\n")[0].slice(0, 200));
    });
    cdp.on("Runtime.consoleAPICalled", (params) => {
      if (params.type !== "error" && params.type !== "assert") return;
      const text = (params.args || [])
        .map((arg) => arg.value ?? arg.description ?? "")
        .join(" ")
        .slice(0, 200);
      consoleErrors.push(text);
    });
    cdp.on("Log.entryAdded", (params) => {
      if (params.entry?.level !== "error") return;
      const url = params.entry.url ? ` (${params.entry.url})` : "";
      consoleErrors.push(`${params.entry.text || ""}${url}`.slice(0, 200));
    });

    // /site-map is expected to disappear after the docs move; probe it once.
    const siteMapResponse = await fetch(`${options.base}/site-map`, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    const siteMapStatus = siteMapResponse ? siteMapResponse.status : null;
    const globalViolations = [];
    globalViolations.push(...legacyTokenViolations());
    globalViolations.push(...emptyStateViolations());
    if (siteMapStatus !== 404) {
      globalViolations.push({
        id: "site-map-still-served",
        message: `GET /site-map returned ${siteMapStatus ?? "no response"}; expected 404 after the docs move`,
        detail: { status: siteMapStatus },
      });
    }

    const routes = options.routes;
    const viewports = options.viewports.map(viewportFor);
    const runs = [];

    for (const route of routes) {
      const url = `${options.base}${route}`;
      for (const viewport of viewports) {
        for (const theme of options.themes) {
          const started = Date.now();
          consoleErrors = [];
          networkErrors = [];
          const run = {
            route,
            viewport,
            theme,
            url,
            violations: [],
            warnings: [],
            metrics: {},
            screenshot: null,
            durationMs: 0,
            status: "ok",
          };

          try {
            await cdp.send("Emulation.setDeviceMetricsOverride", {
              width: viewport.width,
              height: viewport.height,
              deviceScaleFactor: 1,
              mobile: viewport.width < 600,
              screenWidth: viewport.width,
              screenHeight: viewport.height,
            });
            await cdp.send("Emulation.setEmulatedMedia", {
              media: "screen",
              features: [{ name: "prefers-color-scheme", value: theme }],
            });

            await gotoWithRetry(cdp, url);

            // Route-aware readiness: generated rows must exist before counting.
            if (route.startsWith("/brainwallet/")) {
              await waitForSelector(cdp, ".bw-row", SELECTOR_TIMEOUT_MS);
            } else if (route === "/bitcoin-puzzle") {
              await waitForSelector(cdp, "[data-puzzle-row]", SELECTOR_TIMEOUT_MS);
            } else if (route === "/key" || route.startsWith("/key/")) {
              await waitForSelector(cdp, "#priv", SELECTOR_TIMEOUT_MS);
              // A key in the URL derives on load; wait for the rendered table
              // rows (balances settle later and are not needed for layout).
              if (route !== "/key") {
                await waitForSelector(cdp, "#addr-rows .key-row", SELECTOR_TIMEOUT_MS);
              }
            }

            if (route === "/key") {
              const derive = await auditKeyAutoDerive(cdp);
              run.metrics.autoDerive = derive;
              if (!derive.ok) {
                run.violations.push({
                  id: "key-auto-derive",
                  message: `/key did not derive from the input: ${derive.reason}`,
                  detail: derive,
                });
              }
            }

            if (route === "/cabinet/wallet") {
              const seed = await auditWalletSeed(cdp);
              run.metrics.walletSeed = seed.evidence;
              if (!seed.ok) {
                run.violations.push({
                  id: "wallet-seed-strength",
                  message: `/cabinet/wallet seed flow failed: ${seed.reason || (seed.problems || []).join("; ")}`,
                  detail: seed,
                });
              }
            }

            // Audit after the interaction so /key results are inspected too.
            const result = await evaluate(
              cdp,
              `(${auditPage.toString()})(${JSON.stringify({ route, theme })})`,
            );
            run.violations.push(...result.violations);
            run.metrics = { ...result.metrics, ...run.metrics };

            const shot = await cdp.send("Page.captureScreenshot", {
              format: "png",
              fromSurface: true,
            });
            const shotName = `${slugify(route)}-${viewport.width}-${theme}.png`;
            const shotPath = path.join(screenshotsDir, shotName);
            await writeFile(shotPath, Buffer.from(shot.data, "base64"));
            run.screenshot = shotPath;

            // Interaction checks run after the closed-state screenshot so the
            // image above still shows the resting page.
            if (route === "/key") {
              const tooltips = await auditKeyTooltips(cdp);
              run.metrics.tooltipBehaviour = tooltips.evidence;
              if (!tooltips.ok) run.violations.push(...tooltips.violations);
            }
            const quietHover = await auditQuietIconHover(cdp);
            run.metrics.quietIconHover = quietHover.evidence;
            if (!quietHover.ok) run.violations.push(...quietHover.violations);
          } catch (error) {
            run.status = "error";
            run.violations.push({
              id: "navigation-or-evaluation-failed",
              message: error.message,
            });
          }

          run.durationMs = Date.now() - started;
          if (consoleErrors.length) {
            run.warnings.push({
              id: "console-error",
              message: `${consoleErrors.length} console error(s) during this run`,
              detail: [...new Set(consoleErrors)].slice(0, 5),
            });
          }
          if (networkErrors.length) {
            const unique = [...new Set(networkErrors)];
            run.violations.push({
              id: "http-error",
              message: `${unique.length} same-origin request(s) failed during this run`,
              detail: unique.slice(0, 6),
            });
          }
          runs.push(run);
          const mark = run.violations.length ? "FAIL" : "ok  ";
          log(
            `${mark} ${route} ${viewport.width}px ${theme} (${run.durationMs}ms, ${run.violations.length} violation(s))`,
          );
        }
      }
    }

    // Cross-route duplicate component families: the same address-type concept
    // implemented with two different markup families is a parity bug even when
    // each page looks fine alone.
    const familyRoutes = { keyTypes: [], addressTypePanel: [] };
    for (const run of runs) {
      const families = run.metrics.addressTypeFamilies;
      if (!families) continue;
      if (families.keyTypes && !familyRoutes.keyTypes.includes(run.route)) {
        familyRoutes.keyTypes.push(run.route);
      }
      if (families.addressTypePanel && !familyRoutes.addressTypePanel.includes(run.route)) {
        familyRoutes.addressTypePanel.push(run.route);
      }
    }
    if (familyRoutes.keyTypes.length && familyRoutes.addressTypePanel.length) {
      globalViolations.push({
        id: "duplicate-address-type-implementation",
        message:
          "address type is implemented with two different component families across audited routes",
        detail: familyRoutes,
      });
    }

    const violations = runs.reduce((sum, run) => sum + run.violations.length, 0) + globalViolations.length;
    const warnings = runs.reduce((sum, run) => sum + run.warnings.length, 0);

    const summary = {
      generatedAt: new Date().toISOString(),
      base: options.base,
      browser: browserPath,
      routes,
      viewports: viewports.map((viewport) => viewport.width),
      themes: options.themes,
      screenshotsDir,
      runs,
      globalViolations,
      totals: {
        pageRuns: runs.length,
        violations,
        warnings,
        failedRuns: runs.filter((run) => run.violations.length > 0 || run.status !== "ok").length,
      },
      ok: violations === 0,
    };

    if (options.json) {
      await mkdir(path.dirname(path.resolve(options.json)), { recursive: true });
      await writeFile(path.resolve(options.json), `${JSON.stringify(summary, null, 2)}\n`);
    }

    log("");
    if (violations === 0) {
      log(`ui-audit PASS: ${runs.length} page runs across ${routes.length} route(s), no violations.`);
    } else {
      log(`ui-audit FAIL: ${violations} violation(s) in ${summary.totals.failedRuns}/${runs.length} page runs.`);
    }
    const detailSuffix = (detail) => {
      if (detail === undefined || detail === null) return "";
      const text = typeof detail === "string" ? detail : JSON.stringify(detail);
      return text ? ` — ${text}` : "";
    };
    for (const violation of globalViolations) {
      log(`VIOLATION [${violation.id}] ${violation.message}${detailSuffix(violation.detail)}`);
    }
    for (const run of runs) {
      for (const violation of run.violations) {
        log(`VIOLATION [${violation.id}] ${run.route} ${run.viewport.width}px ${run.theme}: ${violation.message}${detailSuffix(violation.detail)}`);
      }
    }
    if (warnings) {
      log(`warnings: ${warnings} (console errors are recorded in the JSON report, not failed on)`);
    }
    log(`screenshots: ${screenshotsDir}`);
    if (options.json) log(`json: ${path.resolve(options.json)}`);

    return violations === 0 ? 0 : 1;
  } finally {
    cleanup();
    if (chromeProfile) {
      await rm(chromeProfile, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
    // DevTools/undici sockets can keep the loop alive on Windows; exit once
    // the report is written.
    setTimeout(() => process.exit(code), 50).unref();
  })
  .catch((error) => {
    console.error(`ui-audit: ${error.message}`);
    process.exit(2);
  });
