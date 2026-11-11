'use strict';

/**
 * Board YAML parser.
 *
 * - `!include <file>` inserts the content of a file (relative to the YAML file,
 *   must stay inside that folder)
 * - layout, color and phase defaults
 * - frame positions from `row`/`col` when x/y are not given
 * - color references (`color: primary`) resolved to hex values
 * - `repeat` blocks expanded into one element per data item, with {{field}} interpolation
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { palette } = require('./style');

const DEFAULT_LAYOUT = {
  startX: 0,
  rowSpacing: 1400,
  frameSpacing: 1800,
  defaultFrameWidth: 1600,
  defaultFrameHeight: 1000
};

const DEFAULT_COLORS = { ...palette };

const COLOR_FIELDS = ['color', 'borderColor', 'textColor'];

class BoardParser {
  /**
   * @param {Object} [options]
   * @param {string} [options.basePath=process.cwd()] - Folder for resolving !include
   */
  constructor({ basePath = process.cwd() } = {}) {
    this.basePath = basePath;
  }

  _schema() {
    const basePath = () => this.basePath;
    const includeType = new yaml.Type('!include', {
      kind: 'scalar',
      construct(filename) {
        const root = path.resolve(basePath());
        const target = path.resolve(root, filename);
        if (target !== root && !target.startsWith(root + path.sep)) {
          throw new Error(`!include must stay inside ${root}: ${filename}`);
        }
        return fs.readFileSync(target, 'utf8').trim();
      }
    });
    return yaml.DEFAULT_SCHEMA.extend([includeType]);
  }

  /** Read a YAML file without applying defaults (used for schema validation). */
  loadFile(filePath) {
    this.basePath = path.dirname(path.resolve(filePath));
    return this.loadString(fs.readFileSync(filePath, 'utf8'));
  }

  loadString(content) {
    const doc = yaml.load(content, { schema: this._schema() });
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('Board definition must be a YAML mapping.');
    }
    return doc;
  }

  parseFile(filePath) {
    return this.normalize(this.loadFile(filePath));
  }

  parseString(content) {
    return this.normalize(this.loadString(content));
  }

  /** Apply defaults and expand shortcuts. Returns a new object. */
  normalize(raw) {
    const board = JSON.parse(JSON.stringify(raw));
    board.layout = { ...DEFAULT_LAYOUT, ...(board.layout || {}) };
    board.colors = { ...DEFAULT_COLORS, ...(board.colors || {}) };
    board.phases = board.phases || {};
    board.style = { headerBar: true, parentElements: false, ...(board.style || {}) };

    for (const phase of Object.values(board.phases)) {
      if (phase && phase.color && board.colors[phase.color]) phase.color = board.colors[phase.color];
    }

    board.frames = (board.frames || []).map((frame, index) => this._normalizeFrame(frame, index, board));
    return board;
  }

  _normalizeFrame(frame, index, board) {
    const { layout } = board;
    if (frame.x === undefined) {
      const col = frame.col !== undefined ? frame.col : index;
      frame.x = layout.startX + col * layout.frameSpacing;
    }
    if (frame.y === undefined) {
      frame.y = (frame.row || 0) * layout.rowSpacing;
    }
    frame.width = frame.width || layout.defaultFrameWidth;
    frame.height = frame.height || layout.defaultFrameHeight;
    if (frame.fillColor && board.colors[frame.fillColor]) frame.fillColor = board.colors[frame.fillColor];
    if (frame.elements) {
      frame.elements = this._normalizeElements(frame.elements, board);
    }
    return frame;
  }

  _normalizeElements(elements, board) {
    return elements.flatMap((element) => {
      if (element.repeat && Array.isArray(element.repeat.data)) {
        return this._expandRepeat(element).map((el) => this._normalizeElement(el, board));
      }
      return [this._normalizeElement(element, board)];
    });
  }

  _normalizeElement(element, board) {
    for (const field of COLOR_FIELDS) {
      if (element[field] && board.colors[element[field]]) {
        element[field] = board.colors[element[field]];
      }
    }
    if (element.items) {
      element.items = this._normalizeElements(element.items, board);
    }
    return element;
  }

  /**
   * Expand `repeat` into one element per data item.
   * Layouts: vertical, horizontal, grid (fills rows), grid-by-row (fills columns).
   */
  _expandRepeat(element) {
    const { repeat, ...template } = element;
    const {
      data,
      layout = 'vertical',
      spacing = 60,
      spacingX,
      spacingY,
      columns = 3,
      rows
    } = repeat;

    return data.map((item, index) => {
      let offsetX = 0;
      let offsetY = 0;
      if (layout === 'horizontal') {
        offsetX = index * (spacingX || spacing);
      } else if (layout === 'vertical') {
        offsetY = index * (spacingY || spacing);
      } else if (layout === 'grid') {
        offsetX = (index % columns) * (spacingX || spacing);
        offsetY = Math.floor(index / columns) * (spacingY || spacing);
      } else if (layout === 'grid-by-row') {
        const effectiveRows = rows || Math.ceil(data.length / columns);
        offsetX = Math.floor(index / effectiveRows) * (spacingX || spacing);
        offsetY = (index % effectiveRows) * (spacingY || spacing);
      } else {
        throw new Error(`Unknown repeat layout: ${layout}`);
      }

      const values = typeof item === 'object' && item !== null ? item : { value: item };
      const expanded = {};
      for (const [key, value] of Object.entries(template)) {
        expanded[key] = typeof value === 'string' ? interpolate(value, values) : value;
      }
      if (typeof item !== 'object' || item === null) {
        expanded.content = template.content ? interpolate(template.content, values) : String(item);
      }
      expanded.x = (template.x || 0) + offsetX;
      expanded.y = (template.y || 0) + offsetY;
      return expanded;
    });
  }
}

function interpolate(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => (values[key] !== undefined ? String(values[key]) : match));
}

module.exports = { BoardParser, DEFAULT_LAYOUT, DEFAULT_COLORS, interpolate };
