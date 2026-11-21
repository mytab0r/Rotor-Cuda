#!/usr/bin/env node
// Donor density parity measurement.
//
// Zero dependencies: drives the same headless Chrome/Edge over the DevTools
// protocol as scripts/ui-audit.mjs (Node's built-in WebSocket and fetch). It
// answers one question with numbers instead of impressions: how much content
// reaches the first viewport on a donor page, how much reaches ours, and which
// block eats the difference.
//
// What it measures per side, viewport and theme:
//   - chrome height: document top -> top of the first data row;
//   - data rows visible above the fold, total rows, row height;
//   - visible / above-the-fold interactive controls;
//   - vertical gap, padding and margin of the main blocks;
//   - font sizes of the page title, stat value and table header;
//   - total document height and horizontal overflow.
//
// Usage:
//   node scripts/density-parity.mjs \
//     --donor https://ref-site-a/private-keys/tron \
//     --ours  http://127.0.0.1:7913/private-keys/tron \
//     --json .claude/density-parity/tron.json
//
// Selectors are per side. The defaults fit ref-site-a's browse page
// and the Rotor coordinator's /private-keys/<chain> page; override when the
// markup changes:
//   --rows-donor "table tbody tr" --rows-ours ".key-row"
//   --blocks-donor "header=nav.navbar,chips=.chain-tabs"
//   --blocks-ours  "header=.site-nav,pageHeader=.page-info"
//
// A donor that cannot be loaded from this machine (network, anti-bot) is
// reported as unreachable with the raw reason; its numbers are never invented.
// One page load per viewport (plus at most one normal-user-agent retry on the
// donor when it blocks the headless browser).
//
// Exit codes: 0 = report produced (donor may be unreachable), 2 = harness error.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
];
const DEFAULT_THEMES = ["dark"];
const SETTLE_MS = 1200;
const NAV_TIMEOUT_MS = 45000;
const CDP_TIMEOUT_MS = 30000;
const NORMAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Default block selectors per side. The first rendered match wins. The
// coordinator build mirrors the donor's block order, so the same names line up
// across both sides and the delta table has one row per concept.
const DEFAULT_BLOCKS = {
  donor: [
    ["header", "nav.navbar, header.site-nav, header, nav"],
    ["globalSearch", "[class*='global-search']"],
    ["breadcrumb", "nav[aria-label='breadcrumb' i], .breadcrumbs, [class*='breadcrumb']"],
    ["chips", ".chain-tabs, [class*='chain-tabs'], [class*='chain-tab']"],
    ["pageHeader", ".page-info-container, [class*='page-info'], [class*='page-header'], h1"],
    ["pager", ".nav-bar, .nav-buttons, [class*='pagination'], [class*='pager'], nav[aria-label*='page' i]"],
    ["search", ".search-bar, [role='search'], form[class*='search'], .search-panel"],
    ["stats", ".balance-summary, [class*='balance-summary'], [class*='stats'], [class*='stat-card'], [class*='stat ']"],
  ],
  ours: [
    ["header", ".site-nav, header.site-nav, header, nav"],
    ["globalSearch", "[class*='global-search-trigger'], [class*='global-search']"],
    ["breadcrumb", ".breadcrumbs, nav[aria-label='Breadcrumb' i], [class*='breadcrumb']"],
    ["chips", ".chain-tabs, [class*='chain-tabs']"],
    ["pageHeader", ".page-info, [class*='page-header'], [class*='page-info'], h1"],
    ["pager", ".browse-controls, .pager, [class*='pagination'], nav[aria-label*='page' i]"],
    ["search", ".search-panel, form.browse-search, [role='search'], form[class*='search']"],
    ["stats", ".balance-summary, [class*='balance-summary'], [class*='stats'], [class*='stat-card']"],
  ],
};

const DEFAULT_ROWS = {
  donor: "table tbody tr, tbody tr, .key-row, [class*='key-row'], [data-key]",
  ours: ".key-row, [data-key], table tbody tr",
};

const HELP = `density-parity - measure donor vs Rotor page density

Options:
  --donor URL            donor page (required; may be unreachable)
  --ours URL             our page (required)
  --viewports WxH,...    default 1440x900,1280x800,375x812
  --themes dark,light    default dark; pass light,dark to compare both
                         (each extra theme is another page load per viewport)
  --rows-donor SELECTOR  data-row selector for the donor
  --rows-ours SELECTOR   data-row selector for ours
  --blocks-donor a=b,... block name=selector overrides for the donor
  --blocks-ours a=b,...  block name=selector overrides for ours
  --json PATH            write the machine-readable report
  --settle MS            post-load settle time (default ${SETTLE_MS})
  --nav-timeout MS       navigation timeout (default ${NAV_TIMEOUT_MS})
  --no-ua-retry          do not retry the donor once with a normal user agent
  -h, --help             show this help

Exit: 0 = report produced, 2 = harness error (no browser, bad arguments).`;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function parseBlocks(value, side) {
  const blocks = new Map(DEFAULT_BLOCKS[side]);
  if (!value) return blocks;
  for (const part of value.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) throw new Error(`--blocks-${side} expects name=selector pairs, got "${part}"`);
    blocks.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return blocks;
}

function parseViewport(text) {
  const match = /^(\d+)x(\d+)$/i.exec(text.trim());
  if (!match) throw new Error(`viewports must look like 1440x900, got "${text}"`);
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (width < 200 || height < 200) throw new Error(`viewport ${text} is too small`);
  return { width, height };
}

function parseArgs(argv) {
  const options = {
    donor: null,
    ours: null,
    viewports: DEFAULT_VIEWPORTS,
    themes: DEFAULT_THEMES,
    rows: { ...DEFAULT_ROWS },
    blocks: { donor: parseBlocks(null, "donor"), ours: parseBlocks(null, "ours") },
    json: null,
    settle: SETTLE_MS,
    navTimeout: NAV_TIMEOUT_MS,
    uaRetry: true,
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
      case "--donor":
        options.donor = value();
        break;
      case "--ours":
        options.ours = value();
        break;
      case "--viewports":
        options.viewports = value().split(",").map(parseViewport);
        break;
      case "--themes":
        options.themes = value()
          .split(",")
          .map((theme) => theme.trim())
          .filter((theme) => theme === "dark" || theme === "light");
        if (options.themes.length === 0) throw new Error("--themes must contain dark and/or light");
        break;
      case "--rows-donor":
        options.rows.donor = value();
        break;
      case "--rows-ours":
        options.rows.ours = value();
        break;
      case "--blocks-donor":
        options.blocks.donor = parseBlocks(value(), "donor");
        break;
      case "--blocks-ours":
        options.blocks.ours = parseBlocks(value(), "ours");
        break;
      case "--json":
        options.json = value();
        break;
      case "--settle":
        options.settle = Number.parseInt(value(), 10);
        break;
      case "--nav-timeout":
        options.navTimeout = Number.parseInt(value(), 10);
        break;
      case "--no-ua-retry":
        options.uaRetry = false;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.help) return options;
  if (!options.donor || !options.ours) throw new Error("--donor and --ours are required");
  if (!Number.isFinite(options.settle) || options.settle < 0) throw new Error("--settle must be a non-negative number");
  if (!Number.isFinite(options.navTimeout) || options.navTimeout < 1000) {
    throw new Error("--nav-timeout must be at least 1000ms");
  }
  return options;
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
    "--window-size=1440,900",
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
        const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
        if (!response.ok) throw new Error(`/json/new returned HTTP ${response.status}: ${stderr.trim()}`);
        const target = await response.json();
        if (!target.webSocketDebuggerUrl) throw new Error("DevTools target has no webSocketDebuggerUrl");
        return { child, wsUrl: target.webSocketDebuggerUrl, stderr: () => stderr };
      }
    }
    await sleep(100);
  }
  killTree(child);
  throw new Error(`browser did not expose a DevTools port within 20s: ${stderr.trim()}`);
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

// Navigate with a long ceiling and keep the partially parsed document when the
// load event is late: a slow donor is still measurable if the rows rendered.
async function navigate(cdp, url, timeoutMs, settleMs) {
  const started = Date.now();
  const loaded = cdp.waitEvent("Page.loadEventFired", timeoutMs);
  const navigation = await cdp.send("Page.navigate", { url }, timeoutMs);
  if (navigation.errorText) throw new Error(`navigation failed: ${navigation.errorText}`);
  let loadTimedOut = false;
  await loaded.catch(() => {
    loadTimedOut = true;
  });

  let state = null;
  while (Date.now() - started < timeoutMs) {
    state = await evaluate(
      cdp,
      `({ ready: document.readyState, url: location.href, title: document.title })`,
      5000,
    ).catch(() => null);
    if (state && state.ready === "complete") break;
    await sleep(200);
  }
  if (!state) {
    state = await evaluate(
      cdp,
      `({ ready: document.readyState, url: location.href, title: document.title })`,
      5000,
    ).catch(() => null);
  }
  await sleep(settleMs);
  return {
    loadTimedOut: loadTimedOut || (state ? state.ready !== "complete" : true),
    readyState: state ? state.ready : null,
    finalUrl: state ? state.url : null,
    title: state ? state.title : null,
    durationMs: Date.now() - started,
  };
}

// Runs inside the page. Keep every helper inside so the function serializes
// without closing over the Node scope.
function measurePage(args) {
  const { rowsSelector, blockSelectors, titleSelectors, viewportHeight } = args;
  const H = viewportHeight;
  const W = window.innerWidth;

  function rendered(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest("[hidden]")) return false;
    if (el.classList.contains("visually-hidden") || el.classList.contains("sr-only")) return false;
    if (el.getAttribute("aria-hidden") === "true" && !el.matches("svg, use")) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number.parseFloat(style.opacity || "1") < 0.05) return false;
    if (style.clip && style.clip !== "auto" && /rect\(0(px)?[,\s]/.test(style.clip)) return false;
    if (style.clipPath && /inset\(50%/.test(style.clipPath)) return false;
    const box = el.getBoundingClientRect();
    if (box.width <= 1 && box.height <= 1) return false;
    return box.width > 0 && box.height > 0;
  }

  function rectOf(el) {
    const box = el.getBoundingClientRect();
    return {
      left: box.left + window.scrollX,
      top: box.top + window.scrollY,
      right: box.right + window.scrollX,
      bottom: box.bottom + window.scrollY,
      width: box.width,
      height: box.height,
      viewTop: box.top,
      viewBottom: box.bottom,
      viewLeft: box.left,
      viewRight: box.right,
    };
  }

  function inViewport(box) {
    return box.viewBottom > 0 && box.viewTop < H && box.viewRight > 0 && box.viewLeft < W;
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

  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return `#${el.id}`;
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 3; depth += 1) {
      let part = node.tagName.toLowerCase();
      if (node.classList.length) part += `.${[...node.classList].slice(0, 2).join(".")}`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? Math.round(sorted[middle])
      : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }

  // --- data rows -----------------------------------------------------------
  function pickRows(selectorText) {
    const selectors = String(selectorText || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const selector of selectors) {
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(selector)].filter(rendered);
      } catch {
        continue;
      }
      // A chain strip of 16 chips matches ".key-row"-free generic selectors
      // only when the selector is wrong; require a real row body (two text-ish
      // descendants) so a tab strip cannot masquerade as the data table.
      nodes = nodes.filter((node) => {
        const textCells = [...node.children].filter((child) => rendered(child) && textOf(child)).length;
        return textCells >= 2 || node.matches("tr");
      });
      if (nodes.length >= 3) return { selector, nodes };
    }
    return { selector: null, nodes: [] };
  }

  function detectRows() {
    const containers = [...document.querySelectorAll("tbody, main, section, div")];
    const groups = [];
    for (const container of containers) {
      const children = [...container.children].filter(rendered);
      if (children.length < 5) continue;
      const buckets = new Map();
      for (const child of children) {
        const key = `${child.tagName}.${child.className}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(child);
      }
      for (const [key, items] of buckets) {
        if (items.length < 5) continue;
        const boxes = items.map((item) => item.getBoundingClientRect());
        const heights = boxes.map((box) => box.height);
        const min = Math.min(...heights);
        const max = Math.max(...heights);
        if (max - min > 6) continue;
        if (min < 20 || min > 220) continue;
        const words = items.filter((item) => textOf(item).length >= 4).length;
        if (words < items.length * 0.8) continue;
        const twoCells = items.filter((item) => [...item.children].filter(rendered).length >= 2).length;
        const rowish = /row|key|entry|item|record/i.test(key) || twoCells >= items.length * 0.8;
        if (!rowish) continue;
        groups.push({ selector: `${container.tagName.toLowerCase()} > ${key.replace(/\./g, ".")}`, items, top: boxes[0].top + window.scrollY });
      }
    }
    groups.sort((a, b) => a.top - b.top || b.items.length - a.items.length);
    return groups[0] || null;
  }

  let picked = pickRows(rowsSelector);
  let rowsSource = "selector";
  if (!picked.nodes.length) {
    picked = detectRows() || { selector: null, nodes: [] };
    rowsSource = picked.selector ? "auto-detected" : "none";
  }
  const rowBoxes = picked.nodes.map((node) => ({ node, box: rectOf(node) }));
  const allHeights = rowBoxes.map(({ box }) => box.height);
  const visibleRowBoxes = rowBoxes.filter(({ box }) => inViewport(box));
  const firstRow = rowBoxes.length ? rowBoxes[0] : null;

  // --- interactive controls ------------------------------------------------
  const controlSelector =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"]';
  const controls = [...document.querySelectorAll(controlSelector)].filter(rendered);
  const controlsByTag = {};
  let controlsInViewport = 0;
  for (const control of controls) {
    const tag = control.tagName.toLowerCase();
    controlsByTag[tag] = (controlsByTag[tag] || 0) + 1;
    if (inViewport(rectOf(control))) controlsInViewport += 1;
  }

  // --- blocks --------------------------------------------------------------
  const blocks = [];
  for (const [name, selectorText] of blockSelectors) {
    const selectors = String(selectorText)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    let el = null;
    let matched = null;
    for (const selector of selectors) {
      let candidate = null;
      try {
        candidate = [...document.querySelectorAll(selector)].find(rendered) || null;
      } catch {
        candidate = null;
      }
      if (candidate) {
        el = candidate;
        matched = selector;
        break;
      }
    }
    if (!el) {
      blocks.push({ name, selector: null, present: false });
      continue;
    }
    const style = getComputedStyle(el);
    const box = rectOf(el);
    blocks.push({
      name,
      selector: matched,
      element: selectorOf(el),
      present: true,
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      height: Math.round(box.height),
      padding: ["Top", "Right", "Bottom", "Left"].map((side) =>
        Math.round(Number.parseFloat(style[`padding${side}`]) || 0),
      ),
      margin: ["Top", "Right", "Bottom", "Left"].map((side) =>
        Math.round(Number.parseFloat(style[`margin${side}`]) || 0),
      ),
      position: style.position,
      rowGap: style.rowGap && style.rowGap !== "normal" ? style.rowGap : null,
      inViewport: inViewport(box),
    });
  }
  const visibleBlocks = blocks
    .filter((block) => block.present)
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  let previousBottom = null;
  for (const block of visibleBlocks) {
    if (previousBottom !== null && block.top >= previousBottom - 2) {
      block.gap = Math.round(block.top - previousBottom);
    } else if (previousBottom !== null) {
      block.gap = null;
      block.overlapsPrevious = true;
    } else {
      block.gap = null;
    }
    previousBottom = Math.max(previousBottom ?? block.bottom, block.bottom);
  }

  function firstRendered(selectors) {
    for (const selector of selectors) {
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(selector)];
      } catch {
        continue;
      }
      const found = nodes.find(rendered);
      if (found) return { el: found, selector };
    }
    return null;
  }

  function fontSize(el) {
    const size = Number.parseFloat(getComputedStyle(el).fontSize);
    return Number.isFinite(size) ? Math.round(size * 10) / 10 : null;
  }

  function maxFontIn(block) {
    if (!block || !block.element) return null;
    const root = document.querySelector(block.element);
    if (!root) return null;
    let best = null;
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (!rendered(el)) continue;
      if (!textOf(el)) continue;
      if (el.closest("svg")) continue;
      const size = fontSize(el);
      if (size === null) continue;
      if (best === null || size > best.size) best = { size, selector: selectorOf(el), text: textOf(el).slice(0, 40) };
    }
    return best;
  }

  const pageHeader = blocks.find((block) => block.name === "pageHeader" && block.present);
  const statsBlock = blocks.find((block) => block.name === "stats" && block.present);

  const titleHit = firstRendered(titleSelectors);
  const title = titleHit
    ? {
        selector: titleHit.selector,
        text: textOf(titleHit.el).slice(0, 80),
        size: fontSize(titleHit.el),
        visible: true,
      }
    : { selector: null, text: null, size: null, visible: false };
  const titleFallback = maxFontIn(pageHeader);

  const statValueHit = firstRendered([
    ".stat-value",
    ".stat__value",
    "[class*='stat-value']",
    "[class*='stat-value']",
    "[class*='balance-summary'] strong",
    ".balance-summary b",
    "[class*='stat'] strong",
    "[class*='stat'] b",
  ]);
  const statValue = statValueHit
    ? { selector: statValueHit.selector, size: fontSize(statValueHit.el), text: textOf(statValueHit.el).slice(0, 40) }
    : null;
  const statValueFallback = maxFontIn(statsBlock);

  const tableHeaderHit = firstRendered([
    "thead th",
    "table th",
    ".keys-header",
    "[class*='table-header']",
    "[class*='keys-header']",
  ]);
  const tableHeader = tableHeaderHit
    ? {
        selector: tableHeaderHit.selector,
        size: fontSize(tableHeaderHit.el),
        text: textOf(tableHeaderHit.el).slice(0, 40),
      }
    : null;

  const docHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
    window.innerHeight,
  );
  const docWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body ? document.body.scrollWidth : 0,
    window.innerWidth,
  );

  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = document.body ? getComputedStyle(document.body) : null;

  return {
    url: location.href,
    title: document.title,
    rows: {
      selector: picked.selector,
      source: rowsSource,
      total: rowBoxes.length,
      visible: visibleRowBoxes.length,
      height: { min: allHeights.length ? Math.round(Math.min(...allHeights)) : null, median: median(allHeights), max: allHeights.length ? Math.round(Math.max(...allHeights)) : null },
      visibleHeight: median(visibleRowBoxes.map(({ box }) => box.height)),
      firstTop: firstRow ? Math.round(firstRow.box.top) : null,
      firstInViewport: firstRow ? inViewport(firstRow.box) : null,
      firstText: firstRow ? textOf(firstRow.node).slice(0, 80) : null,
    },
    chromeHeight: firstRow ? Math.round(firstRow.box.top) : null,
    controls: {
      rendered: controls.length,
      inViewport: controlsInViewport,
      byTag: controlsByTag,
    },
    blocks,
    fonts: {
      title,
      titleFallback,
      statValue,
      statValueFallback,
      tableHeader,
    },
    docHeight,
    horizontalOverflow: Math.max(0, docWidth - window.innerWidth),
    theme: {
      dataTheme: document.documentElement.getAttribute("data-theme"),
      dataBsTheme: document.documentElement.getAttribute("data-bs-theme"),
      prefersDark: window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches,
      background: bodyStyle ? bodyStyle.backgroundColor : null,
      color: rootStyle.color,
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
  };
}

const BLOCKED_PATTERN =
  /just a moment|attention required|access denied|checking your browser|verify you are human|enable javascript and cookies|cf-challenge|cloudflare/i;

function looksBlocked(measured, httpStatus) {
  if ([401, 403, 429, 503].includes(httpStatus)) return true;
  const title = measured && measured.title ? measured.title : "";
  const firstText = measured && measured.rows ? measured.rows.firstText || "" : "";
  return BLOCKED_PATTERN.test(title) || BLOCKED_PATTERN.test(firstText);
}

function padCell(value, width, align = "left") {
  const text = value === null || value === undefined ? "-" : String(value);
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

function table(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(String(header).length, ...rows.map((row) => String(row[index] ?? "-").length)),
  );
  const line = (cells) => cells.map((cell, index) => padCell(cell, widths[index], index === 0 ? "left" : "right")).join("  ");
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

async function measureSide(cdp, side, options, browserState) {
  const url = options[side];
  const result = {
    url,
    status: "not-run",
    error: null,
    httpStatus: null,
    blocked: false,
    userAgent: "headless",
    attempts: [],
    runs: [],
  };

  for (const viewport of options.viewports) {
    for (const theme of options.themes) {
      if (side === "donor" && result.status === "unreachable") {
        result.attempts.push({ viewport, theme, skipped: true, reason: "donor unreachable; not reloaded" });
        continue;
      }
      let attempt = 0;
      let measured = null;
      const maxAttempts = side === "donor" && options.uaRetry ? 2 : 1;
      while (attempt < maxAttempts) {
        attempt += 1;
        const httpStatuses = [];
        let mainStatus = null;
        const offResponse = cdp.on("Network.responseReceived", (params) => {
          if (params.type !== "Document") return;
          const status = params.response?.status;
          if (Number.isFinite(status)) {
            httpStatuses.push({ url: params.response.url, status });
            mainStatus = status;
          }
        });
        const offFailed = cdp.on("Network.loadingFailed", () => {});
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
          if (result.userAgent === "normal" && side === "donor") {
            await cdp.send("Emulation.setUserAgentOverride", { userAgent: NORMAL_UA, platform: "Win32" });
          } else {
            await cdp.send("Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => {});
          }

          const nav = await navigate(cdp, url, options.navTimeout, options.settle);
          measured = await evaluate(
            cdp,
            `(${measurePage.toString()})(${JSON.stringify({
              rowsSelector: options.rows[side],
              blockSelectors: [...options.blocks[side]],
              titleSelectors: ["h1", "[class*='page-title']", "[class*='hero-title']"],
              viewportHeight: viewport.height,
            })})`,
          );
          const blocked = looksBlocked(measured, mainStatus);
          const attemptRecord = {
            viewport,
            theme,
            userAgent: result.userAgent,
            httpStatus: mainStatus,
            httpStatuses,
            blocked,
            loadTimedOut: nav.loadTimedOut,
            readyState: nav.readyState,
            finalUrl: nav.finalUrl,
            durationMs: nav.durationMs,
          };
          result.httpStatus = mainStatus;
          result.blocked = blocked;
          result.attempts.push(attemptRecord);

          if (blocked && side === "donor" && options.uaRetry && result.userAgent === "headless" && attempt === 1) {
            log(`donor blocked the headless browser; retrying once with a normal user agent`);
            result.userAgent = "normal";
            measured = null;
            continue;
          }
          if (blocked) {
            result.status = "unreachable";
            result.error = `donor blocked the headless browser (HTTP ${mainStatus ?? "unknown"})`;
            measured = null;
            break;
          }
          if (!measured.rows.total) {
            result.status = "partial";
            result.error = nav.loadTimedOut
              ? `page did not finish loading within ${options.navTimeout}ms and no data rows rendered`
              : "no data rows matched";
            if (side === "donor") {
              result.status = "unreachable";
              result.error = `${result.error}; donor numbers are not reported`;
            }
          } else {
            result.status = "measured";
            result.error = null;
          }
          result.runs.push({ viewport, theme, status: result.status, error: result.error, measured });
          break;
        } catch (error) {
          result.attempts.push({ viewport, theme, userAgent: result.userAgent, error: error.message });
          result.error = error.message;
          if (side === "donor" && options.uaRetry && result.userAgent === "headless" && attempt === 1) {
            log(`donor load failed (${error.message}); retrying once with a normal user agent`);
            result.userAgent = "normal";
            continue;
          }
          result.status = side === "donor" ? "unreachable" : "error";
          if (side === "donor") {
            result.attempts.push({ viewport, theme, skipped: true, reason: "donor unreachable; not reloaded" });
          }
          break;
        } finally {
          offResponse();
          offFailed();
        }
      }
      if (side === "donor" && result.status === "unreachable") break;
      log(
        `${side} ${viewport.width}x${viewport.height} ${theme}: ${result.status}` +
          (measured && measured.rows ? ` (${measured.rows.total} rows, chrome ${measured.chromeHeight ?? "-"}px)` : ""),
      );
    }
    if (side === "donor" && result.status === "unreachable") break;
  }
  return result;
}

function runKey(run) {
  return `${run.viewport.width}x${run.viewport.height}/${run.theme}`;
}

function buildComparisons(sides) {
  const comparisons = [];
  for (const donorRun of sides.donor.runs.filter((run) => run.status === "measured")) {
    const oursRun = sides.ours.runs.find(
      (run) => run.viewport.width === donorRun.viewport.width &&
        run.viewport.height === donorRun.viewport.height &&
        run.theme === donorRun.theme,
    );
    if (!oursRun) continue;
    const d = donorRun.measured;
    const o = oursRun.measured;
    const density = (rows, chrome) => (chrome && chrome > 0 ? rows / (chrome / 1000) : null);
    const donorDensity = density(d.rows.visible, d.chromeHeight);
    const oursDensity = density(o.rows.visible, o.chromeHeight);
    const blockDeltas = [];
    const names = [...new Set([...d.blocks, ...o.blocks].filter((block) => block.present).map((block) => block.name))];
    for (const name of names) {
      const donorBlock = d.blocks.find((block) => block.name === name && block.present) || null;
      const oursBlock = o.blocks.find((block) => block.name === name && block.present) || null;
      blockDeltas.push({
        name,
        donor: donorBlock
          ? { height: donorBlock.height, padding: donorBlock.padding, gap: donorBlock.gap ?? null, top: donorBlock.top }
          : null,
        ours: oursBlock
          ? { height: oursBlock.height, padding: oursBlock.padding, gap: oursBlock.gap ?? null, top: oursBlock.top }
          : null,
        heightDelta: donorBlock && oursBlock ? oursBlock.height - donorBlock.height : null,
        paddingDelta: donorBlock && oursBlock
          ? oursBlock.padding.map((value, index) => value - donorBlock.padding[index])
          : null,
        gapDelta: donorBlock && oursBlock && donorBlock.gap !== null && oursBlock.gap !== null
          ? oursBlock.gap - donorBlock.gap
          : null,
      });
    }
    comparisons.push({
      viewport: donorRun.viewport,
      theme: donorRun.theme,
      chromeHeight: { donor: d.chromeHeight, ours: o.chromeHeight, delta: o.chromeHeight !== null && d.chromeHeight !== null ? o.chromeHeight - d.chromeHeight : null },
      visibleRows: { donor: d.rows.visible, ours: o.rows.visible, delta: o.rows.visible - d.rows.visible },
      rowHeight: { donor: d.rows.height.median, ours: o.rows.height.median },
      controlsInViewport: { donor: d.controls.inViewport, ours: o.controls.inViewport, delta: o.controls.inViewport - d.controls.inViewport },
      documentHeight: { donor: d.docHeight, ours: o.docHeight, delta: o.docHeight - d.docHeight },
      rowsPer1000pxChrome: {
        donor: donorDensity === null ? null : Number(donorDensity.toFixed(2)),
        ours: oursDensity === null ? null : Number(oursDensity.toFixed(2)),
      },
      // 0 means not a single row reached the fold; it is a measured zero, not
      // a missing value. Only a missing chrome height yields null.
      densityRatio: donorDensity ? Number(((oursDensity ?? 0) / donorDensity).toFixed(2)) : null,
      blockDeltas,
    });
  }
  return comparisons;
}

function printReport(report) {
  log("");
  log("Density parity: donor vs ours");
  log("");
  const mainRows = [];
  for (const side of ["donor", "ours"]) {
    const data = report.sides[side];
    for (const run of data.runs) {
      if (!run.measured) continue;
      // An unreachable donor contributes no numbers; the explicit notice below
      // explains why, and our side is still printed in full.
      if (side === "donor" && run.status === "unreachable") continue;
      const m = run.measured;
      mainRows.push([
        side,
        runKey(run),
        m.chromeHeight ?? "-",
        `${m.rows.visible}/${m.rows.total}`,
        m.rows.height.median ?? "-",
        `${m.controls.inViewport}/${m.controls.rendered}`,
        m.docHeight,
        m.fonts.title.size ?? m.fonts.titleFallback?.size ?? "-",
        m.fonts.statValue?.size ?? m.fonts.statValueFallback?.size ?? "-",
        m.fonts.tableHeader?.size ?? "-",
        `${m.theme.dataTheme || m.theme.dataBsTheme || "-"}/${m.theme.prefersDark ? "dark" : "light"}`,
      ]);
    }
  }
  log(
    table(
      ["side", "viewport/theme", "chrome", "rows vis/total", "rowH", "ctrls vis/all", "docH", "title", "stat", "th", "theme"],
      mainRows,
    ),
  );

  if (report.sides.donor.status === "unreachable") {
    log("");
    log(`DONOR UNREACHABLE: ${report.sides.donor.error}`);
    log("Donor numbers are absent on purpose; only our side is reported.");
  }

  if (report.comparisons.length) {
    log("");
    log("Comparison (ours - donor)");
    log("");
    log(
      table(
        ["viewport/theme", "chromeD", "rowsD", "densityRatio", "ctrlD", "docHD"],
        report.comparisons.map((entry) => [
          `${entry.viewport.width}x${entry.viewport.height}/${entry.theme}`,
          entry.chromeHeight.delta ?? "-",
          entry.visibleRows.delta,
          entry.densityRatio ?? "-",
          entry.controlsInViewport.delta,
          entry.documentHeight.delta,
        ]),
      ),
    );
    log("");
    log(`densityRatio = (ours visible rows / 1000px chrome) / (donor visible rows / 1000px chrome); >1 means ours is denser.`);

    const firstViewport = report.comparisons[0].viewport;
    const firstTheme = report.comparisons[0].theme;
    const blockRows = [];
    for (const side of ["donor", "ours"]) {
      const run = report.sides[side].runs.find(
        (item) => item.measured && item.viewport.width === firstViewport.width &&
          item.viewport.height === firstViewport.height && item.theme === firstTheme,
      );
      if (!run) continue;
      const ordered = run.measured.blocks.filter((block) => block.present).sort((a, b) => a.top - b.top);
      for (const block of ordered) {
        blockRows.push([
          side,
          block.name,
          block.top,
          block.height,
          block.padding.join("/"),
          block.margin.join("/"),
          block.gap ?? "-",
          block.rowGap ?? "-",
          block.position,
        ]);
      }
    }
    log("");
    log(`Blocks at ${firstViewport.width}x${firstViewport.height}/${firstTheme} (pad/margin order: top/right/bottom/left)`);
    log("");
    log(table(["side", "block", "top", "h", "pad T/R/B/L", "mar T/R/B/L", "gap", "rowGap", "pos"], blockRows));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    log(HELP);
    return 0;
  }

  const browserPath = findBrowser();
  if (!browserPath) {
    throw new Error("no Chrome/Edge found; set CHROME_PATH or install Chrome/Chromium/Microsoft Edge");
  }

  let browser = null;
  let cdp = null;
  const profile = await mkdtemp(path.join(tmpdir(), "rotor-density-parity-"));
  const cleanup = () => {
    if (cdp) cdp.close();
    if (browser) killTree(browser);
  };

  try {
    log(`browser: ${browserPath}`);
    const launched = await launchBrowser(browserPath, profile);
    browser = launched.child;
    cdp = await createCdp(launched.wsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable").catch(() => {});

    const sides = {};
    sides.ours = await measureSide(cdp, "ours", options);
    sides.donor = await measureSide(cdp, "donor", options);

    const report = {
      generatedAt: new Date().toISOString(),
      browser: browserPath,
      viewports: options.viewports,
      themes: options.themes,
      selectors: {
        rows: options.rows,
        blocks: Object.fromEntries(
          Object.entries(options.blocks).map(([side, blocks]) => [side, Object.fromEntries(blocks)]),
        ),
      },
      sides,
      comparisons: buildComparisons(sides),
    };

    printReport(report);

    if (options.json) {
      const target = path.resolve(options.json);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
      log("");
      log(`json: ${target}`);
    }
    log("");
    log(
      `donor: ${sides.donor.status}${sides.donor.error ? ` (${sides.donor.error})` : ""}; ` +
        `ours: ${sides.ours.status}${sides.ours.error ? ` (${sides.ours.error})` : ""}`,
    );
    return 0;
  } finally {
    cleanup();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 50).unref();
  })
  .catch((error) => {
    console.error(`density-parity: ${error.message}`);
    process.exit(2);
  });
