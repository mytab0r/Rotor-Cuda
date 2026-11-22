// Operator cabinet client. The token is read from the password field, sent
// once in the login JSON, and cleared; only the non-HttpOnly CSRF cookie is
// read afterwards. Nothing here is inlined into the page.
(() => {
  "use strict";

  const CSRF_COOKIE = "rotor_admin_csrf";
  const JOB_STATES = ["running", "queued", "done", "found"];

  const loginCard = document.getElementById("login-card");
  const dashboard = document.getElementById("dashboard");
  const form = document.getElementById("login-form");
  const tokenInput = document.getElementById("admin-token");
  const loginError = document.getElementById("login-error");
  const loginSubmit = document.getElementById("login-submit");
  const dashboardError = document.getElementById("dashboard-error");
  const dashboardUpdated = document.getElementById("dashboard-updated");
  const logoutButton = document.getElementById("admin-logout");
  const jobStates = document.getElementById("job-states");

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

  function showLoadingDashboard() {
    if (loginCard) loginCard.hidden = true;
    if (dashboard) dashboard.hidden = false;
    if (logoutButton) logoutButton.hidden = false;
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

  function formatUptime(seconds) {
    const total = Number(seconds) || 0;
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function renderJobStates(jobs) {
    if (!jobStates) return;
    jobStates.replaceChildren();
    for (const state of JOB_STATES) {
      const row = document.createElement("tr");
      const label = document.createElement("td");
      label.textContent = state;
      const count = document.createElement("td");
      count.textContent = Number(jobs[state] || 0).toLocaleString("en-US");
      row.append(label, count);
      jobStates.append(row);
    }
  }

  function render(data) {
    showLoadingDashboard();
    setError(dashboardError, "");
    setText("stat-build", data.build_id || "-");
    setText("stat-uptime", formatUptime(data.uptime_secs));
    setText("stat-clients", Number(data.clients?.registered || 0).toLocaleString("en-US"));
    setText("stat-leases", Number(data.leases?.active || 0).toLocaleString("en-US"));
    renderJobStates(data.jobs || {});
    if (dashboardUpdated) {
      dashboardUpdated.textContent = `Jobs: ${Number(data.jobs?.total || 0).toLocaleString("en-US")}. Refreshed ${new Date().toLocaleTimeString()}.`;
    }
  }

  async function loadOverview() {
    const response = await fetch("/cabinet/admin/api/overview", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (response.status === 401) {
      showLogin("Session expired. Sign in again.");
      return;
    }
    if (!response.ok) throw new Error(`overview failed: ${response.status}`);
    render(await response.json());
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError(loginError, "");
    if (loginSubmit) loginSubmit.disabled = true;
    try {
      const response = await fetch("/cabinet/admin/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenInput?.value || "" }),
      });
      if (tokenInput) tokenInput.value = "";
      if (response.status === 429) {
        showLogin("Too many failed attempts. Try again in 15 minutes.");
        return;
      }
      if (!response.ok) {
        showLogin("That token was not accepted.");
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

  const isLoginPage =
    window.location.pathname.replace(/\/+$/, "") === "/cabinet/admin/login";
  if (isLoginPage) {
    showLogin("");
  } else {
    showLoadingDashboard();
    loadOverview().catch((error) => {
      showLogin("Could not load the dashboard.");
      setError(dashboardError, error.message);
    });
  }
})();
