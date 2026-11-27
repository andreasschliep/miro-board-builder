'use strict';

const crypto = require('crypto');

/**
 * Transports for the Miro REST API v2.
 *
 * MiroClient builds request payloads; a transport sends them.
 * - HttpTransport talks to api.miro.com with throttling, timeouts and retries.
 * - DryRunTransport sends nothing. It records every call and returns fake ids,
 *   so a complete build can run without a Miro account.
 */

const DEFAULT_BASE_URL = 'https://api.miro.com/v2';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class MiroApiError extends Error {
  constructor(message, { status = null, body = null, method = null, path = null } = {}) {
    super(message);
    this.name = 'MiroApiError';
    this.status = status;
    this.body = body;
    this.method = method;
    this.path = path;
  }
}

async function readBody(response) {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

class HttpTransport {
  /**
   * @param {Object} options
   * @param {string} options.accessToken - Miro access token with boards:read and boards:write scope
   * @param {string} [options.baseUrl]
   * @param {number} [options.timeoutMs=20000] - A stalled request must fail so that it can be retried
   * @param {number} [options.minIntervalMs=650] - Minimum gap between requests (~90 requests/minute)
   * @param {number} [options.maxRetries=4] - Retries for 429, 5xx, timeouts and network errors
   * @param {number} [options.backoffBaseMs=1000] - First retry delay; doubles on every attempt
   * @param {Function} [options.fetchImpl] - Injectable fetch (tests)
   * @param {Function} [options.sleepImpl] - Injectable sleep (tests)
   * @param {Function} [options.now] - Injectable clock (tests)
   */
  constructor({
    accessToken,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = 20000,
    minIntervalMs = 650,
    maxRetries = 4,
    backoffBaseMs = 1000,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    now = Date.now
  } = {}) {
    if (!accessToken) {
      throw new Error('A Miro access token is required (set MIRO_ACCESS_TOKEN).');
    }
    this.accessToken = accessToken;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.backoffBaseMs = backoffBaseMs;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.now = now;
    this.lastRequestAt = -Infinity;
    this.stats = { requests: 0, retries: 0 };
  }

  /** Keep a minimum interval between requests to stay below the rate limit. */
  async _throttle() {
    const wait = this.lastRequestAt + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  /** Honour Retry-After when the API sends it, otherwise back off exponentially. */
  _retryDelay(attempt, response) {
    const retryAfter = response && response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('retry-after')
      : null;
    const seconds = Number(retryAfter);
    if (retryAfter !== null && retryAfter !== '' && Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    return this.backoffBaseMs * 2 ** (attempt - 1);
  }

  async request(method, path, body) {
    return this._send(method, path, () => ({
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }));
  }

  /**
   * Upload a file as multipart/form-data, the way `curl -F` sends it: the file as part
   * `resource` with its file name, the JSON as part `data` without one. (FormData would
   * give the JSON part the file name "blob", and Miro answers that with HTTP 500.)
   * @param {string} path
   * @param {{data: Object, file: {name: string, contentType: string, bytes: Uint8Array}}} upload
   */
  async upload(path, { data, file }) {
    const boundary = `----miro-board-builder-${crypto.randomUUID()}`;
    const name = String(file.name).replace(/["\r\n]/g, encodeURIComponent);
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="resource"; filename="${name}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`
      ),
      Buffer.from(file.bytes),
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n` +
          `Content-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--\r\n`
      )
    ]);
    return this._send('POST', path, () => ({
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    }));
  }

  async _send(method, path, makeRequest) {
    for (let attempt = 1; ; attempt++) {
      await this._throttle();
      this.stats.requests++;

      const { headers, body } = makeRequest();
      let response;
      try {
        response = await this.fetch(this.baseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            ...headers,
            Accept: 'application/json'
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (error) {
        // Network error or timeout: retryable.
        if (attempt > this.maxRetries) {
          throw new MiroApiError(`${method} ${path} failed after ${attempt} attempts: ${error.message}`, { method, path });
        }
        this.stats.retries++;
        await this.sleep(this._retryDelay(attempt));
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return null;
        const text = await readBody(response);
        return text ? JSON.parse(text) : null;
      }

      const errorBody = await readBody(response);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt <= this.maxRetries) {
        this.stats.retries++;
        await this.sleep(this._retryDelay(attempt, response));
        continue;
      }
      throw new MiroApiError(`${method} ${path} returned HTTP ${response.status}`, {
        status: response.status,
        body: errorBody,
        method,
        path
      });
    }
  }
}

class DryRunTransport {
  constructor() {
    this.calls = [];
    this.counter = 0;
  }

  async request(method, path, body) {
    const call = { seq: this.calls.length + 1, method, path };
    if (body !== undefined) call.body = body;
    this.calls.push(call);

    if (method === 'GET') {
      // In a dry run the target board is treated as empty.
      return { data: [], cursor: null };
    }
    if (method === 'DELETE') return null;

    this.counter++;
    return { id: `dry-run-${this.counter}` };
  }

  /** Records an upload with the file's name, type and size; the bytes are left out. */
  async upload(path, { data, file }) {
    const size = file.bytes.length;
    return this.request('POST', path, { data, file: { name: file.name, contentType: file.contentType, size } });
  }

  /** Plan document written by `build --dry-run`. */
  toPlan(meta = {}) {
    return {
      ...meta,
      dryRun: true,
      callCount: this.calls.length,
      calls: this.calls
    };
  }
}

module.exports = { HttpTransport, DryRunTransport, MiroApiError, DEFAULT_BASE_URL };
