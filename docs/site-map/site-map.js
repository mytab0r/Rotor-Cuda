/* Internal docs site-map renderer. Data lives in site-map-data.js; this file
 * only builds DOM nodes, applies filters and copies paths. No innerHTML with
 * data. Runnable from docs/site-map/ directly: icons, data and links resolve
 * relative to this directory, and route links point at the live site. */
(function () {
  'use strict';

  var data = window.RotorSiteMapData;
  var AREA_LABELS = {
    site: 'Site',
    directory: 'Directory',
    key: 'Key explorer',
    seeds: 'Seeds',
    puzzle: 'Puzzle',
    brainwallet: 'Brainwallet',
    tools: 'Tools',
    wallet: 'Wallet & account'
  };
  var STATUS_LABELS = {
    parity: 'Parity',
    partial: 'Partial',
    missing: 'Missing',
    'ours-only': 'Ours only'
  };
  var PRESENCE_STATUS = {
    present: 'parity',
    partial: 'partial',
    missing: 'missing'
  };
  var SOURCE_ORIGINS = {
    pkf: 'https://ref-site-a',
    ss: 'https://ref-site-b'
  };
  var SOURCE_LABELS = {
    pkf: 'ref-site-a',
    ss: 'ref-site-b'
  };
  /* The docs page is not served by the coordinator, so internal route links
   * open the live site rather than a path relative to this file. */
  var SITE_ORIGIN = 'https://rotor.pxbt.app';

  var state = {
    view: 'ours',
    query: '',
    area: '',
    status: ''
  };

  var nodes = {};
  var donorById = {};

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function icon(name, className) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className || 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', 'icons.svg#' + name);
    svg.appendChild(use);
    return svg;
  }

  function areaLabel(area) {
    return AREA_LABELS[area] || area;
  }

  function statusBadge(status, text) {
    var badge = el('span', 'sitemap-status', text || STATUS_LABELS[status] || status);
    badge.setAttribute('data-status', status);
    return badge;
  }

  function presenceBadge(value) {
    return statusBadge(PRESENCE_STATUS[value] || 'missing', value);
  }

  function sourceLabel(id) {
    return SOURCE_LABELS[String(id).split(':')[0]] || String(id).split(':')[0];
  }

  function donorHref(donor) {
    var path = donor.href || donor.path;
    return SOURCE_ORIGINS[donor.source] + encodeURI(path);
  }

  function routeHref(route) {
    var path = route.href || route.path;
    return /^https?:\/\//i.test(path) ? path : SITE_ORIGIN + encodeURI(path);
  }

  function donorFor(id) {
    return donorById[id] || null;
  }

  function unique(values) {
    var seen = {};
    return values.filter(function (value) {
      if (seen[value]) return false;
      seen[value] = true;
      return true;
    });
  }

  function matches(value, needle) {
    return String(value || '').toLowerCase().indexOf(needle) !== -1;
  }

  function matchesFilters(entry, haystack) {
    if (state.area && entry.area !== state.area) return false;
    if (state.status && entry.status !== state.status) return false;
    return !state.query || matches(haystack, state.query);
  }

  function oursHaystack(route) {
    var donorNames = route.donorIds.map(function (id) {
      var donor = donorFor(id);
      return donor ? sourceLabel(donor.source) + ' ' + donor.title + ' ' + donor.path : id;
    });
    return [
      route.path,
      route.title,
      areaLabel(route.area),
      route.note,
      route.donorIds.join(' '),
      donorNames.join(' ')
    ].join(' ');
  }

  function donorHaystack(donor) {
    return [
      sourceLabel(donor.source),
      donor.path,
      donor.title,
      areaLabel(donor.area),
      donor.note,
      donor.ours || ''
    ].join(' ');
  }

  function featureHaystack(item) {
    return [
      item.capability,
      areaLabel(item.area),
      item.note,
      item.status,
      item.donor,
      item.rotor,
      (item.sources || []).join(' ')
    ].join(' ');
  }

  /* ------------------------------------------------------------------ summary */

  function buildSummary() {
    var host = nodes.summary;
    clear(host);
    if (!data) return;

    var ours = data.ours;
    var missing = data.donors.filter(function (donor) { return donor.status === 'missing'; });
    var rows = [
      { label: 'Our routes', value: ours.length },
      { label: 'Donor routes', value: data.donors.length },
      { label: 'Parity', value: ours.filter(function (r) { return r.status === 'parity'; }).length, tone: 'ok' },
      { label: 'Partial', value: ours.filter(function (r) { return r.status === 'partial'; }).length, tone: 'warn' },
      { label: 'Missing', value: missing.length, tone: 'err' },
      { label: 'Ours only', value: ours.filter(function (r) { return r.status === 'ours-only'; }).length, tone: 'accent' },
      { label: 'Features', value: data.features.length }
    ];

    rows.forEach(function (row) {
      var card = el('div', 'sitemap-stat');
      if (row.tone) card.setAttribute('data-tone', row.tone);
      card.appendChild(el('b', '', row.value.toLocaleString()));
      card.appendChild(el('span', '', row.label));
      host.appendChild(card);
    });
  }

  /* --------------------------------------------------------------------- rows */

  function actionLink(href, label, iconName, external) {
    var link = el('a', 'sitemap-action');
    link.href = href;
    link.setAttribute('aria-label', label);
    link.title = label;
    if (external) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    link.appendChild(icon(iconName));
    return link;
  }

  function metaItem(text) {
    return el('span', 'sitemap-pill', text);
  }

  function rowShell(title, titleHref, external, path, note, meta, actions, status) {
    var row = el('div', 'sitemap-row');
    row.setAttribute('role', 'listitem');

    var main = el('div', 'sitemap-row-main');
    var titleLink = el('a', 'sitemap-row-title');
    titleLink.href = titleHref;
    if (external) {
      titleLink.target = '_blank';
      titleLink.rel = 'noopener noreferrer';
      titleLink.appendChild(document.createTextNode(title + ' '));
      titleLink.appendChild(icon('ui-external', 'icon'));
      titleLink.appendChild(el('span', 'visually-hidden', ' (opens in a new tab)'));
    } else {
      titleLink.appendChild(document.createTextNode(title + ' '));
      titleLink.appendChild(icon('ui-arrow-right', 'icon'));
    }
    main.appendChild(titleLink);
    main.appendChild(el('code', 'sitemap-row-path', path));
    if (note) main.appendChild(el('p', 'sitemap-row-note', note));
    row.appendChild(main);

    var metaWrap = el('div', 'sitemap-row-meta');
    meta.forEach(function (item) { metaWrap.appendChild(item); });
    metaWrap.appendChild(statusBadge(status));
    row.appendChild(metaWrap);

    var actionWrap = el('div', 'sitemap-row-actions');
    actions.forEach(function (action) { actionWrap.appendChild(action); });
    row.appendChild(actionWrap);
    return row;
  }

  function routeRow(route) {
    var href = routeHref(route);
    var meta = [metaItem(areaLabel(route.area))];
    if (route.priority && route.priority !== '-') meta.push(metaItem(route.priority));
    if (route.donorIds.length) {
      meta.push(metaItem(unique(route.donorIds.map(sourceLabel)).join(' · ')));
    } else {
      meta.push(metaItem('No donor route'));
    }
    return rowShell(
      route.title,
      href,
      false,
      route.path,
      route.note,
      meta,
      [
        actionLink(href, 'Open ' + route.path, 'ui-arrow-right', false),
        copyButton(route.path)
      ],
      route.status
    );
  }

  function donorRow(donor) {
    var href = donorHref(donor);
    var meta = [
      metaItem(SOURCE_LABELS[donor.source] || donor.source),
      metaItem(areaLabel(donor.area))
    ];
    if (donor.priority && donor.priority !== '-') meta.push(metaItem(donor.priority));
    meta.push(metaItem(donor.ours ? 'Crypto: ' + donor.ours : 'No Crypto route'));
    return rowShell(
      donor.title,
      href,
      true,
      donor.path,
      donor.note,
      meta,
      [
        actionLink(href, 'Open ' + donor.path + ' on ' + (SOURCE_LABELS[donor.source] || donor.source), 'ui-external', true),
        copyButton(donor.path)
      ],
      donor.status
    );
  }

  function renderRows(host, empty, items, builder) {
    clear(host);
    items.forEach(function (item) { host.appendChild(builder(item)); });
    empty.hidden = items.length > 0;
  }

  /* -------------------------------------------------------------------- table */

  function copyButton(path) {
    var button = el('button', 'sitemap-copy');
    button.type = 'button';
    button.setAttribute('aria-label', 'Copy ' + path);
    button.title = 'Copy ' + path;
    button.appendChild(icon('ui-copy'));
    button.addEventListener('click', function () {
      copyText(path, button);
    });
    return button;
  }

  function copyText(text, button) {
    function finish(ok) {
      button.setAttribute(ok ? 'data-copied' : 'data-error', 'true');
      button.setAttribute('aria-label', ok ? 'Copied ' + text : 'Copy failed');
      window.setTimeout(function () {
        button.removeAttribute('data-copied');
        button.removeAttribute('data-error');
        button.setAttribute('aria-label', 'Copy ' + text);
      }, 1400);
    }

    function fallback() {
      var area = el('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var copied = false;
      try {
        copied = document.execCommand('copy');
      } catch (err) {
        copied = false;
      }
      document.body.removeChild(area);
      finish(copied);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        finish(true);
      }, fallback);
    } else {
      fallback();
    }
  }

  function pairRow(route) {
    var href = routeHref(route);
    var donorText = route.donorIds.map(function (id) {
      var donor = donorFor(id);
      return donor ? SOURCE_LABELS[donor.source] + ' ' + donor.path : id;
    }).join(' · ');
    var note = route.note || '';
    if (donorText) note = (note ? note + ' ' : '') + 'Donor: ' + donorText + '.';

    var meta = [metaItem(areaLabel(route.area))];
    if (route.priority && route.priority !== '-') meta.push(metaItem(route.priority));
    meta.push(metaItem(route.donorIds.length
      ? unique(route.donorIds.map(sourceLabel)).join(' · ')
      : 'No donor route'));

    var actions = [
      actionLink(href, 'Open ' + route.path, 'ui-arrow-right', false),
      copyButton(route.path)
    ];
    var firstDonor = route.donorIds.length ? donorFor(route.donorIds[0]) : null;
    if (firstDonor) {
      actions.push(actionLink(donorHref(firstDonor), 'Open donor ' + firstDonor.path, 'ui-external', true));
    }
    return rowShell(route.title, href, false, route.path, note, meta, actions, route.status);
  }

  function featureRow(item) {
    var row = document.createElement('tr');
    row.appendChild(el('td', '', item.capability));
    row.appendChild(el('td', '', areaLabel(item.area)));

    var donorCell = document.createElement('td');
    donorCell.appendChild(presenceBadge(item.donor));
    donorCell.appendChild(el('div', 'sitemap-source', (item.sources || []).join(' · ') || 'none'));
    row.appendChild(donorCell);

    var rotorCell = document.createElement('td');
    rotorCell.appendChild(presenceBadge(item.rotor));
    row.appendChild(rotorCell);

    var statusCell = document.createElement('td');
    statusCell.appendChild(statusBadge(item.status));
    row.appendChild(statusCell);

    row.appendChild(el('td', '', item.priority || '-'));
    row.appendChild(el('td', 'sitemap-cell-note', item.note || ''));
    return row;
  }

  function renderTables() {
    var pairs = data.ours.filter(function (route) {
      return matchesFilters(route, oursHaystack(route));
    });
    var features = data.features.filter(function (item) {
      return matchesFilters(item, featureHaystack(item));
    });

    clear(nodes.pairsBody);
    pairs.forEach(function (route) { nodes.pairsBody.appendChild(pairRow(route)); });
    nodes.pairsEmpty.hidden = pairs.length > 0;

    clear(nodes.featuresBody);
    features.forEach(function (item) { nodes.featuresBody.appendChild(featureRow(item)); });
    nodes.featuresEmpty.hidden = features.length > 0;

    return { pairs: pairs.length, features: features.length };
  }

  /* ------------------------------------------------------------------- render */

  function render() {
    if (!data) {
      nodes.count.textContent = 'Site map data did not load.';
      return;
    }

    var ours = data.ours.filter(function (route) {
      return matchesFilters(route, oursHaystack(route));
    });
    var donors = data.donors.filter(function (donor) {
      return matchesFilters(donor, donorHaystack(donor));
    });
    var tables = renderTables();

    renderRows(nodes.oursGrid, nodes.oursEmpty, ours, routeRow);
    renderRows(nodes.donorsGrid, nodes.donorsEmpty, donors, donorRow);

    if (state.view === 'ours') {
      nodes.count.textContent = 'Showing ' + ours.length + ' of ' + data.ours.length + ' Crypto routes.';
    } else if (state.view === 'donors') {
      nodes.count.textContent = 'Showing ' + donors.length + ' of ' + data.donors.length + ' donor routes.';
    } else {
      nodes.count.textContent = 'Showing ' + tables.pairs + ' of ' + data.ours.length +
        ' mapped pairs and ' + tables.features + ' of ' + data.features.length + ' features.';
    }
  }

  function setView(view) {
    state.view = view;
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', '#' + view);
    }
    nodes.viewButtons.forEach(function (button) {
      var active = button.getAttribute('data-view') === view;
      button.setAttribute('aria-pressed', String(active));
    });
    [
      ['ours', nodes.viewOurs],
      ['donors', nodes.viewDonors],
      ['matrix', nodes.viewMatrix]
    ].forEach(function (pair) {
      pair[1].hidden = pair[0] !== view;
    });
    render();
  }

  function fillAreas() {
    var areas = unique(data.ours.concat(data.donors).concat(data.features).map(function (entry) {
      return entry.area;
    })).filter(Boolean).sort(function (a, b) {
      return areaLabel(a).localeCompare(areaLabel(b));
    });
    areas.forEach(function (area) {
      var option = el('option', '', areaLabel(area));
      option.value = area;
      nodes.area.appendChild(option);
    });
  }

  function bind() {
    nodes.query.addEventListener('input', function () {
      state.query = nodes.query.value.trim().toLowerCase();
      render();
    });
    nodes.area.addEventListener('change', function () {
      state.area = nodes.area.value;
      render();
    });
    nodes.status.addEventListener('change', function () {
      state.status = nodes.status.value;
      render();
    });
    nodes.viewButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        setView(button.getAttribute('data-view'));
      });
    });
    window.addEventListener('hashchange', function () {
      var view = String(window.location.hash || '').replace('#', '');
      if (['ours', 'donors', 'matrix'].indexOf(view) >= 0 && view !== state.view) {
        setView(view);
      }
    });
  }

  function fail(message) {
    [nodes.oursGrid, nodes.donorsGrid].forEach(function (host) {
      clear(host);
      host.appendChild(el('p', 'sitemap-empty', message));
    });
    nodes.count.textContent = message;
  }

  function start() {
    nodes.summary = document.getElementById('sitemap-summary');
    nodes.query = document.getElementById('sitemap-query');
    nodes.area = document.getElementById('sitemap-area');
    nodes.status = document.getElementById('sitemap-status');
    nodes.count = document.getElementById('sitemap-count');
    nodes.oursGrid = document.getElementById('ours-grid');
    nodes.oursEmpty = document.getElementById('ours-empty');
    nodes.donorsGrid = document.getElementById('donors-grid');
    nodes.donorsEmpty = document.getElementById('donors-empty');
    nodes.pairsBody = document.getElementById('pairs-body');
    nodes.pairsEmpty = document.getElementById('pairs-empty');
    nodes.featuresBody = document.getElementById('features-body');
    nodes.featuresEmpty = document.getElementById('features-empty');
    nodes.viewOurs = document.getElementById('view-ours');
    nodes.viewDonors = document.getElementById('view-donors');
    nodes.viewMatrix = document.getElementById('view-matrix');
    nodes.viewButtons = Array.prototype.slice.call(document.querySelectorAll('.sitemap-view-btn'));

    if (!nodes.summary || !nodes.query || !nodes.oursGrid) return;

    if (!data || !Array.isArray(data.ours) || !Array.isArray(data.donors) || !Array.isArray(data.features)) {
      fail('Site map data is missing or malformed. Reload the page.');
      return;
    }

    data.donors.forEach(function (donor) { donorById[donor.id] = donor; });
    var hashView = String(window.location.hash || '').replace('#', '');
    if (['ours', 'donors', 'matrix'].indexOf(hashView) >= 0) state.view = hashView;
    buildSummary();
    fillAreas();
    bind();
    setView(state.view);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
