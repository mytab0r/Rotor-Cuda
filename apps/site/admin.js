// Operator cabinet client. The token is read from the password field, sent
// once in the login JSON, and cleared; only the non-HttpOnly CSRF cookie is
// read afterwards. Nothing here is inlined into the page.
(() => {
  "use strict";

  const CSRF_COOKIE = "rotor_admin_csrf";
  const JOB_STATES = ["running", "queued", "done", "found"];
  const PANEL_ROUTES = {
    overview: "/cabinet/admin",
    clients: "/cabinet/admin/clients",
    monitor: "/cabinet/admin/monitor",
    jobs: "/cabinet/admin/jobs",
    orders: "/cabinet/admin/orders",
    providers: "/cabinet/admin/providers",
    integrations: "/cabinet/admin/integrations",
    audit: "/cabinet/admin/audit",
  };
  const PANEL_LOADERS = {
    overview: loadOverview,
    clients: loadClients,
    monitor: loadMonitor,
    jobs: loadJobs,
    orders: loadOrders,
    providers: loadProviders,
    integrations: loadIntegrations,
    audit: loadAudit,
  };

  const loginCard = document.getElementById("login-card");
  const dashboard = document.getElementById("dashboard");
  const form = document.getElementById("login-form");
  const userInput = document.getElementById("admin-user");
  const passwordInput = document.getElementById("admin-password");
  const tokenInput = document.getElementById("admin-token");
  const loginError = document.getElementById("login-error");
  const loginSubmit = document.getElementById("login-submit");
  const logoutButton = document.getElementById("admin-logout");
  const jobStates = document.getElementById("job-states");
  const dashboardUpdated = document.getElementById("dashboard-updated");

  function csrfToken() {
    const prefix = `${CSRF_COOKIE}=`;
    const entry = document.cookie.split("; ").find((part) => part.startsWith(prefix));
    return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
  }

  function showLogin(message) {
    if (dashboard) dashboard.hidden = true;
    if (loginCard) loginCard.hidden = false;
    if (logoutButton) logoutButton.hidden = true;
    if (loginError) {
      loginError.textContent = message || "";
      loginError.hidden = !message;
    }
    if (tokenInput) tokenInput.focus();
  }

  function showDashboard() {
    if (loginCard) loginCard.hidden = true;
    if (dashboard) dashboard.hidden = false;
    if (logoutButton) logoutButton.hidden = false;
  }

  function panelEl(name) {
    return document.querySelector(`.admin-panel[data-panel="${name}"]`);
  }

  function roleEl(panel, role) {
    return panel ? panel.querySelector(`[data-role="${role}"]`) : null;
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function setError(node, message) {
    if (!node) return;
    node.textContent = message || "";
    node.hidden = !message;
  }

  function panelError(panel, message) {
    setError(roleEl(panel, "error"), message);
    const loading = roleEl(panel, "loading");
    if (loading) loading.hidden = true;
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("en-US");
  }

  function formatRate(value) {
    return Number(value || 0).toFixed(2);
  }

  function formatTime(secs) {
    if (!secs) return "-";
    return new Date(Number(secs) * 1000).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  function shortValue(value, head = 10, tail = 6) {
    const text = String(value || "");
    if (text.length <= head + tail + 3) return text;
    return `${text.slice(0, head)}...${text.slice(-tail)}`;
  }

  function shortRange(start, end) {
    return `${shortValue(start, 8, 6)} - ${shortValue(end, 8, 6)}`;
  }

  function row(cells) {
    const tr = document.createElement("tr");
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value === null || value === undefined || value === "" ? "-" : String(value);
      tr.append(td);
    }
    return tr;
  }

  function fillBody(id, rows) {
    const body = document.getElementById(id);
    if (body) body.replaceChildren(...rows);
  }

  function toggleBlock(tableId, emptyId, hasRows) {
    const table = document.getElementById(tableId);
    const empty = document.getElementById(emptyId);
    if (table) table.hidden = !hasRows;
    if (empty) empty.hidden = hasRows;
  }

  function formatUptime(seconds) {
    const total = Number(seconds) || 0;
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  async function fetchJson(path) {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (response.status === 401) {
      showLogin("Session expired. Sign in again.");
      throw new Error("unauthorized");
    }
    if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}.`);
    return response.json();
  }

  function renderJobStates(jobs) {
    if (!jobStates) return;
    jobStates.replaceChildren();
    for (const state of JOB_STATES) {
      const tr = document.createElement("tr");
      const label = document.createElement("td");
      label.textContent = state;
      const count = document.createElement("td");
      count.textContent = formatNumber(jobs[state]);
      tr.append(label, count);
      jobStates.append(tr);
    }
  }

  async function loadOverview() {
    const panel = panelEl("overview");
    setError(roleEl(panel, "error"), "");
    const data = await fetchJson("/cabinet/admin/api/overview");
    setText("stat-build", data.build_id || "-");
    setText("stat-uptime", formatUptime(data.uptime_secs));
    setText("stat-clients", formatNumber(data.clients?.registered));
    setText("stat-leases", formatNumber(data.leases?.active));
    renderJobStates(data.jobs || {});
    if (dashboardUpdated) {
      dashboardUpdated.textContent = `Jobs: ${formatNumber(data.jobs?.total)}. Refreshed ${new Date().toLocaleTimeString()}.`;
    }
  }

  async function loadClients() {
    const panel = panelEl("clients");
    const loading = roleEl(panel, "loading");
    const table = roleEl(panel, "table");
    const empty = roleEl(panel, "empty");
    try {
      const data = await fetchJson("/cabinet/admin/api/clients?page=1&page_size=50");
      const clients = data.items || [];
      fillBody(
        "clients-rows",
        clients.map((client) =>
          row([
            client.id,
            client.name,
            formatTime(client.created_at),
            formatTime(client.last_seen),
            formatNumber(client.scanned_total),
            formatRate(client.rate),
            client.disabled ? "disabled" : "enabled",
          ]),
        ),
      );
      if (loading) loading.hidden = true;
      if (table) table.hidden = clients.length === 0;
      if (empty) empty.hidden = clients.length !== 0;
      if (data.has_more && empty) empty.hidden = true;
    } catch (error) {
      panelError(panel, error.message);
    }
  }

  async function loadMonitor() {
    const panel = panelEl("monitor");
    try {
      const [users, events] = await Promise.all([
        fetchJson("/cabinet/admin/api/monitor/users?page=1&page_size=50"),
        fetchJson("/cabinet/admin/api/monitor/events?page=1&page_size=50"),
      ]);
      const accounts = users.items || [];
      fillBody(
        "monitor-users-rows",
        accounts.map((user) =>
          row([
            user.id,
            user.address,
            formatTime(user.created_at),
            formatNumber(user.watches),
            formatNumber(user.sessions),
            user.telegram_linked ? formatTime(user.telegram_linked_at) : "not linked",
            formatTime(user.last_seen_at),
          ]),
        ),
      );
      toggleBlock("monitor-users-table", "monitor-users-empty", accounts.length !== 0);
      const feed = events.items || [];
      fillBody(
        "monitor-events-rows",
        feed.map((event) =>
          row([
            formatTime(event.at),
            event.user_id,
            event.chain,
            event.kind,
            event.severity,
            event.detail,
          ]),
        ),
      );
      toggleBlock("monitor-events-table", "monitor-events-empty", feed.length !== 0);
      const loading = roleEl(panel, "loading");
      if (loading) loading.hidden = true;
    } catch (error) {
      panelError(panel, error.message);
    }
  }

  function jobState(job) {
    if (job.found) return "found";
    if (job.done) return "done";
    if (job.chunks_leased > 0) return "running";
    return "queued";
  }

  async function loadJobs() {
    const panel = panelEl("jobs");
    try {
      const [jobs, workers, leases] = await Promise.all([
        fetchJson("/cabinet/admin/api/jobs?page=1&page_size=50"),
        fetchJson("/cabinet/admin/api/workers?page=1&page_size=50"),
        fetchJson("/cabinet/admin/api/leases?page=1&page_size=50"),
      ]);
      const jobRows = jobs.items || [];
      fillBody(
        "jobs-rows",
        jobRows.map((job) =>
          row([
            job.id,
            job.mode,
            job.coin,
            shortRange(job.start, job.end),
            `${formatNumber(job.chunks_done)}/${formatNumber(job.chunks_total)}`,
            formatNumber(job.scanned),
            jobState(job),
          ]),
        ),
      );
      toggleBlock("jobs-table", "jobs-empty", jobRows.length !== 0);
      const workerRows = workers.items || [];
      fillBody(
        "workers-rows",
        workerRows.map((worker) =>
          row([
            worker.id,
            worker.name,
            formatNumber(worker.scanned),
            formatNumber(worker.chunks_done),
            formatNumber(worker.found),
            formatRate(worker.rate),
            formatTime(worker.last_seen),
            worker.lease ? `${shortValue(worker.lease.job_id)} #${worker.lease.chunk_index}` : "-",
          ]),
        ),
      );
      toggleBlock("workers-table", "workers-empty", workerRows.length !== 0);
      const leaseRows = leases.items || [];
      fillBody(
        "leases-rows",
        leaseRows.map((lease) =>
          row([
            lease.client_id,
            shortValue(lease.job_id),
            formatNumber(lease.chunk_index),
            formatNumber(lease.scanned),
            formatRate(lease.rate),
            formatTime(lease.expires_at),
          ]),
        ),
      );
      toggleBlock("leases-table", "leases-empty", leaseRows.length !== 0);
      const loading = roleEl(panel, "loading");
      if (loading) loading.hidden = true;
    } catch (error) {
      panelError(panel, error.message);
    }
  }

  async function loadOrders() {
    const panel = panelEl("orders");
    try {
      const [orders, payments] = await Promise.all([
        fetchJson("/cabinet/admin/api/orders?page=1&page_size=50"),
        fetchJson("/cabinet/admin/api/payments?page=1&page_size=50"),
      ]);
      const orderRows = orders.items || [];
      fillBody(
        "orders-rows",
        orderRows.map((order) =>
          row([
            order.id,
            order.list,
            order.chain,
            order.amount,
            order.status,
            formatTime(order.created_at),
            formatTime(order.expires_at),
          ]),
        ),
      );
      toggleBlock("orders-table", "orders-empty", orderRows.length !== 0);
      const paymentRows = payments.items || [];
      fillBody(
        "payments-rows",
        paymentRows.map((payment) =>
          row([
            payment.order_id,
            payment.chain,
            shortValue(payment.txid),
            payment.amount,
            formatNumber(payment.confirmations),
            formatTime(payment.seen_at),
          ]),
        ),
      );
      toggleBlock("payments-table", "payments-empty", paymentRows.length !== 0);
      const loading = roleEl(panel, "loading");
      if (loading) loading.hidden = true;
    } catch (error) {
      panelError(panel, error.message);
    }
  }

  function configuredText(value) {
    return value ? "yes" : "no";
  }

  async function loadProviders() {
    const panel = panelEl("providers");
    const table = document.getElementById("providers-table");
    try {
      const data = await fetchJson("/cabinet/admin/api/providers");
      const tron = data.tron || {};
      const cache = tron.cache || {};
      const limiter = tron.limiter || {};
      const lastError = cache.last_error;
      const facts = [
        ["TRON provider configured", configuredText(tron.configured)],
        ["TRON mode", tron.mode || "disabled"],
        ["Cache hits", formatNumber(cache.hits)],
        ["Cache misses", formatNumber(cache.misses)],
        ["Cached provider errors served", formatNumber(cache.errors)],
        ["Cached entries", `${formatNumber(cache.entries)} / ${formatNumber(cache.capacity)}`],
        ["Limiter in flight", `${formatNumber(limiter.in_flight)} / ${formatNumber(limiter.max_in_flight)}`],
        ["Limiter waiting", `${formatNumber(limiter.waiting)} / ${formatNumber(limiter.queue_capacity)}`],
        ["Limiter waited", formatNumber(limiter.waited)],
        ["Limiter rejected", formatNumber(limiter.rejected)],
        [
          "Last provider error",
          lastError ? `${lastError.status} ${lastError.reason}` : "none",
        ],
      ];
      const watcher = data.watcher;
      if (watcher) {
        facts.push(["Watcher last success", formatTime(watcher.last_ok_at)]);
        facts.push(["Watcher last error", formatTime(watcher.last_error_at)]);
        facts.push(["Watcher error detail", watcher.last_error || "none"]);
      }
      fillBody("providers-rows", facts.map(([label, value]) => row([label, value])));
      if (table) table.hidden = false;
      const loading = roleEl(panel, "loading");
      if (loading) loading.hidden = true;
    } catch (error) {
      panelError(panel, error.message);
    }
  }

  async function loadIntegrations() {
    const panel = panelEl("integrations");
    const table = document.getElementById("integrations-table");
    try {
      const data = await fetchJson("/cabinet/admin/api/integrations");
      const integrations = data.integrations || {};
      const telegram = integrations.telegram || {};
      const tronscan = integrations.tronscan || {};
      const orders = integrations.orders || {};
      const walletconnect = integrations.walletconnect || {};
      const rows = [
        [
          "Telegram",
          configuredText(telegram.configured),
          telegram.configured
            ? `${telegram.public_value || "bot"} - webhook secret ${configuredText(telegram.webhook_secret_stored)}; registration result not stored`
            : "bot token or username is not set",
        ],
        [
          "TronScan",
          configuredText(tronscan.configured),
          `${tronscan.mode || "disabled"}; cache hits ${formatNumber(tronscan.counters?.cache?.hits)}, limiter rejected ${formatNumber(tronscan.counters?.limiter?.rejected)}`,
        ],
        [
          "Orders",
          configuredText(orders.configured),
          orders.configured
            ? `${formatNumber(orders.summary?.active_lists)} active list(s) of ${formatNumber(orders.summary?.lists)}; poll ${formatNumber(orders.summary?.poll_interval_secs)}s`
            : "orders config is not set",
        ],
        ["WalletConnect", configuredText(walletconnect.configured), "Reown project id"],
      ];
      fillBody("integrations-rows", rows.map((cells) => row(cells)));
      if (table) table.hidden = false;
      const loading = roleEl(panel, "loading");
      if (loading) loading.hidden = true;
    } catch (error) {
      panelError(panel, error.message);
    }
  }

  async function loadAudit() {
    const panel = panelEl("audit");
    try {
      const data = await fetchJson("/cabinet/admin/api/audit?page=1&page_size=50");
      const empty = document.getElementById("audit-empty");
      if (empty) {
        setText("audit-empty-note", data.detail || "No audit entries exist yet.");
        empty.hidden = (data.items || []).length !== 0;
      }
      const loading = roleEl(panel, "loading");
      if (loading) loading.hidden = true;
    } catch (error) {
      panelError(panel, error.message);
    }
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError(loginError, "");
    if (loginSubmit) loginSubmit.disabled = true;
    try {
      const token = tokenInput?.value || "";
      const credentials =
        token.trim() !== ""
          ? { token }
          : { user: userInput?.value || "", password: passwordInput?.value || "" };
      const response = await fetch("/cabinet/admin/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });
      if (tokenInput) tokenInput.value = "";
      if (passwordInput) passwordInput.value = "";
      if (response.status === 429) {
        showLogin("Too many failed attempts. Try again in 15 minutes.");
        return;
      }
      if (!response.ok) {
        showLogin("That login was not accepted.");
        return;
      }
      window.location.assign("/cabinet/admin");
    } catch {
      showLogin("The coordinator could not be reached.");
    } finally {
      if (loginSubmit) loginSubmit.disabled = false;
    }
  });

  logoutButton?.addEventListener("click", async () => {
    try {
      await fetch("/cabinet/admin/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": csrfToken() },
      });
    } finally {
      window.location.assign("/cabinet/admin/login");
    }
  });

  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/cabinet/admin/login") {
    showLogin("");
    return;
  }

  const active =
    Object.keys(PANEL_ROUTES).find((name) => PANEL_ROUTES[name] === pathname) || "overview";
  for (const link of document.querySelectorAll("[data-panel-link]")) {
    if (link.getAttribute("data-panel-link") === active) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
  const activePanel = panelEl(active);
  if (activePanel) activePanel.hidden = false;
  showDashboard();
  (PANEL_LOADERS[active] || loadOverview)().catch((error) => {
    panelError(activePanel, error.message || "Could not load this panel.");
  });
})();
