/* The only two behaviour islands on the shared layout: the theme toggle and
 * the narrow-screen navigation disclosure. Everything else is static markup.
 *
 * The pre-paint theme decision happens in theme-init.js (loaded from <head>);
 * this module only wires the button and reacts to OS changes. */
import { THEME_STORAGE_KEY } from '../lib/site';

const MOBILE_NAV_QUERY = '(max-width: 1200px)';

type Theme = 'light' | 'dark';

/* Older WebKit/Safari only has the deprecated addListener; typing the legacy
 * shape locally keeps the call without relying on the deprecated member. */
interface LegacyMediaQueryList {
  addListener?: (callback: () => void) => void;
}

function onMediaChange(query: MediaQueryList | undefined, callback: () => void): void {
  if (!query) return;
  if (query.addEventListener) query.addEventListener('change', callback);
  else (query as unknown as LegacyMediaQueryList).addListener?.(callback);
}

function readChoice(): Theme | '' {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : '';
  } catch {
    return '';
  }
}

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function effectiveTheme(): Theme {
  return readChoice() || systemTheme();
}

function assetUrl(path: string): string {
  const build = document.documentElement.getAttribute('data-build');
  return build ? `/a/${build}${path}` : path;
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;

  const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  if (!button) return;
  const use = button.querySelector('use');
  const toLight = theme !== 'light';
  if (use) use.setAttribute('href', assetUrl(toLight ? '/icons.svg#ui-sun' : '/icons.svg#ui-moon'));
  const label = toLight ? 'Switch to light theme' : 'Switch to dark theme';
  button.setAttribute('aria-label', label);
  button.setAttribute('data-tooltip', label);
  button.setAttribute('aria-pressed', String(theme === 'light'));
}

function setupTheme(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  applyTheme(effectiveTheme());
  if (!button) return;

  button.addEventListener('click', () => {
    const next: Theme = effectiveTheme() === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    applyTheme(next);
  });

  const query = window.matchMedia?.('(prefers-color-scheme: light)');
  if (!query) return;
  const onChange = (): void => {
    if (!readChoice()) applyTheme(systemTheme());
  };
  onMediaChange(query, onChange);
}

function setupNav(): void {
  const header = document.querySelector<HTMLElement>('[data-site-header]');
  const button = document.querySelector<HTMLButtonElement>('[data-nav-toggle]');
  const nav = document.getElementById('site-nav-main');
  if (!header || !button || !nav) return;

  const mobile = window.matchMedia?.(MOBILE_NAV_QUERY);

  const setOpen = (open: boolean): void => {
    header.dataset.navOpen = String(open);
    button.setAttribute('aria-expanded', String(open));
    const label = open ? 'Close navigation' : 'Open navigation';
    button.setAttribute('aria-label', label);
    button.setAttribute('data-tooltip', label);
    nav.hidden = !open;
    if (open) {
      const first = nav.querySelector<HTMLElement>('a, button');
      first?.focus();
    }
  };

  const syncToViewport = (): void => {
    if (mobile?.matches) {
      if (header.dataset.navOpen !== 'true') nav.hidden = true;
      return;
    }
    setOpen(false);
    nav.hidden = false;
  };

  button.addEventListener('click', () => {
    setOpen(button.getAttribute('aria-expanded') !== 'true');
  });

  nav.addEventListener('click', (event) => {
    if ((event.target as Element | null)?.closest('a')) setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' && event.key !== 'Esc') return;
    if (button.getAttribute('aria-expanded') !== 'true') return;
    event.preventDefault();
    setOpen(false);
    button.focus();
  });

  document.addEventListener('click', (event) => {
    if (button.getAttribute('aria-expanded') !== 'true') return;
    const target = event.target as Node | null;
    if (target && !header.contains(target)) setOpen(false);
  });

  if (mobile) onMediaChange(mobile, syncToViewport);
  syncToViewport();
}

function setupTooltips(): void {
  const HOVER_DELAY = 150;
  const CLICK_GRACE = 500;
  let tip: HTMLDivElement | null = null;
  let shownFor: HTMLElement | null = null;
  let pendingFor: HTMLElement | null = null;
  let originalDescribedBy: string | null = null;
  let timer = 0;
  let pointerDownAt = 0;

  const node = (): HTMLDivElement => {
    if (tip?.isConnected) return tip;
    tip = document.createElement('div');
    tip.id = 'ui-tooltip';
    tip.className = 'ui-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  };

  const targetOf = (event: Event): HTMLElement | null => {
    const from = event.target as Element | null;
    if (!from || typeof from.closest !== 'function') return null;
    return from.closest('[data-tooltip]') as HTMLElement | null;
  };

  const clearTimer = (): void => {
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
    pendingFor = null;
  };

  const withoutTooltipId = (target: HTMLElement): string => {
    const value = (target.getAttribute('aria-describedby') || '').trim();
    if (!value) return '';
    return value.split(/\s+/).filter((part) => part && part !== 'ui-tooltip').join(' ');
  };

  const place = (target: HTMLElement): void => {
    const el = node();
    el.style.visibility = 'hidden';
    const tipBox = el.getBoundingClientRect();
    const targetBox = target.getBoundingClientRect();
    const gap = 8;
    const edge = 8;
    let top = targetBox.top - tipBox.height - gap;
    if (top < edge) top = targetBox.bottom + gap;
    let left = targetBox.left + (targetBox.width - tipBox.width) / 2;
    const maxLeft = window.innerWidth - tipBox.width - edge;
    if (left < edge) left = edge;
    if (left > maxLeft) left = Math.max(edge, maxLeft);
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
    el.style.visibility = '';
  };

  const hide = (): void => {
    clearTimer();
    if (!shownFor) {
      if (tip) tip.hidden = true;
      return;
    }
    if (originalDescribedBy === null) shownFor.removeAttribute('aria-describedby');
    else shownFor.setAttribute('aria-describedby', originalDescribedBy);
    shownFor = null;
    originalDescribedBy = null;
    if (tip) tip.hidden = true;
  };

  const show = (target: HTMLElement): void => {
    if (!target.isConnected) return;
    const text = target.getAttribute('data-tooltip') || '';
    if (!text || shownFor === target) return;
    hide();
    const el = node();
    el.textContent = text;
    el.hidden = false;
    place(target);
    shownFor = target;
    originalDescribedBy = target.getAttribute('aria-describedby');
    const ids = withoutTooltipId(target);
    target.setAttribute('aria-describedby', ids ? `${ids} ui-tooltip` : 'ui-tooltip');
  };

  document.addEventListener('pointerover', (event) => {
    if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    const target = targetOf(event);
    if (!target || target === shownFor || target === pendingFor) return;
    clearTimer();
    pendingFor = target;
    timer = window.setTimeout(() => {
      timer = 0;
      pendingFor = null;
      show(target);
    }, HOVER_DELAY);
  });

  document.addEventListener('pointerout', (event) => {
    const target = targetOf(event);
    if (!target) return;
    const next = event.relatedTarget as Element | null;
    if (next && typeof next.closest === 'function' && next.closest('[data-tooltip]') === target) return;
    clearTimer();
    if (shownFor === target) hide();
  });

  document.addEventListener('focusin', (event) => {
    const target = targetOf(event);
    if (!target || Date.now() - pointerDownAt < CLICK_GRACE) return;
    show(target);
  });

  document.addEventListener('focusout', (event) => {
    const target = targetOf(event);
    if (target && shownFor === target) hide();
  });

  document.addEventListener('pointerdown', () => {
    pointerDownAt = Date.now();
    hide();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' || event.key === 'Esc') hide();
  });
}

setupTheme();
setupNav();
setupTooltips();
