/* Theme for the internal site-map docs page: follows the OS until the visitor
 * picks light or dark. Self-contained: no /theme.js, no build step. */
(function () {
  'use strict';

  var STORAGE_KEY = 'rotor-theme';
  var ICONS = 'icons.svg#';
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
    if (use) use.setAttribute('href', ICONS + (toLight ? 'ui-sun' : 'ui-moon'));
    var label = toLight ? 'Switch to light theme' : 'Switch to dark theme';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.setAttribute('aria-pressed', String(theme === 'light'));
  }

  apply(effective());

  function bindToggle() {
    var button = document.querySelector('[data-theme-toggle]');
    if (!button) return;
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindToggle);
  else bindToggle();

  if (window.matchMedia) {
    var query = window.matchMedia('(prefers-color-scheme: light)');
    var onChange = function () {
      if (!readChoice()) apply(systemTheme());
    };
    if (query.addEventListener) query.addEventListener('change', onChange);
    else if (query.addListener) query.addListener(onChange);
  }
})();
