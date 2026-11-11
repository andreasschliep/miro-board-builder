'use strict';

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
    for (let attempt = 1; ; attempt++) {
      await this._throttle();
      this.stats.requests++;

      let response;
      try {
        response = await this.fetch(this.baseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: body === undefined ? undefined : JSON.stringify(body),
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
