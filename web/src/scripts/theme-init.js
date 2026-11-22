/* Blocking theme bootstrap, loaded from <head>.
 *
 * It runs before the first paint so the stored choice wins without a flash of
 * the wrong theme, and it marks the document as script-enabled so the mobile
 * navigation can collapse into the menu island. With scripts disabled the
 * class is absent and every nav link stays visible. */
(function () {
  'use strict';

  var root = document.documentElement;
  root.className += (root.className ? ' ' : '') + 'js';

  /* The shared layout stamps the key on <html> at build time, so the
   * storage name has one source (`src/lib/site.ts`). */
  var STORAGE_KEY = root.getAttribute('data-theme-key') || '';
  var choice = '';
  if (STORAGE_KEY) {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') choice = stored;
    } catch (err) {
      /* private mode: follow the OS for this page */
    }
  }

  var system = 'dark';
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      system = 'light';
    }
  } catch (err) {
    /* no matchMedia: keep the dark default */
  }

  var theme = choice || system;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
})();
