'use strict';

/**
 * AI layout optimizer: asks Claude for better element positions per frame and
 * applies them to a copy of the board definition.
 *
 * Only explicit `elements` are optimized. Template frames already have a
 * designed layout and are skipped.
 */

const { SYSTEM_PROMPT, LAYOUT_SCHEMA, buildUserPrompt } = require('./layoutPrompts');

// Keep elements this far away from the frame edge.
const EDGE_MARGIN = 50;

class LayoutOptimizer {
  /**
   * @param {{ completeJson: Function, getStats?: Function }} ai
   * @param {Object} [options]
   * @param {Function} [options.onProgress]
   * @param {Object} [options.logger=console]
   */
  constructor(ai, { onProgress = () => {}, logger = console } = {}) {
    this.ai = ai;
    this.onProgress = onProgress;
    this.logger = logger;
    this.stats = { framesAnalyzed: 0, framesOptimized: 0, elementsChanged: 0, errors: 0 };
  }

  /**
   * @param {Object} board - Normalized board
   * @param {Object} [options]
   * @param {string[]} [options.frameIds] - Only these frames
   * @param {boolean} [options.apply=false] - Apply the suggested positions to the returned board
   * @returns {Promise<{ board: Object, report: Object }>}
   */
  async optimize(board, { frameIds = null, apply = false } = {}) {
    const result = JSON.parse(JSON.stringify(board));
    const report = { board: board.name, applied: apply, frames: [], suggestions: [] };

    for (const frame of result.frames) {
      if (frameIds && !frameIds.includes(frame.id)) continue;
      if (frame.template || !frame.elements || frame.elements.length === 0) continue;

      this.stats.framesAnalyzed++;
      this.onProgress({ type: 'frame_start', frameId: frame.id });
      try {
        const suggestion = await this.ai.completeJson(SYSTEM_PROMPT, buildUserPrompt(frame, result), LAYOUT_SCHEMA);
        const changes = Array.isArray(suggestion.elements) ? suggestion.elements : [];
        if (apply) this.stats.elementsChanged += applySuggestion(frame, changes);
        if (changes.length > 0) this.stats.framesOptimized++;
        report.frames.push({ frameId: frame.id, reasoning: suggestion.reasoning, elementsChanged: changes.length });
        for (const text of suggestion.suggestions || []) report.suggestions.push({ frameId: frame.id, suggestion: text });
      } catch (error) {
        this.stats.errors++;
        this.logger.error(`  Layout optimization for ${frame.id} failed: ${error.message}`);
        report.frames.push({ frameId: frame.id, error: error.message });
      }
      this.onProgress({ type: 'frame_complete', frameId: frame.id });
    }

    return { board: apply ? result : board, report };
  }

  getStats() {
    return { ...this.stats, ai: this.ai.getStats ? this.ai.getStats() : undefined };
  }
}

/**
 * Apply suggested positions/sizes; positions are clamped into the frame.
 * @returns {number} number of elements changed
 */
function applySuggestion(frame, changes) {
  const halfWidth = frame.width / 2;
  const halfHeight = frame.height / 2;
  const clamp = (value, half) => Math.max(-half + EDGE_MARGIN, Math.min(half - EDGE_MARGIN, value));
  let changed = 0;

  for (const change of changes) {
    const element = frame.elements[change.index];
    if (!element) continue;
    if (typeof change.x === 'number') element.x = Math.round(clamp(change.x, halfWidth));
    if (typeof change.y === 'number') element.y = Math.round(clamp(change.y, halfHeight));
    if (typeof change.width === 'number' && change.width > 0) element.width = Math.round(change.width);
    if (typeof change.height === 'number' && change.height > 0 && element.type !== 'text') {
      element.height = Math.round(change.height);
    }
    changed++;
  }
  return changed;
}

module.exports = { LayoutOptimizer, applySuggestion };
