// Operator analytics client. Reads the aggregate-only admin API and renders
// counters and a dependency-free inline SVG sparkline. Every value is inserted
// with textContent; the page has no inline script or style.
(() => {
  "use strict";

  const API = "/cabinet/admin/api/analytics";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const number = new Intl.NumberFormat("en-US");
  // Table cells show a human label, never a raw path.
  const ROUTE_LABELS = {
    "/": "Home",
    "/app": "App",
    "/run": "Run client",
    "/me": "Account",
    "/docs": "Docs",
    "/key": "Key explorer",
    "/keys": "Key ranges",
    "/private-keys": "Private keys",
    "/mnemonic-seeds": "Mnemonic seeds",
    "/mnemonic-converter": "Mnemonic converter",
    "/bitcoin-puzzle": "Bitcoin puzzle",
    "/brainwallet": "Brainwallet",
    "/keystore-parser": "Keystore parser",
    "/public-key": "Public key",
    "/pubkey-add": "Public key addition",
    "/reconstruction": "Reconstruction",
    "/hex-dec-bin": "Hex / dec / bin",
    "/tx": "Transaction decoders",
    "/milk-sad": "Milk Sad",
    "/security": "Security",
    "/tools": "Tools",
    "/vanity": "Vanity",
    "/seed": "Seed studio",
    "/wallets": "Wallet database",
    "/downloads": "Downloads",
    "/cabinet": "Cabinet",
    "/cabinet/wallet": "Wallet cabinet",
    "/cabinet/admin": "Admin",
    "/monitor": "Address monitor",
    "/send": "Send",
    "/faq": "FAQ",
    "/donate": "Donate",
    "/disclaimer": "Disclaimer",
    other: "Other",
  };

  const status = document.getElementById("analytics-status");
  const error = document.getElementById("analytics-error");
  const empty = document.getElementById("analytics-empty");
  const dataBox = document.getElementById("analytics-data");
  const refresh = document.getElementById("analytics-refresh");
  const main = document.querySelector("main");

  let loading = false;

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    return node;
  }

  function count(value) {
    return number.format(Number(value) || 0);
  }

  function percent(part, total) {
    if (!total) return "0%";
    return `${((Number(part) / Number(total)) * 100).toFixed(1)}%`;
  }

  function uptime(seconds) {
    let left = Math.max(0, Number(seconds) || 0);
    const days = Math.floor(left / 86400);
    left %= 86400;
    const hours = Math.floor(left / 3600);
    left %= 3600;
    const minutes = Math.floor(left / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function titleCase(text) {
    const value = String(text || "");
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function routeLabel(name) {
    if (Object.prototype.hasOwnProperty.call(ROUTE_LABELS, name)) return ROUTE_LABELS[name];
    const words = String(name || "")
      .replace(/^\//, "")
      .split(/[/-]/)
      .filter(Boolean)
      .map(titleCase);
    return words.length ? words.join(" ") : "Other";
  }

  function setBusy(busy) {
    if (refresh) refresh.disabled = busy;
    if (main) main.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function showError(message) {
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
    if (status) status.textContent = "Analytics unavailable.";
    if (dataBox) dataBox.hidden = true;
    if (empty) empty.hidden = true;
  }

  function renderRows(id, rows, total, decorate) {
    const body = document.getElementById(id);
    const block = body ? body.closest("[data-analytics-block]") : null;
    if (!body) return;
    body.replaceChildren();
    if (!rows || rows.length === 0) {
      if (block) block.hidden = true;
      return;
    }
    if (block) block.hidden = false;
    for (const row of rows) {
      const tr = document.createElement("tr");
      const name = decorate ? decorate(row.name) : row.name;
      tr.append(
        el("td", name),
        el("td", count(row.views)),
        el("td", percent(row.views, total)),
      );
      body.append(tr);
    }
  }

  function renderSpark(hourly) {
    const chart = document.getElementById("analytics-spark");
    const summary = document.getElementById("analytics-spark-summary");
    if (!chart || !summary) return;
    const values = (hourly || []).map((slot) => Number(slot.views) || 0);
    // Keep the <title>; replace only the drawing.
    for (const child of Array.from(chart.childNodes)) {
      if (child.nodeType === 1 && child.tagName.toLowerCase() === "title") continue;
      chart.removeChild(child);
    }
    if (values.length === 0) {
      summary.textContent = "No hourly data.";
      return;
    }
    const width = 600;
    const height = 120;
    const pad = 8;
    const base = height - pad;
    const max = Math.max(1, ...values);
    const step = values.length > 1 ? (width - 2 * pad) / (values.length - 1) : 0;
    const points = values.map((value, index) => [
      pad + index * step,
      base - (value / max) * (height - 2 * pad),
    ]);

    chart.append(
      svg("line", {
        x1: pad,
        y1: base,
        x2: width - pad,
        y2: base,
        class: "analytics-spark__grid",
      }),
    );
    const line = points
      .map((point, index) => `${index === 0 ? "M" : "L"}${point[0].toFixed(1)},${point[1].toFixed(1)}`)
      .join(" ");
    chart.append(
      svg("path", {
        d: `${line} L${(width - pad).toFixed(1)},${base} L${pad},${base} Z`,
        class: "analytics-spark__area",
      }),
      svg("path", { d: line, class: "analytics-spark__line" }),
    );

    const total = values.reduce((sum, value) => sum + value, 0);
    const peak = Math.max(...values);
    const peakIndex = values.indexOf(peak);
    const peakSlot = hourly[peakIndex];
    if (peak === 0) {
      summary.textContent = "No views in the last 24 hours.";
    } else {
      const hour = new Date(Number(peakSlot.hour) * 1000);
      const label = `${String(hour.getUTCHours()).padStart(2, "0")}:00`;
      summary.textContent = `Peak ${count(peak)} views/hour at ${label} UTC; ${count(total)} views in 24 hours.`;
    }
  }

  function render(data) {
    if (!data || !data.week) {
      showError("The analytics response is missing its totals.");
      return;
    }
    if (error) error.hidden = true;
    const weekViews = Number(data.week.views) || 0;
    const todayViews = Number(data.today && data.today.views) || 0;

    if (weekViews === 0 && todayViews === 0) {
      if (dataBox) dataBox.hidden = true;
      if (empty) empty.hidden = false;
      if (status) status.textContent = "Waiting for the first page view.";
      return;
    }
    if (empty) empty.hidden = true;
    if (dataBox) dataBox.hidden = false;

    const load = data.load || {};
    document.getElementById("stat-today").textContent = count(todayViews);
    document.getElementById("stat-week").textContent = count(weekViews);
    document.getElementById("stat-hour").textContent = count(load.views_this_hour);
    document.getElementById("stat-last24").textContent = count(load.views_last_24h);
    document.getElementById("load-current").textContent = Number(load.views_per_minute_current_hour || 0).toFixed(2);
    document.getElementById("load-average").textContent = Number(load.views_per_minute_last_24h || 0).toFixed(2);

    const coordinator = data.coordinator || {};
    document.getElementById("load-served").textContent = Number(coordinator.served_requests_per_minute || 0).toFixed(2);
    document.getElementById("load-inflight").textContent = `${count(coordinator.in_flight_requests)} / ${count(coordinator.max_concurrent_requests)}`;
    document.getElementById("load-rejected").textContent = count(coordinator.capacity_rejections_total);
    document.getElementById("load-uptime").textContent = uptime(coordinator.uptime_secs);

    renderSpark(data.hourly);
    renderRows("rows-routes", data.routes, weekViews, routeLabel);
    renderRows("rows-countries", data.countries, weekViews);
    renderRows("rows-devices", data.devices, weekViews, titleCase);
    renderRows("rows-browsers", data.browsers, weekViews, titleCase);
    renderRows("rows-referrers", data.referrers, weekViews);

    const stamp = new Date(Number(data.generated_at) * 1000);
    const time = `${String(stamp.getUTCHours()).padStart(2, "0")}:${String(stamp.getUTCMinutes()).padStart(2, "0")}:${String(stamp.getUTCSeconds()).padStart(2, "0")}`;
    if (status) {
      status.textContent = `Updated ${time} UTC, ${count(weekViews)} views in the last 7 days, ${data.retention_hours || 168} hours retained.`;
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    setBusy(true);
    try {
      const response = await fetch(API, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (response.status === 401) {
        showError("Your admin session expired. Sign in again at /cabinet/admin/login.");
        return;
      }
      if (!response.ok) {
        showError(`Analytics request failed (HTTP ${response.status}).`);
        return;
      }
      render(await response.json());
    } catch (err) {
      showError("Could not reach the coordinator. Check the connection and retry.");
    } finally {
      loading = false;
      setBusy(false);
    }
  }

  if (refresh) refresh.addEventListener("click", load);
  window.setInterval(() => {
    if (document.visibilityState !== "hidden") load();
  }, 60000);
  load();
})();
