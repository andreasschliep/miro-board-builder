'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const EXAMPLE = path.join(__dirname, '..', 'examples', 'testing-fundamentals', 'board.yaml');

const silentLogger = { log() {}, warn() {}, error() {} };

function tempDir(prefix = 'miro-board-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Minimal fetch Response stand-in. */
function fakeResponse(status, body = '', headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

module.exports = { EXAMPLE, silentLogger, tempDir, fakeResponse };
