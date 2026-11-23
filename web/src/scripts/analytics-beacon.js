/* First-party page-view beacon for the Astro site.
 *
 * One request per page view to the coordinator collector. It sets no cookie,
 * no storage and no identifier, sends no query string and no referring URL
 * (the host alone), and does nothing when the browser asks not to be tracked.
 * `navigator.sendBeacon` keeps the request off the page-load critical path;
 * the fetch fallback uses `keepalive` and `credentials: "omit"`.
 *
 * The output has no imports: Astro bundles it into one same-origin module. */

export const ANALYTICS_ENDPOINT = 'https://rotor.pxbt.app/api/v1/analytics/collect';

/** DNT is honoured for `1` (the current header) and legacy `yes`. */
export function respectsDoNotTrack(navigatorRef, windowRef) {
  const flag =
    (navigatorRef && navigatorRef.doNotTrack) ||
    (windowRef && windowRef.doNotTrack) ||
    (navigatorRef && navigatorRef.msDoNotTrack);
  return flag !== '1' && flag !== 'yes';
}

/** Referrer host only; a full URL, path or query never leaves the page. */
export function hostOf(referrer, URLCtor) {
  if (!referrer) return '';
  const Ctor = URLCtor || (typeof URL !== 'undefined' ? URL : null);
  if (!Ctor) return '';
  try {
    const host = new Ctor(referrer).hostname.toLowerCase();
    return host.replace(/^\.+|\.+$/g, '');
  } catch (err) {
    return '';
  }
}

/**
 * Send one view. Injected dependencies keep the module testable and let the
 * caller decide which transport exists. Returns true when a request was
 * handed to the browser.
 */
export function sendView(env) {
  const navigatorRef = env.navigator || null;
  if (!respectsDoNotTrack(navigatorRef, env.window)) return false;
  const location = env.location;
  if (!location || typeof location.pathname !== 'string') return false;
  const path = location.pathname || '/';
  if (path.charAt(0) !== '/') return false;

  const payload = { event: 'view', path };
  const host = hostOf(env.document && env.document.referrer, env.URL);
  if (host) payload.referrer_host = host;
  const body = JSON.stringify(payload);
  const endpoint = env.endpoint || ANALYTICS_ENDPOINT;

  try {
    if (typeof env.sendBeacon === 'function') {
      // `text/plain` is a CORS-safelisted type, so the beacon needs no
      // preflight; the coordinator parses the body as JSON regardless.
      const blob =
        typeof env.Blob === 'function'
          ? new env.Blob([body], { type: 'text/plain;charset=UTF-8' })
          : body;
      return env.sendBeacon(endpoint, blob) === true;
    }
    if (typeof env.fetch === 'function') {
      env.fetch(endpoint, {
        method: 'POST',
        body,
        keepalive: true,
        mode: 'cors',
        credentials: 'omit',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
      }).catch(() => {});
      return true;
    }
  } catch (err) {
    /* A blocked or unsupported transport must never break the page. */
  }
  return false;
}

function start() {
  const navigatorRef = typeof navigator !== 'undefined' ? navigator : null;
  const windowRef = typeof window !== 'undefined' ? window : null;
  const documentRef = typeof document !== 'undefined' ? document : null;
  sendView({
    navigator: navigatorRef,
    window: windowRef,
    document: documentRef,
    location: windowRef ? windowRef.location : null,
    sendBeacon:
      navigatorRef && typeof navigatorRef.sendBeacon === 'function'
        ? navigatorRef.sendBeacon.bind(navigatorRef)
        : undefined,
    fetch: windowRef && typeof windowRef.fetch === 'function' ? windowRef.fetch.bind(windowRef) : undefined,
    Blob: typeof Blob !== 'undefined' ? Blob : undefined,
    URL: typeof URL !== 'undefined' ? URL : undefined,
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') start();
