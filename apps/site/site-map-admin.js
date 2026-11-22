// Operator route map. Reads data/routes.json through the admin API and builds
// the table with DOM nodes only: route values never reach innerHTML.
(() => {
  "use strict";

  const ENDPOINT = "/cabinet/admin/api/site-map";
  const STATUS_TONE = {
    live: "status--low",
    planned: "status--medium",
    legacy: "",
  };

  const queryInput = document.getElementById("map-query");
  const familySelect = document.getElementById("map-family");
  const rendererSelect = document.getElementById("map-renderer");
  const authSelect = document.getElementById("map-auth");
  const statusSelect = document.getElementById("map-status");
  const summary = document.getElementById("map-summary");
  const errorBox = document.getElementById("map-error");
  const emptyState = document.getElementById("map-empty");
  const tableWrap = document.getElementById("map-table-wrap");
  const rowsBody = document.getElementById("map-rows");

  let routes = [];

  function normalize(value) {
    return String(value == null ? "" : value).toLowerCase();
  }

  function showError(message) {
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
    if (tableWrap) tableWrap.hidden = true;
    if (emptyState) emptyState.hidden = true;
    if (summary) summary.textContent = "Route map unavailable.";
  }

  function cell(text, className) {
    const td = document.createElement("td");
    if (className) td.className = className;
    td.textContent = text;
    return td;
  }

  function patternCell(route) {
    const td = document.createElement("td");
    const code = document.createElement("code");
    code.className = "mono";
    code.textContent = route.pattern;
    td.append(code);
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = `${route.family} · ${route.notes}`;
    td.append(meta);
    return td;
  }

  function statusCell(route) {
    const td = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = `status ${STATUS_TONE[route.status] || ""}`.trim();
    pill.textContent = route.status;
    td.append(pill);
    return td;
  }

  function matches(route) {
    if (familySelect && familySelect.value && route.family !== familySelect.value) return false;
    if (rendererSelect && rendererSelect.value && route.renderer !== rendererSelect.value) return false;
    if (authSelect && authSelect.value && route.auth !== authSelect.value) return false;
    if (statusSelect && statusSelect.value && route.status !== statusSelect.value) return false;
    const query = queryInput ? normalize(queryInput.value.trim()) : "";
    if (!query) return true;
    const haystack = [
      route.pattern,
      route.family,
      route.template,
      route.renderer,
      route.auth,
      route.status,
      route.notes,
      (route.data_sources || []).join(" "),
    ]
      .map(normalize)
      .join(" ");
    return haystack.includes(query);
  }

  function render() {
    if (!rowsBody) return;
    const visible = routes.filter(matches);
    rowsBody.replaceChildren();
    for (const route of visible) {
      const row = document.createElement("tr");
      row.append(
        patternCell(route),
        cell(route.template, "mono"),
        cell(route.renderer, "mono"),
        cell((route.data_sources || []).join(", "), "mono"),
        cell(route.auth),
        statusCell(route),
      );
      rowsBody.append(row);
    }
    if (tableWrap) tableWrap.hidden = visible.length === 0;
    if (emptyState) emptyState.hidden = visible.length !== 0;
    if (summary) {
      summary.textContent =
        `Showing ${visible.length} of ${routes.length} route families. ` +
        "Static assets are not enumerated; this map covers pages, redirects, admin surfaces and API families.";
    }
  }

  function fillFamilies() {
    if (!familySelect) return;
    const families = [...new Set(routes.map((route) => route.family))].sort((a, b) =>
      a.localeCompare(b),
    );
    for (const family of families) {
      const option = document.createElement("option");
      option.value = family;
      option.textContent = family;
      familySelect.append(option);
    }
  }

  for (const control of [queryInput, familySelect, rendererSelect, authSelect, statusSelect]) {
    if (!control) continue;
    control.addEventListener(control.tagName === "INPUT" ? "input" : "change", render);
  }

  fetch(ENDPOINT, { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then((response) => {
      if (response.status === 401) throw new Error("Session expired. Reload the cabinet and sign in again.");
      if (!response.ok) throw new Error(`Route map request failed (${response.status}).`);
      return response.json();
    })
    .then((data) => {
      if (!data || !Array.isArray(data.routes)) throw new Error("Route map payload has no routes array.");
      routes = data.routes;
      fillFamilies();
      if (errorBox) errorBox.hidden = true;
      render();
    })
    .catch((error) => {
      showError(error && error.message ? error.message : "Cannot load the route map.");
    });
})();
