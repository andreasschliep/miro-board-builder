'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { HttpTransport, DryRunTransport, MiroApiError } = require('../src/miro/transport');
const { fakeResponse } = require('./helpers');

function makeTransport(responses, extra = {}) {
  const calls = [];
  const sleeps = [];
  let clock = 0;
  const transport = new HttpTransport({
    accessToken: 'test-token',
    minIntervalMs: 0,
    backoffBaseMs: 100,
    maxRetries: 3,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    ...extra
  });
  return { transport, calls, sleeps };
}

test('requires an access token', () => {
  assert.throws(() => new HttpTransport({}), /MIRO_ACCESS_TOKEN/);
});

test('sends JSON with a bearer token and parses the response', async () => {
  const { transport, calls } = makeTransport([fakeResponse(201, { id: '42' })]);
  const result = await transport.request('POST', '/boards/b/shapes', { data: { content: 'x' } });
  assert.deepEqual(result, { id: '42' });
  assert.equal(calls[0].url, 'https://api.miro.com/v2/boards/b/shapes');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].init.body, JSON.stringify({ data: { content: 'x' } }));
});

test('retries 429 honouring Retry-After, then succeeds', async () => {
  const { transport, sleeps } = makeTransport([
    fakeResponse(429, '', { 'Retry-After': '2' }),
    fakeResponse(200, { ok: true })
  ]);
  assert.deepEqual(await transport.request('GET', '/boards'), { ok: true });
  assert.deepEqual(sleeps, [2000]);
  assert.equal(transport.stats.retries, 1);
});

test('retries 5xx and network errors with exponential backoff', async () => {
  const { transport, sleeps } = makeTransport([
    fakeResponse(500, 'oops'),
    new Error('socket hang up'),
    fakeResponse(503, 'busy'),
    fakeResponse(200, { done: 1 })
  ]);
  assert.deepEqual(await transport.request('GET', '/x'), { done: 1 });
  assert.deepEqual(sleeps, [100, 200, 400]);
});

test('gives up after maxRetries with a MiroApiError', async () => {
  const { transport } = makeTransport([500, 500, 500, 500].map((s) => fakeResponse(s, 'down')));
  await assert.rejects(transport.request('GET', '/x'), (error) => {
    assert.ok(error instanceof MiroApiError);
    assert.equal(error.status, 500);
    return true;
  });
});

test('does not retry client errors', async () => {
  const { transport, calls } = makeTransport([fakeResponse(400, '{"message":"bad"}')]);
  await assert.rejects(transport.request('POST', '/x', {}), /HTTP 400/);
  assert.equal(calls.length, 1);
});

test('throttles requests to the minimum interval', async () => {
  const { transport, sleeps } = makeTransport(
    [fakeResponse(200, '{}'), fakeResponse(200, '{}'), fakeResponse(204)],
    { minIntervalMs: 650 }
  );
  await transport.request('GET', '/a');
  await transport.request('GET', '/b');
  assert.equal(await transport.request('DELETE', '/c'), null);
  assert.deepEqual(sleeps, [650, 650]);
});

test('DryRunTransport records calls and returns fake ids', async () => {
  const dry = new DryRunTransport();
  const created = await dry.request('POST', '/boards/b/frames', { data: { title: 'T' } });
  const listed = await dry.request('GET', '/boards/b/items?limit=50');
  assert.equal(created.id, 'dry-run-1');
  assert.deepEqual(listed, { data: [], cursor: null });
  const plan = dry.toPlan({ board: 'Demo' });
  assert.equal(plan.callCount, 2);
  assert.equal(plan.calls[0].body.data.title, 'T');
  assert.equal(plan.dryRun, true);
});

test('upload sends multipart data like curl -F: the file as "resource", the JSON as "data" without a file name', async () => {
  const { transport, calls } = makeTransport([fakeResponse(503, 'busy'), fakeResponse(201, { id: 'img' })]);
  const result = await transport.upload('/boards/b/images', {
    data: { position: { x: 1, y: 2 } },
    file: { name: 'logo.svg', contentType: 'image/svg+xml', bytes: Buffer.from('<svg/>') }
  });
  assert.deepEqual(result, { id: 'img' });
  assert.equal(calls.length, 2, 'retried once');
  for (const { url, init } of calls) {
    assert.equal(url, 'https://api.miro.com/v2/boards/b/images');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    const boundary = /^multipart\/form-data; boundary=(\S+)$/.exec(init.headers['Content-Type'])[1];
    const parts = Buffer.from(init.body).toString('utf8').split(`--${boundary}`);
    assert.equal(parts.at(-1), '--\r\n');
    assert.equal(
      parts[1],
      '\r\nContent-Disposition: form-data; name="resource"; filename="logo.svg"\r\n' +
        'Content-Type: image/svg+xml\r\n\r\n<svg/>\r\n'
    );
    // Miro answered 500 when this part carried a file name, as FormData adds for a Blob.
    assert.equal(
      parts[2],
      '\r\nContent-Disposition: form-data; name="data"\r\n' +
        'Content-Type: application/json\r\n\r\n{"position":{"x":1,"y":2}}\r\n'
    );
  }
});

test('upload keeps quotes and line breaks out of the file name', async () => {
  const { transport, calls } = makeTransport([fakeResponse(201, { id: 'img' })]);
  await transport.upload('/boards/b/images', {
    data: {},
    file: { name: 'a"b\r\nc.png', contentType: 'image/png', bytes: Buffer.from('x') }
  });
  assert.match(Buffer.from(calls[0].init.body).toString('utf8'), /filename="a%22b%0D%0Ac\.png"/);
});

test('DryRunTransport records an upload without the file bytes', async () => {
  const dry = new DryRunTransport();
  const created = await dry.upload('/boards/b/images', {
    data: { position: { x: 0, y: 0 } },
    file: { name: 'a.png', contentType: 'image/png', bytes: Buffer.from('1234') }
  });
  assert.equal(created.id, 'dry-run-1');
  assert.deepEqual(dry.calls[0], {
    seq: 1,
    method: 'POST',
    path: '/boards/b/images',
    body: { data: { position: { x: 0, y: 0 } }, file: { name: 'a.png', contentType: 'image/png', size: 4 } }
  });
});
