/* Unit tests for the first-party analytics beacon.
 *
 * The beacon is plain JavaScript so the test imports the shipped file itself:
 * the DNT guard, the payload shape, the sendBeacon/fetch transports and the
 * "no storage, no full referrer" promise are checked without a browser. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ANALYTICS_ENDPOINT,
  hostOf,
  respectsDoNotTrack,
  sendView,
} from '../src/scripts/analytics-beacon.js';

class FakeBlob {
  constructor(parts, options) {
    this.parts = parts;
    this.type = options && options.type;
  }
}

function environment(overrides = {}) {
  return {
    navigator: { doNotTrack: '0' },
    location: { pathname: '/private-keys/ethereum' },
    document: { referrer: 'https://search.example/page?q=secret#frag' },
    URL,
    Blob: FakeBlob,
    endpoint: ANALYTICS_ENDPOINT,
    ...overrides,
  };
}

test('endpoint is the absolute coordinator collector', () => {
  assert.equal(ANALYTICS_ENDPOINT, 'https://rotor.pxbt.app/api/v1/analytics/collect');
});

test('Do Not Track stops the beacon before any transport is touched', () => {
  for (const navigator of [{ doNotTrack: '1' }, { doNotTrack: 'yes' }]) {
    let called = false;
    const sent = sendView(
      environment({
        navigator,
        sendBeacon: () => {
          called = true;
          return true;
        },
        fetch: () => {
          called = true;
          return Promise.resolve();
        },
      }),
    );
    assert.equal(sent, false);
    assert.equal(called, false);
  }
  assert.equal(respectsDoNotTrack({ doNotTrack: '0' }), true);
  assert.equal(respectsDoNotTrack(null), true);
  // Legacy window/ms flags are honoured too.
  assert.equal(respectsDoNotTrack({}, { doNotTrack: '1' }), false);
  assert.equal(respectsDoNotTrack({ msDoNotTrack: '1' }, {}), false);
});

test('sendBeacon gets one view with the path and host only', () => {
  const calls = [];
  const sent = sendView(
    environment({
      sendBeacon: (url, blob) => {
        calls.push({ url, blob });
        return true;
      },
    }),
  );
  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ANALYTICS_ENDPOINT);
  assert.equal(calls[0].blob.type, 'text/plain;charset=UTF-8');
  const payload = JSON.parse(calls[0].blob.parts[0]);
  assert.deepEqual(payload, {
    event: 'view',
    path: '/private-keys/ethereum',
    referrer_host: 'search.example',
  });
  // The query string and fragment never leave the page.
  assert.equal(JSON.stringify(payload).includes('secret'), false);
  assert.equal(JSON.stringify(payload).includes('frag'), false);
});

test('fetch fallback uses keepalive and omits credentials', () => {
  let captured = null;
  const sent = sendView(
    environment({
      sendBeacon: undefined,
      fetch: (url, options) => {
        captured = { url, options };
        return Promise.resolve();
      },
    }),
  );
  assert.equal(sent, true);
  assert.equal(captured.url, ANALYTICS_ENDPOINT);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.keepalive, true);
  assert.equal(captured.options.credentials, 'omit');
  assert.equal(captured.options.mode, 'cors');
  assert.equal(JSON.parse(captured.options.body).event, 'view');
});

test('a direct visit sends no referrer and a bad path sends nothing', () => {
  let payload = null;
  const sent = sendView(
    environment({
      document: { referrer: '' },
      sendBeacon: (_url, blob) => {
        payload = JSON.parse(blob.parts[0]);
        return true;
      },
    }),
  );
  assert.equal(sent, true);
  assert.equal('referrer_host' in payload, false);

  let called = false;
  const bad = sendView(
    environment({
      location: { pathname: 'not-absolute' },
      sendBeacon: () => {
        called = true;
        return true;
      },
    }),
  );
  assert.equal(bad, false);
  assert.equal(called, false);
});

test('malformed and foreign referrers are dropped', () => {
  assert.equal(hostOf('', URL), '');
  assert.equal(hostOf('not a url', URL), '');
  assert.equal(hostOf('https://search.example/x', URL), 'search.example');
  assert.equal(hostOf('https://Search.Example./x', URL), 'search.example');
});

test('a throwing transport never breaks the page', () => {
  const sent = sendView(
    environment({
      sendBeacon: () => {
        throw new Error('blocked');
      },
    }),
  );
  assert.equal(sent, false);
});

test('the shipped beacon never touches storage or a cookie', () => {
  const source = readFileSync(new URL('../src/scripts/analytics-beacon.js', import.meta.url), 'utf8');
  for (const forbidden of [
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'document.cookie',
    'createElement',
  ]) {
    assert.equal(source.includes(forbidden), false, `beacon must not use ${forbidden}`);
  }
});
