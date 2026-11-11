#!/usr/bin/env node
'use strict';

/**
 * miro-board: build Miro boards from YAML.
 *
 *   miro-board validate <board.yaml>
 *   miro-board info <board.yaml>
 *   miro-board build <board.yaml> --dry-run
 *   miro-board build <board.yaml> --board-id <id> [--clear]
 *   miro-board build <board.yaml> --new-board "<name>"
 *   miro-board optimize <board.yaml> [--apply --out <file>]
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Command } = require('commander');

const { BoardParser } = require('../src/parser');
const { validateBoard } = require('../src/validate');
const { BoardBuilder } = require('../src/builder');
const { FrameProtocol } = require('../src/protocol');
const { MiroClient } = require('../src/miro/client');
const { HttpTransport, DryRunTransport } = require('../src/miro/transport');

// Configuration comes from environment variables; a local .env file is a convenience.
if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile('.env');
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

/** Load, normalize and validate a board file. Returns null (and reports) when invalid. */
function loadBoard(file, { quiet = false } = {}) {
  if (!fs.existsSync(file)) {
    fail(`File not found: ${file}`);
    return null;
  }
  const parser = new BoardParser();
  let raw;
  try {
    raw = parser.loadFile(file);
  } catch (error) {
    fail(`Could not read ${file}: ${error.message}`);
    return null;
  }
  const board = parser.normalize(raw);
  const result = validateBoard(raw, board);

  if (!result.valid) {
    console.error(`${file} is not valid:`);
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return null;
  }
  if (!quiet) {
    for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
    for (const issue of result.textFit) {
      console.warn(
        `  text-fit: frame '${issue.frameId}' element ${issue.index} "${issue.text}" ` +
        `needs ~${issue.requiredHeight} height, has ${issue.height} (font ${issue.fontSize})`
      );
    }
  }
  return { board, result };
}

const program = new Command();
program
  .name('miro-board')
  .description('Build Miro boards from YAML definitions')
  .version(require('../package.json').version);

program
  .command('validate')
  .description('Check a board definition against the schema, references and text fit')
  .argument('<file>', 'board YAML file')
  .option('--strict', 'treat text-fit warnings as errors')
  .action((file, options) => {
    const loaded = loadBoard(file);
    if (!loaded) return;
    const { board, result } = loaded;
    if (options.strict && result.textFit.length > 0) {
      fail(`${result.textFit.length} text-fit warning(s) in strict mode`);
      return;
    }
    console.log(`${file} is valid: ${board.frames.length} frames, ${result.warnings.length} warnings, ${result.textFit.length} text-fit warnings`);
  });

program
  .command('info')
  .description('List the frames of a board definition')
  .argument('<file>', 'board YAML file')
  .action((file) => {
    const loaded = loadBoard(file, { quiet: true });
    if (!loaded) return;
    const { board } = loaded;
    console.log(`${board.name}${board.version ? ` (version ${board.version})` : ''}`);
    if (board.duration) console.log(`Duration: ${board.duration}`);
    console.log(`Frames: ${board.frames.length}`);
    for (const frame of board.frames) {
      const phase = frame.phase ? ` [${frame.phase}]` : '';
      const template = frame.template ? ` (template: ${frame.template})` : '';
      console.log(`  ${frame.id}: ${frame.title}${phase}${template}`);
    }
  });

program
  .command('build')
  .description('Build the board on Miro, or plan the API calls with --dry-run')
  .argument('<file>', 'board YAML file')
  .option('-b, --board-id <id>', 'target board id (default: MIRO_BOARD_ID)')
  .option('--new-board <name>', 'create a new board with this name (max 60 characters)')
  .option('--team-id <id>', 'team for --new-board (default: MIRO_TEAM_ID)')
  .option('--clear', 'delete all items on the board before building')
  .option('--dry-run', 'no network: write every planned API call to the plan file')
  .option('--plan <file>', 'plan file for --dry-run', 'board-plan.json')
  .option('--log <file>', 'frame protocol (JSONL, appended)', 'build-log.jsonl')
  .option('--settle-ms <ms>', 'pause after --clear before building', '20000')
  .action(async (file, options) => {
    const loaded = loadBoard(file);
    if (!loaded) return;
    const { board } = loaded;
    const dryRun = Boolean(options.dryRun);
    const boardIdOption = options.boardId || process.env.MIRO_BOARD_ID;

    if (!dryRun && !process.env.MIRO_ACCESS_TOKEN) {
      fail('MIRO_ACCESS_TOKEN is not set. Use --dry-run to try the build without a Miro account.');
      return;
    }
    if (!boardIdOption && !options.newBoard && !dryRun) {
      fail('Pass --board-id <id> (or set MIRO_BOARD_ID), or --new-board "<name>".');
      return;
    }

    const transport = dryRun
      ? new DryRunTransport()
      : new HttpTransport({
        accessToken: process.env.MIRO_ACCESS_TOKEN,
        timeoutMs: Number(process.env.MIRO_HTTP_TIMEOUT_MS || 20000),
        maxRetries: Number(process.env.MIRO_MAX_RETRIES || 4)
      });
    const miro = new MiroClient(transport);

    try {
      if (!dryRun) await miro.verifyConnection();

      let boardId = boardIdOption;
      if (options.newBoard) {
        const created = await miro.createBoard(options.newBoard, { teamId: options.teamId || process.env.MIRO_TEAM_ID });
        boardId = created.id;
        console.log(`Created board ${boardId}`);
      }
      boardId = boardId || 'dry-run-board';

      const protocol = new FrameProtocol(options.log);
      const builder = new BoardBuilder(miro, {
        protocol,
        settleAfterClearMs: dryRun ? 0 : Number(options.settleMs)
      });
      const stats = await builder.build(boardId, board, { clearFirst: Boolean(options.clear), dryRun });

      if (dryRun) {
        const plan = transport.toPlan({ board: board.name, boardId, generatedAt: new Date().toISOString() });
        fs.mkdirSync(path.dirname(path.resolve(options.plan)), { recursive: true });
        fs.writeFileSync(options.plan, `${JSON.stringify(plan, null, 2)}\n`);
        console.log(`Dry run: ${plan.callCount} API calls written to ${options.plan}`);
      } else {
        console.log(`Board: https://miro.com/app/board/${boardId}/`);
      }
      console.log(`Frame protocol: ${options.log}`);
      if (stats.errors > 0) process.exitCode = 1;
    } catch (error) {
      fail(error.message);
    }
  });

program
  .command('optimize')
  .description('Ask Claude for better element positions (needs ANTHROPIC_API_KEY)')
  .argument('<file>', 'board YAML file')
  .option('--frames <ids>', 'comma-separated frame ids')
  .option('--apply', 'write the optimized, fully expanded definition to --out')
  .option('--out <file>', 'output file for --apply (default: <name>.optimized.yaml)')
  .option('--model <id>', 'Claude model (default: ANTHROPIC_MODEL or claude-opus-5-5)')
  .action(async (file, options) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      fail('ANTHROPIC_API_KEY is not set.');
      return;
    }
    const loaded = loadBoard(file, { quiet: true });
    if (!loaded) return;

    const { LayoutAIClient } = require('../src/ai/layoutClient');
    const { LayoutOptimizer } = require('../src/ai/layoutOptimizer');

    const ai = new LayoutAIClient({
      model: options.model,
      cacheDir: path.join(path.dirname(path.resolve(file)), '.layout-cache')
    });
    const optimizer = new LayoutOptimizer(ai, {
      onProgress: (event) => {
        if (event.type === 'frame_start') console.log(`  Analyzing ${event.frameId}...`);
      }
    });

    try {
      const frameIds = options.frames ? options.frames.split(',').map((id) => id.trim()) : null;
      const { board, report } = await optimizer.optimize(loaded.board, { frameIds, apply: Boolean(options.apply) });

      for (const frame of report.frames) {
        if (frame.error) console.log(`  ${frame.frameId}: error - ${frame.error}`);
        else console.log(`  ${frame.frameId}: ${frame.elementsChanged} element(s) - ${frame.reasoning}`);
      }
      for (const item of report.suggestions) console.log(`  suggestion (${item.frameId}): ${item.suggestion}`);

      const stats = ai.getStats();
      console.log(`AI calls: ${stats.apiCalls}, cache hits: ${stats.cacheHits}`);

      if (options.apply) {
        const out = options.out || file.replace(/\.ya?ml$/, '') + '.optimized.yaml';
        fs.writeFileSync(out, yaml.dump(board, { lineWidth: -1, noRefs: true }));
        console.log(`Optimized definition written to ${out}`);
      } else {
        console.log('Report only. Use --apply --out <file> to write the optimized definition.');
      }
    } catch (error) {
      fail(error.message);
    }
  });

program.parseAsync(process.argv);
