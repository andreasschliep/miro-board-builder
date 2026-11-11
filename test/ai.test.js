'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { LayoutAIClient, DEFAULT_MODEL, FALLBACK_BETA } = require('../src/ai/layoutClient');
const { LayoutOptimizer, applySuggestion } = require('../src/ai/layoutOptimizer');
const { LAYOUT_SCHEMA, buildUserPrompt, inferSemanticRole } = require('../src/ai/layoutPrompts');
const { BoardParser } = require('../src/parser');
const { silentLogger, tempDir } = require('./helpers');

/** Stand-in for the Anthropic SDK client: no network. */
function mockSdk(responder) {
  const requests = [];
  const create = async (request) => {
    requests.push(request);
    return responder(request);
  };
  return { requests, client: { beta: { messages: { create } }, messages: { create } } };
}

const okResponse = (payload) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  usage: { input_tokens: 100, output_tokens: 20 }
});

test('builds a structured-output request with the default model and fallback opt-in', async () => {
  const { client, requests } = mockSdk(() => okResponse({ reasoning: 'r', elements: [], suggestions: [] }));
  const ai = new LayoutAIClient({ client, enableCache: false });
  const result = await ai.completeJson('sys', 'user', LAYOUT_SCHEMA);

  assert.deepEqual(result, { reasoning: 'r', elements: [], suggestions: [] });
  const request = requests[0];
  assert.equal(request.model, process.env.ANTHROPIC_MODEL || DEFAULT_MODEL);
  assert.equal(request.system, 'sys');
  assert.deepEqual(request.messages, [{ role: 'user', content: 'user' }]);
  assert.deepEqual(request.output_config.format, { type: 'json_schema', schema: LAYOUT_SCHEMA });
  assert.equal(request.output_config.effort, 'medium');
  assert.deepEqual(request.betas, [FALLBACK_BETA]);
  assert.equal(request.fallbacks, 'default');
});

test('fallbacks can be turned off', async () => {
  const { client, requests } = mockSdk(() => okResponse({ reasoning: '', elements: [], suggestions: [] }));
  await new LayoutAIClient({ client, enableCache: false, fallbacks: false }).completeJson('s', 'u', LAYOUT_SCHEMA);
  assert.equal(requests[0].betas, undefined);
  assert.equal(requests[0].fallbacks, undefined);
});

test('caches in memory and on disk', async () => {
  const cacheDir = tempDir();
  const { client, requests } = mockSdk(() => okResponse({ reasoning: 'cached', elements: [], suggestions: [] }));

  const first = new LayoutAIClient({ client, cacheDir });
  await first.completeJson('s', 'u', LAYOUT_SCHEMA);
  await first.completeJson('s', 'u', LAYOUT_SCHEMA);
  assert.equal(requests.length, 1);
  assert.equal(first.getStats().memoryCacheHits, 1);

  const second = new LayoutAIClient({ client, cacheDir });
  const result = await second.completeJson('s', 'u', LAYOUT_SCHEMA);
  assert.equal(result.reasoning, 'cached');
  assert.equal(requests.length, 1);
  assert.equal(second.getStats().diskCacheHits, 1);
  assert.ok(fs.readdirSync(cacheDir).length > 0);
});

test('a refusal becomes an error and is not cached', async () => {
  const { client } = mockSdk(() => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }));
  const ai = new LayoutAIClient({ client, enableCache: false });
  await assert.rejects(ai.completeJson('s', 'u', LAYOUT_SCHEMA), /declined.*cyber/);
});

test('missing API key is reported clearly', () => {
  assert.throws(() => new LayoutAIClient({ apiKey: '' }), /ANTHROPIC_API_KEY/);
});

test('applySuggestion clamps positions into the frame and keeps text height automatic', () => {
  const frame = {
    width: 1000,
    height: 800,
    elements: [{ type: 'shape', x: 0, y: 0 }, { type: 'text', x: 0, y: 0 }]
  };
  const changed = applySuggestion(frame, [
    { index: 0, x: 900, y: -900, width: 300, height: 120 },
    { index: 1, x: 10, y: 20, width: 400, height: 50 },
    { index: 7, x: 0, y: 0, width: 1, height: 1 }
  ]);
  assert.equal(changed, 2);
  assert.deepEqual(frame.elements[0], { type: 'shape', x: 450, y: -350, width: 300, height: 120 });
  assert.deepEqual(frame.elements[1], { type: 'text', x: 10, y: 20, width: 400 });
});

test('optimizer skips template frames and leaves the board untouched without apply', async () => {
  const board = new BoardParser().parseString(`
name: D
frames:
  - id: free
    title: Free
    elements:
      - { type: shape, content: "<p><strong>Title</strong></p>", x: 0, y: 0 }
  - id: tpl
    title: Tpl
    template: cardGrid
    templateData: { cards: [{ title: A }] }
`);
  const prompts = [];
  const ai = {
    async completeJson(system, user) {
      prompts.push(user);
      return { reasoning: 'move up', elements: [{ index: 0, x: 0, y: -300, width: 500, height: 70 }], suggestions: ['shorter title'] };
    }
  };
  const optimizer = new LayoutOptimizer(ai, { logger: silentLogger });

  const report = await optimizer.optimize(board);
  assert.equal(prompts.length, 1);
  assert.equal(report.board.frames[0].elements[0].y, 0);
  assert.deepEqual(report.report.suggestions, [{ frameId: 'free', suggestion: 'shorter title' }]);

  const applied = await optimizer.optimize(board, { apply: true });
  assert.equal(applied.board.frames[0].elements[0].y, -300);
  assert.equal(board.frames[0].elements[0].y, 0, 'input board is not mutated');
});

test('user prompt carries frame facts and semantic roles', () => {
  const board = new BoardParser().parseString(`
name: D
phases: { C2: { label: Concepts } }
frames:
  - id: f
    title: Frame
    phase: C2
    elements:
      - { type: sticky, content: note }
`);
  const prompt = buildUserPrompt(board.frames[0], board);
  assert.match(prompt, /Frame size: 1600 x 1000/);
  assert.match(prompt, /Session phase: C2 \(Concepts\)/);
  assert.match(prompt, /"semanticRole": "stickyNote"/);
  assert.equal(inferSemanticRole({ type: 'shape', content: '<p><strong>Short title</strong></p>' }), 'title');
});
