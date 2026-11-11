'use strict';

/**
 * Miro REST API v2 client.
 *
 * Builds request payloads for boards, frames, shapes, text, sticky notes,
 * cards, images, embeds and connectors. Sending is delegated to a transport
 * (HttpTransport for real calls, DryRunTransport for planning without network).
 */

// Miro rejects longer board names.
const MAX_BOARD_NAME_LENGTH = 60;

const NAMED_COLORS = {
  light_yellow: '#fff9b1',
  yellow: '#f5d128',
  orange: '#fac710',
  light_orange: '#ffd966',
  light_green: '#d5f692',
  green: '#67c6c0',
  dark_green: '#1a9898',
  cyan: '#80c8e0',
  light_blue: '#b1ccff',
  blue: '#4da6ff',
  dark_blue: '#2d9bf0',
  light_pink: '#ffc0cb',
  pink: '#f797d1',
  violet: '#9d87d8',
  light_purple: '#dcc7f5',
  red: '#ea4e4e',
  light_gray: '#f5f5f5',
  gray: '#e6e6e6',
  dark_gray: '#808080',
  black: '#1a1a1a',
  transparent: 'transparent'
};

// Friendly connector cap names mapped to Miro API values.
const CAP_MAP = {
  none: 'none',
  arrow: 'stealth',
  arrow_open: 'open_arrow',
  circle: 'filled_circle',
  circle_open: 'circle',
  diamond: 'filled_diamond',
  diamond_open: 'diamond',
  triangle: 'filled_triangle',
  triangle_open: 'triangle'
};

class MiroClient {
  /**
   * @param {Object} transport - Object with `request(method, path, body)`
   * @param {Object} [options]
   * @param {Object} [options.logger=console]
   */
  constructor(transport, { logger = console } = {}) {
    if (!transport || typeof transport.request !== 'function') {
      throw new Error('MiroClient needs a transport with a request(method, path, body) method.');
    }
    this.transport = transport;
    this.logger = logger;
  }

  /** Convert a named color to hex; hex values pass through. */
  convertColor(color) {
    if (!color) return 'transparent';
    if (color.startsWith('#') || color === 'transparent') return color;
    return NAMED_COLORS[color] || color;
  }

  _withParent(payload, parentId) {
    if (parentId) payload.parent = { id: parentId };
    return payload;
  }

  // ---------------------------------------------------------------------
  // Boards
  // ---------------------------------------------------------------------

  async verifyConnection() {
    await this.transport.request('GET', '/boards?limit=1');
    return true;
  }

  async createBoard(name, { teamId = null, description } = {}) {
    if (!name || !name.trim()) throw new Error('Board name must not be empty.');
    if (name.length > MAX_BOARD_NAME_LENGTH) {
      throw new Error(`Board name is ${name.length} characters; Miro allows at most ${MAX_BOARD_NAME_LENGTH}.`);
    }
    const payload = { name };
    if (description) payload.description = description;
    if (teamId) payload.teamId = teamId;
    return this.transport.request('POST', '/boards', payload);
  }

  // ---------------------------------------------------------------------
  // Items
  // ---------------------------------------------------------------------

  async getAllItems(boardId) {
    const items = [];
    let cursor = null;
    do {
      const query = cursor ? `limit=50&cursor=${encodeURIComponent(cursor)}` : 'limit=50';
      const page = await this.transport.request('GET', `/boards/${boardId}/items?${query}`);
      if (page && Array.isArray(page.data)) items.push(...page.data);
      cursor = page ? page.cursor : null;
    } while (cursor);
    return items;
  }

  async deleteItem(boardId, itemId) {
    await this.transport.request('DELETE', `/boards/${boardId}/items/${itemId}`);
  }

  /**
   * Remove all items from a board in passes. Deleting a frame also deletes its
   * children, so frames go first and the item list is fetched again after each pass.
   * @returns {Promise<number>} Number of deleted items
   */
  async clearBoard(boardId, { maxPasses = 20 } = {}) {
    let deleted = 0;
    for (let pass = 1; pass <= maxPasses; pass++) {
      const items = await this.getAllItems(boardId);
      if (items.length === 0) break;

      const frames = items.filter((item) => item.type === 'frame');
      const batch = frames.length > 0 ? frames : items;
      this.logger.log(`  Clear pass ${pass}: ${items.length} items left (${frames.length} frames)`);

      let deletedThisPass = 0;
      for (const item of batch) {
        try {
          await this.deleteItem(boardId, item.id);
          deleted++;
          deletedThisPass++;
        } catch (error) {
          // A child may already be gone together with its frame.
          if (error.status !== 404) {
            this.logger.warn(`  Could not delete item ${item.id}: ${error.message}`);
          }
        }
      }
      if (deletedThisPass === 0) break;
    }
    return deleted;
  }

  // ---------------------------------------------------------------------
  // Content
  // ---------------------------------------------------------------------

  async createFrame(boardId, title, x, y, width, height, { fillColor } = {}) {
    const payload = {
      data: { title, type: 'freeform' },
      position: { x, y },
      geometry: { width, height }
    };
    if (fillColor) payload.style = { fillColor: this.convertColor(fillColor) };
    return this.transport.request('POST', `/boards/${boardId}/frames`, payload);
  }

  async createText(boardId, content, x, y, width = 300, style = {}) {
    const textStyle = {
      fontSize: String(style.fontSize || 14),
      textAlign: style.textAlign || 'left'
    };
    if (style.fontFamily) textStyle.fontFamily = style.fontFamily;
    if (style.textColor) textStyle.color = this.convertColor(style.textColor);
    const fill = this.convertColor(style.fillColor);
    if (fill !== 'transparent') textStyle.fillColor = fill;

    const payload = {
      data: { content },
      style: textStyle,
      position: { x, y },
      geometry: { width: width || 300 }
    };
    return this.transport.request('POST', `/boards/${boardId}/texts`, this._withParent(payload, style.parentId));
  }

  async createShape(boardId, content, x, y, width, height, shape = 'rectangle', style = {}) {
    let styledContent = content || '';
    if (style.textColor && styledContent) {
      styledContent = `<span style="color: ${this.convertColor(style.textColor)}">${styledContent}</span>`;
    }
    const payload = {
      data: { content: styledContent, shape },
      style: {
        fillColor: this.convertColor(style.fillColor || 'light_blue'),
        borderColor: this.convertColor(style.borderColor || 'dark_blue'),
        borderWidth: String(style.borderWidth || '2.0'),
        fontSize: String(style.fontSize || 14),
        textAlign: style.textAlign || 'center'
      },
      position: { x, y },
      geometry: { width, height }
    };
    if (style.fontFamily) payload.style.fontFamily = style.fontFamily;
    if (style.rotation) payload.geometry.rotation = style.rotation;
    return this.transport.request('POST', `/boards/${boardId}/shapes`, this._withParent(payload, style.parentId));
  }

  async createStickyNote(boardId, content, x, y, { color = 'light_yellow', width = null, parentId = null } = {}) {
    const payload = {
      data: { content: content || '', shape: 'square' },
      style: { fillColor: color },
      position: { x, y }
    };
    if (width) payload.geometry = { width };
    return this.transport.request('POST', `/boards/${boardId}/sticky_notes`, this._withParent(payload, parentId));
  }

  async createCard(boardId, title, description, x, y, { parentId = null } = {}) {
    const payload = {
      data: { title, description: description || '' },
      position: { x, y }
    };
    return this.transport.request('POST', `/boards/${boardId}/cards`, this._withParent(payload, parentId));
  }

  async createImage(boardId, url, x, y, { width = 400, parentId = null } = {}) {
    const payload = { data: { url }, position: { x, y }, geometry: { width } };
    return this.transport.request('POST', `/boards/${boardId}/images`, this._withParent(payload, parentId));
  }

  async createEmbed(boardId, url, x, y, { width = 480, mode = 'inline' } = {}) {
    const payload = { data: { url, mode }, position: { x, y }, geometry: { width } };
    return this.transport.request('POST', `/boards/${boardId}/embeds`, payload);
  }

  async createConnector(boardId, startItemId, endItemId, options = {}) {
    const startItem = { id: startItemId };
    const endItem = { id: endItemId };
    if (options.startSnapTo) startItem.snapTo = options.startSnapTo;
    if (options.endSnapTo) endItem.snapTo = options.endSnapTo;

    const payload = {
      startItem,
      endItem,
      shape: options.shape || 'curved',
      style: {
        strokeColor: this.convertColor(options.color || '#808080'),
        strokeWidth: String(options.strokeWidth || 2),
        strokeStyle: options.strokeStyle || 'normal',
        startStrokeCap: CAP_MAP[options.startCap] || options.startCap || 'none',
        endStrokeCap: CAP_MAP[options.endCap] || options.endCap || 'stealth'
      }
    };
    if (options.caption) payload.captions = [{ content: options.caption, position: '50%' }];
    return this.transport.request('POST', `/boards/${boardId}/connectors`, payload);
  }

  /** A straight line drawn as a thin rotated rectangle (Miro minimum size is 8). */
  async createLine(boardId, x1, y1, x2, y2, { color = 'dark_gray', thickness = 2, parentId = null } = {}) {
    const hex = this.convertColor(color);
    const length = Math.hypot(x2 - x1, y2 - y1);
    const rotation = Math.round((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI * 100) / 100;
    return this.createShape(boardId, '', (x1 + x2) / 2, (y1 + y2) / 2, Math.max(length, 8), Math.max(thickness, 8), 'rectangle', {
      fillColor: hex,
      borderColor: hex,
      borderWidth: '1',
      rotation,
      parentId
    });
  }

  /** A horizontal divider drawn as a thin rectangle. */
  async createDivider(boardId, x, y, width, { color = 'light_gray', thickness = 8, parentId = null } = {}) {
    const hex = this.convertColor(color);
    return this.createShape(boardId, '', x, y, width, Math.max(thickness, 8), 'rectangle', {
      fillColor: hex,
      borderColor: hex,
      borderWidth: '1',
      parentId
    });
  }
}

module.exports = { MiroClient, MAX_BOARD_NAME_LENGTH, NAMED_COLORS, CAP_MAP };
