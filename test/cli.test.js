'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { EXAMPLE, tempDir } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'miro-board.js');

function run(args, cwd) {
  const env = { ...process.env };
  delete env.MIRO_ACCESS_TOKEN;
  delete env.MIRO_BOARD_ID;
  delete env.ANTHROPIC_API_KEY;
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
}

test('validate succeeds on the example', () => {
  const result = run(['validate', EXAMPLE], tempDir());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /is valid: 5 frames/);
});

test('build --dry-run writes a plan and a frame protocol without credentials', () => {
  const cwd = tempDir();
  const result = run(['build', EXAMPLE, '--dry-run', '--new-board', 'Testing Fundamentals'], cwd);
  assert.equal(result.status, 0, result.stderr);

  const plan = JSON.parse(fs.readFileSync(path.join(cwd, 'board-plan.json'), 'utf8'));
  assert.equal(plan.dryRun, true);
  assert.equal(plan.calls[0].path, '/boards');
  assert.equal(plan.calls[0].body.name, 'Testing Fundamentals');
  assert.equal(plan.callCount, plan.calls.length);

  const log = fs.readFileSync(path.join(cwd, 'build-log.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 5);
});

test('a real build without a token fails with a hint', () => {
  const result = run(['build', EXAMPLE, '--board-id', 'abc'], tempDir());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MIRO_ACCESS_TOKEN is not set.*--dry-run/);
});

test('optimize without an API key fails with a hint', () => {
  const result = run(['optimize', EXAMPLE], tempDir());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ANTHROPIC_API_KEY is not set/);
});

test('invalid files exit with status 1', () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, 'bad.yaml'), 'frames: []\n');
  const result = run(['validate', 'bad.yaml'], cwd);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not valid/);
});
