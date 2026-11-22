/* Public job board. Polls /api/v1/jobs/public and renders a compact table.
 * Server strings are written with textContent only: no innerHTML anywhere.
 * Host page contract:
 *   [data-puzzle-jobs]    container (a div, not a tbody) for the table
 *   [data-puzzle-summary] optional container for the summary stat tiles
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/v1/jobs/public';
  var REFRESH_MS = 5000;
  var TIMEOUT_MS = 8000;

  function num(value) {
    var parsed = typeof value === 'number' ? value : Number(value);
    return isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function child(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function formatNumber(value) {
    return num(value).toLocaleString('en-US');
  }

  function jobsFrom(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.jobs)) return data.jobs;
    if (data && data.data && Array.isArray(data.data.jobs)) return data.data.jobs;
    return null;
  }

  function chunksDone(job) {
    if (job.chunks_done !== undefined) return num(job.chunks_done);
    if (job.chunksDone !== undefined) return num(job.chunksDone);
    return num(job.done);
  }

  function chunksTotal(job) {
    if (job.chunks_total !== undefined) return num(job.chunks_total);
    if (job.chunksTotal !== undefined) return num(job.chunksTotal);
    return num(job.chunks);
  }

  function statusOf(job) {
    var explicit = typeof job.status === 'string' ? job.status.toLowerCase() : '';
    if (job.found || explicit === 'found') return 'found';
    if (explicit === 'done') return 'done';
    var total = chunksTotal(job);
    if (total > 0 && chunksDone(job) >= total) return 'done';
    return 'running';
  }

  function shortId(job) {
    var id = job.id === undefined || job.id === null ? '' : String(job.id);
    if (!id) return '—';
    return id.length > 10 ? id.slice(0, 8) + '…' : id;
  }

  function percent(done, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  }

  function coinMode(job) {
    var coin = job.coin === undefined || job.coin === null ? '' : String(job.coin);
    var mode = job.mode === undefined || job.mode === null ? '' : String(job.mode);
    if (coin && mode) return coin + ' · ' + mode;
    return coin || mode || '—';
  }

  function emptyState(element) {
    clear(element);
    element.appendChild(child('p', 'puzzle-state', 'No public jobs yet. Start a client to create one.'));
  }

  function errorState(element, message) {
    clear(element);
    element.appendChild(child('p', 'puzzle-state err', message + ' Retrying every 5 s.'));
  }

  function renderSummary(element, jobs) {
    if (!jobs.length) {
      emptyState(element);
      return;
    }
    var running = 0;
    var found = 0;
    var done = 0;
    var scanned = 0;
    jobs.forEach(function (job) {
      var status = statusOf(job);
      if (status === 'running') running += 1;
      else if (status === 'found') found += 1;
      else done += 1;
      scanned += num(job.scanned);
    });

    clear(element);
    var grid = child('div', 'stat-grid puzzle-stat-grid');
    [
      ['Public jobs', formatNumber(jobs.length)],
      ['Running', formatNumber(running)],
      ['Found', formatNumber(found)],
      ['Keys scanned', formatNumber(scanned)]
    ].forEach(function (item) {
      var stat = child('div', 'stat');
      stat.appendChild(child('span', 'stat-label', item[0]));
      stat.appendChild(child('span', 'stat-value small', item[1]));
      grid.appendChild(stat);
    });
    element.appendChild(grid);
    element.appendChild(child('p', 'muted puzzle-updated', 'Done: ' + formatNumber(done) + ' jobs · refreshed every 5 s.'));
  }

  function renderJobs(element, jobs) {
    if (!jobs.length) {
      emptyState(element);
      return;
    }

    var wrap = child('div', 'table-scroll');
    var table = child('table', 'data-table puzzle-table');
    var thead = child('thead');
    var headRow = child('tr');
    ['Job', 'Coin / mode', 'Progress', 'Scanned', 'Status'].forEach(function (label) {
      headRow.appendChild(child('th', null, label));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = child('tbody');
    jobs.forEach(function (job) {
      var status = statusOf(job);
      var done = chunksDone(job);
      var total = chunksTotal(job);
      var row = child('tr', 'puzzle-row-' + status);

      row.appendChild(child('td', 'mono', shortId(job)));
      row.appendChild(child('td', null, coinMode(job)));

      var progressCell = child('td', 'puzzle-progress-cell');
      var progress = child('div', 'progress');
      var bar = child('span', 'bar');
      bar.style.width = percent(done, total) + '%';
      progress.appendChild(bar);
      progressCell.appendChild(progress);
      progressCell.appendChild(child('span', 'puzzle-progress-text mono',
        formatNumber(done) + ' / ' + formatNumber(total)));
      row.appendChild(progressCell);

      row.appendChild(child('td', 'puzzle-scanned mono', formatNumber(job.scanned)));

      var statusCell = child('td');
      statusCell.appendChild(child('span', 'puzzle-status puzzle-status-' + status, status));
      row.appendChild(statusCell);
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    clear(element);
    element.appendChild(wrap);
  }

  function init() {
    var summaryEl = document.querySelector('[data-puzzle-summary]');
    var jobsEl = document.querySelector('[data-puzzle-jobs]');
    if (!summaryEl && !jobsEl) return;

    var loading = false;
    var started = false;
    var timer = null;

    function render(data) {
      var jobs = jobsFrom(data);
      if (!jobs) throw new Error('unexpected response');
      if (summaryEl) renderSummary(summaryEl, jobs);
      if (jobsEl) renderJobs(jobsEl, jobs);
      started = true;
    }

    function renderLoading() {
      if (summaryEl && !summaryEl.firstChild) {
        summaryEl.appendChild(child('p', 'muted', 'Loading public jobs…'));
      }
      if (jobsEl && !jobsEl.firstChild) {
        jobsEl.appendChild(child('p', 'puzzle-state', 'Loading public jobs…'));
      }
    }

    async function load() {
      if (loading) return;
      loading = true;
      if (!started) renderLoading();

      var controller = new AbortController();
      var timeout = window.setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
      try {
        var response = await fetch(ENDPOINT, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          credentials: 'omit',
          signal: controller.signal
        });
        var data = null;
        try { data = await response.json(); } catch (err) { data = null; }
        if (!response.ok) {
          var detail = data && data.error ? String(data.error) : 'HTTP ' + response.status;
          throw new Error(detail);
        }
        render(data);
      } catch (err) {
        var message = err && err.name === 'AbortError'
          ? 'Job feed timed out.'
          : 'Job feed unavailable: ' + (err && err.message ? err.message : 'unknown error') + '.';
        if (summaryEl) errorState(summaryEl, message);
        if (jobsEl) errorState(jobsEl, message);
        started = true;
      } finally {
        window.clearTimeout(timeout);
        loading = false;
      }
    }

    load();
    timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener('pagehide', function () {
      if (timer !== null) window.clearInterval(timer);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
