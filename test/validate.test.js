'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BoardParser } = require('../src/parser');
const { validateBoard } = require('../src/validate');
const { EXAMPLE } = require('./helpers');

function check(yamlText) {
  const parser = new BoardParser();
  const raw = parser.loadString(yamlText);
  return validateBoard(raw, parser.normalize(raw));
}

test('the example board is valid and has no text-fit warnings', () => {
  const parser = new BoardParser();
  const raw = parser.loadFile(EXAMPLE);
  const result = validateBoard(raw, parser.normalize(raw));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.textFit, []);
  assert.equal(result.valid, true);
});

test('schema: name and frames are required', () => {
  const result = check('code: X\n');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("'name'")));
  assert.ok(result.errors.some((e) => e.includes("'frames'")));
});

test('schema: unknown element type is rejected', () => {
  const result = check('name: D\nframes:\n  - id: a\n    title: A\n    elements:\n      - { type: hologram }\n');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('/frames/0/elements/0/type')));
});

test('duplicate frame ids are errors', () => {
  const result = check('name: D\nframes:\n  - { id: a, title: A }\n  - { id: a, title: B }\n');
  assert.deepEqual(result.errors, ['Duplicate frame id: a']);
});

test('connectors must point to existing refs', () => {
  const result = check(`
name: D
frames:
  - id: a
    title: A
    elements:
      - { type: shape, ref: one, content: x }
      - { type: connector, from: one, to: two }
`);
  assert.deepEqual(result.errors, ["Connector target ref 'two' does not exist"]);
});

test('unknown template is an error, undefined phase a warning', () => {
  const result = check('name: D\nframes:\n  - { id: a, title: A, template: nope, phase: X }\n');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /unknown template 'nope'/);
  assert.match(result.warnings[0], /phase 'X' is not defined/);
});

test('text-fit warnings are reported for overflowing shapes', () => {
  const long = 'word '.repeat(80);
  const result = check(`name: D\nstyle: { headerBar: false }\nframes:\n  - id: a\n    title: A\n    elements:\n      - { type: shape, content: "${long}", width: 200, height: 100 }\n`);
  assert.equal(result.valid, true);
  assert.equal(result.textFit.length, 1);
  assert.equal(result.textFit[0].frameId, 'a');
});
