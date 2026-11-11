'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { BoardParser, DEFAULT_LAYOUT } = require('../src/parser');
const { EXAMPLE, tempDir } = require('./helpers');

test('applies layout defaults and computes frame positions', () => {
  const board = new BoardParser().parseString(`
name: Demo
layout: { frameSpacing: 2000 }
frames:
  - { id: a, title: A }
  - { id: b, title: B }
  - { id: c, title: C, row: 1, col: 0 }
`);
  assert.equal(board.layout.defaultFrameWidth, DEFAULT_LAYOUT.defaultFrameWidth);
  assert.deepEqual(board.frames.map((f) => [f.x, f.y]), [[0, 0], [2000, 0], [0, DEFAULT_LAYOUT.rowSpacing]]);
  assert.equal(board.frames[0].width, DEFAULT_LAYOUT.defaultFrameWidth);
  assert.equal(board.style.headerBar, true);
});

test('resolves color references on elements and phases', () => {
  const board = new BoardParser().parseString(`
name: Demo
colors: { brand: "#123456" }
phases: { P1: { label: One, color: brand } }
frames:
  - id: a
    title: A
    elements:
      - { type: shape, color: brand, borderColor: "#abcdef", textColor: light_yellow }
`);
  const el = board.frames[0].elements[0];
  assert.equal(el.color, '#123456');
  assert.equal(el.borderColor, '#abcdef');
  assert.equal(el.textColor, 'light_yellow', 'Miro color names are left for the client');
  assert.equal(board.phases.P1.color, '#123456');
});

test('expands repeat blocks with interpolation (grid layout)', () => {
  const board = new BoardParser().parseString(`
name: Demo
frames:
  - id: a
    title: A
    elements:
      - type: sticky
        content: "{{label}} ({{n}})"
        x: 10
        y: 20
        repeat:
          layout: grid
          columns: 2
          spacingX: 100
          spacingY: 50
          data:
            - { label: one, n: 1 }
            - { label: two, n: 2 }
            - { label: three, n: 3 }
`);
  const els = board.frames[0].elements;
  assert.equal(els.length, 3);
  assert.deepEqual(els.map((e) => e.content), ['one (1)', 'two (2)', 'three (3)']);
  assert.deepEqual(els.map((e) => [e.x, e.y]), [[10, 20], [110, 20], [10, 70]]);
  assert.ok(els.every((e) => e.repeat === undefined));
});

test('repeat with plain strings uses the string as content', () => {
  const board = new BoardParser().parseString(`
name: Demo
frames:
  - id: a
    title: A
    elements:
      - { type: sticky, repeat: { layout: vertical, spacing: 30, data: [x, y] } }
`);
  assert.deepEqual(board.frames[0].elements.map((e) => [e.content, e.y]), [['x', 0], ['y', 30]]);
});

test('!include reads files next to the YAML and refuses paths outside', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'snippet.html'), '<p>included</p>\n');
  fs.writeFileSync(path.join(dir, 'ok.yaml'), 'name: Demo\nframes:\n  - id: a\n    title: A\n    elements:\n      - { type: text, content: !include snippet.html }\n');
  const board = new BoardParser().parseFile(path.join(dir, 'ok.yaml'));
  assert.equal(board.frames[0].elements[0].content, '<p>included</p>');

  fs.writeFileSync(path.join(dir, 'bad.yaml'), 'name: Demo\nframes:\n  - id: a\n    title: A\n    elements:\n      - { type: text, content: !include ../../etc/hosts }\n');
  assert.throws(() => new BoardParser().parseFile(path.join(dir, 'bad.yaml')), /must stay inside/);
});

test('parses the example board', () => {
  const board = new BoardParser().parseFile(EXAMPLE);
  assert.equal(board.name, 'Testing Fundamentals');
  assert.equal(board.frames.length, 5);
  assert.match(board.frames[0].elements[0].content, /Testing Fundamentals/);
  assert.equal(board.frames[0].elements.filter((e) => e.type === 'sticky').length, 4);
});
