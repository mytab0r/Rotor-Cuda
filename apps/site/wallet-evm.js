/* EVM send flow (pure browser/Node codec, no DOM).
 *
 * This module owns the parts that can be tested without a browser:
 *  - exact decimal parsing of native values and gwei into wei (BigInt, no float);
 *  - EIP-55 destination validation and the zero-address refusal;
 *  - the chain table, the chain-id guard and the mainnet arm/balance/fee-cap
 *    gates;
 *  - ERC-20 token reads (decimals, symbol, balanceOf) and the fixed
 *    transfer(address,uint256) calldata built locally;
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
  var AMOUNT = SSOT_ROOT.RotorAmount;

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

  /* ERC-20 reads and the one transfer method this slice signs. The selectors
   * are the canonical function signatures; calldata is always built here and
   * never accepted from the form. */
  var ERC20_TRANSFER_SELECTOR = '0xa9059cbb';
  var ERC20_DECIMALS_SELECTOR = '0x313ce567';
  var ERC20_SYMBOL_SELECTOR = '0x95d89b41';
  var ERC20_BALANCE_OF_SELECTOR = '0x70a08231';
  var TOKEN_MAX_DECIMALS = 24;
  var TOKEN_MAX_SYMBOL_CHARS = 32;
  var TOKEN_DATA_ERROR = 'Data is not allowed with a token transfer; the calldata is built from the fixed ERC-20 transfer ABI.';

  /* EVM chains the vault can hold. */
  var EVM_CHAIN_SLUGS = SSOT_PROVIDERS.groups['evm-mainnet'].slice();
  var U64_MAX = (1n << 64n) - 1n;
  var U128_MAX = (1n << 128n) - 1n;
  var U256_MAX = (1n << 256n) - 1n;

  function errorText(err) {
    return err && err.message ? err.message : String(err);
  }

  function fieldError(errors, key, message) {
    errors[key] = message;
  }

  function parseEthToWei(text) {
    return AMOUNT.parseUnits(text, ETH_DECIMALS);
  }

  function parseGweiToWei(text) {
    return AMOUNT.parseUnits(text, GWEI_DECIMALS);
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

  /* EIP-55 validation. All-lowercase input is accepted without a checksum
   * (the convention); any uppercase letter makes the address checksummed, so
   * mixed case and all-uppercase must both match the EIP-55 checksum exactly.
   * The zero address is always refused because value sent there is
   * unrecoverable. `role` only changes that refusal's wording. */
  function normalizeAddress(text, role) {
    var what = role || 'transfer recipient';
    if (typeof text !== 'string') throw new Error('Enter a 0x-prefixed 20-byte address.');
    var value = text.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new Error('Use 0x followed by 40 hex characters.');
    }
    var lower = value.toLowerCase();
    if (/^0x0{40}$/.test(lower)) {
      throw new Error('The zero address cannot be a ' + what + '; value sent there is not recoverable.');
    }
    if (/[A-F]/.test(value.slice(2)) && checksumAddress(lower) !== value) {
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

  /* ---------------------------------------------------------- ERC-20 ABI */

  function padWord(hex) {
    if (hex.length > 64) throw new Error('A 32-byte ABI word cannot hold that value.');
    return hex.padStart(64, '0');
  }

  /* Canonical transfer(address,uint256): selector 0xa9059cbb, then the
   * recipient and the raw token amount each left-padded to one 32-byte word.
   * The amount is in the token's smallest unit, already scaled by decimals. */
  function transferCalldata(recipient, amountWei) {
    var to = normalizeAddress(recipient);
    if (typeof amountWei !== 'bigint' || amountWei <= 0n) {
      throw new Error('The token amount must be greater than zero.');
    }
    if (amountWei > U256_MAX) {
      throw new Error('The token amount is too large for a uint256.');
    }
    return ERC20_TRANSFER_SELECTOR + padWord(to.slice(2)) + padWord(amountWei.toString(16));
  }

  function abiBody(hex, what) {
    if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) {
      throw new Error('The token ' + what + ' call returned non-hex data.');
    }
    return hex.slice(2).toLowerCase();
  }

  function decodeUint256(hex, what) {
    var body = abiBody(hex, what);
    if (body.length < 64) {
      throw new Error('The token ' + what + ' call returned no uint256 value.');
    }
    return BigInt('0x' + body.slice(0, 64));
  }

  function utf8Text(bytes, what) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (err) {
      throw new Error('The token ' + what + ' is not valid UTF-8.');
    }
  }

  /* ABI string symbols are [offset=32][length][data]; some older tokens
   * return a fixed bytes32 instead. Both are accepted, then the same limits
   * apply: at most 32 characters and printable ASCII only. */
  function decodeTokenSymbol(result) {
    var body = abiBody(result, 'symbol');
    if (body.length < 64) {
      throw new Error('The token symbol call returned no data.');
    }
    var text;
    if (body.length >= 128 && /^0{62}20$/.test(body.slice(0, 64))) {
      var length = BigInt('0x' + body.slice(64, 128));
      if (length > BigInt(TOKEN_MAX_SYMBOL_CHARS)) {
        throw new Error('The token symbol is longer than ' + TOKEN_MAX_SYMBOL_CHARS +
          ' characters; refusing to sign an unfamiliar token.');
      }
      var size = Number(length);
      var dataHex = body.slice(128, 128 + size * 2);
      if (dataHex.length !== size * 2) {
        throw new Error('The token symbol call returned a truncated string.');
      }
      text = utf8Text(hexToBytes(dataHex), 'symbol');
    } else {
      var bytes = hexToBytes(body.slice(0, 64));
      var end = bytes.length;
      for (var i = 0; i < bytes.length; i += 1) {
        if (bytes[i] === 0) { end = i; break; }
      }
      text = utf8Text(bytes.slice(0, end), 'symbol');
    }
    if (!text) {
      throw new Error('The token reports an empty symbol; refusing to sign an unfamiliar token.');
    }
    if (Array.from(text).length > TOKEN_MAX_SYMBOL_CHARS) {
      throw new Error('The token symbol is longer than ' + TOKEN_MAX_SYMBOL_CHARS +
        ' characters; refusing to sign an unfamiliar token.');
    }
    if (!/^[\x20-\x7e]+$/.test(text)) {
      throw new Error('The token symbol contains non-printable characters; refusing to sign an unfamiliar token.');
    }
    return text;
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
   * all field errors at once. A filled `token` switches the amount to token
   * units (parsed later once the contract decimals are read) and keeps the
   * native value at zero. */
  function validateForm(raw) {
    var input = raw || {};
    var errors = {};
    var values = {
      to: null,
      token: null,
      amountText: '',
      value: 0n,
      data: '0x',
      gasLimit: null,
      maxFee: null,
      priorityFee: null
    };
    var tokenText = typeof input.token === 'string' ? input.token.trim() : '';
    var tokenWanted = tokenText !== '';

    try {
      values.to = normalizeAddress(input.to);
    } catch (err) {
      fieldError(errors, 'to', errorText(err));
    }

    if (tokenWanted) {
      try {
        values.token = normalizeAddress(tokenText, 'token contract');
      } catch (err) {
        fieldError(errors, 'token', errorText(err));
      }
    }

    try {
      var valueText = typeof input.value === 'string' ? input.value.trim() : '';
      if (tokenWanted) {
        values.amountText = valueText;
        if (!valueText) throw new Error('Enter the token amount.');
        if (!/^\d+(?:\.\d+)?$/.test(valueText)) {
          throw new Error('Use a plain decimal token amount like 1.5 (no exponent, sign or comma).');
        }
        if (!/[1-9]/.test(valueText)) {
          throw new Error('The token amount must be greater than zero.');
        }
        values.value = 0n;
      } else {
        values.value = valueText ? parseEthToWei(valueText) : 0n;
        if (values.value > U128_MAX) throw new Error('Value is too large.');
      }
    } catch (err) {
      fieldError(errors, 'value', errorText(err));
    }

    try {
      values.data = normalizeData(input.data);
    } catch (err) {
      fieldError(errors, 'data', errorText(err));
    }
    if (tokenWanted && !errors.data && values.data !== '0x') {
      fieldError(errors, 'data', TOKEN_DATA_ERROR);
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

  /* A token review is only signable when its calldata still matches the
   * reviewed recipient and amount, and no native value rides along. This runs
   * on every chain, testnet included. */
  function assertReviewedTokenTransfer(review) {
    var contract;
    try {
      contract = normalizeAddress(review.tokenContract, 'token contract');
    } catch (err) {
      throw new Error('The reviewed token contract is invalid: ' + errorText(err) +
        ' Refusing to sign.');
    }
    var expected;
    try {
      expected = transferCalldata(review.to, review.tokenAmountWei);
    } catch (err) {
      throw new Error('The reviewed token transfer is invalid: ' + errorText(err) +
        ' Refusing to sign.');
    }
    if (review.dataHex !== expected) {
      throw new Error('The reviewed token calldata does not match the reviewed recipient ' +
        'and amount. Refusing to sign.');
    }
    if (review.valueWei !== 0n) {
      throw new Error('A token transfer must not send native value; the reviewed value is ' +
        'not zero. Refusing to sign.');
    }
    return contract;
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
      throw new Error('The maximum network fee ' + AMOUNT.formatUnits(feeWei, ETH_DECIMALS) + ' ' +
        network.symbol + ' exceeds the ' + network.name + ' cap of ' +
        AMOUNT.formatUnits(network.feeCapWei, ETH_DECIMALS) + ' ' + network.symbol +
        '; refusing to sign. Lower the gas limit or the max fee.');
    }
  }

  function assertSufficientBalance(network, balance, totalWei) {
    if (totalWei > balance) {
      throw new Error('The amount plus the maximum network fee (' +
        AMOUNT.formatUnits(totalWei, ETH_DECIMALS) + ' ' + network.symbol +
        ') exceeds the balance of ' + AMOUNT.formatUnits(balance, ETH_DECIMALS) + ' ' +
        network.symbol + '; refusing to sign.');
    }
  }

  /* A token send moves no native value; only the gas fee has to fit. */
  function assertFeeBalance(network, balance, feeWei) {
    if (feeWei > balance) {
      throw new Error('The maximum network fee ' + AMOUNT.formatUnits(feeWei, ETH_DECIMALS) +
        ' ' + network.symbol + ' exceeds the native balance of ' +
        AMOUNT.formatUnits(balance, ETH_DECIMALS) + ' ' + network.symbol +
        '; refusing to sign.');
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

  function tokenFieldError(field, message) {
    var err = new Error('Fix the highlighted fields before review.');
    err.fieldErrors = {};
    err.fieldErrors[field] = message;
    return err;
  }

  /* Read one ERC-20 contract through the selected public RPC. The contract
   * must have code on this chain; decimals, symbol and the sender's balance
   * are read with plain eth_call and the amount is parsed exactly with the
   * token's own decimals. The transfer calldata is built here from the
   * recipient and the raw amount, never supplied by the form. */
  async function readTokenMetadata(fetchJson, url, network, contract, owner, recipient, amountText) {
    var code = await read(fetchJson, url, 'eth_getCode', [contract, 'latest'],
      'the token contract code');
    if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)) {
      throw new Error('eth_getCode returned a non-hex value for the token contract.');
    }
    if (code.length <= 2) {
      throw new Error('The token address ' + contract + ' has no contract code on ' +
        network.name + '; it is an externally owned account or does not exist. ' +
        'Refusing to sign.');
    }
    var decimalsHex = await read(fetchJson, url, 'eth_call',
      [{ to: contract, data: ERC20_DECIMALS_SELECTOR }, 'latest'], 'the token decimals');
    var decimalsValue = decodeUint256(decimalsHex, 'decimals');
    if (decimalsValue > BigInt(TOKEN_MAX_DECIMALS)) {
      throw new Error('The token reports ' + decimalsValue.toString() +
        ' decimals; this wallet signs ERC-20 amounts with 0 to ' + TOKEN_MAX_DECIMALS +
        ' decimals only. Refusing to sign.');
    }
    var symbolHex = await read(fetchJson, url, 'eth_call',
      [{ to: contract, data: ERC20_SYMBOL_SELECTOR }, 'latest'], 'the token symbol');
    var symbol = decodeTokenSymbol(symbolHex);
    var decimals = Number(decimalsValue);
    var balanceHex = await read(fetchJson, url, 'eth_call',
      [{ to: contract, data: ERC20_BALANCE_OF_SELECTOR + padWord(owner.slice(2)) }, 'latest'],
      'the token balance');
    var balance = decodeUint256(balanceHex, 'balanceOf');
    var amount;
    try {
      amount = AMOUNT.parseUnits(amountText, decimals);
    } catch (err) {
      throw tokenFieldError('value',
        'The ' + symbol + ' amount has more than ' + decimals + ' decimals.');
    }
    if (amount <= 0n) {
      throw tokenFieldError('value', 'The token amount must be greater than zero.');
    }
    if (amount > U256_MAX) {
      throw new Error('The token amount is too large for a uint256.');
    }
    if (amount > balance) {
      throw new Error('The amount ' + AMOUNT.formatUnits(amount, decimals) + ' ' + symbol +
        ' exceeds the token balance of ' + AMOUNT.formatUnits(balance, decimals) + ' ' +
        symbol + '; refusing to sign.');
    }
    return {
      contract: contract,
      symbol: symbol,
      decimals: decimals,
      balance: balance,
      amount: amount,
      data: transferCalldata(recipient, amount)
    };
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
    var formInput = settings.form || {};
    var tokenText = typeof formInput.token === 'string' ? formInput.token.trim() : '';
    var tokenRequested = tokenText !== '';
    /* A native mainnet transfer needs calldata to stay empty and the amount to
     * be greater than zero. A token transfer carries locally built calldata
     * and its native value is always zero. */
    if (!network.testnet && !tokenRequested) {
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
    var txTo = values.to;
    var nativeValue = values.value;
    var transferData = values.data;
    if (values.token) {
      txTo = values.token;
      nativeValue = 0n;
      transferData = '0x';
    }
    var tokenMeta = null;
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
        if (!values.token) return null;
        return readTokenMetadata(settings.fetchJson, chosen, network, values.token, from,
          values.to, values.amountText).then(function (meta) {
          tokenMeta = meta;
          transferData = meta.data;
        });
      })
      .then(function () {
        return read(settings.fetchJson, providerUrl, 'eth_getTransactionCount', [from, 'pending'], 'the nonce');
      })
      .then(function (nonceHex) {
        nonce = quantity(nonceHex, 'nonce');
        if (nonce > U64_MAX) throw new Error('The nonce is too large.');
        return read(settings.fetchJson, providerUrl, 'eth_getBalance', [from, 'latest'], 'the balance');
      })
      .then(function (balanceHex) {
        balance = quantity(balanceHex, 'balance');
        var call = { from: from, to: txTo, value: toQuantity(nativeValue) };
        if (transferData !== '0x') call.data = transferData;
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
        var totalMaxCost = nativeValue + gasLimit * maxFee;
        var symbol = settings.nativeSymbol || network.symbol;
        if (!network.testnet) {
          assertFeeCap(network, gasLimit, maxFee);
          if (values.token) {
            assertFeeBalance(network, balance, gasLimit * maxFee);
          } else {
            assertSufficientBalance(network, balance, totalMaxCost);
          }
        }
        var fields = {
          chain_id: String(expectedChainId),
          nonce: nonce.toString(),
          max_priority_fee: priority.toString(),
          max_fee: maxFee.toString(),
          gas_limit: gasLimit.toString(),
          to: txTo,
          value: nativeValue.toString(),
          data: transferData
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
              AMOUNT.formatUnits(balance, ETH_DECIMALS) + ' ' + symbol +
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
            isToken: values.token !== null,
            tokenContract: tokenMeta ? tokenMeta.contract : null,
            tokenSymbol: tokenMeta ? tokenMeta.symbol : null,
            tokenDecimals: tokenMeta ? tokenMeta.decimals : null,
            tokenAmountWei: tokenMeta ? tokenMeta.amount : null,
            tokenBalanceWei: tokenMeta ? tokenMeta.balance : null,
            valueWei: nativeValue,
            dataHex: transferData,
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
    if (typeof settings.unsigned !== 'function') {
      throw new Error('The local unsigned-transaction builder is unavailable.');
    }
    var signTo = review.to;
    if (review.isToken) {
      signTo = assertReviewedTokenTransfer(review);
    } else if (!network.testnet) {
      assertMainnetNativeTransfer(network, review.dataHex, review.valueWei);
    }
    if (!network.testnet) {
      assertFeeCap(network, review.gasLimit, review.maxFeeWei);
      if (review.isToken) {
        assertFeeBalance(network, review.balanceWei, review.gasLimit * review.maxFeeWei);
      } else {
        assertSufficientBalance(network, review.balanceWei, review.totalMaxCostWei);
      }
    }
    assertType2Hex(review.unsignedHex, 'unsigned transaction');

    /* Pin the whole unsigned transaction: rebuild it from the reviewed fields
     * and compare byte-for-byte before signing. This covers the token
     * contract address, nonce, fees and gas too, so a review mutated after
     * preparation cannot sign a different transaction. */
    var fields = {
      chain_id: String(review.chainId),
      nonce: String(review.nonce),
      max_priority_fee: String(review.priorityWei),
      max_fee: String(review.maxFeeWei),
      gas_limit: String(review.gasLimit),
      to: signTo,
      value: String(review.valueWei),
      data: review.dataHex
    };
    var rebuilt;
    try {
      rebuilt = await Promise.resolve(settings.unsigned(fields));
    } catch (err) {
      throw new Error('Rebuilding the reviewed unsigned transaction failed: ' +
        errorText(err) + ' Refusing to sign.');
    }
    assertType2Hex(rebuilt, 'rebuilt unsigned transaction');
    if (rebuilt !== review.unsignedHex) {
      throw new Error('The reviewed unsigned transaction does not match the reviewed ' +
        'fields (chain id, nonce, fees, gas, to, value or data). Refusing to sign.');
    }

    return read(settings.fetchJson, review.providerUrl, 'eth_chainId', [], 'the chain id')
      .then(function (chainHex) {
        assertChainId(chainHex, review.chainId);
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
    parseEthToWei: parseEthToWei,
    parseGweiToWei: parseGweiToWei,
    keccak256Hex: keccak256Hex,
    checksumAddress: checksumAddress,
    normalizeAddress: normalizeAddress,
    normalizeData: normalizeData,
    transferCalldata: transferCalldata,
    decodeTokenSymbol: decodeTokenSymbol,
    TOKEN_DATA_ERROR: TOKEN_DATA_ERROR,
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
