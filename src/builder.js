'use strict';

/**
 * Board builder: creates the frames and elements of a normalized board
 * definition on a Miro board.
 *
 * Pass 1 creates every frame and its elements; elements with a `ref` are
 * remembered. Pass 2 creates connectors between referenced elements.
 * Every frame is written to the frame protocol (if one is given).
 *
 * The build stops early, keeping what was already created, when
 * - the optional AbortSignal fires (checked between frames), or
 * - Miro answers 401, 403 or 404: a missing token, a missing scope or a
 *   missing board will not fix itself for the next frame.
 */

const defaultTemplates = require('./templates');
const { resolveFrameElements } = require('./frameElements');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** HTTP statuses that end the whole build instead of only the current item. */
const FATAL_STATUSES = new Set([401, 403, 404]);

function isFatal(error) {
  return Boolean(error) && FATAL_STATUSES.has(error.status);
}

function describeAbort(signal) {
  const reason = signal && signal.reason;
  if (reason && reason.message) return `cancelled: ${reason.message}`;
  if (typeof reason === 'string' && reason) return `cancelled: ${reason}`;
  return 'cancelled';
}

class BoardBuilder {
  /**
   * @param {import('./miro/client').MiroClient} miro
   * @param {Object} [options]
   * @param {Object} [options.templates] - Template registry
   * @param {import('./protocol').FrameProtocol} [options.protocol]
   * @param {Object} [options.logger=console]
   * @param {number} [options.settleAfterClearMs=20000] - Pause after clearing a board.
   *   Creating frames right after a large delete tends to fail with HTTP 500.
   * @param {Function} [options.sleep] - Injectable sleep (tests)
   */
  constructor(miro, {
    templates = defaultTemplates,
    protocol = null,
    logger = console,
    settleAfterClearMs = 20000,
    sleep: sleepImpl = sleep
  } = {}) {
    this.miro = miro;
    this.templates = templates;
    this.protocol = protocol;
    this.logger = logger;
    this.settleAfterClearMs = settleAfterClearMs;
    this.sleep = sleepImpl;
    this._reset();
  }

  _reset() {
    this.stats = { framesCreated: 0, elementsCreated: 0, connectorsCreated: 0, errors: 0 };
    this.refMap = {};
    this.pendingConnectors = [];
    this.abortReason = null;
  }

  /** True when the build must stop; remembers why. */
  _shouldStop(signal) {
    if (this.abortReason) return true;
    if (signal && signal.aborted) {
      this.abortReason = describeAbort(signal);
      return true;
    }
    return false;
  }

  _result() {
    return { ...this.stats, aborted: this.abortReason !== null, abortReason: this.abortReason };
  }

  /**
   * @param {string} boardId
   * @param {Object} board - Normalized board (BoardParser)
   * @param {Object} [options]
   * @param {boolean} [options.clearFirst=false]
   * @param {boolean} [options.dryRun=false] - Only marks protocol entries
   * @param {AbortSignal} [options.signal] - Stops the build between frames
   * @returns {Promise<{framesCreated: number, elementsCreated: number, connectorsCreated: number,
   *   errors: number, aborted: boolean, abortReason: string|null}>}
   */
  async build(boardId, board, { clearFirst = false, dryRun = false, signal = null } = {}) {
    this._reset();
    this.logger.log(`Building "${board.name}" (${board.frames.length} frames) on board ${boardId}`);

    if (this._shouldStop(signal)) {
      this.logger.log(`Stopped before the first frame (${this.abortReason})`);
      return this._result();
    }

    if (clearFirst) {
      const deleted = await this.miro.clearBoard(boardId);
      this.logger.log(`  Cleared ${deleted} items`);
      if (this.settleAfterClearMs > 0) {
        this.logger.log(`  Waiting ${Math.round(this.settleAfterClearMs / 1000)} s for the board to settle`);
        await this.sleep(this.settleAfterClearMs);
      }
    }

    for (const frame of board.frames) {
      if (this._shouldStop(signal)) break;
      const elementsBefore = this.stats.elementsCreated;
      const errorsBefore = this.stats.errors;
      const entry = { boardId, frameId: frame.id, title: frame.title, dryRun };
      try {
        const created = await this._buildFrame(boardId, frame, board);
        this.stats.framesCreated++;
        const errors = this.stats.errors - errorsBefore;
        this._record({
          ...entry,
          miroId: created && created.id ? created.id : null,
          elements: this.stats.elementsCreated - elementsBefore,
          errors,
          status: errors > 0 ? 'partial' : 'created'
        });
      } catch (error) {
        this.stats.errors++;
        this.logger.error(`  Frame ${frame.id} failed: ${error.message}`);
        this._record({
          ...entry,
          miroId: error.frameMiroId || null,
          elements: this.stats.elementsCreated - elementsBefore,
          errors: this.stats.errors - errorsBefore,
          status: 'failed',
          error: error.message
        });
        if (isFatal(error)) {
          this.abortReason = `Miro returned HTTP ${error.status}: ${error.message}`;
          break;
        }
      }
    }

    for (const connector of this.pendingConnectors) {
      if (this._shouldStop(signal)) break;
      try {
        await this._createConnector(boardId, connector);
        this.stats.connectorsCreated++;
      } catch (error) {
        this.stats.errors++;
        this.logger.error(`  Connector ${connector.from} -> ${connector.to} failed: ${error.message}`);
        if (isFatal(error)) {
          this.abortReason = `Miro returned HTTP ${error.status}: ${error.message}`;
          break;
        }
      }
    }

    if (this.abortReason) this.logger.log(`Stopped early: ${this.abortReason}`);
    this.logger.log(
      `Done: ${this.stats.framesCreated} frames, ${this.stats.elementsCreated} elements, ` +
      `${this.stats.connectorsCreated} connectors, ${this.stats.errors} errors`
    );
    return this._result();
  }

  _record(entry) {
    if (this.protocol) this.protocol.record(entry);
  }

  async _buildFrame(boardId, frame, board) {
    this.logger.log(`  Frame ${frame.id}: ${frame.title}`);
    const created = await this.miro.createFrame(boardId, frame.title, frame.x, frame.y, frame.width, frame.height, {
      fillColor: frame.fillColor || board.style.frameFill
    });

    // With style.parentElements the frame becomes the parent of its elements.
    // Miro then expects child positions relative to the frame's top-left corner.
    const ctx = board.style.parentElements && created && created.id
      ? { parentId: created.id, width: frame.width, height: frame.height }
      : {};

    const elements = resolveFrameElements(frame, board, this.templates);
    try {
      await this._buildElements(boardId, elements, frame.x, frame.y, ctx);
    } catch (error) {
      // Only fatal errors get here; keep the id of the frame that does exist.
      if (created && created.id) error.frameMiroId = created.id;
      throw error;
    }
    return created;
  }

  async _buildElements(boardId, elements, frameX, frameY, ctx) {
    for (const element of elements) {
      if (element.type === 'group') {
        // Group items are positioned relative to the group's offset.
        const shifted = (element.items || []).map((item) => ({
          ...item,
          x: (item.x || 0) + (element.x || 0),
          y: (item.y || 0) + (element.y || 0)
        }));
        await this._buildElements(boardId, shifted, frameX, frameY, ctx);
        continue;
      }
      if (element.type === 'connector') {
        // Connectors need the ids of both ends, so they wait for pass 2.
        this.pendingConnectors.push(element);
        continue;
      }
      try {
        const result = await this._buildElement(boardId, element, frameX, frameY, ctx);
        if (result) {
          this.stats.elementsCreated++;
          if (element.ref && result.id) this.refMap[element.ref] = result.id;
        }
      } catch (error) {
        // A fatal error ends the frame and the build; the frame-level handler counts it.
        if (isFatal(error)) throw error;
        this.stats.errors++;
        this.logger.error(`    ${element.type} failed: ${error.message}`);
      }
    }
  }

  _position(element, frameX, frameY, ctx) {
    if (ctx.parentId) {
      return { x: ctx.width / 2 + (element.x || 0), y: ctx.height / 2 + (element.y || 0) };
    }
    return { x: frameX + (element.x || 0), y: frameY + (element.y || 0) };
  }

  async _buildElement(boardId, element, frameX, frameY, ctx) {
    const { x, y } = this._position(element, frameX, frameY, ctx);
    const parentId = ctx.parentId || null;
    const miro = this.miro;

    switch (element.type) {
      case 'text':
        return miro.createText(boardId, element.content || '', x, y, element.width || 300, {
          fontSize: element.fontSize,
          textAlign: element.textAlign,
          fillColor: element.color,
          fontFamily: element.fontFamily,
          textColor: element.textColor,
          parentId
        });
      case 'shape':
        return miro.createShape(boardId, element.content || '', x, y, element.width || 200, element.height || 100,
          element.shape || 'rectangle', {
            fillColor: element.color,
            textColor: element.textColor,
            borderColor: element.borderColor,
            borderWidth: element.borderWidth,
            fontSize: element.fontSize,
            textAlign: element.textAlign,
            fontFamily: element.fontFamily,
            parentId
          });
      case 'sticky':
        return miro.createStickyNote(boardId, element.content || '', x, y, {
          color: element.color || 'light_yellow',
          width: element.width || null,
          parentId
        });
      case 'card':
        return miro.createCard(boardId, element.title || element.content || '', element.description || '', x, y, { parentId });
      case 'image':
        if (!element.url) throw new Error('image needs a url');
        return miro.createImage(boardId, element.url, x, y, { width: element.width || 400, parentId });
      case 'embed':
        if (!element.url) throw new Error('embed needs a url');
        return miro.createEmbed(boardId, element.url, x, y, { width: element.width, mode: element.mode });
      case 'divider':
        return miro.createDivider(boardId, x, y, element.width || 400, {
          color: element.color,
          thickness: element.thickness,
          parentId
        });
      case 'line':
        return miro.createLine(boardId, x, y, x + (element.toX || 0), y + (element.toY || 0), {
          color: element.color,
          thickness: element.thickness,
          parentId
        });
      default:
        throw new Error(`unknown element type '${element.type}'`);
    }
  }

  async _createConnector(boardId, connector) {
    const startId = this.refMap[connector.from];
    const endId = this.refMap[connector.to];
    if (!startId) throw new Error(`source ref '${connector.from}' was not created`);
    if (!endId) throw new Error(`target ref '${connector.to}' was not created`);
    return this.miro.createConnector(boardId, startId, endId, {
      shape: connector.shape || 'curved',
      startCap: connector.startCap || 'none',
      endCap: connector.endCap || 'arrow',
      color: connector.color,
      strokeWidth: connector.strokeWidth,
      strokeStyle: connector.strokeStyle,
      caption: connector.caption,
      startSnapTo: connector.startSnapTo,
      endSnapTo: connector.endSnapTo
    });
  }
}

module.exports = { BoardBuilder, FATAL_STATUSES };
