---
name: validate-board
description: Check a board YAML file before building - schema, unique ids, connector references, templates, phases and text fit - and propose concrete fixes. Use after editing a board definition.
argument-hint: <board.yaml>
allowed-tools: Read Edit Bash(node bin/miro-board.js *) Glob Grep
---

# Validate a board definition

Check `$ARGUMENTS` (a board YAML file).

## Steps

1. Run `node bin/miro-board.js validate $ARGUMENTS`.
2. For every error, find the line in the YAML and propose the fix (missing `title`, duplicate frame `id`, connector `from`/`to` without a matching `ref`, unknown `template`).
3. For every text-fit warning, propose one of: shorter text, larger `width`/`height`, smaller `fontSize`. Prefer shorter text when the box sits in a grid with others of the same size.
4. Run `node bin/miro-board.js info $ARGUMENTS` and check the session flow: does every frame have a `phase`, and do the phases appear in order?
5. Apply fixes only after the user agrees, then validate again.

## Reference

- Schema: `schema/board.schema.json`
- Templates: `src/templates.js` (`columns`, `exercise`, `cardGrid`)
- Example: `examples/testing-fundamentals/board.yaml`
