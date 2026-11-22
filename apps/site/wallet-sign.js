/* Vault-key sign-in for the address monitor account (pure browser/Node code).
 *
 * This module owns the two pieces of the EIP-191 sign-in flow that do not
 * need the DOM:
 *  - the binary `evm_sign_message` call into the local WASM core, with the
 *    same key-zeroing discipline as the transaction signing glue: the key is
 *    written into wasm memory, never copied to hex, and both the wasm copy and
 *    the result buffer are wiped in `finally`;
 *  - the coordinator challenge/login exchange, with the request shape
 *    `/api/v1/monitor` uses. The token is returned to the caller; this module
 *    never stores, renders or logs it.
 *
 * The identity that signs in is the EVM address derived from the vault key.
 * Signing a challenge proves control of that EVM address only. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorWalletSign = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 65-byte r || s || v with the ethers personal_sign v (27 or 28). */
  var SIGNATURE = /^0x[0-9a-f]{128}(1b|1c)$/;
  var ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  var KEY_BYTES = 32;

  function wasmText(wasm, pointer, length) {
    if (!pointer || !length) return '';
    return new TextDecoder('utf-8').decode(
      new Uint8Array(wasm.memory.buffer, pointer, length)
    );
  }

  function bytesOf(value) {
    if (value instanceof Uint8Array) return value;
    throw new Error('The signer needs the raw 32-byte key.');
  }

  /* Sign `message` (a string, signed as UTF-8 bytes) with EIP-191
   * `personal_sign` in the local core. Returns `0x` + 65-byte `r || s || v`. */
  function signMessage(wasm, key, message) {
    if (!wasm || typeof wasm.evm_sign_message !== 'function') {
      throw new Error('The local core has no "evm_sign_message" export.');
    }
    var keyBytes = bytesOf(key);
    if (keyBytes.length !== KEY_BYTES) {
      throw new Error('The signer needs the raw 32-byte key.');
    }
    if (typeof message !== 'string' || !message) {
      throw new Error('There is no challenge message to sign.');
    }
    var messageBytes = new TextEncoder().encode(message);
    var keyPointer = wasm.alloc(KEY_BYTES) >>> 0;
    if (!keyPointer) throw new Error('WASM memory exhausted.');
    var messagePointer = 0;
    try {
      new Uint8Array(wasm.memory.buffer, keyPointer, KEY_BYTES).set(keyBytes);
      messagePointer = wasm.alloc(messageBytes.length) >>> 0;
      if (!messagePointer) throw new Error('WASM memory exhausted.');
      new Uint8Array(wasm.memory.buffer, messagePointer, messageBytes.length).set(messageBytes);
      var status = wasm.evm_sign_message(
        keyPointer,
        KEY_BYTES,
        messagePointer,
        messageBytes.length
      ) >>> 0;
      if (status !== 0) {
        var detail = wasmText(wasm, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0);
        throw new Error(
          'The local core rejected the message signature' +
            (detail ? ': ' + detail : ' (status ' + status + ')')
        );
      }
      var signature = wasmText(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0);
      if (!SIGNATURE.test(signature)) {
        throw new Error('The local core returned an unexpected message signature.');
      }
      return signature;
    } finally {
      new Uint8Array(wasm.memory.buffer, keyPointer, KEY_BYTES).fill(0);
      if (messagePointer) {
        new Uint8Array(wasm.memory.buffer, messagePointer, messageBytes.length).fill(0);
        wasm.dealloc(messagePointer, messageBytes.length);
      }
      wasm.dealloc(keyPointer, KEY_BYTES);
      if (typeof wasm.clear_result === 'function') wasm.clear_result();
    }
  }

  /* A `request(path, {method, body, token})` function over `base`, matching
   * the monitor page: JSON in/out, bearer header only when a token is passed,
   * and an Error carrying `status` for a non-2xx response. */
  function createRequest(base, fetchImpl) {
    var doFetch = fetchImpl ||
      (typeof fetch === 'function' ? fetch : null);
    if (typeof doFetch !== 'function') {
      throw new Error('This browser has no fetch.');
    }
    return async function request(path, options) {
      var settings = options || {};
      var headers = {};
      if (settings.body !== undefined) headers['Content-Type'] = 'application/json';
      if (settings.token) headers.Authorization = 'Bearer ' + settings.token;

      var response;
      try {
        response = await doFetch(base + path, {
          method: settings.method || 'GET',
          headers: headers,
          body: settings.body !== undefined ? JSON.stringify(settings.body) : undefined
        });
      } catch (err) {
        var network = new Error(
          'network error: ' + (err && err.message ? err.message : String(err))
        );
        network.status = 0;
        throw network;
      }

      var text = await response.text();
      var data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (err) { data = null; }
      }
      if (!response.ok) {
        var failure = new Error(
          data && data.error ? data.error : 'HTTP ' + response.status
        );
        failure.status = response.status;
        throw failure;
      }
      return data;
    };
  }

  /* Check a stored session once with `GET /api/v1/monitor/me`.
   *
   * `true` for a live session, `false` when the coordinator rejects the token
   * (HTTP 401, for example after its TTL or a logout elsewhere). Any other
   * failure is rethrown so the caller can keep an optimistic offline state
   * instead of signing the user out on a network glitch. */
  async function validateSession(options) {
    var request = options && options.request;
    var token = options && options.token;
    if (typeof request !== 'function') {
      throw new Error('Session validation needs a request function.');
    }
    if (!token) return false;
    try {
      await request('/me', { method: 'GET', token: token });
      return true;
    } catch (err) {
      if (err && err.status === 401) return false;
      throw err;
    }
  }

  /* Request the SIWE challenge for `address`, sign it with `sign(message)` and
   * exchange the signature for a session. Returns the coordinator's login
   * object `{token, user}`. Nothing is stored here. */
  async function signIn(options) {
    var request = options && options.request;
    var address = options && options.address;
    var sign = options && options.sign;
    if (typeof request !== 'function' || typeof sign !== 'function') {
      throw new Error('The sign-in flow needs a request function and a signer.');
    }
    if (typeof address !== 'string' || !ADDRESS.test(address)) {
      throw new Error('There is no EVM address to sign in with.');
    }

    var challenge = await request('/challenge', {
      method: 'POST',
      body: { chain: 'evm', address: address },
      token: ''
    });
    if (!challenge || typeof challenge.message !== 'string' || !challenge.message) {
      throw new Error('The coordinator returned no challenge message.');
    }

    var signature = await sign(challenge.message);
    if (typeof signature !== 'string' || !SIGNATURE.test(signature)) {
      throw new Error('The local core returned no valid message signature.');
    }

    var login = await request('/login', {
      method: 'POST',
      body: { chain: 'evm', message: challenge.message, signature: signature },
      token: ''
    });
    if (!login || typeof login.token !== 'string' || !login.token) {
      throw new Error('The coordinator returned no session token.');
    }
    return login;
  }

  return {
    signMessage: signMessage,
    createRequest: createRequest,
    signIn: signIn,
    validateSession: validateSession
  };
});
