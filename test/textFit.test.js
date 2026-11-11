'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { estimateRequiredHeight, checkElement, checkBoard, htmlToLines, effectiveFontSize } = require('../src/textFit');
const { BoardParser } = require('../src/parser');

test('htmlToLines splits paragraphs and breaks and strips tags', () => {
  assert.deepEqual(htmlToLines('<p><strong>A</strong></p><p>B<br/>C</p>'), ['A', 'B', 'C']);
});

test('more text needs more height', () => {
  const short = estimateRequiredHeight('<p>Short</p>', { fontSize: 14, width: 200 });
  const long = estimateRequiredHeight(`<p>${'x'.repeat(200)}</p>`, { fontSize: 14, width: 200 });
  assert.ok(long > short);
});

test('a one-line title fits a 60-high bar at font 28', () => {
  assert.equal(checkElement({ type: 'shape', content: '<p><strong>Welcome</strong></p>', width: 1500, height: 60, fontSize: 28 }), null);
});

test('overflow is reported with the deficit', () => {
  const issue = checkElement({ type: 'shape', content: `<p>${'lorem ipsum '.repeat(20)}</p>`, width: 200, height: 100, fontSize: 14 });
  assert.ok(issue);
  assert.equal(issue.deficit, issue.requiredHeight - 100);
});

test('inline font-size wins over fontSize', () => {
  assert.equal(effectiveFontSize({ content: '<span style="font-size: 36px">x</span>', fontSize: 14 }), 36);
  assert.equal(effectiveFontSize({ content: 'x' }), 14);
});

test('only shapes are checked', () => {
  assert.equal(checkElement({ type: 'text', content: 'x'.repeat(500), width: 10 }), null);
  assert.equal(checkElement({ type: 'sticky', content: 'x'.repeat(500) }), null);
});

test('checkBoard covers template output and group items', () => {
  const long = 'word '.repeat(60);
  const board = new BoardParser().parseString(`
name: D
frames:
  - id: cols
    title: Columns
    template: columns
    templateData:
      columns:
        - { title: "T", items: ["${long}"] }
  - id: grouped
    title: Grouped
    elements:
      - type: group
        x: 100
        items:
          - { type: shape, content: "${long}", width: 150, height: 80 }
`);
  const warnings = checkBoard(board);
  assert.deepEqual(warnings.map((w) => w.frameId).sort(), ['cols', 'grouped']);
});
