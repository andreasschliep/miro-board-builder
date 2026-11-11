'use strict';

/**
 * Frame protocol: one JSON line per frame the builder processed, appended to a
 * JSONL file. It answers "what did this run create, and where did it fail?"
 * without opening the board.
 */

const fs = require('fs');
const path = require('path');

class FrameProtocol {
  /**
   * @param {string|null} filePath - JSONL file to append to; null keeps entries in memory only
   * @param {Object} [options]
   * @param {Function} [options.now] - Clock for timestamps (tests)
   */
  constructor(filePath = null, { now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.entries = [];
    if (filePath) fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }

  record(entry) {
    const line = { ts: this.now().toISOString(), ...entry };
    this.entries.push(line);
    if (this.filePath) fs.appendFileSync(this.filePath, `${JSON.stringify(line)}\n`);
    return line;
  }
}

module.exports = { FrameProtocol };
