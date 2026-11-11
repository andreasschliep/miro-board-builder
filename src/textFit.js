'use strict';

/**
 * Pre-flight check: will the text of a shape fit into the shape?
 *
 * Miro does not report overflowing text through the API, so the check runs on
 * the YAML before anything is built. It is a heuristic based on average glyph
 * width and line height, good enough to catch boxes that are clearly too small.
 */

const { resolveFrameElements } = require('./frameElements');

const DEFAULTS = {
  fontSize: 14,
  charWidthFactor: 0.6, // average glyph width relative to font size
  lineHeightFactor: 1.6, // line height relative to font size
  paddingXFactor: 0.6, // horizontal inner padding per side, relative to font size
  paddingYFactor: 0.25 // vertical inner padding per side, relative to font size
};

function htmlToLines(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<\/li>\s*<li[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .split('\n')
    .map((line) => line.trim());
}

/** Inline `font-size: NNpx` in the content wins over the element's fontSize. */
function effectiveFontSize(element) {
  const match = String(element.content || '').match(/font-size:\s*(\d+)px/);
  if (match) return Number(match[1]);
  return Number(element.fontSize) || DEFAULTS.fontSize;
}

/**
 * Estimate the height a block of text needs inside a box of the given width.
 * @returns {number} required height in board units
 */
function estimateRequiredHeight(html, { fontSize = DEFAULTS.fontSize, width } = {}) {
  const paddingX = Math.max(8, fontSize * DEFAULTS.paddingXFactor);
  const paddingY = Math.max(4, fontSize * DEFAULTS.paddingYFactor);
  const charWidth = fontSize * DEFAULTS.charWidthFactor;
  const lineHeight = fontSize * DEFAULTS.lineHeightFactor;
  const available = Math.max(charWidth, width - paddingX * 2);

  let lines = 0;
  for (const line of htmlToLines(html)) {
    lines += Math.max(1, Math.ceil((line.length * charWidth) / available));
  }
  return Math.ceil(lines * lineHeight + paddingY * 2);
}

/** @returns {null|Object} overflow details, or null when the text fits */
function checkElement(element) {
  if (element.type !== 'shape' || !element.content) return null;
  const width = element.width || 200;
  const height = element.height || 100;
  const fontSize = effectiveFontSize(element);
  const requiredHeight = estimateRequiredHeight(element.content, { fontSize, width });
  if (requiredHeight <= height) return null;
  return { width, height, fontSize, requiredHeight, deficit: requiredHeight - height };
}

function preview(html) {
  const text = htmlToLines(html).join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 50 ? `${text.slice(0, 47)}...` : text;
}

/**
 * Check every shape on every frame (including template output and group items).
 * @returns {Object[]} warnings
 */
function checkBoard(board, templates) {
  const warnings = [];
  const visit = (elements, frame) => {
    elements.forEach((element, index) => {
      if (element.type === 'group' && element.items) {
        visit(element.items, frame);
        return;
      }
      const issue = checkElement(element);
      if (issue) {
        warnings.push({ frameId: frame.id, index, text: preview(element.content), ...issue });
      }
    });
  };
  for (const frame of board.frames || []) {
    visit(resolveFrameElements(frame, board, templates), frame);
  }
  return warnings;
}

module.exports = { estimateRequiredHeight, checkElement, checkBoard, htmlToLines, effectiveFontSize };
