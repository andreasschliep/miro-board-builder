# miro-board-builder

Describe a Miro board in YAML, check it, plan it offline, then build it through the Miro REST API v2.

*Built with Claude Code as co-developer.*

## Problem

Workshop boards with many frames are slow to build by hand and hard to keep consistent. Once a board exists, nobody knows which version of the content it shows. Rebuilding it is a manual job again.

## Approach

- **YAML as the source.** Frames, shapes, text, sticky notes, cards, images, embeds and connectors are described in a file under version control. Templates cover recurring frame layouts; `repeat` generates rows and grids of elements; `!include` pulls longer text from separate files.
- **Check before building.** `validate` runs a JSON Schema, checks ids and connector references, and estimates whether the text of each shape fits its size. Miro does not report overflowing text, so this is the only place to catch it.
- **Dry run.** `build --dry-run` runs the complete build against a recording transport: no network, no account. Every API call it would make lands in `board-plan.json`.
- **Frame protocol.** Each build appends one JSON line per frame to `build-log.jsonl`: frame id, title, Miro item id, element count, status and errors.
- **Robust API use.** Throttling to about 90 requests per minute, retries with backoff for 429, 5xx, timeouts and network errors (honouring `Retry-After`), board clearing in passes, a pause after clearing before frames are created, and the 60-character limit for board names.
- **Optional AI layout pass.** `optimize` sends each frame's elements to Claude and gets positions back as schema-checked JSON. Results are cached in memory and on disk, so an unchanged frame is not sent twice.

## Quick start

Requires Node.js 20.12 or later.

```bash
npm install
npx miro-board validate examples/testing-fundamentals/board.yaml
npx miro-board build examples/testing-fundamentals/board.yaml --dry-run
```

The dry run needs no credentials. It writes `board-plan.json` (all planned API calls) and `build-log.jsonl` (one line per frame).

To build for real, create a Miro app with `boards:read` and `boards:write`, then:

```bash
cp .env.example .env    # add MIRO_ACCESS_TOKEN
npx miro-board build examples/testing-fundamentals/board.yaml --board-id <board-id>
# or create a new board:
npx miro-board build examples/testing-fundamentals/board.yaml --new-board "Testing Fundamentals"
```

`--clear` deletes every item on the target board before building. Use it only on boards that are generated from YAML.

## Example output

```text
$ npx miro-board build examples/testing-fundamentals/board.yaml --dry-run
Building "Testing Fundamentals" (5 frames) on board dry-run-board
  Frame welcome: Welcome & Check-in
  Frame anatomy: Anatomy of a Unit Test
  Frame test-levels: Where Tests Live
  Frame kata: Practice: String Calculator Kata
  Frame wrap-up: Takeaways
Done: 5 frames, 42 elements, 2 connectors, 0 errors
Dry run: 49 API calls written to board-plan.json
Frame protocol: build-log.jsonl
```

One line of `build-log.jsonl`:

```json
{"ts":"…","boardId":"dry-run-board","frameId":"welcome","title":"Welcome & Check-in","dryRun":true,"miroId":"dry-run-1","elements":7,"errors":0,"status":"created"}
```

## Board YAML in short

```yaml
name: "Testing Fundamentals"
colors: { brand: "#2563eb" }          # named colors; defaults: primary, secondary, accent, ...
phases:                                # optional; frames with `phase: C1` get a badge
  C1: { label: "Connections", color: primary }
style: { headerBar: true, parentElements: false }

frames:
  - id: welcome                        # unique, lowercase
    title: "Welcome & Check-in"
    phase: C1
    elements:                          # x/y are offsets from the frame center
      - { type: text, content: !include notes/check-in.html, y: -250, width: 900 }
      - type: sticky
        content: "{{prompt}}"
        repeat: { layout: horizontal, spacingX: 300, data: [{ prompt: "..." }] }
      - { type: shape, ref: a, content: "A", color: brand }
      - { type: shape, ref: b, content: "B", x: 400 }
      - { type: connector, from: a, to: b, caption: "then" }

  - id: practice
    title: "Practice"
    template: exercise                 # columns | exercise | cardGrid
    templateData: { instructions: "...", debrief: ["..."] }
```

Element types: `text`, `shape`, `sticky`, `card`, `image`, `embed`, `divider`, `line`, `connector`, `group`. The full format is in [`schema/board.schema.json`](schema/board.schema.json); a complete example is in [`examples/testing-fundamentals/board.yaml`](examples/testing-fundamentals/board.yaml) (fictional content).

## Commands

| Command | What it does | Needs |
|---|---|---|
| `validate <file> [--strict]` | Schema, ids, references, templates, phases, text fit | nothing |
| `info <file>` | Lists frames with phase and template | nothing |
| `build <file> --dry-run` | Records all API calls to `--plan`, frame protocol to `--log` | nothing |
| `build <file> --board-id <id>` | Builds on an existing board (`--clear` to replace content) | `MIRO_ACCESS_TOKEN` |
| `build <file> --new-board "<name>"` | Creates a board, then builds | `MIRO_ACCESS_TOKEN` |
| `optimize <file> [--apply --out <file>]` | Claude suggests element positions; report only unless `--apply` | `ANTHROPIC_API_KEY` |

`optimize --apply` writes a fully expanded definition (includes, repeats and defaults resolved) to a new file, so the original YAML stays untouched.

## Configuration

All configuration comes from environment variables; see [`.env.example`](.env.example). A `.env` file in the working directory is loaded if present.

`optimize` uses `claude-opus-5-5` by default (override with `ANTHROPIC_MODEL` or `--model`) with structured JSON output and effort `medium`. It opts into Anthropic's server-side refusal fallback (`fallbacks: "default"`); pass `fallbacks: false` to `LayoutAIClient` to turn that off.

## Use as a library

`require('miro-board-builder')` exports the parser, validator, builder, Miro client and transports. Two options matter when the YAML does not come from you, for example when an agent writes it:

- `new BoardParser({ allowInclude: false })` makes `!include` fail instead of reading a local file.
- `builder.build(boardId, board, { signal })` stops between frames when the `AbortSignal` fires. Independently of the signal, the build stops when Miro answers 401, 403 or 404. The result then has `aborted: true` and an `abortReason`; everything created before stays on the board and in the frame protocol.

## Project layout

```text
bin/miro-board.js        CLI
src/parser.js            YAML loading, defaults, !include, repeat, color references
src/validate.js          JSON Schema + semantic checks
src/textFit.js           text overflow estimate for shapes
src/frameElements.js     header bar, template output, phase badge per frame
src/templates.js         columns, exercise, cardGrid
src/builder.js           frames, elements, connectors (two passes) + frame protocol
src/protocol.js          JSONL frame protocol
src/miro/client.js       Miro REST API v2 payloads
src/miro/transport.js    HTTP transport (throttle, retry) and dry-run transport
src/ai/                  Claude layout client, prompts, optimizer
.claude/skills/          Claude Code skills: build-board, validate-board
```

## Tests

```bash
npm test
```

All tests run offline. The Miro API is replaced by the dry-run transport or a fake `fetch`; the Anthropic SDK client is replaced by a stub.

## How this was built

I built this tool to generate the boards for my workshops and talks. I set the requirements and made the design decisions; Claude Code wrote most of the implementation and the tests. For this public version, Claude Code extracted the builder from a larger private toolset, removed everything specific to my courses and added the dry run, the frame protocol and the offline tests.

Three rules I follow when working with AI:

1. It only sees what I would also show a client.
2. It says what it has done.
3. Nothing leaves the house without human review.

## Credits

- The four session phases in the example (Connections, Concepts, Concrete Practice, Conclusions) follow the 4C model from Sharon Bowman, *Training from the BACK of the Room!*
- [Miro REST API v2](https://developers.miro.com/reference/api-reference)
- [Anthropic API](https://docs.claude.com/) via the official `@anthropic-ai/sdk`

## Related tools

Small tools from my work as a trainer and facilitator:

- [learning-objective-lint](https://github.com/andreasschliep/learning-objective-lint): lint learning objectives against Bloom's taxonomy and check that an agenda practises them
- [facilitation-planner](https://github.com/andreasschliep/facilitation-planner): plan a session backwards from acceptance sentences and let a checker keep the timing honest
- [wardley-map-builder](https://github.com/andreasschliep/wardley-map-builder): render Wardley maps from YAML to PNG or onto a Miro board

More about me: [github.com/andreasschliep](https://github.com/andreasschliep)

## License

MIT, see [LICENSE](LICENSE).
