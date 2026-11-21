/* Theme: follows the OS until the visitor picks light or dark. No build step,
 * no deps. Loaded from <head> so the first paint already has the right theme;
 * the toggle button is injected into the shared header when the DOM is ready. */
(function () {
  'use strict';

  var STORAGE_KEY = 'rotor-theme';
  var root = document.documentElement;

  function readChoice() {
    try {
      var value = localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : '';
    } catch (err) {
      return '';
    }
  }

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function effective() {
    return readChoice() || systemTheme();
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
    var button = document.querySelector('[data-theme-toggle]');
    if (!button) return;
    var use = button.querySelector('use');
    var toLight = theme !== 'light';
    if (use) use.setAttribute('href', toLight ? '/icons.svg#ui-sun' : '/icons.svg#ui-moon');
    var label = toLight ? 'Switch to light theme' : 'Switch to dark theme';
    button.setAttribute('aria-label', label);
    button.setAttribute('data-tooltip', label);
    button.setAttribute('aria-pressed', String(theme === 'light'));
  }

  /* Apply before the body renders to avoid a flash of the wrong theme. */
  apply(effective());

  function buildToggle() {
    var tools = document.querySelector('.nav-tools');
    if (!tools || tools.querySelector('[data-theme-toggle]')) return;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button icon-button--quiet icon-button--lg theme-toggle';
    button.setAttribute('data-theme-toggle', '');
    button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="/icons.svg#ui-moon"></use></svg>';
    var search = tools.querySelector('[data-nav="search"]');
    if (search && search.parentNode === tools) tools.insertBefore(button, search.nextSibling);
    else tools.insertBefore(button, tools.firstChild);
    button.addEventListener('click', function () {
      var next = effective() === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch (err) {
        /* private mode: the choice lasts for this page only */
      }
      apply(next);
    });
    apply(effective());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildToggle);
  else buildToggle();

  /* A stored choice wins; otherwise follow live OS changes. */
  if (window.matchMedia) {
    var query = window.matchMedia('(prefers-color-scheme: light)');
    var onChange = function () {
      if (!readChoice()) apply(systemTheme());
    };
    if (query.addEventListener) query.addEventListener('change', onChange);
    else if (query.addListener) query.addListener(onChange);
  }
})();
