/* Pure helpers shared by the brainwallet pages and their Node test.
 *
 * This module never touches the DOM, storage, the URL or the network. It
 * builds the deterministic two-word corpus, does BigInt page math, selects the
 * chain-specific row from an existing wasm `derive_report`, builds explorer
 * links and turns a passphrase into its SHA-256 key (the same transform the
 * key search uses). Address math stays in the wasm core; this file only picks
 * and labels the already-derived rows. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorBrainwallet = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Chain identity and public providers come from data/*.json through the
   * generated globals in chains.generated.js (loaded before this script). */
  var SSOT_ROOT = typeof globalThis !== 'undefined' ? globalThis : this;
  var SSOT_CHAINS = SSOT_ROOT.RotorChains;
  var SSOT_PROVIDERS = SSOT_ROOT.RotorProviders;

  var WARNING_TEXT = 'Brainwallets are unsafe for real funds. A SHA-256 passphrase can be ' +
    'guessed or found in public wordlists, and anyone who knows the phrase controls the ' +
    'funds. Use only throwaway phrases you are authorized to test; never a phrase that ' +
    'protects money.';

  var ROWS_PER_PAGE = 60n;
  var CORPUS_SIZE = 18890n;
  var TOTAL_PAGES = (CORPUS_SIZE + ROWS_PER_PAGE - 1n) / ROWS_PER_PAGE;
  var SECP_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  var UINT256 = (1n << 256n) - 1n;

  /* Exactly 138 unique words. The corpus is every ordered two-word pair
   * (138 x 138 = 19,044), sliced to the first 18,890 phrases. Words are plain
   * test inputs, not secrets and not a mnemonic wordlist. */
  var WORDS = [
    'amber', 'anchor', 'acorn', 'alder', 'alpine', 'apple', 'arrow', 'aspen', 'atlas', 'aurora',
    'bamboo', 'basil', 'bay', 'beacon', 'berry', 'birch', 'bloom', 'bluff', 'boulder', 'breeze',
    'brook', 'butter', 'cabin', 'cactus', 'candle', 'canyon', 'cedar', 'cherry', 'cinder', 'clover',
    'cobalt', 'comet', 'copper', 'coral', 'cotton', 'creek', 'crystal', 'dawn', 'delta', 'desert',
    'dew', 'drift', 'dune', 'dusk', 'eagle', 'echo', 'ember', 'emerald', 'falcon', 'fern',
    'field', 'finch', 'flint', 'flower', 'fog', 'forest', 'frost', 'garden', 'garnet', 'glacier',
    'granite', 'grass', 'grove', 'harbor', 'hazel', 'heather', 'hill', 'hollow', 'honey', 'horizon',
    'indigo', 'iris', 'island', 'ivory', 'jade', 'juniper', 'kettle', 'lagoon', 'lake', 'lantern',
    'lark', 'leaf', 'lily', 'lime', 'linen', 'lotus', 'maple', 'marble', 'meadow', 'meteor',
    'mint', 'mist', 'moss', 'mountain', 'nectar', 'night', 'north', 'oak', 'ocean', 'olive',
    'onyx', 'opal', 'orbit', 'orchid', 'otter', 'pebble', 'pine', 'plum', 'pond', 'prairie',
    'prism', 'quartz', 'quill', 'rain', 'raven', 'reed', 'ridge', 'river', 'robin', 'rose',
    'saffron', 'sage', 'sand', 'shadow', 'silver', 'sky', 'snow', 'spring', 'spruce', 'star',
    'stone', 'storm', 'sunset', 'thrush', 'tundra', 'valley', 'velvet', 'violet'
  ];

  var BTC_TYPES = [
    { value: 'legacy', label: 'Legacy', field: 'btc_p2pkh' },
    { value: 'segwit', label: 'SegWit', field: 'btc_p2wpkh' },
    { value: 'script', label: 'Nested SegWit', field: 'btc_p2sh_p2wpkh' },
    { value: 'taproot', label: 'Taproot', field: 'btc_p2tr' }
  ];

  var LTC_TYPES = [
    { value: 'legacy', label: 'Legacy', field: 'ltc_p2pkh' },
    { value: 'segwit', label: 'SegWit', field: 'ltc_p2wpkh' },
    { value: 'script', label: 'Nested SegWit', field: 'ltc_p2sh_p2wpkh' },
    { value: 'taproot', label: 'Taproot', field: 'ltc_p2tr' }
  ];

  var EVM_RPC = {};
  SSOT_PROVIDERS.groups['evm-mainnet'].forEach(function (slug) {
    EVM_RPC[slug] = SSOT_PROVIDERS.first(slug).url;
  });

  function explorerPrefix(slug) {
    return SSOT_CHAINS.bySlug[slug].explorerPrefix;
  }

  var EXPLORERS = {
    btc_p2pkh: explorerPrefix('bitcoin'),
    btc_p2pkh_uncompressed: explorerPrefix('bitcoin'),
    btc_p2sh_p2wpkh: explorerPrefix('bitcoin'),
    btc_p2wpkh: explorerPrefix('bitcoin'),
    btc_p2tr: explorerPrefix('bitcoin'),
    evm: explorerPrefix('ethereum')
  };

  /* Per-chain behaviour only. Identity (name, symbol, color, icon, explorer)
   * and order come from data/chains.json. */
  var CHAIN_BEHAVIOR = {
    bitcoin: { curve: 0, field: 'btc_p2pkh', types: BTC_TYPES, wif: true, balance: 'btc' },
    ethereum: { curve: 0, field: 'evm', balance: 'evm' },
    bnb: { curve: 0, field: 'evm', balance: 'evm' },
    arbitrum: { curve: 0, field: 'evm', balance: 'evm' },
    optimism: { curve: 0, field: 'evm', balance: 'evm' },
    base: { curve: 0, field: 'evm', balance: 'evm' },
    polygon: { curve: 0, field: 'evm', balance: 'evm' },
    avalanche: { curve: 0, field: 'evm', balance: 'evm' },
    zksync: { curve: 0, field: 'evm', balance: 'evm' },
    solana: { curve: 1, field: 'solana', balance: null },
    tron: { curve: 0, field: 'tron', balance: null },
    xrp: { curve: 0, field: 'xrp_classic', balance: null },
    litecoin: { curve: 0, field: 'ltc_p2pkh', types: LTC_TYPES, wif: true, balance: null },
    'bitcoin-cash': { curve: 0, field: 'bch_legacy', wif: true, balance: null },
    dogecoin: { curve: 0, field: 'doge_p2pkh', wif: true, balance: null },
    zcash: { curve: 0, field: 'zcash_p2pkh', balance: null },
    sui: { curve: 1, field: 'sui', balance: null },
    ton: { curve: 1, field: 'ton', balance: null, ton: true }
  };

  function chainFromSlug(slug) {
    var meta = SSOT_CHAINS.bySlug[slug];
    var behavior = CHAIN_BEHAVIOR[slug];
    var entry = {
      slug: slug,
      name: meta.name,
      symbol: meta.symbol,
      color: meta.color,
      icon: meta.icon,
      decimals: meta.decimals,
      explorer: meta.explorerPrefix
    };
    Object.keys(behavior).forEach(function (key) { entry[key] = behavior[key]; });
    if (behavior.balance === 'evm') entry.rpc = EVM_RPC[slug];
    return entry;
  }

  var CHAIN_LIST = SSOT_CHAINS.order.map(chainFromSlug);

  var CHAINS = {};
  CHAIN_LIST.forEach(function (chain) { CHAINS[chain.slug] = chain; });

  var LEGACY_FOCUS = {
    all: { wif: true, ids: ['btc_p2pkh', 'btc_p2wpkh', 'btc_p2tr', 'evm'] },
    bitcoin: { wif: true, ids: ['btc_p2pkh', 'btc_p2wpkh', 'btc_p2tr'] },
    ethereum: { wif: false, ids: ['evm'] }
  };

  var RANDOM_WORDS = WORDS.slice(0, 38);

  function focusConfig(focus) {
    return LEGACY_FOCUS[focus] || LEGACY_FOCUS.all;
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) {
      out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return out;
  }

  /* key = SHA-256(UTF-8 phrase.trim()), matching search.js's brainwallet path. */
  async function phraseKey(phrase, subtle) {
    var text = String(phrase == null ? '' : phrase).trim();
    if (!text) throw new Error('Enter a passphrase to test.');
    if (!subtle || typeof subtle.digest !== 'function') {
      throw new Error('Web Crypto (SHA-256) is unavailable. Open this page over HTTPS or localhost in a modern browser.');
    }
    var encoded = new TextEncoder().encode(text);
    try {
      return new Uint8Array(await subtle.digest('SHA-256', encoded));
    } finally {
      encoded.fill(0);
    }
  }

  function chainConfig(slug) {
    return CHAINS[slug] || null;
  }

  function chainSlugs() {
    return CHAIN_LIST.map(function (chain) { return chain.slug; });
  }

  function addressTypes(chain) {
    return chain && chain.types ? chain.types : [];
  }

  function corpusPhrase(index) {
    var value = Number(index);
    if (!Number.isInteger(value) || value < 0 || value >= Number(CORPUS_SIZE)) {
      throw new Error('Corpus index is outside 0..' + (Number(CORPUS_SIZE) - 1) + '.');
    }
    var first = WORDS[Math.floor(value / WORDS.length)];
    var second = WORDS[value % WORDS.length];
    return first + ' ' + second;
  }

  function clampPage(value) {
    var page;
    try {
      page = BigInt(value);
    } catch (err) {
      page = 1n;
    }
    if (page < 1n) page = 1n;
    if (page > TOTAL_PAGES) page = TOTAL_PAGES;
    return page;
  }

  /* BigInt page math: page 1 has rows 0..59, page 315 has rows 18840..18889. */
  function pageRows(value) {
    var page = clampPage(value);
    var start = (page - 1n) * ROWS_PER_PAGE;
    var end = start + ROWS_PER_PAGE;
    if (end > CORPUS_SIZE) end = CORPUS_SIZE;
    var rows = [];
    for (var index = start; index < end; index += 1n) {
      var position = Number(index);
      rows.push({ index: position, phrase: corpusPhrase(position) });
    }
    return rows;
  }

  function pagePath(slug, value) {
    var page = clampPage(value);
    return page <= 1n
      ? '/brainwallet/' + slug
      : '/brainwallet/' + slug + '/' + page.toString();
  }

  function totalPages() {
    return TOTAL_PAGES;
  }

  function corpusSize() {
    return CORPUS_SIZE;
  }

  function rowsPerPage() {
    return ROWS_PER_PAGE;
  }

  function explorerUrl(id, address) {
    var prefix = EXPLORERS[id];
    if (!prefix || !address) return '';
    return prefix + encodeURIComponent(address);
  }

  function explorerFor(slug, address) {
    var chain = chainConfig(slug);
    if (!chain || !address) return '';
    return chain.explorer + encodeURIComponent(address);
  }

  /* Pick the chain row from an already-derived wasm report. `typeValue`
   * selects one of the chain's address types (Bitcoin/Litecoin); without it
   * the chain's primary field is used. */
  function addressOf(report, slug, typeValue) {
    var chain = chainConfig(slug);
    if (!chain || !report || !Array.isArray(report.addresses)) return '';
    var field = chain.field;
    if (typeValue) {
      addressTypes(chain).forEach(function (kind) {
        if (kind.value === typeValue) field = kind.field;
      });
    }
    if (!field) return '';
    for (var i = 0; i < report.addresses.length; i += 1) {
      var entry = report.addresses[i];
      if (entry && entry.id === field) return entry.address || '';
    }
    return '';
  }

  function addressRows(report, focus) {
    var config = focusConfig(focus);
    var byId = {};
    var entries = report && Array.isArray(report.addresses) ? report.addresses : [];
    entries.forEach(function (entry) {
      if (entry && entry.id) byId[entry.id] = entry;
    });
    var rows = [];
    config.ids.forEach(function (id) {
      var entry = byId[id];
      if (!entry || !entry.address) return;
      rows.push({
        id: id,
        label: entry.label || id,
        address: entry.address,
        explorer: explorerUrl(id, entry.address)
      });
    });
    return rows;
  }

  function keyFields(report, focus) {
    if (!report) return [];
    var fields = [['Private key (hex)', report.priv_hex || '']];
    if (focusConfig(focus).wif) {
      fields.push(['WIF (compressed)', report.wif_compressed || '']);
      fields.push(['WIF (uncompressed)', report.wif_uncompressed || '']);
    }
    return fields.filter(function (field) { return Boolean(field[1]); });
  }

  /* Key-cell links for the brainwallet directory, following the donor: the hex
   * key opens /key/<hex>, and explicit WIF values add the WIF(c)/WIF(u) links
   * to /key/<wif>. The caller owns the network encoding (BTC/BCH 0x80, LTC
   * 0xb0, DOGE 0x9e). Returns [] when there is no key yet, which also clears
   * stale links in the error state. */
  function keyLinksFor(hex, wifs) {
    var value = String(hex == null ? '' : hex).trim();
    if (!value) return [];
    var links = [{ label: value, href: '/key/' + encodeURIComponent(value) }];
    if (wifs && wifs.compressed) {
      links.push({ label: 'WIF(c)', href: '/key/' + encodeURIComponent(wifs.compressed) });
    }
    if (wifs && wifs.uncompressed) {
      links.push({ label: 'WIF(u)', href: '/key/' + encodeURIComponent(wifs.uncompressed) });
    }
    return links;
  }

  /* Incremented variants for the generator's 1/3/5/10 address count. Offset 0
   * is exactly the SHA-256 brainwallet key; later rows are key + offset, which
   * the page labels explicitly. secp256k1 wraps modulo the curve order;
   * ed25519 seeds are any 32 bytes and wrap modulo 2^256. */
  function addToKey(hex, offset, curve) {
    var add = BigInt(offset || 0);
    if (add === 0n) return String(hex).toLowerCase();
    var value = BigInt('0x' + hex) + add;
    if (Number(curve) === 0) {
      value %= SECP_ORDER;
      if (value === 0n) value = 1n;
    } else {
      value &= UINT256;
    }
    return value.toString(16).padStart(64, '0');
  }

  function csvEscape(value) {
    var text = String(value == null ? '' : value);
    if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  function toCsv(header, rows) {
    var lines = [header.map(csvEscape).join(',')];
    rows.forEach(function (row) {
      lines.push(row.map(csvEscape).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  /* Fill-in-only random phrase. Uses the platform CSPRNG when available; the
   * caller must still wait for an explicit Generate click. */
  function randomPhrase(cryptoObj, count) {
    if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
      throw new Error('This browser has no secure random source for a test phrase.');
    }
    var words = [];
    var wanted = count || 5;
    var buffer = new Uint32Array(1);
    var limit = Math.floor(0x100000000 / RANDOM_WORDS.length) * RANDOM_WORDS.length;
    while (words.length < wanted) {
      cryptoObj.getRandomValues(buffer);
      if (buffer[0] >= limit) continue;
      words.push(RANDOM_WORDS[buffer[0] % RANDOM_WORDS.length]);
    }
    return words.join(' ');
  }

  function readWasmString(wasm, ptr, length) {
    if (!ptr || !length) return '';
    return new TextDecoder('utf-8').decode(new Uint8Array(wasm.memory.buffer, ptr, length));
  }

  /* Address math stays in the wasm `derive_report` export. */
  function deriveReport(wasm, bytes, curve) {
    var ptr = wasm.alloc(bytes.length) >>> 0;
    if (!ptr) throw new Error('WASM memory exhausted.');
    try {
      new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
      var status = wasm.derive_report(ptr, curve) >>> 0;
      if (status !== 0) {
        var detail = readWasmString(wasm, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0);
        throw new Error('Derivation failed' + (detail ? ': ' + detail : ' (status ' + status + ')'));
      }
      var text = readWasmString(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0);
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error('The derivation core returned invalid JSON.');
      }
    } finally {
      try {
        new Uint8Array(wasm.memory.buffer, ptr, bytes.length).fill(0);
      } catch (err) { /* memory may have grown; nothing else to wipe */ }
      wasm.dealloc(ptr, bytes.length);
    }
  }

  return {
    WARNING_TEXT: WARNING_TEXT,
    WORDS: WORDS,
    CHAIN_LIST: CHAIN_LIST,
    ROWS_PER_PAGE: ROWS_PER_PAGE,
    CORPUS_SIZE: CORPUS_SIZE,
    bytesToHex: bytesToHex,
    phraseKey: phraseKey,
    chainConfig: chainConfig,
    chainSlugs: chainSlugs,
    addressTypes: addressTypes,
    corpusPhrase: corpusPhrase,
    clampPage: clampPage,
    pageRows: pageRows,
    pagePath: pagePath,
    totalPages: totalPages,
    corpusSize: corpusSize,
    rowsPerPage: rowsPerPage,
    explorerUrl: explorerUrl,
    explorerFor: explorerFor,
    addressOf: addressOf,
    addressRows: addressRows,
    keyFields: keyFields,
    keyLinksFor: keyLinksFor,
    addToKey: addToKey,
    csvEscape: csvEscape,
    toCsv: toCsv,
    randomPhrase: randomPhrase,
    deriveReport: deriveReport
  };
});
