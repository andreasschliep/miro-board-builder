'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { BoardParser } = require('../src/parser');
const { BoardBuilder } = require('../src/builder');
const { FrameProtocol } = require('../src/protocol');
const { MiroClient } = require('../src/miro/client');
const { DryRunTransport } = require('../src/miro/transport');
const { EXAMPLE, silentLogger, tempDir } = require('./helpers');

function dryBuild(board, options = {}) {
  const dry = new DryRunTransport();
  const miro = new MiroClient(dry, { logger: silentLogger });
  const protocol = new FrameProtocol(options.log || null);
  const builder = new BoardBuilder(miro, { protocol, logger: silentLogger, ...options.builder });
  return { dry, protocol, builder };
}

test('dry run of the example plans frames first, connectors last', async () => {
  const board = new BoardParser().parseFile(EXAMPLE);
  const { dry, builder } = dryBuild(board);
  const stats = await builder.build('board-1', board, { dryRun: true });

  assert.equal(stats.framesCreated, 5);
  assert.equal(stats.connectorsCreated, 2);
  assert.equal(stats.errors, 0);

  const paths = dry.calls.map((c) => c.path);
  assert.equal(paths[0], '/boards/board-1/frames');
  assert.equal(paths.filter((p) => p.endsWith('/frames')).length, 5);
  assert.deepEqual(paths.slice(-2), ['/boards/board-1/connectors', '/boards/board-1/connectors']);
  assert.equal(dry.calls.length, 5 + stats.elementsCreated + stats.connectorsCreated);

  // Every frame gets a header bar with its title.
  const firstShape = dry.calls.find((c) => c.path.endsWith('/shapes'));
  assert.match(firstShape.body.data.content, /Welcome &amp;|Welcome &/);
});

test('connectors link the ids returned for the referenced elements', async () => {
  const board = new BoardParser().parseString(`
name: D
style: { headerBar: false }
frames:
  - id: a
    title: A
    elements:
      - { type: shape, ref: left, content: L }
      - { type: shape, ref: right, content: R }
      - { type: connector, from: left, to: right }
`);
  const { dry, builder } = dryBuild(board);
  await builder.build('b', board);
  const connector = dry.calls.find((c) => c.path.endsWith('/connectors'));
  const shapes = dry.calls.filter((c) => c.path.endsWith('/shapes'));
  assert.equal(shapes.length, 2);
  assert.equal(connector.body.startItem.id, 'dry-run-2');
  assert.equal(connector.body.endItem.id, 'dry-run-3');
});

test('writes one protocol line per frame', async () => {
  const board = new BoardParser().parseFile(EXAMPLE);
  const log = path.join(tempDir(), 'logs', 'build-log.jsonl');
  const { builder } = dryBuild(board, { log });
  await builder.build('board-1', board, { dryRun: true });

  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.map((l) => l.frameId), ['welcome', 'anatomy', 'test-levels', 'kata', 'wrap-up']);
  for (const line of lines) {
    assert.equal(line.status, 'created');
    assert.equal(line.dryRun, true);
    assert.match(line.miroId, /^dry-run-\d+$/);
    assert.ok(line.elements > 0);
    assert.ok(!Number.isNaN(Date.parse(line.ts)));
  }
});

test('a failing frame is recorded as failed and the build continues', async () => {
  const board = new BoardParser().parseString('name: D\nframes:\n  - { id: a, title: A }\n  - { id: b, title: B }\n');
  const dry = new DryRunTransport();
  const original = dry.request.bind(dry);
  dry.request = async (method, p, body) => {
    if (p.endsWith('/frames') && body.data.title === 'A') throw new Error('HTTP 500');
    return original(method, p, body);
  };
  const protocol = new FrameProtocol();
  const builder = new BoardBuilder(new MiroClient(dry, { logger: silentLogger }), { protocol, logger: silentLogger });
  const stats = await builder.build('b', board);
  assert.equal(stats.framesCreated, 1);
  assert.equal(stats.errors, 1);
  assert.deepEqual(protocol.entries.map((e) => [e.frameId, e.status]), [['a', 'failed'], ['b', 'created']]);
  assert.equal(protocol.entries[0].error, 'HTTP 500');
});

test('clearing waits for the board to settle before building', async () => {
  const board = new BoardParser().parseString('name: D\nframes:\n  - { id: a, title: A }\n');
  const sleeps = [];
  const { dry, builder } = dryBuild(board, {
    builder: { settleAfterClearMs: 20000, sleep: async (ms) => { sleeps.push(ms); } }
  });
  await builder.build('b', board, { clearFirst: true });
  assert.deepEqual(sleeps, [20000]);
  assert.equal(dry.calls[0].method, 'GET');
});

test('parented elements are positioned relative to the frame top-left', async () => {
  const board = new BoardParser().parseString(`
name: D
style: { headerBar: false, parentElements: true }
frames:
  - id: a
    title: A
    x: 5000
    y: 3000
    width: 1000
    height: 800
    elements:
      - { type: text, content: hi, x: 100, y: -50 }
      - type: group
        x: 10
        y: 10
        items:
          - { type: sticky, content: s, x: 5, y: 5 }
`);
  const { dry, builder } = dryBuild(board);
  await builder.build('b', board);
  const text = dry.calls.find((c) => c.path.endsWith('/texts'));
  const sticky = dry.calls.find((c) => c.path.endsWith('/sticky_notes'));
  assert.deepEqual(text.body.position, { x: 600, y: 350 });
  assert.deepEqual(text.body.parent, { id: 'dry-run-1' });
  assert.deepEqual(sticky.body.position, { x: 515, y: 415 });
});

test('phase badge is added when the phase is defined', async () => {
  const board = new BoardParser().parseString(`
name: D
style: { headerBar: false }
phases: { P1: { label: One, color: "#111111" } }
frames:
  - { id: a, title: A, phase: P1 }
`);
  const { dry, builder } = dryBuild(board);
  await builder.build('b', board);
  const badge = dry.calls.find((c) => c.path.endsWith('/shapes'));
  assert.equal(badge.body.data.shape, 'circle');
  assert.equal(badge.body.style.fillColor, '#111111');
});

function twoFrameBoard() {
  return new BoardParser().parseString(
    'name: D\nframes:\n  - id: a\n    title: A\n    elements:\n      - { type: text, content: one, ref: one }\n' +
    '  - id: b\n    title: B\n    elements:\n      - { type: text, content: two, ref: two }\n      - { type: connector, from: one, to: two }\n'
  );
}

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

test('an aborted signal stops the build before the first frame', async () => {
  const { dry, builder } = dryBuild(twoFrameBoard());
  const controller = new AbortController();
  controller.abort(new Error('user cancelled'));
  const result = await builder.build('b', twoFrameBoard(), { signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(result.abortReason, 'cancelled: user cancelled');
  assert.equal(result.framesCreated, 0);
  assert.equal(dry.calls.length, 0);
});

test('cancelling during the build stops between frames and keeps what exists', async () => {
  const controller = new AbortController();
  const dry = new DryRunTransport();
  const protocol = { entries: [], record(entry) { this.entries.push(entry); controller.abort(); } };
  const builder = new BoardBuilder(new MiroClient(dry, { logger: silentLogger }), { protocol, logger: silentLogger });
  const result = await builder.build('b', twoFrameBoard(), { signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(result.framesCreated, 1);
  assert.equal(result.connectorsCreated, 0);
  assert.deepEqual(protocol.entries.map((e) => e.frameId), ['a']);
});

test('HTTP 401 on a frame stops the whole build', async () => {
  const dry = new DryRunTransport();
  const original = dry.request.bind(dry);
  dry.request = async (method, p, body) => {
    if (p.endsWith('/frames')) throw httpError(401);
    return original(method, p, body);
  };
  const protocol = new FrameProtocol();
  const builder = new BoardBuilder(new MiroClient(dry, { logger: silentLogger }), { protocol, logger: silentLogger });
  const result = await builder.build('b', twoFrameBoard());
  assert.equal(result.aborted, true);
  assert.match(result.abortReason, /HTTP 401/);
  assert.deepEqual(protocol.entries.map((e) => [e.frameId, e.status]), [['a', 'failed']]);
  assert.equal(dry.calls.length, 0);
});

test('HTTP 403 on an element fails the frame, keeps its id and stops the build', async () => {
  const dry = new DryRunTransport();
  const original = dry.request.bind(dry);
  dry.request = async (method, p, body) => {
    if (p.endsWith('/texts')) throw httpError(403);
    return original(method, p, body);
  };
  const protocol = new FrameProtocol();
  const builder = new BoardBuilder(new MiroClient(dry, { logger: silentLogger }), { protocol, logger: silentLogger });
  const result = await builder.build('b', twoFrameBoard());
  assert.equal(result.aborted, true);
  assert.equal(result.errors, 1);
  assert.deepEqual(protocol.entries.map((e) => [e.frameId, e.status, e.miroId]), [['a', 'failed', 'dry-run-1']]);
});

test('a build that is not stopped reports aborted: false', async () => {
  const { builder } = dryBuild(twoFrameBoard());
  const result = await builder.build('b', twoFrameBoard());
  assert.equal(result.aborted, false);
  assert.equal(result.abortReason, null);
  assert.equal(result.connectorsCreated, 1);
});
