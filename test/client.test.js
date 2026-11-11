'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MiroClient, MAX_BOARD_NAME_LENGTH } = require('../src/miro/client');
const { DryRunTransport } = require('../src/miro/transport');
const { silentLogger } = require('./helpers');

test('board names longer than 60 characters are rejected before any call', async () => {
  const dry = new DryRunTransport();
  const miro = new MiroClient(dry, { logger: silentLogger });
  await assert.rejects(miro.createBoard('x'.repeat(MAX_BOARD_NAME_LENGTH + 1)), /at most 60/);
  assert.equal(dry.calls.length, 0);
  await miro.createBoard('x'.repeat(MAX_BOARD_NAME_LENGTH));
  assert.equal(dry.calls.length, 1);
});

test('createShape converts named colors and sets the parent', async () => {
  const dry = new DryRunTransport();
  const miro = new MiroClient(dry);
  await miro.createShape('b', '<p>Hi</p>', 1, 2, 100, 50, 'circle', {
    fillColor: 'light_yellow', borderColor: '#000000', textColor: 'red', parentId: 'f1'
  });
  const { path, body } = dry.calls[0];
  assert.equal(path, '/boards/b/shapes');
  assert.equal(body.style.fillColor, '#fff9b1');
  assert.equal(body.style.borderColor, '#000000');
  assert.equal(body.data.content, '<span style="color: #ea4e4e"><p>Hi</p></span>');
  assert.deepEqual(body.parent, { id: 'f1' });
});

test('connector caps map to Miro names', async () => {
  const dry = new DryRunTransport();
  await new MiroClient(dry).createConnector('b', 's', 'e', { startCap: 'circle', endCap: 'arrow', caption: 'c' });
  const { body } = dry.calls[0];
  assert.equal(body.style.startStrokeCap, 'filled_circle');
  assert.equal(body.style.endStrokeCap, 'stealth');
  assert.deepEqual(body.captions, [{ content: 'c', position: '50%' }]);
});

test('lines and dividers respect the Miro minimum size of 8', async () => {
  const dry = new DryRunTransport();
  const miro = new MiroClient(dry);
  await miro.createLine('b', 0, 0, 0, 4, { thickness: 2 });
  await miro.createDivider('b', 0, 0, 300, { thickness: 2 });
  assert.equal(dry.calls[0].body.geometry.width, 8);
  assert.equal(dry.calls[0].body.geometry.height, 8);
  assert.equal(dry.calls[0].body.geometry.rotation, 90);
  assert.equal(dry.calls[1].body.geometry.height, 8);
});

test('clearBoard deletes frames first, re-reads, then deletes the rest', async () => {
  const pages = [
    [{ id: 'f1', type: 'frame' }, { id: 's1', type: 'shape' }, { id: 's2', type: 'shape' }],
    [{ id: 's2', type: 'shape' }],
    []
  ];
  const deleted = [];
  const transport = {
    async request(method, path) {
      if (method === 'GET') return { data: pages.shift(), cursor: null };
      if (method === 'DELETE') deleted.push(path.split('/').pop());
      return null;
    }
  };
  const count = await new MiroClient(transport, { logger: silentLogger }).clearBoard('b');
  assert.deepEqual(deleted, ['f1', 's2']);
  assert.equal(count, 2);
});

test('clearBoard stops when a pass deletes nothing', async () => {
  let gets = 0;
  const transport = {
    async request(method) {
      if (method === 'GET') { gets++; return { data: [{ id: 'x', type: 'shape' }], cursor: null }; }
      const error = new Error('forbidden');
      error.status = 403;
      throw error;
    }
  };
  const count = await new MiroClient(transport, { logger: silentLogger }).clearBoard('b');
  assert.equal(count, 0);
  assert.equal(gets, 1);
});

test('getAllItems follows the cursor', async () => {
  const pages = [{ data: [{ id: 1 }], cursor: 'abc' }, { data: [{ id: 2 }], cursor: null }];
  const paths = [];
  const transport = { async request(method, path) { paths.push(path); return pages.shift(); } };
  const items = await new MiroClient(transport).getAllItems('b');
  assert.deepEqual(items.map((i) => i.id), [1, 2]);
  assert.equal(paths[1], '/boards/b/items?limit=50&cursor=abc');
});
