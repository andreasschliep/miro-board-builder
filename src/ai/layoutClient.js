'use strict';

/**
 * Claude client for layout suggestions.
 *
 * - Official Anthropic SDK (retries 429/5xx with backoff, honours retry-after)
 * - Structured output: the response is guaranteed to match a JSON schema
 * - Two-tier cache (memory + disk) so repeated runs on an unchanged frame cost nothing
 * - Server-side refusal fallback opted in ("default" routing)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function loadSdk() {
  const sdk = require('@anthropic-ai/sdk');
  return sdk.default || sdk.Anthropic || sdk;
}

class LayoutAIClient {
  /**
   * @param {Object} [options]
   * @param {string} [options.apiKey=process.env.ANTHROPIC_API_KEY]
   * @param {string} [options.model] - Defaults to ANTHROPIC_MODEL or claude-opus-5-5
   * @param {string} [options.effort='medium'] - low | medium | high | xhigh | max
   * @param {number} [options.maxTokens=16000]
   * @param {number} [options.maxRetries=3] - SDK retries for 429/5xx/connection errors
   * @param {boolean} [options.fallbacks=true] - Opt into server-side refusal fallback
   * @param {string} [options.cacheDir='.layout-cache']
   * @param {boolean} [options.enableCache=true]
   * @param {Object} [options.client] - Pre-built SDK client (tests)
   */
  constructor({
    apiKey = process.env.ANTHROPIC_API_KEY,
    model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    effort = 'medium',
    maxTokens = 16000,
    maxRetries = 3,
    fallbacks = true,
    cacheDir = path.join(process.cwd(), '.layout-cache'),
    enableCache = true,
    client = null
  } = {}) {
    if (!client && !apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required for layout optimization.');
    }
    this.model = model;
    this.effort = effort;
    this.maxTokens = maxTokens;
    this.fallbacks = fallbacks;
    this.cacheDir = cacheDir;
    this.enableCache = enableCache;
    this.memoryCache = new Map();
    this.stats = { memoryCacheHits: 0, diskCacheHits: 0, apiCalls: 0, inputTokens: 0, outputTokens: 0 };

    if (client) {
      this.client = client;
    } else {
      const Anthropic = loadSdk();
      this.client = new Anthropic({ apiKey, maxRetries });
    }
  }

  _cacheKey(system, user, schema) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify({ model: this.model, effort: this.effort, system, user, schema }))
      .digest('hex');
  }

  _cachePath(key) {
    return path.join(this.cacheDir, key.slice(0, 2), `${key}.json`);
  }

  _readDisk(key) {
    if (!this.enableCache) return null;
    try {
      const entry = JSON.parse(fs.readFileSync(this._cachePath(key), 'utf8'));
      if (Date.now() - new Date(entry.timestamp).getTime() < CACHE_TTL_MS) return entry.result;
    } catch {
      // missing or unreadable cache entry: ask the API
    }
    return null;
  }

  _writeDisk(key, result) {
    if (!this.enableCache) return;
    try {
      const file = this._cachePath(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), model: this.model, result }, null, 2));
    } catch {
      // the cache is an optimization; a write failure must not break the run
    }
  }

  /** Request body for the Messages API. */
  buildRequest(system, user, schema) {
    const request = {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: {
        effort: this.effort,
        format: { type: 'json_schema', schema }
      }
    };
    if (this.fallbacks) {
      request.betas = [FALLBACK_BETA];
      request.fallbacks = 'default';
    }
    return request;
  }

  /**
   * Ask Claude for a JSON object that matches `schema`.
   * @returns {Promise<Object>}
   */
  async completeJson(system, user, schema) {
    const key = this._cacheKey(system, user, schema);

    if (this.memoryCache.has(key)) {
      this.stats.memoryCacheHits++;
      return this.memoryCache.get(key);
    }
    const cached = this._readDisk(key);
    if (cached) {
      this.stats.diskCacheHits++;
      this.memoryCache.set(key, cached);
      return cached;
    }

    const request = this.buildRequest(system, user, schema);
    const response = this.fallbacks
      ? await this.client.beta.messages.create(request)
      : await this.client.messages.create(request);
    this.stats.apiCalls++;
    this.stats.inputTokens += (response.usage && response.usage.input_tokens) || 0;
    this.stats.outputTokens += (response.usage && response.usage.output_tokens) || 0;

    if (response.stop_reason === 'refusal') {
      const category = response.stop_details && response.stop_details.category;
      throw new Error(`Claude declined the layout request${category ? ` (${category})` : ''}.`);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('Layout response was cut off at max_tokens; raise maxTokens or optimize fewer frames at once.');
    }

    const text = (response.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const result = JSON.parse(text);

    this.memoryCache.set(key, result);
    this._writeDisk(key, result);
    return result;
  }

  getStats() {
    return { ...this.stats, cacheHits: this.stats.memoryCacheHits + this.stats.diskCacheHits };
  }
}

module.exports = { LayoutAIClient, DEFAULT_MODEL, FALLBACK_BETA };
