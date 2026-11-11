---
name: build-board
description: Build a Miro board from a board YAML file with this repository's CLI. Always validates and dry-runs first; a real build needs MIRO_ACCESS_TOKEN and a board id. Use when creating or rebuilding a board.
argument-hint: <board.yaml> [board-id]
allowed-tools: Read Bash(node bin/miro-board.js *) Bash(npx miro-board *) Bash(ls *) Glob Grep
---

# Build a Miro board

Build the board described by `$0` (a board YAML file). `$1` is the target board id; if it is missing, use `MIRO_BOARD_ID` or ask before creating a new board.

## Steps

1. Validate:
   `node bin/miro-board.js validate $0`
   Stop on errors. Report text-fit warnings and ask whether to fix the shape sizes before building.
2. Dry run:
   `node bin/miro-board.js build $0 --dry-run --plan board-plan.json --log build-log.jsonl`
   Report frames, elements, connectors and the number of planned API calls.
3. Real build (only if the user wants it and `MIRO_ACCESS_TOKEN` is set):
   `node bin/miro-board.js build $0 --board-id <id>`
   Add `--clear` only when the user asked to replace the board's content: it deletes every item on the board.
4. Read `build-log.jsonl` and report frames with status `failed` or `partial`, with their error.
5. Give the board URL that the CLI printed.

## Rules

- Never print or log the access token.
- Never run `--clear` on a board the user did not name explicitly.
- Do not create boards (`--new-board`) without asking; names are limited to 60 characters.
