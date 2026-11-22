/* EVM send flow (pure browser/Node codec, no DOM).
 *
 * This module owns the parts that can be tested without a browser:
 *  - exact decimal parsing of native values and gwei into wei (BigInt, no float);
 *  - EIP-55 destination validation and the zero-address refusal;
 *  - the chain table, the chain-id guard and the mainnet arm/balance/fee-cap
 *    gates;
 *  - review preparation over an injected public RPC and the explicit confirm
 *    step that signs and broadcasts.
 *
 * It never holds a private key: `confirmTransaction` calls an injected `sign`
 * callback bound to the unlocked vault entry, and the only network payloads it
 * builds are public JSON-RPC reads and the signed raw transaction. The
 * provider URLs are called directly by the browser with its real Origin; there
 * is no proxy and no spoofing here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorEvmSend = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Chain identity and public providers come from data/*.json through the
   * generated globals in chains.generated.js (loaded before this script). */
  var SSOT_ROOT = typeof globalThis !== 'undefined' ? globalThis : this;
  var SSOT_CHAINS = SSOT_ROOT.RotorChains;
  var SSOT_PROVIDERS = SSOT_ROOT.RotorProviders;

  var ETH_DECIMALS = 18;
  var GWEI_DECIMALS = 9;

  /* One descriptor per signable chain. `feeCapWei` is the maximum total
   * network fee (gas limit x max fee per gas) this wallet will sign, in the
   * chain's native unit; `null` means the testnet has no mainnet cap.
   * Mainnet caps are deliberately conservative: 0.05 ETH on Ethereum and
   * 0.01 native on every other chain. */
  var NETWORKS = [
    {
      slug: 'sepolia',
      chainId: 11155111,
      chainIdHex: '0xaa36a7',
      name: 'Ethereum Sepolia',
      symbol: SSOT_CHAINS.bySlug['sepolia'].symbol,
      decimals: SSOT_CHAINS.bySlug['sepolia'].decimals,
      testnet: true,
      explorerTx: SSOT_CHAINS.bySlug.sepolia.explorerTxPrefix,
      feeCapWei: null,
      /* Verified with a real browser (Chrome, Origin http://127.0.0.1:18321) on
       * 2026-11-19: all three answer eth_chainId with 0xaa36a7 and allow CORS.
       * The canonical list lives in data/providers.json. */
      providers: SSOT_PROVIDERS.byChain.sepolia
    },
    {
      slug: 'ethereum',
      chainId: 1,
      chainIdHex: '0x1',
      name: 'Ethereum mainnet',
      symbol: SSOT_CHAINS.bySlug['ethereum'].symbol,
      decimals: SSOT_CHAINS.bySlug['ethereum'].decimals,
      testnet: false,
      explorerTx: SSOT_CHAINS.bySlug.ethereum.explorerTxPrefix,
      feeCapWei: 5n * 10n ** 16n,
      providers: SSOT_PROVIDERS.byChain.ethereum
    },
    {
      slug: 'bnb',
      chainId: 56,
      chainIdHex: '0x38',
      name: 'BNB Chain mainnet',
      symbol: SSOT_CHAINS.bySlug['bnb'].symbol,
      decimals: SSOT_CHAINS.bySlug['bnb'].decimals,
      testnet: false,
      explorerTx: SSOT_CHAINS.bySlug.bnb.explorerTxPrefix,
      feeCapWei: 10n ** 16n,
      providers: [SSOT_PROVIDERS.find('bnb', 'bsc-dataseed')]
    },
    {
      slug: 'arbitrum',
      chainId: 42161,
      chainIdHex: '0xa4b1',
      name: 'Arbitrum One',
      symbol: SSOT_CHAINS.bySlug['arbitrum'].symbol,
      decimals: SSOT_CHAINS.bySlug['arbitrum'].decimals,
      testnet: false,
      explorerTx: SSOT_CHAINS.bySlug.arbitrum.explorerTxPrefix,
      feeCapWei: 10n ** 16n,
      providers: [SSOT_PROVIDERS.find('arbitrum', 'arbitrum')]
    },
    {
      slug: 'optimism',
      chainId: 10,
      chainIdHex: '0xa',
      name: 'OP Mainnet',
      symbol: SSOT_CHAINS.bySlug['optimism'].symbol,
      decimals: SSOT_CHAINS.bySlug['optimism'].decimals,
      testnet: false,
      explorerTx: SSOT_CHAINS.bySlug.optimism.explorerTxPrefix,
      feeCapWei: 10n ** 16n,
      /* mainnet.optimism.io answers HTTP 403 to a browser-like request even
       * with an Origin header (checked 2026-11-22), so it is not offered. */
      providers: SSOT_PROVIDERS.byChain.optimism
    },
    {
      slug: 'base',
      chainId: 8453,
      chainIdHex: '0x2105',
      name: 'Base mainnet',
      symbol: SSOT_CHAINS.bySlug['base'].symbol,
      decimals: SSOT_CHAINS.bySlug['base'].decimals,
      testnet: false,
      explorerTx: SSOT_CHAINS.bySlug.base.explorerTxPrefix,
      feeCapWei: 10n ** 16n,
      providers: [SSOT_PROVIDERS.find('base', 'base')]
    },
    {
      slug: 'polygon',
      chainId: 137,
      chainIdHex: '0x89',
      name: 'Polygon mainnet',
      symbol: SSOT_CHAINS.bySlug['polygon'].symbol,
      decimals: SSOT_CHAINS.bySlug['polygon'].decimals,
      testnet: false,
      explorerTx: SSOT_CHAINS.bySlug.polygon.explorerTxPrefix,
      feeCapWei: 10n ** 16n,
      /* polygon-rpc.com answers "API key disabled, tenant disabled" (checked
       * 2026-11-22), so it is not offered. */
      providers: SSOT_PROVIDERS.byChain.polygon
    },
    {
      slug: 'avalanche',
      chainId: 43114,
      chainIdHex: '0xa86a',
      name: 'Avalanche C-Chain',
      symbol: SSOT_CHAINS.bySlug['avalanche'].symbol,
      decimals: SSOT_CHAINS.bySlug['avalanche'].decimals,
      testnet: false,
      explorerTx: SSOT_CHAINS.bySlug.avalanche.explorerTxPrefix,
      feeCapWei: 10n ** 16n,
      providers: [SSOT_PROVIDERS.find('avalanche', 'avalanche')]
    },
    {
      slug: 'zksync',
      chainId: 324,
      chainIdHex: '0x144',
      name: 'zkSync Era mainnet',
      symbol: SSOT_CHAINS.bySlug['zksync'].symbol,
      decimals: SSOT_CHAINS.bySlug['zksync'].decimals,
      testnet: false,
      explorerTx: SSOT_CHAINS.bySlug.zksync.explorerTxPrefix,
      feeCapWei: 10n ** 16n,
      providers: SSOT_PROVIDERS.byChain.zksync
    },
    {
      /* Used by the separate TESTNET /send page, which reuses this codec.
       * It is not offered by the cabinet wallet's network picker. */
      slug: 'bnb-testnet',
      chainId: 97,
      chainIdHex: '0x61',
      name: 'BNB Smart Chain testnet',
      symbol: SSOT_CHAINS.bySlug['bnb-testnet'].symbol,
      decimals: SSOT_CHAINS.bySlug['bnb-testnet'].decimals,
      testnet: true,
      wallet: false,
      explorerTx: SSOT_CHAINS.bySlug['bnb-testnet'].explorerTxPrefix,
      feeCapWei: null,
      providers: []
    }
  ];

  function networkById(id) {
    var value = Number(id);
    for (var i = 0; i < NETWORKS.length; i += 1) {
      if (NETWORKS[i].chainId === value) return NETWORKS[i];
    }
    return null;
  }

  function networkBySlug(slug) {
    for (var i = 0; i < NETWORKS.length; i += 1) {
      if (NETWORKS[i].slug === slug) return NETWORKS[i];
    }
    return null;
  }

  function walletNetworks() {
    return NETWORKS.filter(function (network) { return network.wallet !== false; });
  }

  var SEPOLIA = networkById(11155111);
  var PROVIDERS = SEPOLIA.providers;
  var GAS_BUFFER_PERCENT = 20n;

  /* EVM chains the vault can hold. */
  var EVM_CHAIN_SLUGS = SSOT_PROVIDERS.groups['evm-mainnet'].slice();
  var U64_MAX = (1n << 64n) - 1n;
  var U128_MAX = (1n << 128n) - 1n;

  function errorText(err) {
    return err && err.message ? err.message : String(err);
  }

  function fieldError(errors, key, message) {
    errors[key] = message;
  }

  /* Exact decimal -> integer conversion. No Number, no exponent, no rounding. */
  function parseUnits(text, decimals) {
    if (typeof text !== 'string') throw new Error('use a plain decimal number');
    var value = text.trim();
    if (!value) throw new Error('a number is required');
    var match = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) {
      throw new Error('use a plain decimal number like 0.01 (no exponent, sign or comma)');
    }
    var fraction = match[2] || '';
    if (fraction.length > decimals) {
      throw new Error('at most ' + decimals + ' decimal places');
    }
    return BigInt(match[1]) * (10n ** BigInt(decimals)) +
      BigInt(fraction.padEnd(decimals, '0') || '0');
  }

  function formatUnits(value, decimals) {
    var unit = 10n ** BigInt(decimals);
    var whole = value / unit;
    var fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? whole.toString() + '.' + fraction : whole.toString();
  }

  function parseEthToWei(text) {
    return parseUnits(text, ETH_DECIMALS);
  }

  function parseGweiToWei(text) {
    return parseUnits(text, GWEI_DECIMALS);
  }

  /* ------------------------------------------------------------- keccak-256 */

  /* Keccak-256 as used by Ethereum (original 0x01 padding, not SHA3-256).
   * It has no native browser primitive and the wasm core does not export one,
   * so the checksum and the transaction hash are computed here. */
  var KECCAK_MASK = (1n << 64n) - 1n;
  var KECCAK_ROUNDS = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
    0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
    0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
    0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
    0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
    0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
    0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
  ];
  var KECCAK_ROTATIONS = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14]
  ];

  function rotl64(value, count) {
    var shift = count % 64;
    if (shift === 0) return value & KECCAK_MASK;
    var bits = BigInt(shift);
    return ((value << bits) | (value >> (64n - bits))) & KECCAK_MASK;
  }

  function keccakF(state) {
    for (var round = 0; round < 24; round += 1) {
      var c = [];
      var d = [];
      var x;
      var y;
      for (x = 0; x < 5; x += 1) {
        c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
      }
      for (x = 0; x < 5; x += 1) {
        d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
      }
      for (var lane = 0; lane < 25; lane += 1) {
        state[lane] = (state[lane] ^ d[lane % 5]) & KECCAK_MASK;
      }
      var b = new Array(25);
      for (x = 0; x < 5; x += 1) {
        for (y = 0; y < 5; y += 1) {
          b[y + 5 * ((2 * x + 3 * y) % 5)] =
            rotl64(state[x + 5 * y], KECCAK_ROTATIONS[x][y]);
        }
      }
      for (x = 0; x < 5; x += 1) {
        for (y = 0; y < 5; y += 1) {
          state[x + 5 * y] = b[x + 5 * y] ^
            ((~b[(x + 1) % 5 + 5 * y] & KECCAK_MASK) & b[(x + 2) % 5 + 5 * y]);
        }
      }
      state[0] = (state[0] ^ KECCAK_ROUNDS[round]) & KECCAK_MASK;
    }
  }

  function keccak256Bytes(bytes) {
    var rate = 136;
    var padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
    padded.set(bytes);
    padded[bytes.length] ^= 0x01;
    padded[padded.length - 1] ^= 0x80;
    var state = new Array(25);
    for (var i = 0; i < 25; i += 1) state[i] = 0n;
    for (var offset = 0; offset < padded.length; offset += rate) {
      for (var word = 0; word < rate / 8; word += 1) {
        var laneValue = 0n;
        for (var byte = 0; byte < 8; byte += 1) {
          laneValue |= BigInt(padded[offset + word * 8 + byte]) << BigInt(8 * byte);
        }
        state[word] ^= laneValue;
      }
      keccakF(state);
    }
    var out = new Uint8Array(32);
    for (var wordIndex = 0; wordIndex < 4; wordIndex += 1) {
      var lane = state[wordIndex];
      for (var index = 0; index < 8; index += 1) {
        out[wordIndex * 8 + index] = Number(lane & 0xffn);
        lane >>= 8n;
      }
    }
    return out;
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  function hexToBytes(hex) {
    var value = hex.replace(/^0x/i, '');
    var out = new Uint8Array(value.length / 2);
    for (var i = 0; i < out.length; i += 1) {
      out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function keccak256Hex(text) {
    var bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
    return bytesToHex(keccak256Bytes(bytes));
  }

  /* EIP-55 mixed-case checksum for a lowercase 0x address. */
  function checksumAddress(address) {
    var lower = String(address).toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{40}$/.test(lower)) {
      throw new Error('Use 0x followed by 40 hex characters.');
    }
    var hash = keccak256Hex(lower);
    var out = '0x';
    for (var i = 0; i < lower.length; i += 1) {
      var char = lower.charAt(i);
      out += /[a-f]/.test(char) && parseInt(hash.charAt(i), 16) >= 8
        ? char.toUpperCase()
        : char;
    }
    return out;
  }

  /* EIP-55 recipient validation. All-lowercase and all-uppercase input is
   * accepted without a checksum (the convention); mixed case must match the
   * EIP-55 checksum exactly. The zero address is always refused because value
   * sent there is unrecoverable. */
  function normalizeAddress(text) {
    if (typeof text !== 'string') throw new Error('Enter a 0x-prefixed 20-byte address.');
    var value = text.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new Error('Use 0x followed by 40 hex characters.');
    }
    var lower = value.toLowerCase();
    if (/^0x0{40}$/.test(lower)) {
      throw new Error('The zero address cannot be a transfer recipient; value sent there is not recoverable.');
    }
    var body = value.slice(2);
    var hasLower = /[a-f]/.test(body);
    var hasUpper = /[A-F]/.test(body);
    if (hasLower && hasUpper && checksumAddress(lower) !== value) {
      throw new Error('The address fails the EIP-55 checksum. Copy it again or use the all-lowercase form.');
    }
    return lower;
  }

  function normalizeData(text) {
    var value = typeof text === 'string' ? text.trim() : '';
    if (!value || value === '0x' || value === '0X') return '0x';
    if (!/^0[xX][0-9a-fA-F]*$/.test(value)) {
      throw new Error('Use 0x followed by hexadecimal digits, or leave empty.');
    }
    var hex = value.slice(2).toLowerCase();
    if (hex.length % 2) throw new Error('Use an even number of hex digits.');
    return '0x' + hex;
  }

  function parseUint(text, max, field) {
    var value = typeof text === 'string' ? text.trim() : '';
    if (!/^\d+$/.test(value)) throw new Error(field + ' must be a whole decimal number.');
    var parsed = BigInt(value);
    if (parsed <= 0n) throw new Error(field + ' must be greater than zero.');
    if (parsed > max) throw new Error(field + ' is too large.');
    return parsed;
  }

  function parseFee(text, field, allowZero) {
    var parsed = parseGweiToWei(text);
    if (!allowZero && parsed === 0n) throw new Error(field + ' must be greater than zero.');
    return parsed;
  }

  /* Validate the raw form strings. Returns { errors, values }; every value
   * that parsed is present even when another field failed, so the UI can show
   * all field errors at once. */
  function validateForm(raw) {
    var input = raw || {};
    var errors = {};
    var values = {
      to: null,
      value: 0n,
      data: '0x',
      gasLimit: null,
      maxFee: null,
      priorityFee: null
    };

    try {
      values.to = normalizeAddress(input.to);
    } catch (err) {
      fieldError(errors, 'to', errorText(err));
    }

    try {
      var valueText = typeof input.value === 'string' ? input.value.trim() : '';
      values.value = valueText ? parseEthToWei(valueText) : 0n;
      if (values.value > U128_MAX) throw new Error('Value is too large.');
    } catch (err) {
      fieldError(errors, 'value', errorText(err));
    }

    try {
      values.data = normalizeData(input.data);
    } catch (err) {
      fieldError(errors, 'data', errorText(err));
    }

    try {
      var gasText = typeof input.gasLimit === 'string' ? input.gasLimit.trim() : '';
      if (gasText) values.gasLimit = parseUint(gasText, U64_MAX, 'Gas limit');
    } catch (err) {
      fieldError(errors, 'gasLimit', errorText(err));
    }

    try {
      var maxText = typeof input.maxFee === 'string' ? input.maxFee.trim() : '';
      if (maxText) values.maxFee = parseFee(maxText, 'Max fee', false);
      if (values.maxFee !== null && values.maxFee > U128_MAX) {
        throw new Error('Max fee is too large.');
      }
    } catch (err) {
      fieldError(errors, 'maxFee', errorText(err));
    }

    try {
      var priorityText = typeof input.priorityFee === 'string' ? input.priorityFee.trim() : '';
      if (priorityText) values.priorityFee = parseFee(priorityText, 'Priority fee', true);
      if (values.priorityFee !== null && values.priorityFee > U128_MAX) {
        throw new Error('Priority fee is too large.');
      }
    } catch (err) {
      fieldError(errors, 'priorityFee', errorText(err));
    }

    if (values.maxFee !== null && values.priorityFee !== null &&
        values.priorityFee > values.maxFee) {
      fieldError(errors, 'priorityFee', 'Priority fee must not exceed the max fee.');
    }

    return { errors: errors, values: values };
  }

  /* ------------------------------------------------------------- chain id */

  function parseChainId(value) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new Error('eth_chainId returned a non-hex quantity.');
    }
    return BigInt(value);
  }

  function assertChainId(value, expectedId) {
    var actual = parseChainId(value);
    var expected = BigInt(expectedId);
    if (actual !== expected) {
      throw new Error('Chain id mismatch: the provider answered ' + actual.toString() +
        ' but ' + expected.toString() + ' is required. Refusing to sign.');
    }
    return Number(actual);
  }

  /* The descriptor table is the allowlist: an id outside it is not signable
   * even if a caller asks for it. */
  function assertKnownNetwork(id) {
    var network = networkById(id);
    if (!network) {
      throw new Error('Chain id ' + String(id) +
        ' is not in the wallet chain table. Refusing to sign.');
    }
    return network;
  }

  /* A mainnet send is only allowed after the user arms it for the session.
   * This check lives in the codec, not only in the DOM. */
  function assertMainnetArmed(network, armed) {
    if (network.testnet) return;
    if (armed !== true) {
      throw new Error('Mainnet signing is not armed. Tick "I understand this spends real ' +
        network.symbol + ' on ' + network.name + ' for this session" before signing.');
    }
  }

  /* Defense in depth at confirm time: a review object can be mutated after it
   * was prepared, so the native-only shape is re-checked before signing. */
  function assertMainnetNativeTransfer(network, dataHex, valueWei) {
    if (network.testnet) return;
    if (dataHex !== '0x') {
      throw new Error('Mainnet signing here is native-token transfers only; ' +
        'the reviewed transaction has calldata. Refusing to sign.');
    }
    if (typeof valueWei !== 'bigint' || valueWei <= 0n) {
      throw new Error('Mainnet signing here is native-token transfers only; ' +
        'the reviewed amount is not greater than zero. Refusing to sign.');
    }
  }

  function bufferedGasLimit(estimate) {
    var percent = 100n + GAS_BUFFER_PERCENT;
    var buffered = (estimate * percent + 99n) / 100n;
    if (buffered === 0n || buffered > U64_MAX) {
      throw new Error('The buffered gas limit is out of range.');
    }
    return buffered;
  }

  function assertFeeCap(network, gasLimit, maxFee) {
    if (network.feeCapWei === null) return;
    var feeWei = gasLimit * maxFee;
    if (feeWei > network.feeCapWei) {
      throw new Error('The maximum network fee ' + formatUnits(feeWei, ETH_DECIMALS) + ' ' +
        network.symbol + ' exceeds the ' + network.name + ' cap of ' +
        formatUnits(network.feeCapWei, ETH_DECIMALS) + ' ' + network.symbol +
        '; refusing to sign. Lower the gas limit or the max fee.');
    }
  }

  function assertSufficientBalance(network, balance, totalWei) {
    if (totalWei > balance) {
      throw new Error('The amount plus the maximum network fee (' +
        formatUnits(totalWei, ETH_DECIMALS) + ' ' + network.symbol +
        ') exceeds the balance of ' + formatUnits(balance, ETH_DECIMALS) + ' ' +
        network.symbol + '; refusing to sign.');
    }
  }

  /* ------------------------------------------------------------------ RPC */

  function rpcCall(fetchJson, url, method, params) {
    return Promise.resolve()
      .then(function () {
        return fetchJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: method,
            params: params
          })
        });
      })
      .then(function (response) {
        if (!response || typeof response !== 'object') {
          throw new Error('the RPC returned a non-JSON response');
        }
        if (response.error) {
          throw new Error(String(response.error.message || 'RPC error code ' + response.error.code));
        }
        if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
          throw new Error('the RPC response has no result');
        }
        return response.result;
      });
  }

  function providerLabel(url) {
    for (var n = 0; n < NETWORKS.length; n += 1) {
      for (var i = 0; i < NETWORKS[n].providers.length; i += 1) {
        if (NETWORKS[n].providers[i].url === url) return NETWORKS[n].providers[i].label;
      }
    }
    return url;
  }

  function quantity(value, field) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new Error(field + ' is not a hex quantity.');
    }
    return BigInt(value);
  }

  function toQuantity(value) {
    return '0x' + value.toString(16);
  }

  function assertType2Hex(text, what) {
    if (typeof text !== 'string' || !/^0x02[0-9a-f]+$/.test(text) || text.length % 2) {
      throw new Error('The local core returned an unexpected ' + what + '.');
    }
    return text;
  }

  function wasmText(wasm, pointer, length) {
    if (!pointer || !length) return '';
    return new TextDecoder('utf-8').decode(new Uint8Array(wasm.memory.buffer, pointer, length));
  }

  /* Call a wasm string entry point and erase the request afterwards.
   *
   * The signing request carries the private key as text. Parsing happens in
   * wasm, but the raw bytes stay in linear memory until the allocation is
   * reused, so the finally block zeroes the wasm copy and the JS `bytes`
   * before deallocating. The finally also runs when the wasm call rejects or
   * traps; `clear_result` still wipes the result buffer. */
  function callWasmString(wasm, name, request) {
    if (!wasm || typeof wasm[name] !== 'function') {
      throw new Error('The local core has no "' + name + '" export.');
    }
    var bytes = new TextEncoder().encode(request);
    var pointer = wasm.alloc(bytes.length) >>> 0;
    if (!pointer) throw new Error('WASM memory exhausted.');
    try {
      new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
      var status = wasm[name](pointer, bytes.length) >>> 0;
      if (status !== 0) {
        var detail = wasmText(wasm, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0);
        throw new Error('The local core rejected the transaction' +
          (detail ? ': ' + detail : ' (status ' + status + ')'));
      }
      return wasmText(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0);
    } finally {
      new Uint8Array(wasm.memory.buffer, pointer, bytes.length).fill(0);
      bytes.fill(0);
      wasm.dealloc(pointer, bytes.length);
      if (typeof wasm.clear_result === 'function') wasm.clear_result();
    }
  }

  function chooseProvider(fetchJson, providers, expectedChainId, networkName) {
    var failures = [];
    var label = networkName || 'Sepolia';

    function attempt(index) {
      if (index >= providers.length) {
        throw new Error('No public ' + label + ' RPC answered correctly from this browser' +
          (providers.length > 1 ? ' (tried ' + providers.length + ' endpoints)' : '') +
          '. Browser CORS or network access may be blocked; Crypto does not proxy or spoof Origin. ' +
          failures.join(' · '));
      }
      var url = providers[index];
      return rpcCall(fetchJson, url, 'eth_chainId', []).then(function (hex) {
        assertChainId(hex, expectedChainId);
        return url;
      }).catch(function (err) {
        failures.push(providerLabel(url) + ': ' + errorText(err));
        return attempt(index + 1);
      });
    }

    return attempt(0);
  }

  function read(fetchJson, url, method, params, what) {
    return rpcCall(fetchJson, url, method, params).catch(function (err) {
      throw new Error('Reading ' + what + ' failed on ' + providerLabel(url) + ': ' + errorText(err));
    });
  }

  /* --------------------------------------------------------------- prepare */

  /* Build the review. It never signs: `unsigned` is a local serializer and
   * there is no signing callback in this function's contract.
   *
   * options: { form, from, fetchJson, providers?, providerUrl?,
   *            unsigned(fields) -> hex, expectedChainId?, chainName? } */
  async function prepareTransaction(options) {
    var settings = options || {};
    var network = assertKnownNetwork(settings.expectedChainId === undefined
      ? SEPOLIA.chainId
      : settings.expectedChainId);
    assertMainnetArmed(network, settings.mainnetArmed);
    var expectedChainId = network.chainId;
    var validated = validateForm(settings.form);
    /* Mainnet in this slice is native-token transfers only: no calldata and
     * no zero-value contract call. */
    if (!network.testnet) {
      if (!validated.errors.data && validated.values.data !== '0x') {
        validated.errors.data = 'Mainnet signing here is native-token transfers only; clear the data field.';
      }
      if (!validated.errors.value && validated.values.value === 0n) {
        validated.errors.value = 'Enter an amount greater than zero for a native-token transfer.';
      }
    }
    if (Object.keys(validated.errors).length) {
      var invalid = new Error('Fix the highlighted fields before review.');
      invalid.fieldErrors = validated.errors;
      throw invalid;
    }
    if (typeof settings.unsigned !== 'function') {
      throw new Error('The local unsigned-transaction builder is unavailable.');
    }

    var from;
    try {
      from = normalizeAddress(settings.from);
    } catch (err) {
      throw new Error('The vault address is invalid: ' + errorText(err));
    }
    var values = validated.values;
    var providers = settings.providerUrl
      ? [settings.providerUrl]
      : (settings.providers || network.providers.map(function (provider) { return provider.url; }));
    if (!providers.length) {
      throw new Error('No RPC provider is configured for ' + network.name + '.');
    }

    var providerUrl;
    var nonce;
    var balance;
    var estimate = null;
    var estimateError = null;
    var baseFee;
    var networkPriority;
    var feesSource = 'eth_feeHistory';
    var prioritySource = 'eth_maxPriorityFeePerGas';

    return chooseProvider(settings.fetchJson, providers, expectedChainId,
      settings.networkName || network.name)
      .then(function (chosen) {
        providerUrl = chosen;
        return read(settings.fetchJson, chosen, 'eth_getTransactionCount', [from, 'pending'], 'the nonce');
      })
      .then(function (nonceHex) {
        nonce = quantity(nonceHex, 'nonce');
        if (nonce > U64_MAX) throw new Error('The nonce is too large.');
        return read(settings.fetchJson, providerUrl, 'eth_getBalance', [from, 'latest'], 'the balance');
      })
      .then(function (balanceHex) {
        balance = quantity(balanceHex, 'balance');
        var call = { from: from, to: values.to, value: toQuantity(values.value) };
        if (values.data !== '0x') call.data = values.data;
        /* Best-effort estimate: with a manual gas limit its failure is only a
         * warning, because the reviewed limit is what will be signed. Without
         * one the estimate is required, since there is no limit to send. */
        return rpcCall(settings.fetchJson, providerUrl, 'eth_estimateGas', [call])
          .then(function (estimateHex) {
            estimate = quantity(estimateHex, 'gas estimate');
            if (estimate === 0n || estimate > U64_MAX) {
              throw new Error('The gas estimate is out of range.');
            }
          })
          .catch(function (err) {
            estimate = null;
            estimateError = providerLabel(providerUrl) + ': ' + errorText(err);
            if (values.gasLimit === null) {
              throw new Error('Cannot estimate gas; enter a gas limit manually (' +
                estimateError + ').');
            }
          });
      })
      .then(function () {
        return rpcCall(settings.fetchJson, providerUrl, 'eth_feeHistory', ['0x1', 'latest', []])
          .then(function (history) {
            if (!history || !Array.isArray(history.baseFeePerGas) || !history.baseFeePerGas.length) {
              throw new Error('the fee history has no base fee');
            }
            baseFee = quantity(history.baseFeePerGas[history.baseFeePerGas.length - 1], 'base fee');
          }, function () {
            feesSource = 'eth_gasPrice';
            return read(settings.fetchJson, providerUrl, 'eth_gasPrice', [], 'the base fee')
              .then(function (hex) { baseFee = quantity(hex, 'base fee'); });
          });
      })
      .then(function () {
        return rpcCall(settings.fetchJson, providerUrl, 'eth_maxPriorityFeePerGas', [])
          .then(function (hex) {
            networkPriority = quantity(hex, 'priority fee');
          }, function () {
            prioritySource = 'eth_gasPrice';
            return read(settings.fetchJson, providerUrl, 'eth_gasPrice', [], 'the priority fee')
              .then(function (hex) { networkPriority = quantity(hex, 'priority fee'); });
          });
      })
      .then(function () {
        var priority = values.priorityFee === null ? networkPriority : values.priorityFee;
        var maxFee = values.maxFee === null ? baseFee * 2n + priority : values.maxFee;
        if (priority > maxFee) {
          var conflict = new Error('Priority fee exceeds the max fee.');
          conflict.fieldErrors = { priorityFee: 'Priority fee must not exceed the max fee.' };
          throw conflict;
        }
        /* Mainnet never signs a blind gas limit: the node estimate gets a 20%
         * buffer. A manual limit is the user's explicit value and is reviewed
         * as such. */
        var gasLimit = values.gasLimit === null
          ? (network.testnet ? estimate : bufferedGasLimit(estimate))
          : values.gasLimit;
        if (gasLimit > U64_MAX) throw new Error('The gas limit is too large.');
        var totalMaxCost = values.value + gasLimit * maxFee;
        var symbol = settings.nativeSymbol || network.symbol;
        if (!network.testnet) {
          assertFeeCap(network, gasLimit, maxFee);
          assertSufficientBalance(network, balance, totalMaxCost);
        }
        var fields = {
          chain_id: String(expectedChainId),
          nonce: nonce.toString(),
          max_priority_fee: priority.toString(),
          max_fee: maxFee.toString(),
          gas_limit: gasLimit.toString(),
          to: values.to,
          value: values.value.toString(),
          data: values.data
        };
        return Promise.resolve(settings.unsigned(fields)).then(function (unsignedHex) {
          assertType2Hex(unsignedHex, 'unsigned transaction');

          var warnings = [];
          if (estimateError !== null) {
            warnings.push('Node estimate failed: ' + estimateError +
              '; using the manual gas limit.');
          }
          if (values.gasLimit !== null && estimate !== null && gasLimit < estimate) {
            warnings.push('Gas limit ' + gasLimit.toString() +
              ' is below the node estimate of ' + estimate.toString() +
              '; the transaction may run out of gas.');
          }
          if (network.testnet && totalMaxCost > balance) {
            warnings.push('The maximum cost exceeds the balance of ' +
              formatUnits(balance, ETH_DECIMALS) + ' ' + symbol +
              '; the node will reject the transaction.');
          }

          return {
            chainId: expectedChainId,
            chainName: settings.chainName || network.name,
            networkSlug: network.slug,
            testnet: network.testnet,
            symbol: symbol,
            explorerTx: network.explorerTx,
            feeCapWei: network.feeCapWei,
            from: from,
            to: values.to,
            valueWei: values.value,
            dataHex: values.data,
            gasLimit: gasLimit,
            gasEstimate: estimate,
            gasLimitIsManual: values.gasLimit !== null,
            priorityWei: priority,
            maxFeeWei: maxFee,
            baseFeeWei: baseFee,
            nonce: nonce,
            balanceWei: balance,
            totalMaxCostWei: totalMaxCost,
            feesSource: feesSource,
            prioritySource: prioritySource,
            providerUrl: providerUrl,
            providerLabel: providerLabel(providerUrl),
            warnings: warnings,
            unsignedHex: unsignedHex
          };
        });
      });
  }

  /* --------------------------------------------------------------- confirm */

  /* options: { review, fetchJson, sign(fields) -> signed hex,
   *            mainnetArmed? } */
  async function confirmTransaction(options) {
    var settings = options || {};
    var review = settings.review;
    if (!review || typeof review !== 'object') {
      throw new Error('Prepare and review the transaction first.');
    }
    var network = assertKnownNetwork(review.chainId);
    assertMainnetArmed(network, settings.mainnetArmed);
    if (typeof settings.sign !== 'function') {
      throw new Error('Local signing is unavailable.');
    }
    if (typeof settings.fetchJson !== 'function' || !review.providerUrl) {
      throw new Error('The RPC provider is missing from the review.');
    }
    if (!network.testnet) {
      assertMainnetNativeTransfer(network, review.dataHex, review.valueWei);
      assertFeeCap(network, review.gasLimit, review.maxFeeWei);
      assertSufficientBalance(network, review.balanceWei, review.totalMaxCostWei);
    }
    assertType2Hex(review.unsignedHex, 'unsigned transaction');

    return read(settings.fetchJson, review.providerUrl, 'eth_chainId', [], 'the chain id')
      .then(function (chainHex) {
        assertChainId(chainHex, review.chainId);
        var fields = {
          chain_id: String(review.chainId),
          nonce: String(review.nonce),
          max_priority_fee: String(review.priorityWei),
          max_fee: String(review.maxFeeWei),
          gas_limit: String(review.gasLimit),
          to: review.to,
          value: String(review.valueWei),
          data: review.dataHex
        };
        return Promise.resolve(settings.sign(fields));
      })
      .then(function (signedHex) {
        assertType2Hex(signedHex, 'signed transaction');
        /* One broadcast, no retry: a provider error is surfaced verbatim so
         * the user can decide, and a duplicate send cannot be triggered by
         * this code. */
        return rpcCall(settings.fetchJson, review.providerUrl, 'eth_sendRawTransaction', [signedHex])
          .catch(function (err) {
            throw new Error('Broadcasting to ' + providerLabel(review.providerUrl) +
              ' failed: ' + errorText(err));
          })
          .then(function (hash) {
            if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
              throw new Error('The provider returned an unexpected transaction hash.');
            }
            var txHash = hash.toLowerCase();
            return {
              signedHex: signedHex,
              txHash: txHash,
              chainName: network.name,
              symbol: network.symbol,
              testnet: network.testnet,
              providerUrl: review.providerUrl,
              providerLabel: providerLabel(review.providerUrl),
              explorerUrl: network.explorerTx + txHash
            };
          });
      });
  }

  return {
    NETWORKS: NETWORKS,
    SEPOLIA: SEPOLIA,
    PROVIDERS: PROVIDERS,
    EVM_CHAIN_SLUGS: EVM_CHAIN_SLUGS,
    ETH_DECIMALS: ETH_DECIMALS,
    GWEI_DECIMALS: GWEI_DECIMALS,
    parseUnits: parseUnits,
    formatUnits: formatUnits,
    parseEthToWei: parseEthToWei,
    parseGweiToWei: parseGweiToWei,
    keccak256Hex: keccak256Hex,
    checksumAddress: checksumAddress,
    normalizeAddress: normalizeAddress,
    normalizeData: normalizeData,
    parseChainId: parseChainId,
    assertChainId: assertChainId,
    assertKnownNetwork: assertKnownNetwork,
    assertMainnetArmed: assertMainnetArmed,
    bufferedGasLimit: bufferedGasLimit,
    validateForm: validateForm,
    callWasmString: callWasmString,
    prepareTransaction: prepareTransaction,
    confirmTransaction: confirmTransaction,
    providerLabel: providerLabel,
    networkById: networkById,
    networkBySlug: networkBySlug,
    walletNetworks: walletNetworks
  };
});
