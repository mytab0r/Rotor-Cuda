/* Cabinet wallet security-status helpers.
 *
 * Pure code: no DOM, no network, no storage of its own. The page passes the
 * advisory catalog (fetched from /security-advisories.json), the vault
 * entries, a Storage object and the local scan functions. Addresses never
 * leave the browser: selection only compares the entry's chain, and a check
 * derives addresses locally from data the user already owns.
 *
 * The module deliberately keeps only timestamps in storage, keyed by
 * advisory id and the vault's random entry id. It never writes an address. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorWalletSecurity = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'rotor-security-checks.v1';

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function catalogParts(catalog) {
    var checkers = Object.create(null);
    var advisories = [];
    if (!isObject(catalog)) return { checkers: checkers, advisories: advisories };
    if (Array.isArray(catalog.checkers)) {
      catalog.checkers.forEach(function (checker) {
        if (isObject(checker) && typeof checker.id === 'string') checkers[checker.id] = checker;
      });
    }
    if (Array.isArray(catalog.advisories)) {
      catalog.advisories.forEach(function (advisory) {
        if (!isObject(advisory)) return;
        /* A draft entry is not a user-facing fact yet. */
        if (!isObject(advisory.review) || advisory.review.status !== 'reviewed') return;
        advisories.push(advisory);
      });
    }
    return { checkers: checkers, advisories: advisories };
  }

  /* Which reviewed advisories touch at least one chain present in this vault.
   * `applicable` entries have a runnable local checker; `uncheckable` entries
   * are real but cannot be assessed from an address alone. */
  function selectForEntries(catalog, entries) {
    var parts = catalogParts(catalog);
    var vaultEntries = Array.isArray(entries) ? entries : [];
    var applicable = [];
    var uncheckable = [];
    parts.advisories.forEach(function (advisory) {
      var checker = advisory.checker ? parts.checkers[advisory.checker] : null;
      var scope = checker && Array.isArray(checker.chains)
        ? checker.chains
        : (isObject(advisory.affected) && Array.isArray(advisory.affected.chains) ? advisory.affected.chains : []);
      var matching = vaultEntries.filter(function (entry) {
        return isObject(entry) && scope.indexOf(entry.chain) >= 0;
      });
      if (!matching.length) return;
      var item = { advisory: advisory, checker: checker || null, entries: matching };
      if (checker && checker.kind === 'local-seed-range') applicable.push(item);
      else uncheckable.push(item);
    });
    return { applicable: applicable, uncheckable: uncheckable };
  }

  function checkKey(advisoryId, entryId) {
    return String(advisoryId) + '|' + String(entryId);
  }

  function readCheckTimes(storage) {
    if (!storage) return {};
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var value = JSON.parse(raw);
      return isObject(value) ? value : {};
    } catch (err) {
      return {};
    }
  }

  function writeCheckTime(storage, advisoryId, entryId, iso) {
    var times = readCheckTimes(storage);
    times[checkKey(advisoryId, entryId)] = String(iso);
    if (storage) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(times));
      } catch (err) {
        /* A full or blocked storage is not a reason to fail the check. */
      }
    }
    return times;
  }

  function itemKeys(items) {
    var keys = [];
    (items || []).forEach(function (item) {
      (item.entries || []).forEach(function (entry) {
        keys.push(checkKey(item.advisory.id, entry.id));
      });
    });
    return keys;
  }

  function latestCheck(times, items) {
    var latest = null;
    var map = isObject(times) ? times : {};
    itemKeys(items).forEach(function (key) {
      var value = map[key];
      if (typeof value !== 'string') return;
      if (!latest || value > latest) latest = value;
    });
    return latest;
  }

  function countChecks(times, items) {
    var map = isObject(times) ? times : {};
    var count = 0;
    itemKeys(items).forEach(function (key) {
      if (typeof map[key] === 'string') count += 1;
    });
    return count;
  }

  function formatTime(iso) {
    if (typeof iso !== 'string' || !iso) return '—';
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    function pad(value) { return String(value).padStart(2, '0'); }
    return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()) +
      ' ' + pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()) + ' UTC';
  }

  function shortAddress(address) {
    var text = String(address == null ? '' : address);
    if (text.length <= 14) return text;
    return text.slice(0, 6) + '…' + text.slice(-4);
  }

  /* Run one local checker. Only the address for the user's own vault entry is
   * passed in, and only to the local scan callback. */
  async function runCheck(item, entry, address, options) {
    var settings = options || {};
    if (!item || !item.checker) throw new Error('This advisory has no local checker.');
    if (!entry || typeof entry.id !== 'string') throw new Error('Choose a vault entry.');
    if (!address) throw new Error('The address is not derived yet.');
    var checker = item.checker;
    if (checker.kind === 'local-seed-range') {
      if (typeof settings.scanRange !== 'function') throw new Error('The scan library did not load.');
      var limit = checker.limits && Number.isInteger(checker.limits.max_seeds_per_run)
        ? checker.limits.max_seeds_per_run
        : 2000;
      return settings.scanRange({
        address: address,
        start: settings.start,
        count: settings.count,
        maxSeeds: limit,
        derive: settings.derive,
        onProgress: settings.onProgress,
        yieldTo: settings.yieldTo
      });
    }
    throw new Error('Unsupported checker kind: ' + checker.kind);
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    selectForEntries: selectForEntries,
    checkKey: checkKey,
    readCheckTimes: readCheckTimes,
    writeCheckTime: writeCheckTime,
    latestCheck: latestCheck,
    countChecks: countChecks,
    formatTime: formatTime,
    shortAddress: shortAddress,
    runCheck: runCheck
  };
});
